-- Phase 5: tables for storing estimates.
--
-- Safe to run more than once: everything uses "if not exists" or
-- "on conflict do nothing".

create table if not exists businesses (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists customers (
  id           uuid primary key default gen_random_uuid(),
  business_id  text not null references businesses (id),
  name         text,
  phone        text,
  created_at   timestamptz not null default now()
);

create table if not exists vehicles (
  id           uuid primary key default gen_random_uuid(),
  business_id  text not null references businesses (id),
  -- Null until we can identify the caller. See customers above.
  customer_id  uuid references customers (id),
  year         integer not null,
  make         text not null,
  model        text not null,
  created_at   timestamptz not null default now()
);

create table if not exists estimates (
  -- Supplied by the application (crypto.randomUUID), not generated here, so
  -- the id in the API response is the id in the database.
  id                 uuid primary key,
  business_id        text not null references businesses (id),
  customer_id        uuid references customers (id),
  vehicle_id         uuid not null references vehicles (id),
  service            text not null,
  low_price          integer not null,
  high_price         integer not null,
  currency           text not null default 'USD',
  disclaimer         text not null,
  -- 'api' for POST /api/estimate, 'vapi' for the Vapi tool endpoint.
  source             text not null,
  vapi_tool_call_id  text,
  created_at         timestamptz not null default now()
);

-- If Vapi retries a tool call it reuses the same tool call id, so this stops a
-- retry from creating a second estimate. Partial, because plain API estimates
-- have no tool call id and many of them can be null at once.
create unique index if not exists estimates_vapi_tool_call_id_key
  on estimates (vapi_tool_call_id)
  where vapi_tool_call_id is not null;

-- Handy for the verification script and for looking at recent activity.
create index if not exists estimates_created_at_idx on estimates (created_at desc);

-- The demo shop every request falls back to today.
insert into businesses (id, name)
values ('demo-shop', 'Demo Auto Repair')
on conflict (id) do nothing;

-- Row level security is on with no policies, so the anon/publishable key can
-- read nothing. The server uses the secret key, which bypasses RLS. Add
-- policies later if a browser ever needs direct access.
alter table businesses enable row level security;
alter table customers  enable row level security;
alter table vehicles   enable row level security;
alter table estimates  enable row level security;
