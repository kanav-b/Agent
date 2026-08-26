import {
  getActiveBusinessServices,
  getBusiness,
  getBusinessHours,
  getBusinessService,
  type BusinessHoursRow
} from "../db/businesses.js";
import type { ServicePricing } from "../pricing/estimate.js";

/**
 * Resolves which shop a request belongs to and what it charges.
 *
 * Everything a route needs to know about a business comes through here, so
 * routes never write a query and never carry a hardcoded price, name, or
 * phone number.
 */

/**
 * A shop's configuration, in a shape that owes nothing to Vapi or to the
 * database. A later phase can use it to configure an assistant; nothing here
 * depends on that happening.
 */
export interface BusinessConfig {
  id: string;
  name: string;
  phone: string | null;
  timezone: string;
  afterHoursMessage: string | null;
  isActive: boolean;
  hours: BusinessHoursRow[];
  /** Optional, and only ever the shop's public address — never a caller's. */
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

/** Why a business could not be used. Both are the caller's problem, not ours. */
export type BusinessProblem = "not_found" | "inactive";

export type BusinessResolution =
  | { ok: true; business: BusinessConfig }
  | { ok: false; problem: BusinessProblem };

/**
 * Confirms a business exists and is switched on, and loads its configuration.
 *
 * An unknown or inactive shop stops the request before anything is priced or
 * stored — a `businessId` is no longer just a string that fails later.
 */
export async function resolveBusiness(businessId: string): Promise<BusinessResolution> {
  const business = await getBusiness(businessId);

  if (!business) {
    return { ok: false, problem: "not_found" };
  }

  if (!business.isActive) {
    return { ok: false, problem: "inactive" };
  }

  const hours = await getBusinessHours(businessId);

  return {
    ok: true,
    business: {
      id: business.id,
      name: business.name,
      phone: business.phone,
      timezone: business.timezone,
      afterHoursMessage: business.afterHoursMessage,
      isActive: business.isActive,
      hours,
      addressLine1: business.addressLine1 ?? null,
      addressLine2: business.addressLine2 ?? null,
      city: business.city ?? null,
      state: business.state ?? null,
      postalCode: business.postalCode ?? null
    }
  };
}

/** Why a service could not be priced. Both look the same to a caller. */
export type ServiceProblem = "unknown_service" | "inactive_service";

export type ServiceResolution =
  | { ok: true; pricing: ServicePricing }
  | { ok: false; problem: ServiceProblem };

/**
 * Looks up what this shop charges for a service.
 *
 * A service the shop has never offered and one it has switched off are
 * reported separately here, so the reason is visible in logs and tests, but
 * both mean the same thing to a caller: we cannot quote for that.
 */
export async function resolveServicePricing(
  businessId: string,
  serviceKey: string
): Promise<ServiceResolution> {
  const service = await getBusinessService(businessId, serviceKey);

  if (!service) {
    return { ok: false, problem: "unknown_service" };
  }

  if (!service.isActive) {
    return { ok: false, problem: "inactive_service" };
  }

  return {
    ok: true,
    pricing: {
      serviceKey: service.serviceKey,
      low: service.lowPrice,
      high: service.highPrice,
      currency: service.currency,
      disclaimer: service.disclaimer
    }
  };
}

/**
 * The service keys this shop currently offers.
 *
 * Used to tell a caller what we *can* quote for. There is no public endpoint
 * for it: the assistant's tool schema still carries a fixed list, and the
 * backend stays the authority on what is actually available.
 */
export async function listAvailableServiceKeys(businessId: string): Promise<string[]> {
  const services = await getActiveBusinessServices(businessId);
  return services.map((service) => service.serviceKey);
}
