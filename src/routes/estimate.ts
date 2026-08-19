import { randomUUID } from "node:crypto";
import { Router } from "express";
import { estimateRequestSchema } from "../schemas/estimate.js";
import { getEstimate, UnsupportedServiceError, type Estimate } from "../pricing/estimate.js";
import { SUPPORTED_SERVICES } from "../pricing/catalog.js";
import { persistEstimate } from "../db/estimates.js";

/** What the API sends back: the price estimate plus an ID for tracking it. */
export type EstimateResponse = Estimate & { estimateId: string };

export const estimateRouter = Router();

estimateRouter.post("/estimate", async (req, res) => {
  const parsed = estimateRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten()
    });
  }

  const { businessId, service, vehicle } = parsed.data;

  // Step 1: work out the price. Nothing is stored yet, so an unsupported
  // service leaves the database untouched.
  let estimate: Estimate;
  try {
    estimate = getEstimate(service, vehicle);
  } catch (err) {
    if (err instanceof UnsupportedServiceError) {
      return res.status(400).json({
        error: `Service "${service}" is not supported.`,
        supportedServices: SUPPORTED_SERVICES
      });
    }
    throw err;
  }

  // Step 2: store it. The id is generated here, at the response boundary, so
  // getEstimate stays deterministic.
  const estimateId = randomUUID();

  try {
    await persistEstimate({ estimateId, businessId, vehicle, estimate, source: "api" });
  } catch {
    return res.status(500).json({ error: "Could not save the estimate. Please try again." });
  }

  const response: EstimateResponse = { estimateId, ...estimate };
  return res.status(200).json(response);
});
