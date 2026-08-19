import { z } from "zod";

/**
 * The envelope Vapi POSTs to a server-events URL.
 *
 * Vapi sends many event types and the shape varies by call type and version,
 * so almost everything here is optional. Only what we genuinely need is
 * required: a message with a type, and — for an end-of-call report — a call id.
 * Unknown fields pass through untouched rather than causing a rejection.
 */

const customerSchema = z
  .object({
    number: z.string().min(1).optional(),
    name: z.string().min(1).optional()
  })
  .passthrough();

/** Only the handful of call fields we read. Everything else is ignored. */
const callSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    customer: customerSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
    assistantOverrides: z
      .object({ metadata: z.record(z.unknown()).optional() })
      .passthrough()
      .optional()
  })
  .passthrough();

const artifactMessageSchema = z
  .object({
    role: z.string().optional(),
    message: z.string().optional(),
    content: z.string().optional()
  })
  .passthrough();

/**
 * Any Vapi event. `type` decides what we do with it; everything else is
 * optional so an unsupported event never fails validation.
 */
export const vapiEventSchema = z.object({
  message: z
    .object({
      type: z.string().min(1),
      call: callSchema.optional(),
      customer: customerSchema.optional(),
      endedReason: z.string().optional(),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      artifact: z
        .object({
          transcript: z.string().optional(),
          messages: z.array(artifactMessageSchema).optional()
        })
        .passthrough()
        .optional(),
      analysis: z
        .object({ summary: z.string().optional() })
        .passthrough()
        .optional()
    })
    .passthrough()
});

export type VapiEvent = z.infer<typeof vapiEventSchema>;
export type VapiEventMessage = VapiEvent["message"];

/** The only event Phase 6 acts on. */
export const END_OF_CALL_REPORT = "end-of-call-report";

/**
 * An end-of-call report we can actually use.
 *
 * The generic schema leaves `call` optional because other event types do not
 * always have one. For an end-of-call report the call id is the primary key of
 * everything we store, so it is required here.
 */
export const endOfCallReportSchema = z.object({
  message: z
    .object({
      type: z.literal(END_OF_CALL_REPORT),
      call: callSchema
    })
    .passthrough()
});
