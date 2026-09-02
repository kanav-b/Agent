import { getVapiConfig } from "../config.js";

/**
 * The only place that talks to the Vapi REST API.
 *
 * Uses the platform's fetch, so no dependency is added to make three HTTP
 * calls. Nothing here reads the database, and nothing here decides whether a
 * sync should happen.
 *
 * Verified against the current API:
 *   create  POST   https://api.vapi.ai/assistant
 *   read    GET    https://api.vapi.ai/assistant/{id}
 *   update  PATCH  https://api.vapi.ai/assistant/{id}
 *   auth    Authorization: Bearer <private API key>
 */

const BASE_URL = "https://api.vapi.ai";

/**
 * A provider failure, reduced to what an operator needs.
 *
 * Carries the HTTP status and a short category. The response body is
 * deliberately not kept: it can echo the prompt we just submitted, and a
 * prompt is business content rather than something to print in a terminal.
 */
export class VapiRequestError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number, detail?: string) {
    super(`Vapi ${operation} failed with HTTP ${status}${detail ? `: ${detail}` : "."}`);
    this.name = "VapiRequestError";
    this.status = status;
    this.operation = operation;
  }
}

/** True when the assistant simply is not there. */
export function isNotFound(err: unknown): boolean {
  return err instanceof VapiRequestError && err.status === 404;
}

/**
 * Describes a failure without quoting the provider back.
 *
 * Statuses are categorised by hand so an operator learns what to do, without
 * a response body — which may contain the submitted prompt — reaching a log.
 */
function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "the API key was rejected";
  }
  if (status === 404) {
    return "not found";
  }
  if (status === 429) {
    return "rate limited";
  }
  if (status >= 500) {
    return "the provider had a server error";
  }
  if (status === 400 || status === 422) {
    return "the request was rejected as invalid";
  }
  return "unexpected status";
}

async function request(
  operation: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  // Reading the key here means a missing one fails before any network call.
  const { apiKey } = getVapiConfig();

  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        // Never logged, never included in an error.
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    // A network failure. The original error can quote the request, so it is
    // replaced rather than wrapped.
    throw new VapiRequestError(operation, 0, "could not reach the provider");
  }

  if (!response.ok) {
    throw new VapiRequestError(operation, response.status, describeStatus(response.status));
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new VapiRequestError(operation, response.status, "the response was not JSON");
  }
}

/** The bits of an assistant this project reads back. */
export interface VapiAssistant {
  id: string;
  /** Whatever the assistant's model settings currently are. Shape is theirs. */
  model?: Record<string, unknown>;
}

export async function getAssistant(assistantId: string): Promise<VapiAssistant> {
  const body = (await request("read", "GET", `/assistant/${assistantId}`)) as VapiAssistant;

  if (!body || typeof body.id !== "string") {
    throw new VapiRequestError("read", 200, "the response contained no assistant id");
  }

  return body;
}

export async function createAssistant(payload: unknown): Promise<VapiAssistant> {
  const body = (await request("create", "POST", "/assistant", payload)) as VapiAssistant;

  // Without an id there is nothing to record, and recording a guess would be
  // worse than failing.
  if (!body || typeof body.id !== "string" || body.id.length === 0) {
    throw new VapiRequestError("create", 200, "the response contained no assistant id");
  }

  return body;
}

export async function updateAssistant(
  assistantId: string,
  payload: unknown
): Promise<VapiAssistant> {
  return (await request(
    "update",
    "PATCH",
    `/assistant/${assistantId}`,
    payload
  )) as VapiAssistant;
}
