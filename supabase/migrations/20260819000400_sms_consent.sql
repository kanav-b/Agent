-- Phase 8.2: evidence that a caller agreed to a confirmation text.
--
-- Consent is recorded on the request it was given for, because that is all it
-- covers: this one confirmation, on this one request. It is not marketing
-- consent, not account-wide, and not consent for anything later.
--
-- No transcript text is stored as proof — only that consent was given, when,
-- how, and for what.
--
-- Safe to run more than once.

alter table appointment_requests
  add column if not exists customer_sms_consent boolean not null default false,
  add column if not exists customer_sms_consent_at timestamptz,
  add column if not exists customer_sms_consent_method text,
  add column if not exists customer_sms_consent_scope text;

alter table callback_requests
  add column if not exists customer_sms_consent boolean not null default false,
  add column if not exists customer_sms_consent_at timestamptz,
  add column if not exists customer_sms_consent_method text,
  add column if not exists customer_sms_consent_scope text;

-- Postgres has no "add constraint if not exists", and the constraints below
-- are worth keeping strict, so each one is added only when it is not already
-- there. Weakening them to make the syntax simpler would defeat the point.
do $$
declare
  target text;
begin
  foreach target in array array['appointment_requests', 'callback_requests'] loop

    -- The audit columns must agree with the flag, in both directions:
    -- consent given means all three are recorded; consent not given means all
    -- three are absent, so a row can never keep stale evidence of a consent
    -- that no longer applies.
    --
    -- Dropped first rather than only added when missing: an earlier run of
    -- this file may have created a looser version of the same constraint, and
    -- a plain "add if not exists" would silently leave that one in place. The
    -- whole block is one transaction, so the table is never left unguarded.
    execute format(
      'alter table %I drop constraint if exists %I',
      target, target || '_sms_consent_evidence_chk'
    );
    execute format(
      'alter table %I add constraint %I check (
         (
           customer_sms_consent = false
           and customer_sms_consent_at is null
           and customer_sms_consent_method is null
           and customer_sms_consent_scope is null
         )
         or (
           customer_sms_consent = true
           and customer_sms_consent_at is not null
           and customer_sms_consent_method is not null
           and customer_sms_consent_scope is not null
         )
       )',
      target, target || '_sms_consent_evidence_chk'
    );

    -- How consent was captured. 'voice' is a caller saying yes on the phone;
    -- 'manual' is somebody at the shop recording it.
    if not exists (
      select 1 from pg_constraint
      where conname = target || '_sms_consent_method_chk'
    ) then
      execute format(
        'alter table %I add constraint %I check (
           customer_sms_consent_method is null
           or customer_sms_consent_method in (''voice'', ''manual'')
         )',
        target, target || '_sms_consent_method_chk'
      );
    end if;

    -- What the consent covers. Only ever this request's confirmation.
    if not exists (
      select 1 from pg_constraint
      where conname = target || '_sms_consent_scope_chk'
    ) then
      execute format(
        'alter table %I add constraint %I check (
           customer_sms_consent_scope is null
           or customer_sms_consent_scope in (''request_confirmation'')
         )',
        target, target || '_sms_consent_scope_chk'
      );
    end if;

  end loop;
end $$;
