import { randomUUID } from "node:crypto";
import { Router } from "express";
import { vapiToolCallsSchema, normalizeToolCall, type VapiToolCall } from "../schemas/vapi.js";
import { estimateRequestSchema } from "../schemas/estimate.js";
import { getEstimate, UnsupportedServiceError, type Estimate } from "../pricing/estimate.js";
import { SUPPORTED_SERVICES } from "../pricing/catalog.js";

/** The only tool this server answers today. */
const CALCULATE_ESTIMATE = "calculate_estimate";

/** One entry in the payload Vapi expects back. Either result or error, never both. */
type VapiResult =
  | { toolCallId: string; result: string }
  | { toolCallId: string; error: string };

export const vapiRouter = Router();

/**
 * Runs a single tool call and turns it into a Vapi result.
 *
 * Every failure here is a *tool-level* failure: Vapi should hear about it and
 * say something sensible to the caller, so these come back inside a 200. The
 * messages are written to be read aloud, and never include internals.
 */
function runToolCall(rawToolCall: VapiToolCall): VapiResult {
  // Flatten the flat and nested Vapi shapes into one before doing anything.
  const toolCall = normalizeToolCall(rawToolCall);

  if (toolCall.name !== CALCULATE_ESTIMATE) {
    return {
      toolCallId: toolCall.id,
      error: `Unsupported tool "${toolCall.name}". This server only supports ${CALCULATE_ESTIMATE}.`
    };
  }

  const parsed = estimateRequestSchema.safeParse(toolCall.arguments);

  if (!parsed.success) {
    return {
      toolCallId: toolCall.id,
      error:
        "Invalid estimate parameters. Provide a service name and a vehicle with year, make, and model."
    };
  }

  const { service, vehicle } = parsed.data;

  try {
    // Same deterministic pricing function POST /api/estimate uses.
    const estimate: Estimate = getEstimate(service, vehicle);

    // estimateId is generated here, at the response boundary, for the same
    // reason as in the normal route: it is tracking metadata, so keeping it out
    // of getEstimate leaves pricing deterministic.
    const payload = { estimateId: randomUUID(), ...estimate };

    // Vapi requires result to be a string, so send compact single-line JSON.
    return { toolCallId: toolCall.id, result: JSON.stringify(payload) };
  } catch (err) {
    if (err instanceof UnsupportedServiceError) {
      return {
        toolCallId: toolCall.id,
        error: `Service "${service}" is not supported. Supported services are: ${SUPPORTED_SERVICES.join(", ")}.`
      };
    }
    throw err;
  }
}

vapiRouter.post("/estimate", (req, res) => {
  const parsed = vapiToolCallsSchema.safeParse(req.body);

  // If the envelope itself is unreadable there is no toolCallId to answer with,
  // so a Vapi-shaped reply is impossible. This is a request-level problem (bad
  // configuration or something that is not Vapi), not a tool-level one, so 400
  // is the honest answer and shows up clearly while wiring things up.
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid Vapi tool-call request body." });
  }

  const results = parsed.data.message.toolCallList.map(runToolCall);

  return res.status(200).json({ results });
});
