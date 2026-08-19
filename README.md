# AI Mechanic-Shop Receptionist

Backend API for an AI receptionist that gives customers a preliminary price
estimate for common auto services.

Prices come from a hardcoded catalog, estimates are stored in Supabase, and a
Vapi voice assistant can request one during a call. The assistant can also
record appointment and callback **requests** — which the shop still has to act
on, since nothing here confirms a booking. All Vapi endpoints are protected by
a shared secret. There is no calendar, SMS, or frontend yet.

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

Then open `.env` and fill in the values below:

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
header — on the tool **and** on the server URL: `x-vapi-tool-secret`. Requests
without it are rejected with `401` before any pricing or database work happens.
One secret covers both Vapi endpoints.

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
back to, and turns on row level security.

Then run the remaining migrations the same way, in this order:

```
supabase/migrations/20260819000000_calls.sql
supabase/migrations/20260819000100_estimates_vapi_call_id.sql
supabase/migrations/20260819000200_requests.sql
```

These add the `calls` table, let an estimate remember which call produced it,
and add `appointment_requests` and `callback_requests`. All are safe to run
more than once.

## 4. Check the database connection

```bash
npm run db:check
```

This confirms the credentials work, that `demo-shop` exists, and that the
`estimates`, `calls`, `appointment_requests`, and `callback_requests` tables
are reachable, with counts and the five most recent rows of each.

It prints no secrets and **no personal information** — calls are listed by
Vapi call id, outcome, and follow-up flag, and requests by id and status only.
Never a phone number, name, transcript, problem description, or reason. Nothing
runs it automatically.

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

### Appointment and callback request tools

Two more tool endpoints, behind the same `x-vapi-tool-secret` header:

| Endpoint | Vapi tool name |
| --- | --- |
| `POST /api/vapi/tools/appointment-request` | `create_appointment_request` |
| `POST /api/vapi/tools/callback-request` | `create_callback_request` |

> **These create requests, not bookings.** Nothing in this backend can confirm
> an appointment. A row is written with `status = 'pending'` and stays there
> until someone at the shop acts on it. The wording returned to the assistant
> says so explicitly, so it should never tell a caller they are booked in.
> There is no calendar integration and no availability checking.

#### `create_appointment_request`

```json
{
  "businessId": "demo-shop",
  "customer": { "name": "Dana", "phone": "+14085551234" },
  "vehicle": { "year": 2019, "make": "Toyota", "model": "Camry" },
  "service": "front_brake_pads",
  "problemDescription": "grinding noise when braking",
  "preferredDate": "2026-08-25",
  "preferredTimeText": "morning"
}
```

Every field is optional except that the request must carry **enough to be
useful**: a `service` *or* a `problemDescription`, **and** a `preferredDate`
*or* a `preferredTimeText`. A request with neither a reason to come in nor any
idea of when is worse than no request at all, so it is refused with a
tool-level error the assistant can act on.

`preferredDate` must be a real `YYYY-MM-DD` date. `preferredTimeText` is free
text on purpose — "morning", "after work", "around 2 PM" — and is stored
verbatim. **It is never interpreted into a real time.**

The result:

```json
{
  "requestId": "...",
  "status": "pending",
  "message": "Appointment request recorded. The shop still needs to confirm it, so it is not booked yet.",
  "preferredDate": "2026-08-25",
  "preferredTimeText": "morning"
}
```

#### `create_callback_request`

```json
{
  "businessId": "demo-shop",
  "customer": { "name": "Dana", "phone": "+14085551234" },
  "reason": "Wants to discuss the quote",
  "preferredCallbackAt": "2026-08-20T14:00:00Z"
}
```

Everything is optional. `preferredCallbackAt`, if given, must be an ISO
datetime **including a timezone** — a time without one is ambiguous, and
guessing a zone would store the wrong instant.

The result reports `status: "pending"` and says the request is waiting on the
shop. It never suggests anyone has called back yet.

#### Requests and customers

Callers are matched exactly as they are for calls: by business and phone
number, reusing an existing customer, creating one only when there is a real
phone number, and filling in a missing name without ever replacing one. **No
phone number means `customer_id` stays null** — no caller is invented.

If the tool payload carries `message.call.id` it is stored as `vapi_call_id`,
which lets the end-of-call report find the requests made during that call and
fill in their `customer_id`.

#### Retries

Vapi may retry a tool call. Both tables have a partial unique index on
`vapi_tool_call_id`, and a retry with the same tool call id returns the
**original** `requestId` instead of creating a second row.

### Vapi events endpoint (end-of-call reports)

`POST /api/vapi/events` receives Vapi's server events. It uses the **same**
`x-vapi-tool-secret` header as the tool endpoint — there is one shared secret,
not two.

Only `end-of-call-report` is acted on. Any other event type is acknowledged and
dropped, so you can point all of Vapi's server events here safely:

```json
{ "status": "ignored" }
```

A stored report returns:

```json
{ "status": "ok" }
```

#### What a completed call stores

| Table | What happens |
| --- | --- |
| `calls` | One row: Vapi call id, business, caller phone, start/end times, ended reason, transcript, summary, outcome, follow-up flag |
| `customers` | The caller, matched or created — **only when a phone number is present** |
| `estimates` | Estimates made during the call get their `customer_id` filled in, if it was blank |
| `appointment_requests` / `callback_requests` | Same backfill: requests made during the call get their `customer_id` filled in, if it was blank |

#### Customer matching

Conservative by design:

1. **No phone number** → no customer is created and `customer_id` stays null.
   A caller is never invented to satisfy the schema.
2. **Phone matches an existing customer** for that business → that customer is
   reused.
3. **No match** → a new customer is created from the phone and, if Vapi
   supplied one, the name.

A name is only ever *filled in* when the stored one is null. An existing name
is never overwritten automatically.

#### Repeated reports

Vapi retries server events. `calls.vapi_call_id` is unique and the write is an
upsert, so a repeated report **updates the existing row** rather than adding a
second one. `created_at` keeps its original value. Sending the same report ten
times leaves exactly one call row.

If the write fails, the endpoint returns **HTTP 500** — that tells Vapi the
report was not recorded so it can retry, which is safe precisely because the
write is idempotent.

#### Call outcome

Deterministic, never a guess:

| Outcome | When |
| --- | --- |
| `estimate_provided` | An estimate from this call is in the database |
| `callback_requested` | A callback request row exists for this call |
| `appointment_requested` | An appointment request row exists for this call |
| `unresolved` | The ended reason indicates the call broke (errors, timeouts) |
| `callback_requested` | *(fallback)* The transcript contains an explicit phrase like "call me back" |
| `information_only` | There is a transcript and none of the above applies |
| `unknown` | Not enough information |

Rows beat words: a stored estimate or request settles the outcome outright, and
the phrase heuristic is only consulted when no structured request exists.

`requires_follow_up` is true for `callback_requested`, `appointment_requested`,
and `unresolved` — false otherwise. There is no sentiment analysis and no
urgency detection.

#### Pointing Vapi at this endpoint

Once the server is reachable (via ngrok or a deployment), in the Vapi
dashboard set the assistant's **Server URL** to:

```
https://<your-host>/api/vapi/events
```

and add the custom header `x-vapi-tool-secret` with your `VAPI_TOOL_SECRET`
value. Enable the `end-of-call-report` server message. For summaries, also
enable Vapi's post-call analysis — this backend never calls an LLM to write
one, and stores `null` when Vapi does not supply one.

> **Privacy note.** Call and request records contain personal information:
> phone numbers, names, everything said on the call, what is wrong with
> someone's car, and why they want a call back. The `calls`, `customers`,
> `appointment_requests`, and `callback_requests` tables all have row level
> security enabled with no policies, so only the server's secret key can read
> them. Failure logs deliberately record only ids, the step, the database error
> code, and the business — never a phone number, name, transcript, problem
> description, or callback reason. Treat a database backup as personal data.
>
> **Never expose `SUPABASE_SECRET_KEY` or `VAPI_TOOL_SECRET`.** Both are
> server-side only. Neither belongs in a browser, a frontend build, a log line,
> a screenshot, or a commit.

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
    estimates.ts          # estimate queries
    calls.ts               # call and customer queries
    requests.ts            # appointment + callback request queries
  scripts/
    check-db.ts           # manual connection check (npm run db:check)
  middleware/
    vapiAuth.ts          # shared-secret check for the Vapi endpoint
    errors.ts             # JSON 404 / 500 handling, no stack traces
  calls/
    normalize.ts         # end-of-call payload -> flat record, outcome rules
  routes/
    vapiToolCall.ts      # shared Vapi tool-call envelope handling
    vapiRequests.ts       # appointment + callback request tools
    estimate.ts          # POST /api/estimate route handler
    estimate.test.ts      # HTTP-level tests for the route
    health.ts             # GET /health route handler
    health.test.ts         # test for the health check
    vapi.ts                # POST /api/vapi/tools/estimate (Vapi adapter)
    vapi.test.ts            # tests for the Vapi adapter
    vapiEvents.ts            # POST /api/vapi/events (end-of-call reports)
  schemas/
    estimate.ts          # Zod schema for validating the request body
    vapi.ts               # Zod schema for the Vapi tool-call envelope
    vapiEvents.ts          # Zod schema for Vapi server events
    requests.ts             # Zod schemas for appointment/callback input
  pricing/
    catalog.ts            # hardcoded price ranges per service
    estimate.ts            # pure pricing logic (no Express, no HTTP)
    estimate.test.ts        # unit tests for the pricing logic
```

## What's intentionally not here yet

- Confirmed bookings and calendar integration (requests are captured, but
  nothing checks availability or confirms anything)
- SMS (Twilio)
- Calendar booking (Google Calendar)
- Authentication on `POST /api/estimate` (the Vapi tool endpoint *is* protected)
- Frontend

These will be added in later phases.
