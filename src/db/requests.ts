import { getSupabase } from "./supabase.js";
import { resolveCustomerByPhone } from "./calls.js";
import type { AppointmentRequestInput, CallbackRequestInput } from "../schemas/requests.js";

/**
 * Queries for appointment and callback requests.
 *
 * Both are records of what a caller asked for. Nothing here confirms
 * anything — a row is created as 'pending' and only the shop moves it on.
 *
 * The rows hold personal information (names, phone numbers, what is wrong with
 * the car, why someone wants a call back), so nothing in this file logs a
 * row's contents.
 */

export type RequestKind = "appointment" | "callback";

export class RequestPersistenceError extends Error {
  readonly step: string;
  readonly code?: string;

  constructor(step: string, message: string, code?: string) {
    super(message);
    this.name = "RequestPersistenceError";
    this.step = step;
    this.code = code;
  }
}

function fail(step: string, error: { message: string; code?: string }): never {
  throw new RequestPersistenceError(step, error.message, error.code);
}

/**
 * Logs a request failure.
 *
 * Records only what is needed to find the problem. Never a name, a phone
 * number, a problem description, or a callback reason.
 */
export function logRequestFailure(
  err: unknown,
  context: { kind: RequestKind; toolCallId?: string; vapiCallId?: string; businessId?: string }
): void {
  const withStep = err as { step?: string; code?: string; message?: string };

  console.error(
    `[requests] kind=${context.kind} step=${withStep.step ?? "unknown"} status=FAIL ` +
      `code=${JSON.stringify(withStep.code || "-")} ` +
      `message=${JSON.stringify(withStep.message ?? "unknown error")} ` +
      `toolCallId=${JSON.stringify(context.toolCallId ?? "-")} ` +
      `vapiCallId=${JSON.stringify(context.vapiCallId ?? "-")} ` +
      `businessId=${JSON.stringify(context.businessId ?? "-")}`
  );
}

const TABLES: Record<RequestKind, string> = {
  appointment: "appointment_requests",
  callback: "callback_requests"
};

async function ensureBusinessExists(businessId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from("businesses")
    .select("id")
    .eq("id", businessId)
    .maybeSingle();

  if (error) fail("ensureBusinessExists", error);
  if (!data) {
    throw new RequestPersistenceError(
      "ensureBusinessExists",
      `Business "${businessId}" does not exist.`
    );
  }
}

/** The id of a request already created by this tool call, if there is one. */
export async function findRequestByToolCallId(
  kind: RequestKind,
  toolCallId: string
): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from(TABLES[kind])
    .select("id")
    .eq("vapi_tool_call_id", toolCallId)
    .maybeSingle();

  if (error) fail("findRequestByToolCallId", error);

  return data ? (data.id as string) : null;
}

/** True when the call produced at least one request of this kind. */
export async function hasRequestForCall(kind: RequestKind, vapiCallId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from(TABLES[kind])
    .select("id")
    .eq("vapi_call_id", vapiCallId)
    .limit(1);

  if (error) fail("hasRequestForCall", error);

  return (data ?? []).length > 0;
}

/**
 * Attaches a caller to the requests they made during a call.
 *
 * Only fills blanks — a request that already has a customer is left alone.
 */
export async function linkRequestsToCustomer(
  vapiCallId: string,
  customerId: string
): Promise<void> {
  for (const kind of ["appointment", "callback"] as const) {
    const { error } = await getSupabase()
      .from(TABLES[kind])
      .update({ customer_id: customerId, updated_at: new Date().toISOString() })
      .eq("vapi_call_id", vapiCallId)
      .is("customer_id", null);

    if (error) fail("linkRequestsToCustomer", error);
  }
}

/**
 * Turns a consent flag into the evidence stored alongside the request.
 *
 * The timestamp, method, and scope are decided here, never taken from the
 * tool: a caller-supplied "I consented at 9am" would be worthless as proof.
 * The scope records that this covers one confirmation for this one request —
 * not marketing, not future requests, not anything else.
 */
function consentEvidence(consented: boolean): Record<string, unknown> {
  if (!consented) {
    return {
      customer_sms_consent: false,
      customer_sms_consent_at: null,
      customer_sms_consent_method: null,
      customer_sms_consent_scope: null
    };
  }

  return {
    customer_sms_consent: true,
    customer_sms_consent_at: new Date().toISOString(),
    customer_sms_consent_method: "voice",
    customer_sms_consent_scope: "request_confirmation"
  };
}

export interface RequestContext {
  vapiToolCallId?: string;
  vapiCallId?: string;
}

export interface CreatedRequest {
  requestId: string;
  /** True when this tool call had already created the request. */
  reused: boolean;
}

/** Shared by both kinds: recognise a retry, check the business, find the caller. */
async function prepare(
  kind: RequestKind,
  businessId: string,
  customer: { name?: string; phone?: string } | undefined,
  context: RequestContext
): Promise<{ existing: string | null; customerId: string | null }> {
  if (context.vapiToolCallId) {
    const existing = await findRequestByToolCallId(kind, context.vapiToolCallId);
    if (existing) {
      return { existing, customerId: null };
    }
  }

  await ensureBusinessExists(businessId);

  const customerId = await resolveCustomerByPhone(
    businessId,
    customer?.phone ?? null,
    customer?.name ?? null
  );

  return { existing: null, customerId };
}

/** Reads back the row a retry collided with, so a race still returns one id. */
async function afterConflict(
  kind: RequestKind,
  context: RequestContext,
  err: unknown
): Promise<CreatedRequest> {
  const code = (err as { code?: string }).code;

  if (code === "23505" && context.vapiToolCallId) {
    const existing = await findRequestByToolCallId(kind, context.vapiToolCallId);
    if (existing) {
      return { requestId: existing, reused: true };
    }
  }

  throw err;
}

export async function createAppointmentRequest(
  input: AppointmentRequestInput,
  context: RequestContext = {}
): Promise<CreatedRequest> {
  const { existing, customerId } = await prepare(
    "appointment",
    input.businessId,
    input.customer,
    context
  );

  if (existing) {
    return { requestId: existing, reused: true };
  }

  const { data, error } = await getSupabase()
    .from("appointment_requests")
    .insert({
      business_id: input.businessId,
      customer_id: customerId,
      vapi_call_id: context.vapiCallId ?? null,
      vapi_tool_call_id: context.vapiToolCallId ?? null,
      vehicle_year: input.vehicle?.year ?? null,
      vehicle_make: input.vehicle?.make ?? null,
      vehicle_model: input.vehicle?.model ?? null,
      service: input.service ?? null,
      problem_description: input.problemDescription ?? null,
      preferred_date: input.preferredDate ?? null,
      preferred_time_text: input.preferredTimeText ?? null,
      ...consentEvidence(input.customerSmsConsent)
      // status defaults to 'pending'. Nothing here can confirm a booking.
    })
    .select("id")
    .single();

  if (error) {
    return afterConflict("appointment", context, new RequestPersistenceError(
      "createAppointmentRequest",
      error.message,
      error.code
    ));
  }

  if (!data) {
    throw new RequestPersistenceError("createAppointmentRequest", "Insert returned no row.");
  }

  return { requestId: data.id as string, reused: false };
}

export async function createCallbackRequest(
  input: CallbackRequestInput,
  context: RequestContext = {}
): Promise<CreatedRequest> {
  const { existing, customerId } = await prepare(
    "callback",
    input.businessId,
    input.customer,
    context
  );

  if (existing) {
    return { requestId: existing, reused: true };
  }

  const { data, error } = await getSupabase()
    .from("callback_requests")
    .insert({
      business_id: input.businessId,
      customer_id: customerId,
      vapi_call_id: context.vapiCallId ?? null,
      vapi_tool_call_id: context.vapiToolCallId ?? null,
      reason: input.reason ?? null,
      preferred_callback_at: input.preferredCallbackAt ?? null,
      ...consentEvidence(input.customerSmsConsent)
    })
    .select("id")
    .single();

  if (error) {
    return afterConflict("callback", context, new RequestPersistenceError(
      "createCallbackRequest",
      error.message,
      error.code
    ));
  }

  if (!data) {
    throw new RequestPersistenceError("createCallbackRequest", "Insert returned no row.");
  }

  return { requestId: data.id as string, reused: false };
}
