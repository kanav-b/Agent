import { loadBusinessAssistantConfig } from "../assistant/load.js";
import type { BusinessAssistantConfig } from "../assistant/generate.js";
import { getVapiConfig, missingVapiConfig } from "../config.js";
import {
  createBusinessIntegration,
  getBusinessIntegration,
  updateBusinessIntegration,
  IntegrationError,
  UNIQUE_VIOLATION
} from "../db/integrations.js";
import {
  createAssistant,
  getAssistant,
  isNotFound,
  updateAssistant,
  VapiRequestError
} from "./client.js";
import { buildCreatePayload, buildUpdatePayload } from "./payload.js";

/**
 * Deciding what a sync would do, and — only when asked — doing it.
 *
 * Planning never contacts Vapi and never writes to the database, so the
 * default path of the command is safe to run at any time. A remote write
 * happens only when the operator passes --apply.
 */

export type SyncOperation = "create" | "update";

export type SyncProblem =
  | "business_not_found"
  | "business_inactive"
  | "integration_disabled"
  | "integration_error_state"
  | "provisioning_not_configured"
  | "remote_missing"
  | "provider_failed"
  | "conflict";

export class SyncError extends Error {
  readonly problem: SyncProblem;

  constructor(problem: SyncProblem, message: string) {
    super(message);
    this.name = "SyncError";
    this.problem = problem;
  }
}

export interface SyncPlan {
  operation: SyncOperation;
  businessId: string;
  businessName: string;
  assistantName: string;
  serviceCount: number;
  timezone: string;
  /** Present only for an update: the assistant the sync would target. */
  assistantId?: string;
  config: BusinessAssistantConfig;
}

const PROVIDER = "vapi" as const;

/**
 * Works out whether a sync would create or update, and refuses early when it
 * could not safely do either.
 *
 * Reads the database. Never contacts Vapi, and never writes anything.
 */
export async function planSync(businessId: string): Promise<SyncPlan> {
  const resolution = await loadBusinessAssistantConfig(businessId);

  if (!resolution.ok) {
    throw resolution.problem === "not_found"
      ? new SyncError("business_not_found", `No business with id "${businessId}".`)
      : new SyncError(
          "business_inactive",
          `Business "${businessId}" is marked inactive, so no assistant will be generated.`
        );
  }

  const { config } = resolution;
  const integration = await getBusinessIntegration(businessId, PROVIDER);

  if (integration) {
    // A disabled or errored mapping is a decision somebody made. Turning it
    // back on silently would undo that without anyone noticing.
    if (integration.status === "disabled") {
      throw new SyncError(
        "integration_disabled",
        `The Vapi integration for "${businessId}" is disabled. Re-enable it deliberately ` +
          "before syncing; it is never reactivated automatically."
      );
    }

    if (integration.status === "error") {
      throw new SyncError(
        "integration_error_state",
        `The Vapi integration for "${businessId}" is marked as errored and needs looking ` +
          "at before another sync."
      );
    }
  }

  const shared = {
    businessId: config.businessId,
    businessName: config.businessName,
    assistantName: config.assistantName,
    serviceCount: config.supportedServices.length,
    timezone: config.timezone,
    config
  };

  return integration
    ? { ...shared, operation: "update" as const, assistantId: integration.externalId }
    : { ...shared, operation: "create" as const };
}

/** Refuses before any network call when provisioning is not set up. */
export function assertProvisioningConfigured(): void {
  const missing = missingVapiConfig();

  if (missing.length > 0) {
    throw new SyncError(
      "provisioning_not_configured",
      `Cannot sync: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "See .env.example."
    );
  }
}

export interface SyncResult {
  operation: SyncOperation;
  assistantId: string;
}

/**
 * Performs the remote write.
 *
 * Only ever reached when the operator passed --apply.
 */
export async function applySync(plan: SyncPlan): Promise<SyncResult> {
  // Checked before anything remote happens, so a missing key never becomes a
  // half-finished sync.
  assertProvisioningConfigured();

  return plan.operation === "update" ? applyUpdate(plan) : applyCreate(plan);
}

async function applyUpdate(plan: SyncPlan): Promise<SyncResult> {
  const assistantId = plan.assistantId as string;

  let existing;
  try {
    // Reading first does two jobs: it proves the assistant is still there,
    // and it yields the model object to preserve around our messages.
    existing = await getAssistant(assistantId);
  } catch (err) {
    if (isNotFound(err)) {
      // Someone deleted it, or the mapping is wrong. Creating a replacement
      // here would paper over exactly the mistake worth noticing.
      throw new SyncError(
        "remote_missing",
        `The stored Vapi assistant "${assistantId}" for "${plan.businessId}" does not exist ` +
          "remotely. This needs deliberate repair — no replacement is created automatically."
      );
    }
    throw asProviderFailure(err);
  }

  try {
    await updateAssistant(assistantId, buildUpdatePayload(plan.config, existing.model));
  } catch (err) {
    throw asProviderFailure(err);
  }

  await updateBusinessIntegration(plan.businessId, PROVIDER, { status: "active" });

  return { operation: "update", assistantId };
}

async function applyCreate(plan: SyncPlan): Promise<SyncResult> {
  const vapi = getVapiConfig();

  // Re-read immediately before creating: a plan may be minutes old, and
  // another operator may have synced in the meantime.
  const nowExisting = await getBusinessIntegration(plan.businessId, PROVIDER);

  if (nowExisting) {
    throw new SyncError(
      "conflict",
      `An assistant was recorded for "${plan.businessId}" while this sync was running. ` +
        "Run the command again to update it instead."
    );
  }

  const payload = buildCreatePayload(
    plan.config,
    {
      estimateToolId: vapi.estimateToolId,
      appointmentRequestToolId: vapi.appointmentRequestToolId,
      callbackRequestToolId: vapi.callbackRequestToolId
    },
    { modelProvider: vapi.modelProvider, model: vapi.model }
  );

  let created;
  try {
    created = await createAssistant(payload);
  } catch (err) {
    // Nothing is recorded, so the database never claims an assistant exists
    // when the request failed.
    throw asProviderFailure(err);
  }

  try {
    await createBusinessIntegration({
      businessId: plan.businessId,
      provider: PROVIDER,
      externalId: created.id
    });
  } catch (err) {
    // Two syncs raced past the re-check and both created an assistant. The
    // unique constraint keeps the first mapping; ours is now an orphan.
    if (err instanceof IntegrationError && err.code === UNIQUE_VIOLATION) {
      const winner = await getBusinessIntegration(plan.businessId, PROVIDER).catch(() => null);

      throw new SyncError(
        "conflict",
        `Another sync recorded an assistant for "${plan.businessId}" first` +
          (winner ? ` (${winner.externalId})` : "") +
          `. The assistant this run created (${created.id}) is unused and should be removed ` +
          "by hand in the Vapi dashboard."
      );
    }
    throw err;
  }

  return { operation: "create", assistantId: created.id };
}

/** Keeps provider detail from leaking past this module. */
function asProviderFailure(err: unknown): SyncError {
  if (err instanceof VapiRequestError) {
    return new SyncError("provider_failed", err.message);
  }
  return new SyncError("provider_failed", "The provider request failed.");
}
