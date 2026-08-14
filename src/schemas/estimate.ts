import { z } from "zod";

export const vehicleSchema = z.object({
  year: z.number().int().gte(1900).lte(2100),
  make: z.string().min(1),
  model: z.string().min(1)
});

export const DEFAULT_BUSINESS_ID = "demo-shop";

export const estimateRequestSchema = z.object({
  // Optional today. Callers that leave it out get the demo shop, so existing
  // requests keep working. It does not affect pricing yet.
  businessId: z.string().min(1).default(DEFAULT_BUSINESS_ID),
  service: z.string().min(1),
  vehicle: vehicleSchema
});

export type EstimateRequest = z.infer<typeof estimateRequestSchema>;
