# AI Mechanic-Shop Receptionist

Backend API for an AI receptionist that gives customers a preliminary price
estimate for common auto services.

Prices come from each shop's own configuration, estimates are stored in Supabase, and a
Vapi voice assistant can request one during a call. The assistant can also
record appointment and callback **requests** — which the shop still has to act
on, since nothing here confirms a booking — and the shop is texted when one
arrives. All Vapi endpoints are protected by a shared secret. There is no
calendar or frontend yet.

## Requirements

- [Node.js](https://nodejs.org/) version 20 or newer (check with `node -v`)
- npm (comes with Node.js)
- A [Supabase](https://supabase.com) project (the free tier is fine)
- A [Twilio](https://www.twilio.com/) account with an SMS-capable number —
  optional; without it everything works except sending texts

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
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info (a credential) |
| `TWILIO_FROM_NUMBER` | An SMS-capable Twilio number, E.164 (`+14155550123`) |
| `SHOP_NOTIFICATION_NUMBER` | Fallback for shop alerts, E.164 — optional |
| `SMS_ENABLED` | `true` or `false` — **defaults to `false`** |

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

> **⚠️ Never commit `SUPABASE_SECRET_KEY` or `TWILIO_AUTH_TOKEN`.**
> The Supabase key bypasses row level security and can read and write your
> entire database; the Twilio token can send messages and spend money. Both are
> server-side only: never put them in a browser, a frontend build, a log line,
> or an API response. `.env` is gitignored — keep it that way. If either leaks,
> rotate it immediately in the relevant dashboard.

The server refuses to start if `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, or
`VAPI_TOOL_SECRET` is missing, and tells you which ones.

**SMS is off unless you turn it on.** `SMS_ENABLED` defaults to `false`, and
having Twilio credentials set is *not* enough on its own — the switch must say
`true`. Anything other than `true` or `false` stops the server with a clear
message rather than being guessed at.

**The four Twilio variables are optional.** Without them the server starts
normally; estimates, calls, appointment requests, and callback requests all
keep working. `npm run db:check` never needs them.

Startup says which state you are in:

| State | At startup | Notification results |
| --- | --- | --- |
| `SMS_ENABLED=false` | `SMS notifications are disabled.` | `disabled` |
| `SMS_ENABLED=true`, credentials missing | a warning naming the missing variables | `not_configured` |
| `SMS_ENABLED=true`, credentials present | nothing | `sent` / `failed` |

A missing or broken SMS setup never takes the receptionist down: the phone line
keeps working and requests keep being recorded.

### Twilio setup

1. Create a [Twilio](https://www.twilio.com/) account.
2. Buy or use an **SMS-capable** phone number — that becomes
   `TWILIO_FROM_NUMBER`.
3. Copy the Account SID and Auth Token from the console.
4. Set `SHOP_NOTIFICATION_NUMBER` to the shop's mobile — the fallback number
   for alerts. It is not a caller's number, and a shop's own
   `notification_phone` takes precedence over it.
5. On a Twilio trial account you can only text **verified** numbers, so verify
   the shop number before testing.

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
supabase/migrations/20260819000300_notifications.sql
supabase/migrations/20260819000400_sms_consent.sql
supabase/migrations/20260819000500_business_config.sql
```

These add the `calls` table, let an estimate remember which call produced it,
add `appointment_requests` and `callback_requests`, add `notifications`, and
add the SMS consent columns, and add the per-shop configuration tables. All
are safe to run more than once.

## 4. Check the database connection

```bash
npm run db:check
```

This confirms the credentials work, that `demo-shop` exists, and that the
`estimates`, `calls`, `appointment_requests`, `callback_requests`, and
`notifications` tables are reachable, with counts and the five most recent rows
of each. It also prints the demo shop's configuration: whether it is active,
its timezone, how many hours rows it has, and its services with prices. It
needs Supabase but **not** Twilio.

It prints no secrets and **no personal information** — calls are listed by
Vapi call id, outcome, and follow-up flag, and requests by id and status only.
Notifications are listed by type, recipient, and status, and a shop's
notification phone is reported only as configured or not. Never a phone number,
name, transcript, problem description, reason, or message text. Nothing runs it
automatically.

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
`"demo-shop"`. It now decides which prices apply — see
[Business configuration](#business-configuration).

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

### SMS notifications

When a request is stored, the shop is texted. The caller is texted **only if
they explicitly agreed on the call**.

> **⚠️ A request can be recorded even when SMS delivery fails.** Storing the
> request is the real action; texting is a notification about it. A failed
> message never deletes, rolls back, or invalidates a request — it is recorded
> as `failed` in `notifications` and the tool still reports the request as
> recorded. If Twilio is down, requests keep arriving and the shop must check
> the system rather than rely on the alert.

#### Shop alerts

Sent to `SHOP_NOTIFICATION_NUMBER` for every appointment and callback request.
They carry the vehicle, service or problem, preferred date/time, and — because
the shop is the intended recipient and needs to ring people back — the caller's
name and number when known. They never contain a transcript, and they never
describe anything as booked or confirmed.

#### Caller confirmations are opt-in

Both tools take an optional `customerSmsConsent` boolean, defaulting to
`false`. A text is sent to the caller **only** when all of these hold:

1. `customerSmsConsent` is `true`
2. a phone number was supplied
3. the request was stored successfully

**Having someone's phone number is not consent, and neither is silence.** The
assistant must set this to `true` only after the caller explicitly says yes on
that call.

When it is `true`, the server records evidence on the request row:

| Column | Value |
| --- | --- |
| `customer_sms_consent` | `true` |
| `customer_sms_consent_at` | the **server's** timestamp |
| `customer_sms_consent_method` | `voice` |
| `customer_sms_consent_scope` | `request_confirmation` |

The timestamp, method, and scope are decided by the server and cannot be set by
the tool — a caller-supplied "I consented at 9am" would be worthless as proof.
When consent is not given, the flag is `false` and the other three stay null. A
database constraint enforces both directions: `true` must carry all three, and
`false` must carry none of them, so a row can never keep stale evidence of a
consent that no longer applies.

Consent is recorded even when SMS is switched off, so turning it on later does
not retrospectively invent permission.

> **What this consent covers.** One confirmation text, about the one request it
> was given for. It is **not** marketing consent, **not** account-wide, **not**
> consent for future requests, and **not** consent for any other kind of
> message. Nothing in this system reuses it.

Caller-facing wording:

- **Appointment** — *"Demo Auto Repair: We received your appointment request
  for 2026-08-25 morning. This is not a confirmed appointment. The shop will
  follow up to confirm."*
- **Callback** — *"Demo Auto Repair: We received your callback request. It is
  pending until someone from the shop follows up."* A preferred time is echoed
  back as a preference, never as a promise.

#### Notification status in the tool result

```json
{
  "requestId": "...",
  "status": "pending",
  "message": "Appointment request recorded. The shop still needs to confirm it, so it is not booked yet.",
  "shopNotification": "sent",
  "customerConfirmation": "not_requested"
}
```

| Value | Meaning |
| --- | --- |
| `sent` | The provider accepted the message |
| `failed` | Delivery was attempted and rejected |
| `not_requested` | The caller did not consent (customer only) |
| `no_phone` | Consent given but no number (customer only) |
| `disabled` | `SMS_ENABLED` is not `true`; nothing was attempted |
| `not_configured` | SMS is on but Twilio is not set up; nothing was attempted |

Consent always takes precedence over the delivery state: no consent gives
`not_requested`, and consent without a phone number gives `no_phone`.
`disabled` and `not_configured` appear only when a message would otherwise
have been sent. **`failed` is never used for something deliberately switched
off.**

**Only `sent` means a text went out.** The assistant must never tell a caller a
confirmation was sent unless `customerConfirmation` is exactly `sent`.

#### Vapi dashboard: add the consent parameter

Add one optional boolean parameter to **both** existing tools:

```
customerSmsConsent   boolean   optional
```

Description to give the model: *"True only if the caller explicitly agreed to
receive a confirmation text about this request. Never infer this from the fact
that you have their phone number."*

`calculate_estimate` is unchanged.

#### Assistant rules worth adding to the system prompt

- When you have a phone number and it feels natural, you may ask: *"Would you
  like a text confirming that I recorded the request?"*
- Set `customerSmsConsent=true` **only** after an explicit yes. A phone number
  is not consent, and silence is not consent.
- Never pressure the caller. If they say no, carry on normally — consent is not
  needed to save the request.
- Do not ask at all when the caller clearly wants to end the call quickly.
- Never say a confirmation text was sent unless the tool result shows
  `customerConfirmation` exactly equal to `sent`.
- Never say an appointment is booked or confirmed. It is a request.

#### Notification idempotency

A `notifications` row is claimed **before** the message is sent, and unique
indexes allow one notification per request per type. A retried tool call loses
that race and reports what the first attempt achieved instead of texting
anybody a second time.

#### What notifications store

Only that a message was attempted and how it went: business, request id, Vapi
call id, recipient type, channel, notification type, status, provider,
provider message id, and the provider's error code. **No message text and no
phone numbers** — those live on the request and customer rows already, and
duplicating them would spread personal data further for no benefit.

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
> description, callback reason, or the text of any SMS. Treat a database backup
> as personal data.
>
> **Never expose `SUPABASE_SECRET_KEY`, `VAPI_TOOL_SECRET`, or
> `TWILIO_AUTH_TOKEN`.** All three are server-side only.
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

## Business configuration

Everything that varies between shops lives in the database rather than in the
code: prices, opening hours, timezone, and where alerts are sent. The same
backend can therefore serve more than one shop without a code change.

This is **not** multi-tenant SaaS. There is no onboarding, no tenant login, and
no automatic routing. A second shop is added by inserting rows.

### Where configuration lives

| Table | Holds |
| --- | --- |
| `businesses` | Name, phone, timezone, address, after-hours message, `is_active`, `notification_phone` |
| `business_hours` | One row per weekday: open/close times, or closed |
| `business_services` | What the shop offers and charges, per service key |

`demo-shop` remains the default when a request omits `businessId`, so existing
callers keep working unchanged.

### Pricing comes from `business_services`

There are no prices in the application code any more. A request resolves the
shop, then that shop's row for the requested service, and prices from it.

The migration seeds `demo-shop` with **exactly** the prices the old hardcoded
catalog used, so nothing changed for anybody:

| Service key | Price |
| --- | --- |
| `synthetic_oil_change` | $80–$120 |
| `front_brake_pads` | $300–$450 |
| `battery_replacement` | $190–$340 |
| `diagnostic` | $149–$149 |
| `tire_rotation` | $40–$60 |

**A service is unavailable** when the shop has no row for that key, or has one
with `is_active = false`. Both give the caller the same answer — we cannot
quote for that — with the shop's actual services listed instead.

**An inactive business** (`is_active = false`) is refused before anything is
priced or stored. So is an unknown one. A `businessId` is no longer just a
string that fails later.

### Deterministic pricing is preserved

The split that matters:

```
resolveServicePricing(businessId, service)   ← database
        ↓
buildEstimate(vehicle, pricing)              ← pure, no I/O
```

`buildEstimate()` does no lookups, reads no clock, and touches no database.
Give it the same pricing and vehicle and it returns the same estimate every
time. `src/pricing/` imports nothing from `src/db/` — there is a test that
reads the source files and fails if it ever does.

`getEstimate()` still exists and still prices from the built-in catalog. It is
the reference catalog a new shop is seeded from, and the simplest way to
exercise the calculation; live requests do not use it.

### Business hours

Times are wall-clock times in the shop's own `timezone`, handled with the
platform's `Intl` support — no dependency, and daylight saving is handled for
you.

- `open_time` is **inclusive**: at exactly 08:00 the shop is open.
- `close_time` is **exclusive**: at exactly 17:00 the shop is closed. Better
  than promising someone a slot at the moment the doors lock.
- A day with no row is treated as **closed**. Silence is not an invitation.

`isBusinessOpenAt(hours, timestamp, timezone)` is pure and takes the hours it
needs, so every awkward case is testable without a database or a fake clock.

**Not supported in this phase, deliberately:** overnight shifts (a close time
earlier than the open time), split shifts, and holiday overrides. One row per
day cannot say which day a 02:00 closing belongs to, and guessing would produce
a shop that claims to be open at 3am — such a row is treated as closed.

### Where shop alerts go

Most specific wins:

1. `businesses.notification_phone` for that shop
2. the global `SHOP_NOTIFICATION_NUMBER` fallback
3. neither → `not_configured`, and nothing is attempted

`SHOP_NOTIFICATION_NUMBER` is therefore now optional rather than a required
credential. Caller confirmations are unaffected — they go to the caller.

### Adding a second shop

By hand, for now. Nothing in the tests depends on this:

```sql
insert into businesses (id, name, timezone, notification_phone)
values ('second-shop', 'Second Auto Repair', 'America/New_York', null);

insert into business_hours (business_id, day_of_week, open_time, close_time, is_closed)
values
  ('second-shop', 0, null, null, true),
  ('second-shop', 1, '09:00', '18:00', false),
  ('second-shop', 2, '09:00', '18:00', false),
  ('second-shop', 3, '09:00', '18:00', false),
  ('second-shop', 4, '09:00', '18:00', false),
  ('second-shop', 5, '09:00', '18:00', false),
  ('second-shop', 6, '09:00', '13:00', false);

insert into business_services
  (business_id, service_key, display_name, low_price, high_price, disclaimer)
values
  ('second-shop', 'front_brake_pads', 'Front Brake Pads', 320, 480,
   'Final pricing is subject to vehicle inspection.');
```

Then send `"businessId": "second-shop"` with the request.

### Generated assistant configuration

The backend can turn a shop's database configuration into the assistant
configuration for that shop — its name, greeting, system prompt, service list,
and hours:

```
demo-shop    →  Demo Auto Repair Receptionist
joes-garage  →  Joe's Garage Receptionist
```

Same generator, different rows. Nothing about the demo shop is written into the
code.

Preview what a shop would get:

```bash
npm run assistant:preview -- demo-shop
```

It prints the assistant name, service count, timezone, first message, and
system prompt. Read-only, and it publishes nothing.

#### Business configuration vs. provider configuration

Two different things, kept apart on purpose:

- **Business configuration** is what this shop's receptionist should say and
  know — the name, greeting, prompt, services, hours. That is what the
  generator produces.
- **Provider configuration** is how Vapi happens to want that expressed —
  model, voice, transcriber, tool attachment, phone numbers. None of that is
  modelled here.

The generated object is deliberately *not* a Vapi API object. Translating it
into one is a separate concern, so the interesting part stays reviewable
without knowing anything about Vapi.

#### The generator is pure

```
loadBusinessAssistantConfig(businessId)   ← database
        ↓
buildBusinessAssistantConfig({business, hours, services})   ← pure, no I/O
```

`buildBusinessAssistantConfig()` has no database access, no network, no
environment, no clock, and no randomness. The same shop configuration always
produces byte-identical output, so a generated prompt can be reviewed and
diffed rather than guessed at. There is a test that reads the source file and
fails if it ever gains an import.

The loader reuses the same queries pricing uses, so "this shop" means one thing
everywhere. An unknown or inactive shop produces no configuration at all, and
an explicit `businessId` is never quietly swapped for the default.

#### What the prompt contains

`businessId` is stated explicitly — *"On EVERY backend tool call you must send
`businessId = "joes-garage"`"* — rather than left to the tool description. That
line is currently the whole bridge between an assistant and the shared backend.

Services come from `business_services`, listed by display name for the caller
and mapped to tool keys for the model:

```
SUPPORTED ESTIMATE SERVICES
- Front Brake Pads

SERVICE TOOL KEYS
- Front Brake Pads -> front_brake_pads
```

Hours come from `business_hours`, with runs of identical days collapsed:

```
BUSINESS HOURS
Monday-Friday: 8:00 AM-5:00 PM
Saturday: Closed
Sunday: Closed
Timezone: America/Los_Angeles
```

This is descriptive only — the generator never works out whether the shop is
open *right now*, and never reads the clock. A shop with no services still gets
a valid prompt saying pricing is unavailable, and days with no configuration
are left out rather than invented.

The prompt also carries the behavioural rules: no invented prices, preliminary
estimates only, an appointment request is not a booking, a callback is pending,
explicit SMS consent, no duplicate tool calls, no claiming success before the
tool says so, and the safety rules.

> **⚠️ The live assistant is still configured by hand.** This phase only
> generates configuration locally. Nothing is published to Vapi, so editing a
> shop's rows changes what *would* be generated, not what the assistant
> currently says. Remote provisioning is Phase 10B.

### Deferred on purpose

- **Publishing to Vapi.** The assistant configuration is generated locally but
  never sent anywhere. Creating and updating assistants, attaching tools, and
  provisioning numbers is Phase 10B.
- **Dynamic Vapi tool schemas.** The assistant's `calculate_estimate` tool
  still carries a fixed service enum for demo testing. The backend stays the
  authority: a service the shop does not offer is refused regardless of what
  the tool schema allows.
- **Knowing whether the shop is open right now.** `isBusinessOpenAt()` exists
  and is tested, but the generator is descriptive and never consults it.
- Holiday hours, multi-location, and tenant authentication.

## Pricing vs. persistence

These are two separate steps, and keeping them separate is deliberate.

**Pricing is deterministic.** `buildEstimate()` in `src/pricing/estimate.ts`
turns already-resolved pricing into an estimate. It has no database access, no
clock, and no randomness: the same pricing and vehicle always produce the same
numbers, which makes it easy to test and impossible for an outage to change a
price. Which prices apply is settled beforehand, from the shop's own
configuration.

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
    notifications.ts        # notification log queries
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
- Marketing or bulk SMS — messages are strictly transactional
- Inbound SMS and STOP handling (Twilio handles STOP at the account level, but
  this system will not know a caller opted out)
- Retrying a failed SMS (failures are recorded, nothing retries them)
- SMS (Twilio)
- Calendar booking (Google Calendar)
- Authentication on `POST /api/estimate` (the Vapi tool endpoint *is* protected)
- Frontend

These will be added in later phases.
