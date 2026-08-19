import {
  vapiToolCallsSchema,
  normalizeToolCall,
  type NormalizedToolCall
} from "../schemas/vapi.js";

/**
 * The bits every Vapi tool endpoint shares: read the envelope, flatten each
 * tool call, check the tool name, and shape the reply Vapi expects.
 *
 * Each endpoint still owns its own arguments and its own work — this only
 * removes the envelope handling that would otherwise be copied three times.
 */

/** One entry in the payload Vapi expects back. Either result or error, never both. */
export type VapiResult =
  | { toolCallId: string; result: string }
  | { toolCallId: string; error: string };

export interface ToolCallContext {
  /** Vapi's id for the live call, when the payload carried one. */
  vapiCallId?: string;
}

export interface ToolResponse {
  status: number;
  body: unknown;
}

/**
 * Runs every tool call in the request and builds Vapi's reply.
 *
 * A tool call for something this endpoint does not answer comes back as a
 * tool-level error rather than a failed request, so the assistant can say
 * something sensible.
 */
export async function handleToolCalls(
  body: unknown,
  expectedTool: string,
  run: (toolCall: NormalizedToolCall, context: ToolCallContext) => Promise<VapiResult>
): Promise<ToolResponse> {
  const parsed = vapiToolCallsSchema.safeParse(body);

  // With an unreadable envelope there is no toolCallId to answer with, so a
  // Vapi-shaped reply is impossible and a plain 400 is the honest answer.
  if (!parsed.success) {
    return { status: 400, body: { error: "Invalid Vapi tool-call request body." } };
  }

  const context: ToolCallContext = { vapiCallId: parsed.data.message.call?.id };

  const results = await Promise.all(
    parsed.data.message.toolCallList.map(async (raw) => {
      const toolCall = normalizeToolCall(raw);

      if (toolCall.name !== expectedTool) {
        return {
          toolCallId: toolCall.id,
          error: `Unsupported tool "${toolCall.name}". This endpoint only supports ${expectedTool}.`
        };
      }

      return run(toolCall, context);
    })
  );

  return { status: 200, body: { results } };
}

/** Vapi requires result to be a string, so payloads go out as compact JSON. */
export function toolResult(toolCallId: string, payload: unknown): VapiResult {
  return { toolCallId, result: JSON.stringify(payload) };
}

export function toolError(toolCallId: string, message: string): VapiResult {
  return { toolCallId, error: message };
}
