-- Phase 8: a record of every SMS the system tried to send.
--
-- Deliberately holds no message text and no phone numbers. The request and
-- customer rows already carry that, and duplicating it here would spread
-- personal data across another table for no benefit.
--
-- Safe to run more than once.

create table if not exists notifications (
  id                      uuid primary key default gen_random_uuid(),
  business_id             text not null references businesses (id),
  vapi_call_id            text,
  appointment_request_id  uuid references appointment_requests (id),
  callback_request_id     uuid references callback_requests (id),
  recipient_type          text not null
    check (recipient_type in ('shop', 'customer')),
  channel                 text not null
    check (channel in ('sms')),
  notification_type       text not null
    check (notification_type in (
      'appointment_request_shop',
      'appointment_request_customer',
      'callback_request_shop',
      'callback_request_customer'
    )),
  status                  text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  provider                text,
  provider_message_id     text,
  -- The provider's own error code, e.g. Twilio's 21211. Never an exception dump.
  error_code              text,
  created_at              timestamptz not null default now(),
  sent_at                 timestamptz
);

create index if not exists notifications_business_id_idx on notifications (business_id);
create index if not exists notifications_status_idx on notifications (status);
create index if not exists notifications_created_at_idx on notifications (created_at desc);
create index if not exists notifications_vapi_call_id_idx
  on notifications (vapi_call_id)
  where vapi_call_id is not null;

-- One notification of each kind per request. A retried Vapi tool call returns
-- the original request, and these indexes stop it texting anybody twice.
create unique index if not exists notifications_appointment_type_key
  on notifications (appointment_request_id, notification_type)
  where appointment_request_id is not null;

create unique index if not exists notifications_callback_type_key
  on notifications (callback_request_id, notification_type)
  where callback_request_id is not null;

alter table notifications enable row level security;
