-- Phase 9: configuration that used to live in code moves into the database, so
-- the same backend can serve more than one shop.
--
-- Nothing here changes anybody's prices: demo-shop is seeded with exactly the
-- values the hardcoded catalog already used.
--
-- Safe to run more than once. Seeds use "on conflict do nothing" so a rerun
-- never overwrites a shop's own edits.

-- ---------------------------------------------------------------- businesses

alter table businesses
  add column if not exists phone text,
  -- Where shop alerts are sent. Falls back to SHOP_NOTIFICATION_NUMBER.
  add column if not exists notification_phone text,
  add column if not exists timezone text not null default 'America/Los_Angeles',
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text not null default 'US',
  add column if not exists after_hours_message text,
  add column if not exists is_active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

-- ------------------------------------------------------------ business_hours

create table if not exists business_hours (
  id           uuid primary key default gen_random_uuid(),
  business_id  text not null references businesses (id),
  -- 0 = Sunday through 6 = Saturday.
  day_of_week  integer not null check (day_of_week between 0 and 6),
  -- Local wall-clock times, read in the business's own timezone.
  open_time    time,
  close_time   time,
  is_closed    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- The times must agree with the flag, in both directions. A closed day
  -- carries no times at all, and an open day carries a real window: this
  -- rejects overnight hours, zero-length hours, and closed rows that still
  -- have times left on them.
  constraint business_hours_times_chk check (
    (is_closed = true and open_time is null and close_time is null)
    or (
      is_closed = false
      and open_time is not null
      and close_time is not null
      and open_time < close_time
    )
  ),
  constraint business_hours_day_key unique (business_id, day_of_week)
);

create index if not exists business_hours_business_id_idx on business_hours (business_id);

-- Applied separately as well as inline, because an earlier run of this file
-- may have created a looser version of the same constraint and "create table
-- if not exists" would leave it in place. Dropping first makes the file
-- converge on the definition above however many times it is run. The block is
-- one transaction, so the table is never left unguarded.
do $$
begin
  alter table business_hours drop constraint if exists business_hours_times_chk;

  alter table business_hours add constraint business_hours_times_chk check (
    (is_closed = true and open_time is null and close_time is null)
    or (
      is_closed = false
      and open_time is not null
      and close_time is not null
      and open_time < close_time
    )
  );
end $$;

alter table business_hours enable row level security;

-- --------------------------------------------------------- business_services

create table if not exists business_services (
  id            uuid primary key default gen_random_uuid(),
  business_id   text not null references businesses (id),
  -- The key the assistant sends, e.g. front_brake_pads.
  service_key   text not null,
  display_name  text not null,
  low_price     integer not null check (low_price >= 0),
  high_price    integer not null,
  currency      text not null default 'USD',
  disclaimer    text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint business_services_price_order_chk check (high_price >= low_price),
  constraint business_services_key_key unique (business_id, service_key)
);

create index if not exists business_services_business_id_idx on business_services (business_id);
create index if not exists business_services_active_idx
  on business_services (business_id, is_active);

alter table business_services enable row level security;

-- ------------------------------------------------------------ demo-shop seed
--
-- Demo data only. Every insert below is "on conflict do nothing", so editing
-- these rows and re-running this file leaves your edits alone.
--
-- Phone, address, and notification_phone are deliberately left null rather
-- than filled with invented values.

insert into businesses (id, name)
values ('demo-shop', 'Demo Auto Repair')
on conflict (id) do nothing;

-- Monday to Friday 08:00-17:00, weekends closed.
insert into business_hours (business_id, day_of_week, open_time, close_time, is_closed)
values
  ('demo-shop', 0, null, null, true),
  ('demo-shop', 1, '08:00', '17:00', false),
  ('demo-shop', 2, '08:00', '17:00', false),
  ('demo-shop', 3, '08:00', '17:00', false),
  ('demo-shop', 4, '08:00', '17:00', false),
  ('demo-shop', 5, '08:00', '17:00', false),
  ('demo-shop', 6, null, null, true)
on conflict (business_id, day_of_week) do nothing;

-- Exactly the prices the hardcoded catalog used, so nothing changes.
insert into business_services
  (business_id, service_key, display_name, low_price, high_price, currency, disclaimer)
values
  ('demo-shop', 'synthetic_oil_change', 'Synthetic Oil Change', 80, 120, 'USD',
   'Final pricing is subject to vehicle inspection.'),
  ('demo-shop', 'front_brake_pads', 'Front Brake Pads', 300, 450, 'USD',
   'Final pricing is subject to vehicle inspection.'),
  ('demo-shop', 'battery_replacement', 'Battery Replacement', 190, 340, 'USD',
   'Final pricing is subject to vehicle inspection.'),
  ('demo-shop', 'diagnostic', 'Diagnostic', 149, 149, 'USD',
   'Final pricing is subject to vehicle inspection.'),
  ('demo-shop', 'tire_rotation', 'Tire Rotation', 40, 60, 'USD',
   'Final pricing is subject to vehicle inspection.')
on conflict (business_id, service_key) do nothing;
