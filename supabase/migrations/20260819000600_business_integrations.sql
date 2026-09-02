-- Phase 10B: which remote assistant belongs to which shop.
--
-- One Vapi assistant per business. The mapping lives here rather than on the
-- businesses table, so a second provider could be added later without
-- reshaping a table everything else depends on.
--
-- Safe to run more than once.

create table if not exists business_integrations (
  id           uuid primary key default gen_random_uuid(),
  business_id  text not null references businesses (id),
  provider     text not null check (provider in ('vapi')),
  -- The provider's own id for the thing, e.g. a Vapi assistant id. An
  -- identifier, not a credential.
  external_id  text not null,
  status       text not null default 'active'
    check (status in ('active', 'disabled', 'error')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- A shop has at most one assistant per provider, so a repeated sync can
  -- only ever target the assistant it targeted last time.
  constraint business_integrations_business_provider_key
    unique (business_id, provider),
  -- And no two shops may point at the same remote assistant, which would let
  -- one shop's sync quietly rewrite another shop's receptionist.
  constraint business_integrations_provider_external_key
    unique (provider, external_id)
);

create index if not exists business_integrations_business_id_idx
  on business_integrations (business_id);
create index if not exists business_integrations_status_idx
  on business_integrations (status);

-- Same rule as every other table: no policies, so only the server's secret
-- key can read or write.
alter table business_integrations enable row level security;
