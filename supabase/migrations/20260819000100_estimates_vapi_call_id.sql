-- Phase 6: let an estimate remember which call produced it.
--
-- Vapi's tool-call request carries message.call.id, so the estimate endpoint
-- can record it at the time the estimate is made.
--
-- Deliberately NOT a foreign key to calls: the estimate is written during the
-- call, and the calls row only appears afterwards in the end-of-call report.

alter table estimates add column if not exists vapi_call_id text;

-- Used to find a call's estimates when the end-of-call report arrives.
create index if not exists estimates_vapi_call_id_idx
  on estimates (vapi_call_id)
  where vapi_call_id is not null;
