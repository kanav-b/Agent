-- Phase 6: records of completed Vapi calls.
--
-- Safe to run more than once.

create table if not exists calls (
  id                  uuid primary key default gen_random_uuid(),
  business_id         text not null references businesses (id),
  -- Vapi's own id for the call. Unique, so a retried end-of-call report
  -- updates the existing row instead of adding a second one.
  vapi_call_id        text not null unique,
  -- Null when the caller could not be identified. Never a placeholder.
  customer_id         uuid references customers (id),
  caller_phone        text,
  started_at          timestamptz,
  ended_at            timestamptz,
  ended_reason        text,
  transcript          text,
  summary             text,
  -- estimate_provided | callback_requested | information_only | unresolved | unknown
  outcome             text,
  requires_follow_up  boolean not null default false,
  created_at          timestamptz not null default now()
);

create index if not exists calls_business_id_idx on calls (business_id);
create index if not exists calls_created_at_idx on calls (created_at desc);

-- Same rule as every other table: no policies, so only the server's secret
-- key can read or write. Call rows hold personal information, so this matters
-- more here than anywhere else in the schema.
alter table calls enable row level security;
