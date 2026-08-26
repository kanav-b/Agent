import { resolveBusiness, type BusinessProblem } from "../business/config.js";
import { getActiveBusinessServices } from "../db/businesses.js";
import {
  buildBusinessAssistantConfig,
  type BusinessAssistantConfig
} from "./generate.js";

/**
 * Loads a shop's configuration and hands it to the pure generator.
 *
 * This is the only part of assistant generation that touches the database.
 * It reuses the Phase 9 queries rather than writing its own, so there is one
 * definition of what "this shop" means.
 *
 * Nothing here talks to Vapi. The result is local configuration, ready for a
 * later phase to publish.
 */

export type AssistantConfigResolution =
  | { ok: true; config: BusinessAssistantConfig }
  | { ok: false; problem: BusinessProblem };

export async function loadBusinessAssistantConfig(
  businessId: string
): Promise<AssistantConfigResolution> {
  // Unknown and switched-off shops are refused here, exactly as they are for
  // pricing. An explicit businessId is never quietly swapped for the default.
  const resolution = await resolveBusiness(businessId);

  if (!resolution.ok) {
    return { ok: false, problem: resolution.problem };
  }

  const { business } = resolution;
  const services = await getActiveBusinessServices(businessId);

  return {
    ok: true,
    config: buildBusinessAssistantConfig({
      business: {
        id: business.id,
        name: business.name,
        timezone: business.timezone,
        phone: business.phone,
        addressLine1: business.addressLine1,
        addressLine2: business.addressLine2,
        city: business.city,
        state: business.state,
        postalCode: business.postalCode,
        afterHoursMessage: business.afterHoursMessage
      },
      hours: business.hours,
      // Only active services reach the generator, so an inactive one can never
      // appear in a prompt.
      services: services.map((service) => ({
        serviceKey: service.serviceKey,
        displayName: service.displayName
      }))
    })
  };
}
