import { SERVICE_CATALOG, isSupportedService, type ServiceName } from "./catalog.js";

export interface Vehicle {
  year: number;
  make: string;
  model: string;
}

export interface Estimate {
  estimateType: "preliminary";
  service: ServiceName;
  vehicle: Vehicle;
  low: number;
  high: number;
  currency: "USD";
  disclaimer: string;
}

export class UnsupportedServiceError extends Error {
  constructor(public readonly service: string) {
    super(`Service "${service}" is not supported.`);
    this.name = "UnsupportedServiceError";
  }
}

const DISCLAIMER = "Final pricing is subject to vehicle inspection.";

/**
 * Works out the price range for a service.
 *
 * This function is deterministic on purpose: the same service and vehicle
 * always produce the same result. That is why it does not generate the
 * estimateId — an ID is tracking metadata, not part of the price calculation.
 * The route adds the ID after calling this.
 */
export function getEstimate(service: string, vehicle: Vehicle): Estimate {
  if (!isSupportedService(service)) {
    throw new UnsupportedServiceError(service);
  }

  const { low, high } = SERVICE_CATALOG[service];

  return {
    estimateType: "preliminary",
    service,
    vehicle,
    low,
    high,
    currency: "USD",
    disclaimer: DISCLAIMER
  };
}
