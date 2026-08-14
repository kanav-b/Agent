import { z } from "zod";

/**
 * The envelope Vapi POSTs to a custom tool server.
 *
 * Vapi's docs show the arguments under `arguments`, but the field is also seen
 * as `parameters`, so we accept either and normalise below. Anything else in
 * the body (timestamps, `toolWithToolCallList`, etc.) is ignored rather than
 * rejected, since Vapi may add fields at any time.
 */
const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown().optional(),
  parameters: z.unknown().optional()
});

export const vapiToolCallsSchema = z.object({
  message: z.object({
    type: z.literal("tool-calls"),
    toolCallList: z.array(toolCallSchema).min(1)
  })
});

export type VapiToolCall = z.infer<typeof toolCallSchema>;

/**
 * Pulls the tool arguments out of a tool call.
 *
 * Some LLM providers send the arguments as a JSON string instead of an object,
 * so parse that case too. Returns undefined when nothing usable is present,
 * which the caller turns into a tool-level error.
 */
export function readToolArguments(toolCall: VapiToolCall): unknown {
  const raw = toolCall.arguments ?? toolCall.parameters;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  return raw;
}
