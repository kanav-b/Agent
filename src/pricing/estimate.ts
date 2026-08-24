import { SERVICE_CATALOG, isSupportedService } from "./catalog.js";

export interface Vehicle {
  year: number;
  make: string;
  model: string;
}

export interface Estimate {
  estimateType: "preliminary";
  /** The service key. A plain string now that shops define their own. */
  service: string;
  vehicle: Vehicle;
  low: number;
  high: number;
  currency: string;
  disclaimer: string;
}

/**
 * One service's prices, already resolved for a particular shop.
 *
 * Whoever calls buildEstimate is responsible for producing this — from the
 * database, from the built-in catalog, or from a test fixture. Nothing in this
 * module knows or cares where it came from.
 */
export interface ServicePricing {
  serviceKey: string;
  low: number;
  high: number;
  currency: string;
  disclaimer: string;
}

export class UnsupportedServiceError extends Error {
  constructor(public readonly service: string) {
    super(`Service "${service}" is not supported.`);
    this.name = "UnsupportedServiceError";
  }
}

/** The wording used by the built-in catalog below. */
export const DEFAULT_DISCLAIMER = "Final pricing is subject to vehicle inspection.";

/**
 * Turns resolved pricing into an estimate.
 *
 * This is the whole pricing calculation, and it is deliberately dull: it does
 * no lookups, reads no clock, and touches no database. Give it the same
 * service pricing and the same vehicle and it returns the same estimate,
 * every time. That is what makes a price something you can reason about and
 * test rather than something that depends on what the network did.
 *
 * Where the prices came from — which shop, which table — is settled before
 * this is called. The estimateId is added after, because an id is tracking
 * metadata rather than part of the price.
 */
export function buildEstimate(vehicle: Vehicle, pricing: ServicePricing): Estimate {
  return {
    estimateType: "preliminary",
    service: pricing.serviceKey,
    vehicle,
    low: pricing.low,
    high: pricing.high,
    currency: pricing.currency,
    disclaimer: pricing.disclaimer
  };
}

/**
 * Prices a service from the built-in default catalog.
 *
 * Kept as the reference catalog the migration seeds a new shop from, and as
 * the simplest way to exercise the calculation. Live requests do not use it:
 * they resolve prices from the shop's own configuration and call
 * buildEstimate directly.
 */
export function getEstimate(service: string, vehicle: Vehicle): Estimate {
  if (!isSupportedService(service)) {
    throw new UnsupportedServiceError(service);
  }

  const { low, high } = SERVICE_CATALOG[service];

  return buildEstimate(vehicle, {
    serviceKey: service,
    low,
    high,
    currency: "USD",
    disclaimer: DEFAULT_DISCLAIMER
  });
}
