import { getSupabase } from "./supabase.js";

/**
 * Which remote assistant belongs to which shop.
 *
 * Queries only. Nothing here talks to a provider, and nothing here decides
 * whether a sync should happen.
 */

export type IntegrationProvider = "vapi";
export type IntegrationStatus = "active" | "disabled" | "error";

export class IntegrationError extends Error {
  readonly step: string;
  readonly code?: string;

  constructor(step: string, message: string, code?: string) {
    super(message);
    this.name = "IntegrationError";
    this.step = step;
    this.code = code;
  }
}

/** Postgres unique-violation code, raised when two syncs collide. */
export const UNIQUE_VIOLATION = "23505";

function fail(step: string, error: { message: string; code?: string }): never {
  throw new IntegrationError(step, error.message, error.code);
}

export interface BusinessIntegration {
  id: string;
  businessId: string;
  provider: IntegrationProvider;
  /** The provider's id for the assistant. An identifier, not a credential. */
  externalId: string;
  status: IntegrationStatus;
}

const COLUMNS = "id, business_id, provider, external_id, status";

function toIntegration(row: Record<string, unknown>): BusinessIntegration {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    provider: row.provider as IntegrationProvider,
    externalId: row.external_id as string,
    status: row.status as IntegrationStatus
  };
}

export async function getBusinessIntegration(
  businessId: string,
  provider: IntegrationProvider
): Promise<BusinessIntegration | null> {
  const { data, error } = await getSupabase()
    .from("business_integrations")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) fail("getBusinessIntegration", error);

  return data ? toIntegration(data as Record<string, unknown>) : null;
}

/**
 * Records a newly created remote assistant.
 *
 * Written only after the provider has confirmed the assistant exists, so a
 * row never claims something that was not created.
 */
export async function createBusinessIntegration(input: {
  businessId: string;
  provider: IntegrationProvider;
  externalId: string;
}): Promise<BusinessIntegration> {
  const { data, error } = await getSupabase()
    .from("business_integrations")
    .insert({
      business_id: input.businessId,
      provider: input.provider,
      external_id: input.externalId
      // status defaults to 'active'.
    })
    .select(COLUMNS)
    .single();

  if (error) fail("createBusinessIntegration", error);
  if (!data) {
    throw new IntegrationError("createBusinessIntegration", "Insert returned no row.");
  }

  return toIntegration(data as Record<string, unknown>);
}

/**
 * Touches an existing integration after a successful sync.
 *
 * Deliberately cannot change external_id: repointing a shop at a different
 * remote assistant is a repair, and a repair should be deliberate rather than
 * a side effect of a routine sync.
 */
export async function updateBusinessIntegration(
  businessId: string,
  provider: IntegrationProvider,
  changes: { status?: IntegrationStatus }
): Promise<void> {
  const { error } = await getSupabase()
    .from("business_integrations")
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("provider", provider);

  if (error) fail("updateBusinessIntegration", error);
}
