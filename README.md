# AI Mechanic-Shop Receptionist

Backend API for an AI receptionist that gives customers a preliminary price
estimate for common auto services.

This is **phase 1**: a single endpoint, `POST /api/estimate`, backed by a
hardcoded pricing catalog. There is no database, no phone/voice integration,
and no authentication yet — those come later.

## Requirements

- [Node.js](https://nodejs.org/) version 20 or newer (check with `node -v`)
- npm (comes with Node.js)

## 1. Install dependencies

From the project root, run:

```bash
npm install
```

This downloads everything listed in `package.json` into a `node_modules/`
folder.

## 2. Set up your environment file

Copy the example env file. No real secrets are needed yet, but this keeps the
project ready for when they are:

```bash
cp .env.example .env
```

## 3. Run the server

For local development (auto-restarts when you edit a file):

```bash
npm run dev
```

You should see:

```
Mechanic-shop receptionist API listening on port 3000
```

## 4. Try it out

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

`POST /api/vapi/tools/estimate` is an adapter for a Vapi custom tool. It speaks
Vapi's envelope format, but it does **not** calculate anything itself — it
calls the exact same pricing code as `POST /api/estimate`, so both routes
always agree on price.

It answers one tool, `calculate_estimate`. The tool arguments are the same
shape as the normal estimate request body.

```bash
curl -X POST http://localhost:3000/api/vapi/tools/estimate \
  -H "Content-Type: application/json" \
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

## Running tests

```bash
npm test
```

This runs the unit tests (pricing logic) and the API route tests (using
`supertest` to send real HTTP requests to the app in-memory).

## Type-checking

```bash
npm run typecheck
```

## Project structure

```
src/
  index.ts              # starts the HTTP server
  app.ts                # builds the Express app (used by both index.ts and tests)
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

- Database / persistence
- Voice integration (Vapi)
- Phone integration (Twilio)
- Calendar booking (Google Calendar)
- Authentication
- Frontend

These will be added in later phases.
