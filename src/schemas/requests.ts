import { z } from "zod";
import { DEFAULT_BUSINESS_ID } from "./estimate.js";

/**
 * What the assistant may send when a caller asks for an appointment or a
 * callback.
 *
 * Everything the caller might not have said is optional. Nothing is invented:
 * a field the assistant does not supply is stored as null.
 */

const customerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional()
});

const vehicleSchema = z.object({
  year: z.number().int().gte(1900).lte(2100).optional(),
  make: z.string().min(1).optional(),
  model: z.string().min(1).optional()
});

/** A real calendar date written as YYYY-MM-DD. */
const preferredDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => {
    // Rejects 2026-02-31, which matches the pattern but is not a real day.
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, "Not a real date.");

export const appointmentRequestSchema = z
  .object({
    businessId: z.string().min(1).default(DEFAULT_BUSINESS_ID),
    customer: customerSchema.optional(),
    /**
     * Whether the caller explicitly agreed, on this call, to a confirmation
     * text. A phone number on its own is never consent, and this applies only
     * to this one request — it is not standing permission to text them.
     */
    customerSmsConsent: z.boolean().default(false),

    vehicle: vehicleSchema.optional(),
    service: z.string().min(1).optional(),
    problemDescription: z.string().min(1).optional(),
    preferredDate: preferredDateSchema.optional(),
    // Deliberately free text: "morning", "after work", "around 2 PM". The
    // backend stores it verbatim and never turns it into a real time.
    preferredTimeText: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    // A request the shop cannot act on is worse than no request at all, so
    // there has to be both a reason to come in and some idea of when.
    if (!value.service && !value.problemDescription) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either a service or a description of the problem."
      });
    }

    if (!value.preferredDate && !value.preferredTimeText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either a preferred date or a preferred time."
      });
    }
  });

export type AppointmentRequestInput = z.infer<typeof appointmentRequestSchema>;

export const callbackRequestSchema = z.object({
  businessId: z.string().min(1).default(DEFAULT_BUSINESS_ID),
  customer: customerSchema.optional(),
  /**
   * Whether the caller explicitly agreed, on this call, to a confirmation
   * text. A phone number on its own is never consent, and this applies only
   * to this one request — it is not standing permission to text them.
   */
  customerSmsConsent: z.boolean().default(false),

  // Recommended, not required: a caller may just ask to be rung back.
  reason: z.string().min(1).optional(),
  // Must carry a timezone, so the stored instant is unambiguous.
  preferredCallbackAt: z
    .string()
    .datetime({ offset: true, message: "Use an ISO datetime including a timezone, e.g. 2026-08-20T14:00:00Z." })
    .optional()
});

export type CallbackRequestInput = z.infer<typeof callbackRequestSchema>;
