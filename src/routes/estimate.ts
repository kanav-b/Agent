import { randomUUID } from "node:crypto";
import { Router } from "express";
import { estimateRequestSchema } from "../schemas/estimate.js";
import { getEstimate, UnsupportedServiceError, type Estimate } from "../pricing/estimate.js";
import { SUPPORTED_SERVICES } from "../pricing/catalog.js";

/** What the API sends back: the price estimate plus an ID for tracking it. */
export type EstimateResponse = Estimate & { estimateId: string };

export const estimateRouter = Router();

estimateRouter.post("/estimate", (req, res) => {
  const parsed = estimateRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten()
    });
  }

  // businessId is validated and defaulted here, but nothing uses it yet. It is
  // in place so a future multi-business version has it on every request.
  const { service, vehicle } = parsed.data;

  try {
    const estimate = getEstimate(service, vehicle);
    const response: EstimateResponse = { estimateId: randomUUID(), ...estimate };
    return res.status(200).json(response);
  } catch (err) {
    if (err instanceof UnsupportedServiceError) {
      return res.status(400).json({
        error: `Service "${service}" is not supported.`,
        supportedServices: SUPPORTED_SERVICES
      });
    }
    throw err;
  }
});
