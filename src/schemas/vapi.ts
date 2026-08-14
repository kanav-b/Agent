import { z } from "zod";

/**
 * The envelope Vapi POSTs to a custom tool server.
 *
 * A tool call arrives in one of two shapes:
 *
 *   flat:    { id, name, arguments }
 *   nested:  { id, function: { name, arguments } }   (OpenAI style)
 *
 * The arguments have also been seen under `parameters` instead of `arguments`.
 * The schema below accepts all of these; `normalizeToolCall` flattens them into
 * one shape so the route only has to deal with a single case.
 *
 * Anything else in the body (timestamps, `toolWithToolCallList`, etc.) is
 * ignored rather than rejected, since Vapi may add fields at any time.
 */
const toolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    arguments: z.unknown().optional(),
    parameters: z.unknown().optional(),
    function: z
      .object({
        name: z.string().min(1).optional(),
        arguments: z.unknown().optional(),
        parameters: z.unknown().optional()
      })
      .optional()
  })
  // The name is optional in each position but required overall: it has to
  // appear in one of them, or we cannot tell which tool was called.
  .refine((toolCall) => Boolean(toolCall.name ?? toolCall.function?.name), {
    message: "Tool call is missing a name."
  });

export const vapiToolCallsSchema = z.object({
  message: z.object({
    type: z.literal("tool-calls"),
    toolCallList: z.array(toolCallSchema).min(1)
  })
});

export type VapiToolCall = z.infer<typeof toolCallSchema>;

/** A tool call reduced to the only three things the route cares about. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * Flattens either supported tool-call shape into one.
 *
 * Flat fields win over nested ones when both are present, and `arguments` wins
 * over `parameters`. Some providers send the arguments as a JSON string rather
 * than an object, so that is parsed here too; unparseable arguments become
 * undefined, which the caller turns into a tool-level error.
 */
export function normalizeToolCall(toolCall: VapiToolCall): NormalizedToolCall {
  // The schema guarantees one of these is set; ?? "" keeps the type a string.
  const name = toolCall.name ?? toolCall.function?.name ?? "";

  const raw =
    toolCall.arguments ??
    toolCall.parameters ??
    toolCall.function?.arguments ??
    toolCall.function?.parameters;

  return { id: toolCall.id, name, arguments: parseArguments(raw) };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
