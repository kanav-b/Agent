import { z } from "zod";

export const vehicleSchema = z.object({
  year: z.number().int().gte(1900).lte(2100),
  make: z.string().min(1),
  model: z.string().min(1)
});

export const estimateRequestSchema = z.object({
  service: z.string().min(1),
  vehicle: vehicleSchema
});

export type EstimateRequest = z.infer<typeof estimateRequestSchema>;
