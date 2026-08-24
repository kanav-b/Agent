import { randomUUID } from "node:crypto";
import { Router } from "express";
import { vapiToolCallsSchema, normalizeToolCall, type VapiToolCall } from "../schemas/vapi.js";
import { estimateRequestSchema } from "../schemas/estimate.js";
import { buildEstimate, type Estimate } from "../pricing/estimate.js";
import { persistEstimate } from "../db/estimates.js";
import {
  listAvailableServiceKeys,
  resolveBusiness,
  resolveServicePricing
} from "../business/config.js";

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
async function runToolCall(rawToolCall: VapiToolCall, vapiCallId?: string): Promise<VapiResult> {
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

  const { businessId, service, vehicle } = parsed.data;

  // Step 1: price it, using this shop's own configuration. Nothing is stored
  // yet, so an unknown shop or service leaves the database untouched.
  let estimate: Estimate;
  try {
    const business = await resolveBusiness(businessId);

    if (!business.ok) {
      return {
        toolCallId: toolCall.id,
        error: "This shop is not available right now, so I cannot quote a price."
      };
    }

    const pricing = await resolveServicePricing(businessId, service);

    if (!pricing.ok) {
      const available = await listAvailableServiceKeys(businessId);
      return {
        toolCallId: toolCall.id,
        error: `Service "${service}" is not supported. Supported services are: ${available.join(", ")}.`
      };
    }

    // The same deterministic calculation POST /api/estimate uses.
    estimate = buildEstimate(vehicle, pricing.pricing);
  } catch {
    return {
      toolCallId: toolCall.id,
      error: "Could not look up pricing right now. Please try again in a moment."
    };
  }

  // Step 2: store it. estimateId is generated here, at the response boundary,
  // for the same reason as in the normal route: it is tracking metadata, so
  // keeping it out of getEstimate leaves pricing deterministic.
  let storedEstimateId: string;
  try {
    const saved = await persistEstimate({
      estimateId: randomUUID(),
      businessId,
      vehicle,
      estimate,
      source: "vapi",
      vapiToolCallId: toolCall.id,
      // Lets the end-of-call report find the estimates made during the call.
      vapiCallId
    });
    // On a retry this is the id stored the first time, not the new one.
    storedEstimateId = saved.estimateId;
  } catch {
    // A tool-level error, so the assistant can say something sensible rather
    // than claiming an estimate that was never saved.
    return {
      toolCallId: toolCall.id,
      error: "Could not save the estimate right now. Please try again in a moment."
    };
  }

  const payload = { estimateId: storedEstimateId, ...estimate };

  // Vapi requires result to be a string, so send compact single-line JSON.
  return { toolCallId: toolCall.id, result: JSON.stringify(payload) };
}

vapiRouter.post("/estimate", async (req, res) => {
  const parsed = vapiToolCallsSchema.safeParse(req.body);

  // If the envelope itself is unreadable there is no toolCallId to answer with,
  // so a Vapi-shaped reply is impossible. This is a request-level problem (bad
  // configuration or something that is not Vapi), not a tool-level one, so 400
  // is the honest answer and shows up clearly while wiring things up.
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid Vapi tool-call request body." });
  }

  const vapiCallId = parsed.data.message.call?.id;

  const results = await Promise.all(
    parsed.data.message.toolCallList.map((toolCall) => runToolCall(toolCall, vapiCallId))
  );

  return res.status(200).json({ results });
});
