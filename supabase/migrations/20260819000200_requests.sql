-- Phase 7: appointment and callback requests.
--
-- These are REQUESTS, not bookings. Nothing here confirms anything: a row
-- starts as 'pending' and only the shop can move it on.
--
-- Safe to run more than once.

create table if not exists appointment_requests (
  id                   uuid primary key default gen_random_uuid(),
  business_id          text not null references businesses (id),
  customer_id          uuid references customers (id),
  -- Vapi's id for the call this was asked for on, when the tool payload had one.
  vapi_call_id         text,
  -- The tool call that created this row, used to recognise a Vapi retry.
  vapi_tool_call_id    text,
  vehicle_year         integer,
  vehicle_make         text,
  vehicle_model        text,
  service              text,
  problem_description  text,
  preferred_date       date,
  -- Free text on purpose: "morning", "after work", "around 2 PM". Never
  -- interpreted into a real time by this backend.
  preferred_time_text  text,
  status               text not null default 'pending'
    check (status in ('pending', 'confirmed', 'declined', 'cancelled')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists appointment_requests_business_id_idx
  on appointment_requests (business_id);
create index if not exists appointment_requests_status_idx
  on appointment_requests (status);
create index if not exists appointment_requests_created_at_idx
  on appointment_requests (created_at desc);
create index if not exists appointment_requests_vapi_call_id_idx
  on appointment_requests (vapi_call_id)
  where vapi_call_id is not null;

-- A retried tool call carries the same id, so this stops it creating a second
-- request. Partial, because rows created outside Vapi have no tool call id.
create unique index if not exists appointment_requests_vapi_tool_call_id_key
  on appointment_requests (vapi_tool_call_id)
  where vapi_tool_call_id is not null;

create table if not exists callback_requests (
  id                     uuid primary key default gen_random_uuid(),
  business_id            text not null references businesses (id),
  customer_id            uuid references customers (id),
  vapi_call_id           text,
  vapi_tool_call_id      text,
  reason                 text,
  preferred_callback_at  timestamptz,
  status                 text not null default 'pending'
    check (status in ('pending', 'completed', 'cancelled')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists callback_requests_business_id_idx
  on callback_requests (business_id);
create index if not exists callback_requests_status_idx
  on callback_requests (status);
create index if not exists callback_requests_created_at_idx
  on callback_requests (created_at desc);
create index if not exists callback_requests_vapi_call_id_idx
  on callback_requests (vapi_call_id)
  where vapi_call_id is not null;

create unique index if not exists callback_requests_vapi_tool_call_id_key
  on callback_requests (vapi_tool_call_id)
  where vapi_tool_call_id is not null;

-- Both tables hold what a caller said they wanted, which is personal
-- information. No policies, so only the server's secret key can read them.
alter table appointment_requests enable row level security;
alter table callback_requests    enable row level security;
