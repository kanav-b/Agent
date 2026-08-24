import { randomUUID } from "node:crypto";
import { Router } from "express";
import { estimateRequestSchema } from "../schemas/estimate.js";
import { buildEstimate, type Estimate } from "../pricing/estimate.js";
import { persistEstimate } from "../db/estimates.js";
import {
  listAvailableServiceKeys,
  resolveBusiness,
  resolveServicePricing
} from "../business/config.js";

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

  let estimate: Estimate;

  try {
    // Step 1: which shop is this, and is it open for business at all? An
    // unknown or switched-off shop stops here, before anything is priced.
    const business = await resolveBusiness(businessId);

    if (!business.ok) {
      return res.status(400).json({ error: "This shop is not available." });
    }

    // Step 2: what does *this* shop charge? Prices come from its own
    // configuration; there are none in this file.
    const pricing = await resolveServicePricing(businessId, service);

    if (!pricing.ok) {
      return res.status(400).json({
        error: `Service "${service}" is not supported.`,
        supportedServices: await listAvailableServiceKeys(businessId)
      });
    }

    // Step 3: the calculation itself, which is pure.
    estimate = buildEstimate(vehicle, pricing.pricing);
  } catch {
    // A configuration lookup failed. Say nothing about the database.
    return res.status(500).json({ error: "Could not price the estimate. Please try again." });
  }

  // Step 4: store it. The id is generated here, at the response boundary, so
  // the pricing calculation stays deterministic.
  const estimateId = randomUUID();

  try {
    await persistEstimate({ estimateId, businessId, vehicle, estimate, source: "api" });
  } catch {
    return res.status(500).json({ error: "Could not save the estimate. Please try again." });
  }

  const response: EstimateResponse = { estimateId, ...estimate };
  return res.status(200).json(response);
});
