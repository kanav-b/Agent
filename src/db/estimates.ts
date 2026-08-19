import { getSupabase } from "./supabase.js";
import type { Estimate, Vehicle } from "../pricing/estimate.js";

/**
 * Everything that touches the database lives here. Routes call
 * persistEstimate() and never write a query themselves.
 *
 * Nothing in this file affects prices: it is called *after* getEstimate() has
 * already worked them out.
 */

/** The database steps, so a failure says which one broke. */
export type PersistenceStep =
  | "findEstimateByToolCallId"
  | "ensureBusinessExists"
  | "createVehicle"
  | "saveEstimate";

/** What Supabase tells us when a query fails. Never contains credentials. */
interface SupabaseErrorFields {
  code?: string;
  details?: string;
  hint?: string;
}

/** Raised for any database problem. The message is safe to log, not to return. */
export class PersistenceError extends Error {
  readonly step: PersistenceStep;
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(step: PersistenceStep, message: string, fields: SupabaseErrorFields = {}) {
    super(message);
    this.name = "PersistenceError";
    this.step = step;
    this.code = fields.code;
    this.details = fields.details;
    this.hint = fields.hint;
  }
}

export interface PersistEstimateInput {
  estimateId: string;
  businessId: string;
  vehicle: Vehicle;
  estimate: Estimate;
  source: "api" | "vapi";
  vapiToolCallId?: string;
}

export interface PersistEstimateResult {
  /** The stored id. Differs from the requested one when a retry was detected. */
  estimateId: string;
  /** True when an earlier identical Vapi tool call had already been stored. */
  reused: boolean;
}

/** Postgres unique-violation code, raised when two rows collide. */
const UNIQUE_VIOLATION = "23505";

/* ------------------------------------------------------------------ *
 * TEMPORARY DIAGNOSTICS
 *
 * Added to find out which persistence step is failing. Logs the step,
 * the Supabase code/message/details/hint, and the ids involved.
 *
 * It never logs the Supabase URL, the secret key, or any header — the
 * fields below are the only ones written out.
 *
 * Remove this block (and the logStep/logFailure calls) once the cause
 * is found.
 * ------------------------------------------------------------------ */

interface LogContext {
  estimateId?: string;
  businessId?: string;
  service?: string;
}

/** Wraps a value so empty ones are obvious and spaces do not break the line. */
function field(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    return `${name}=-`;
  }
  return `${name}=${JSON.stringify(value)}`;
}

function logStep(step: PersistenceStep, status: "start" | "ok", context: LogContext): void {
  console.log(
    `[db] step=${step} status=${status} ` +
      `${field("businessId", context.businessId)} ` +
      `${field("service", context.service)} ` +
      `${field("estimateId", context.estimateId)}`
  );
}

function logFailure(err: unknown, context: LogContext): void {
  if (err instanceof PersistenceError) {
    console.error(
      `[db] step=${err.step} status=FAIL ` +
        `${field("code", err.code)} ` +
        `${field("message", err.message)} ` +
        `${field("details", err.details)} ` +
        `${field("hint", err.hint)} ` +
        `${field("businessId", context.businessId)} ` +
        `${field("service", context.service)} ` +
        `${field("estimateId", context.estimateId)}`
    );
    return;
  }

  // Something that is not a database error: a network failure, a bad URL, a
  // bug. Log the message only, never the object, so nothing unexpected leaks.
  console.error(
    `[db] step=unknown status=FAIL ` +
      `${field("message", (err as Error)?.message ?? String(err))} ` +
      `${field("businessId", context.businessId)} ` +
      `${field("service", context.service)} ` +
      `${field("estimateId", context.estimateId)}`
  );
}

/* ------------------------- end diagnostics ------------------------- */

/** Throws if the business is not in the database. */
export async function ensureBusinessExists(businessId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from("businesses")
    .select("id")
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    throw new PersistenceError("ensureBusinessExists", error.message, error);
  }

  if (!data) {
    throw new PersistenceError(
      "ensureBusinessExists",
      `Business "${businessId}" does not exist.`,
      { hint: "Run the migration in supabase/migrations, which seeds demo-shop." }
    );
  }
}

/**
 * Stores the vehicle an estimate is for and returns its id.
 *
 * customer_id stays null: at this phase the caller is not identified, and a
 * placeholder customer row would be worse than no row at all.
 */
export async function createVehicle(businessId: string, vehicle: Vehicle): Promise<string> {
  const { data, error } = await getSupabase()
    .from("vehicles")
    .insert({
      business_id: businessId,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model
    })
    .select("id")
    .single();

  if (error) {
    throw new PersistenceError("createVehicle", error.message, error);
  }

  if (!data) {
    throw new PersistenceError("createVehicle", "Insert returned no row.", {
      hint: "The insert may have succeeded but the row was not readable back."
    });
  }

  return data.id as string;
}

/** Writes the estimate row, using the application's estimateId as the primary key. */
export async function saveEstimate(
  input: PersistEstimateInput,
  vehicleId: string
): Promise<void> {
  const { error } = await getSupabase()
    .from("estimates")
    .insert({
      id: input.estimateId,
      business_id: input.businessId,
      vehicle_id: vehicleId,
      service: input.estimate.service,
      low_price: input.estimate.low,
      high_price: input.estimate.high,
      currency: input.estimate.currency,
      disclaimer: input.estimate.disclaimer,
      source: input.source,
      vapi_tool_call_id: input.vapiToolCallId ?? null
    });

  if (error) {
    throw new PersistenceError("saveEstimate", error.message, error);
  }
}

/** Finds an estimate already stored for a Vapi tool call, if there is one. */
export async function findEstimateByToolCallId(toolCallId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("estimates")
    .select("id")
    .eq("vapi_tool_call_id", toolCallId)
    .maybeSingle();

  if (error) {
    throw new PersistenceError("findEstimateByToolCallId", error.message, error);
  }

  return data ? (data.id as string) : null;
}

/**
 * Saves one estimate: check the business, store the vehicle, store the estimate.
 *
 * Vapi may retry a tool call, and a retry carries the same toolCallId. When
 * that id has already been stored we return the original estimateId instead of
 * writing a second row, so the caller hears about the same estimate it got the
 * first time.
 */
export async function persistEstimate(
  input: PersistEstimateInput
): Promise<PersistEstimateResult> {
  const context: LogContext = {
    estimateId: input.estimateId,
    businessId: input.businessId,
    service: input.estimate.service
  };

  try {
    if (input.vapiToolCallId) {
      logStep("findEstimateByToolCallId", "start", context);
      const existing = await findEstimateByToolCallId(input.vapiToolCallId);
      logStep("findEstimateByToolCallId", "ok", context);

      if (existing) {
        return { estimateId: existing, reused: true };
      }
    }

    logStep("ensureBusinessExists", "start", context);
    await ensureBusinessExists(input.businessId);
    logStep("ensureBusinessExists", "ok", context);

    logStep("createVehicle", "start", context);
    const vehicleId = await createVehicle(input.businessId, input.vehicle);
    logStep("createVehicle", "ok", context);

    logStep("saveEstimate", "start", context);
    try {
      await saveEstimate(input, vehicleId);
    } catch (err) {
      // Two retries racing each other: the loser looks up the winner's row.
      if (err instanceof PersistenceError && err.code === UNIQUE_VIOLATION && input.vapiToolCallId) {
        const existing = await findEstimateByToolCallId(input.vapiToolCallId);
        if (existing) {
          return { estimateId: existing, reused: true };
        }
      }
      throw err;
    }
    logStep("saveEstimate", "ok", context);

    return { estimateId: input.estimateId, reused: false };
  } catch (err) {
    logFailure(err, context);
    throw err;
  }
}
