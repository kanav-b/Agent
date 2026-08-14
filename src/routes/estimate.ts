import { Router } from "express";
import { estimateRequestSchema } from "../schemas/estimate.js";
import { getEstimate, UnsupportedServiceError } from "../pricing/estimate.js";
import { SUPPORTED_SERVICES } from "../pricing/catalog.js";

export const estimateRouter = Router();

estimateRouter.post("/estimate", (req, res) => {
  const parsed = estimateRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten()
    });
  }

  const { service, vehicle } = parsed.data;

  try {
    const estimate = getEstimate(service, vehicle);
    return res.status(200).json(estimate);
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
