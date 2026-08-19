# AI Mechanic-Shop Receptionist

Backend API for an AI receptionist that gives customers a preliminary price
estimate for common auto services.

Prices come from a hardcoded catalog, estimates are stored in Supabase, and a
Vapi voice assistant can request one during a call. The Vapi tool endpoint is
protected by a shared secret. There is no scheduling, SMS, or frontend yet —
those come later.

## Requirements

- [Node.js](https://nodejs.org/) version 20 or newer (check with `node -v`)
- npm (comes with Node.js)
- A [Supabase](https://supabase.com) project (the free tier is fine)

## 1. Install dependencies

From the project root, run:

```bash
npm install
```

This downloads everything listed in `package.json` into a `node_modules/`
folder.

## 2. Set up your environment file

```bash
cp .env.example .env
```

Then open `.env` and fill in two values from your Supabase project dashboard:

| Variable | Where to find it |
| --- | --- |
| `SUPABASE_URL` | Project Settings → Data API → Project URL |
| `SUPABASE_SECRET_KEY` | Project Settings → API Keys → **secret** key (`service_role`) |
| `VAPI_TOOL_SECRET` | You choose it — see below |

`PORT` is optional and defaults to `3000`.

`VAPI_TOOL_SECRET` is a shared password between this server and Vapi. Generate
one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `.env`, then set the same value in the Vapi dashboard as a custom
header on the tool: `x-vapi-tool-secret`. Requests without it are rejected with
`401` before any pricing or database work happens.

> **⚠️ Never commit `SUPABASE_SECRET_KEY`.**
> This key bypasses row level security and can read and write your entire
> database. It is server-side only: never put it in a browser, a frontend
> build, a log line, or an API response. `.env` is gitignored — keep it that
> way. If it ever leaks, rotate it immediately in the Supabase dashboard.

The server refuses to start if any required variable is missing, and tells you
which ones.

## 3. Create the database tables

Open your Supabase project → **SQL Editor** → **New query**. Paste the entire
contents of:

```
supabase/migrations/20260815000000_init.sql
```

and click **Run**. This creates four tables (`businesses`, `customers`,
`vehicles`, `estimates`), adds the `demo-shop` business every request falls
back to, and turns on row level security. Running it more than once is safe.

## 4. Check the database connection

```bash
npm run db:check
```

This confirms the credentials work, that `demo-shop` exists, and prints the
five most recent estimates. It prints no secrets, and nothing runs it
automatically — it is there for you to run when you want to check.

## 5. Run the server

For local development (auto-restarts when you edit a file):

```bash
npm run dev
```

You should see:

```
Mechanic-shop receptionist API listening on port 3000
```

## 6. Try it out

In another terminal:

```bash
curl -X POST http://localhost:3000/api/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "service": "front_brake_pads",
    "vehicle": { "year": 2019, "make": "Toyota", "model": "Camry" }
  }'
```

Expected response:

```json
{
  "estimateId": "3f1c2b8e-9a45-4d21-9f0e-7c6a5b4d3e2f",
  "estimateType": "preliminary",
  "service": "front_brake_pads",
  "vehicle": { "year": 2019, "make": "Toyota", "model": "Camry" },
  "low": 300,
  "high": 450,
  "currency": "USD",
  "disclaimer": "Final pricing is subject to vehicle inspection."
}
```

`estimateId` is a fresh UUID on every successful estimate, so a single quote
can be referred to later (for example, during a phone call). The prices
themselves never change for the same service and vehicle.

### Optional: businessId

The shop can be named explicitly. It is optional and defaults to
`"demo-shop"`, and it does **not** affect pricing yet — it is here so the API
can support multiple shops later.

```bash
curl -X POST http://localhost:3000/api/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "demo-shop",
    "service": "front_brake_pads",
    "vehicle": { "year": 2019, "make": "Toyota", "model": "Camry" }
  }'
```

### Vapi tool endpoint

`POST /api/vapi/tools/estimate` is an adapter for a Vapi custom tool. It
requires the `x-vapi-tool-secret` header (see `VAPI_TOOL_SECRET` above);
without it the request is rejected with `401 {"error":"Unauthorized."}`. It speaks
Vapi's envelope format, but it does **not** calculate anything itself — it
calls the exact same pricing code as `POST /api/estimate`, so both routes
always agree on price.

It answers one tool, `calculate_estimate`. The tool arguments are the same
shape as the normal estimate request body.

```bash
curl -X POST http://localhost:3000/api/vapi/tools/estimate \
  -H "Content-Type: application/json" \
  -H "x-vapi-tool-secret: $VAPI_TOOL_SECRET" \
  -d '{
    "message": {
      "type": "tool-calls",
      "toolCallList": [
        {
          "id": "call_test_123",
          "name": "calculate_estimate",
          "arguments": {
            "businessId": "demo-shop",
            "service": "front_brake_pads",
            "vehicle": { "year": 2019, "make": "Toyota", "model": "Camry" }
          }
        }
      ]
    }
  }'
```

Vapi requires `result` to be a string, so the estimate is sent back as compact
JSON inside it:

```json
{
  "results": [
    { "toolCallId": "call_test_123", "result": "{\"estimateId\":\"...\",\"low\":300,\"high\":450,...}" }
  ]
}
```

If the tool call fails in a way Vapi should explain to the caller (unknown
service, bad parameters, unknown tool), the response is still **HTTP 200** with
an `error` string instead of `result`, so the assistant can respond naturally:

```json
{
  "results": [
    { "toolCallId": "call_test_123", "error": "Service \"engine_rebuild\" is not supported. ..." }
  ]
}
```

### Health check

A simple endpoint to confirm the server is running:

```bash
curl http://localhost:3000/health
```

Returns `{"status":"ok"}` with HTTP 200.

### Supported services

| Service                 | Price range |
| ------------------------ | ----------- |
| `synthetic_oil_change`   | $80–$120    |
| `front_brake_pads`       | $300–$450   |
| `battery_replacement`    | $190–$340   |
| `diagnostic`              | $149–$149   |
| `tire_rotation`          | $40–$60     |

If you send a `service` that isn't in this list, you'll get a `400` response
listing the supported services.

## Pricing vs. persistence

These are two separate steps, and keeping them separate is deliberate.

**Pricing is deterministic.** `getEstimate()` in `src/pricing/estimate.ts` looks
a service up in the hardcoded catalog and returns a price range. It has no
database access, no clock, and no randomness: the same service and vehicle
always produce the same numbers, which makes it easy to test and impossible for
an outage to change a price.

**Persistence is a side effect that happens afterwards.** Once the price is
known, the route generates an `estimateId` and asks `src/db/estimates.ts` to
store the result. If that write fails, the request fails — but the price it
calculated was never in question.

Put simply: the database records what an estimate was, it never decides it.

### What gets stored when an estimate is created

| Table | Row written |
| --- | --- |
| `businesses` | Nothing new — only checked that the `businessId` exists |
| `customers` | **Nothing.** The caller is not identified yet, so no row is invented |
| `vehicles` | One row: `business_id`, `year`, `make`, `model` (`customer_id` null) |
| `estimates` | One row: the `estimateId`, business, vehicle, service, `low_price`, `high_price`, currency, disclaimer, `source`, and `vapi_tool_call_id` |

`source` records where the estimate came from — `api` for `POST /api/estimate`,
`vapi` for the voice tool endpoint. For Vapi calls, `vapi_tool_call_id` stores
the tool call id, and a unique index on it means a retried tool call returns
the original estimate instead of creating a second one.

Nothing is stored when a request is rejected: unsupported services and
malformed bodies never reach the database.

## Running tests

```bash
npm test
```

This runs the unit tests (pricing logic) and the API route tests (using
`supertest` to send real HTTP requests to the app in-memory).

The tests replace the database layer with a stub, so they never connect to
Supabase and never need your credentials. `npm test` is safe to run before you
have set up a project at all.

## Type-checking

```bash
npm run typecheck
```

## Project structure

```
supabase/
  migrations/
    20260815000000_init.sql   # the tables; paste into the Supabase SQL editor

src/
  index.ts              # starts the HTTP server
  app.ts                # builds the Express app (used by both index.ts and tests)
  config.ts             # the only place that reads process.env
  db/
    supabase.ts          # server-only Supabase client
    estimates.ts          # every database query lives here
  scripts/
    check-db.ts           # manual connection check (npm run db:check)
  middleware/
    vapiAuth.ts          # shared-secret check for the Vapi endpoint
    errors.ts             # JSON 404 / 500 handling, no stack traces
  routes/
    estimate.ts          # POST /api/estimate route handler
    estimate.test.ts      # HTTP-level tests for the route
    health.ts             # GET /health route handler
    health.test.ts         # test for the health check
    vapi.ts                # POST /api/vapi/tools/estimate (Vapi adapter)
    vapi.test.ts            # tests for the Vapi adapter
  schemas/
    estimate.ts          # Zod schema for validating the request body
    vapi.ts               # Zod schema for the Vapi tool-call envelope
  pricing/
    catalog.ts            # hardcoded price ranges per service
    estimate.ts            # pure pricing logic (no Express, no HTTP)
    estimate.test.ts        # unit tests for the pricing logic
```

## What's intentionally not here yet

- Caller identity (customer name and phone are never captured, so `customers`
  stays empty and `customer_id` is always null)
- Appointment scheduling
- SMS (Twilio)
- Calendar booking (Google Calendar)
- Authentication on `POST /api/estimate` (the Vapi tool endpoint *is* protected)
- Frontend

These will be added in later phases.
