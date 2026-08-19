import { getSupabase } from "./supabase.js";
import type { NormalizedCall } from "../calls/normalize.js";

/**
 * Every query about calls and callers lives here. Routes call
 * persistCall() and never write a query themselves.
 *
 * Call data contains personal information — phone numbers, names, and the
 * words people said — so nothing in this file logs a row's contents. Failures
 * report the step, the database error code, the business, and Vapi's call id,
 * and nothing else.
 */

export type CallStep =
  | "findCallByVapiId"
  | "ensureBusinessExists"
  | "findCustomerByPhone"
  | "createCustomer"
  | "updateCustomerNameIfMissing"
  | "saveCall"
  | "linkEstimatesToCustomer"
  | "findEstimatesForCall";

export class CallPersistenceError extends Error {
  readonly step: CallStep;
  readonly code?: string;

  constructor(step: CallStep, message: string, code?: string) {
    super(message);
    this.name = "CallPersistenceError";
    this.step = step;
    this.code = code;
  }
}

interface SupabaseError {
  message: string;
  code?: string;
}

/** Turns a Supabase error into ours, keeping only the code and the message. */
function fail(step: CallStep, error: SupabaseError): never {
  throw new CallPersistenceError(step, error.message, error.code);
}

/**
 * Logs a call failure.
 *
 * Deliberately narrower than the estimate logger: no `details` or `hint`,
 * because a constraint violation on this table could echo a phone number or a
 * line of transcript back in them.
 */
export function logCallFailure(
  err: unknown,
  context: { vapiCallId?: string; businessId?: string }
): void {
  const step = err instanceof CallPersistenceError ? err.step : "unknown";
  // Network failures arrive with an empty code, not a missing one.
  const code = (err instanceof CallPersistenceError ? err.code : undefined) || "-";
  const message = err instanceof CallPersistenceError ? err.message : (err as Error)?.message;

  console.error(
    `[calls] step=${step} status=FAIL code=${JSON.stringify(code)} ` +
      `message=${JSON.stringify(message ?? "unknown error")} ` +
      `vapiCallId=${JSON.stringify(context.vapiCallId ?? "-")} ` +
      `businessId=${JSON.stringify(context.businessId ?? "-")}`
  );
}

/** The stored id of a call already recorded for this Vapi call, if any. */
export async function findCallByVapiId(vapiCallId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("calls")
    .select("id")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle();

  if (error) fail("findCallByVapiId", error);

  return data ? (data.id as string) : null;
}

async function ensureBusinessExists(businessId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from("businesses")
    .select("id")
    .eq("id", businessId)
    .maybeSingle();

  if (error) fail("ensureBusinessExists", error);
  if (!data) {
    throw new CallPersistenceError(
      "ensureBusinessExists",
      `Business "${businessId}" does not exist.`
    );
  }
}

interface CustomerRow {
  id: string;
  name: string | null;
}

/** Looks for a caller already known to this business by phone number. */
export async function findCustomerByPhone(
  businessId: string,
  phone: string
): Promise<CustomerRow | null> {
  const { data, error } = await getSupabase()
    .from("customers")
    .select("id, name")
    .eq("business_id", businessId)
    .eq("phone", phone)
    .maybeSingle();

  if (error) fail("findCustomerByPhone", error);

  return data ? { id: data.id as string, name: (data.name as string | null) ?? null } : null;
}

/** Creates a caller record. Only ever called when there is a real phone number. */
export async function createCustomer(
  businessId: string,
  phone: string,
  name: string | null
): Promise<string> {
  const { data, error } = await getSupabase()
    .from("customers")
    .insert({ business_id: businessId, phone, name })
    .select("id")
    .single();

  if (error) fail("createCustomer", error);
  if (!data) {
    throw new CallPersistenceError("createCustomer", "Insert returned no row.");
  }

  return data.id as string;
}

/**
 * Fills in a caller's name only when we do not already have one.
 *
 * An existing name was either given by the caller or entered by the shop, so
 * it is never replaced automatically.
 */
export async function updateCustomerNameIfMissing(
  customerId: string,
  name: string
): Promise<void> {
  const { error } = await getSupabase()
    .from("customers")
    .update({ name })
    .eq("id", customerId)
    .is("name", null);

  if (error) fail("updateCustomerNameIfMissing", error);
}

/** True when this call already produced at least one stored estimate. */
export async function findEstimatesForCall(vapiCallId: string): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("estimates")
    .select("id")
    .eq("vapi_call_id", vapiCallId);

  if (error) fail("findEstimatesForCall", error);

  return (data ?? []).map((row: { id: string }) => row.id);
}

/**
 * Attaches the caller to the estimates made during the call.
 *
 * Only fills blanks — an estimate that already has a customer is left alone.
 */
export async function linkEstimatesToCustomer(
  vapiCallId: string,
  customerId: string
): Promise<void> {
  const { error } = await getSupabase()
    .from("estimates")
    .update({ customer_id: customerId })
    .eq("vapi_call_id", vapiCallId)
    .is("customer_id", null);

  if (error) fail("linkEstimatesToCustomer", error);
}

/**
 * Writes the call row.
 *
 * An upsert on vapi_call_id, so a retried end-of-call report updates the row
 * it wrote the first time instead of adding a second one. created_at is not
 * sent, so the original stays.
 */
export async function saveCall(call: NormalizedCall, customerId: string | null): Promise<void> {
  const { error } = await getSupabase()
    .from("calls")
    .upsert(
      {
        business_id: call.businessId,
        vapi_call_id: call.vapiCallId,
        customer_id: customerId,
        caller_phone: call.callerPhone,
        started_at: call.startedAt,
        ended_at: call.endedAt,
        ended_reason: call.endedReason,
        transcript: call.transcript,
        summary: call.summary,
        outcome: call.outcome,
        requires_follow_up: call.requiresFollowUp
      },
      { onConflict: "vapi_call_id" }
    );

  if (error) fail("saveCall", error);
}

/**
 * Finds or creates the caller behind a call.
 *
 * With no phone number there is nothing to match on, so the call is stored
 * without a customer rather than against an invented one.
 */
export async function resolveCustomer(call: NormalizedCall): Promise<string | null> {
  if (!call.callerPhone) {
    return null;
  }

  const existing = await findCustomerByPhone(call.businessId, call.callerPhone);

  if (existing) {
    if (!existing.name && call.customerName) {
      await updateCustomerNameIfMissing(existing.id, call.customerName);
    }
    return existing.id;
  }

  return createCustomer(call.businessId, call.callerPhone, call.customerName);
}

export interface PersistCallResult {
  /** True when this call had already been recorded and the row was updated. */
  duplicate: boolean;
  customerId: string | null;
}

/**
 * Stores one completed call: confirm the business, work out who called, write
 * the call, then attach the caller to any estimates made during it.
 */
export async function persistCall(call: NormalizedCall): Promise<PersistCallResult> {
  const alreadyStored = await findCallByVapiId(call.vapiCallId);

  await ensureBusinessExists(call.businessId);

  const customerId = await resolveCustomer(call);

  await saveCall(call, customerId);

  if (customerId) {
    // Estimates written during the call did not know who was speaking.
    await linkEstimatesToCustomer(call.vapiCallId, customerId);
  }

  return { duplicate: alreadyStored !== null, customerId };
}
