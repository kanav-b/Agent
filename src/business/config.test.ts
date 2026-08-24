import { beforeEach, describe, expect, it, vi } from "vitest";

// The database layer is stubbed: this is about resolution logic, not queries.
vi.mock("../db/businesses.js", () => ({
  getBusiness: vi.fn(),
  getBusinessHours: vi.fn(),
  getBusinessService: vi.fn(),
  getActiveBusinessServices: vi.fn()
}));

import {
  getActiveBusinessServices,
  getBusiness,
  getBusinessHours,
  getBusinessService
} from "../db/businesses.js";
import { listAvailableServiceKeys, resolveBusiness, resolveServicePricing } from "./config.js";
import { buildEstimate } from "../pricing/estimate.js";

const mockGetBusiness = vi.mocked(getBusiness);
const mockGetHours = vi.mocked(getBusinessHours);
const mockGetService = vi.mocked(getBusinessService);
const mockGetActive = vi.mocked(getActiveBusinessServices);

const demoShop = {
  id: "demo-shop",
  name: "Demo Auto Repair",
  phone: null,
  notificationPhone: null,
  timezone: "America/Los_Angeles",
  afterHoursMessage: null,
  isActive: true
};

const brakePads = {
  serviceKey: "front_brake_pads",
  displayName: "Front Brake Pads",
  lowPrice: 300,
  highPrice: 450,
  currency: "USD",
  disclaimer: "Final pricing is subject to vehicle inspection.",
  isActive: true
};

const hours = [{ dayOfWeek: 1, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false }];

const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBusiness.mockResolvedValue(demoShop);
  mockGetHours.mockResolvedValue(hours);
  mockGetService.mockResolvedValue(brakePads);
  mockGetActive.mockResolvedValue([brakePads]);
});

describe("resolveBusiness", () => {
  it("resolves the demo business", async () => {
    const result = await resolveBusiness("demo-shop");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.business.id).toBe("demo-shop");
      expect(result.business.name).toBe("Demo Auto Repair");
    }
  });

  it("rejects an unknown business", async () => {
    mockGetBusiness.mockResolvedValue(null);

    expect(await resolveBusiness("no-such-shop")).toEqual({ ok: false, problem: "not_found" });
  });

  it("rejects an inactive business", async () => {
    mockGetBusiness.mockResolvedValue({ ...demoShop, isActive: false });

    expect(await resolveBusiness("demo-shop")).toEqual({ ok: false, problem: "inactive" });
  });

  it("does not load hours for a business it rejects", async () => {
    mockGetBusiness.mockResolvedValue({ ...demoShop, isActive: false });

    await resolveBusiness("demo-shop");

    expect(mockGetHours).not.toHaveBeenCalled();
  });

  it("returns the configured timezone", async () => {
    mockGetBusiness.mockResolvedValue({ ...demoShop, timezone: "America/New_York" });

    const result = await resolveBusiness("demo-shop");

    expect(result.ok && result.business.timezone).toBe("America/New_York");
  });

  it("returns the business hours", async () => {
    const result = await resolveBusiness("demo-shop");

    expect(result.ok && result.business.hours).toEqual(hours);
  });

  it("carries the after-hours message and phone through", async () => {
    mockGetBusiness.mockResolvedValue({
      ...demoShop,
      phone: "+15550001111",
      afterHoursMessage: "We are closed until 8am."
    });

    const result = await resolveBusiness("demo-shop");

    expect(result.ok && result.business.phone).toBe("+15550001111");
    expect(result.ok && result.business.afterHoursMessage).toBe("We are closed until 8am.");
  });
});

describe("resolveServicePricing", () => {
  it("resolves an active service", async () => {
    const result = await resolveServicePricing("demo-shop", "front_brake_pads");

    expect(result).toEqual({
      ok: true,
      pricing: {
        serviceKey: "front_brake_pads",
        low: 300,
        high: 450,
        currency: "USD",
        disclaimer: "Final pricing is subject to vehicle inspection."
      }
    });
  });

  it("rejects a service the shop does not offer", async () => {
    mockGetService.mockResolvedValue(null);

    expect(await resolveServicePricing("demo-shop", "engine_rebuild")).toEqual({
      ok: false,
      problem: "unknown_service"
    });
  });

  it("rejects a service the shop has switched off", async () => {
    mockGetService.mockResolvedValue({ ...brakePads, isActive: false });

    expect(await resolveServicePricing("demo-shop", "front_brake_pads")).toEqual({
      ok: false,
      problem: "inactive_service"
    });
  });

  it("takes the prices from the shop's configuration", async () => {
    mockGetService.mockResolvedValue({ ...brakePads, lowPrice: 275, highPrice: 400 });

    const result = await resolveServicePricing("demo-shop", "front_brake_pads");

    expect(result.ok && result.pricing.low).toBe(275);
    expect(result.ok && result.pricing.high).toBe(400);
  });

  it("changing the configuration changes the estimate", async () => {
    const first = await resolveServicePricing("demo-shop", "front_brake_pads");

    mockGetService.mockResolvedValue({
      ...brakePads,
      lowPrice: 275,
      highPrice: 400,
      currency: "CAD",
      disclaimer: "Different shop, different wording."
    });
    const second = await resolveServicePricing("demo-shop", "front_brake_pads");

    const before = first.ok ? buildEstimate(vehicle, first.pricing) : null;
    const after = second.ok ? buildEstimate(vehicle, second.pricing) : null;

    expect(before?.low).toBe(300);
    expect(after?.low).toBe(275);
    expect(after?.currency).toBe("CAD");
    expect(after?.disclaimer).toBe("Different shop, different wording.");
  });
});

describe("listAvailableServiceKeys", () => {
  it("lists the keys the shop currently offers", async () => {
    mockGetActive.mockResolvedValue([brakePads, { ...brakePads, serviceKey: "diagnostic" }]);

    expect(await listAvailableServiceKeys("demo-shop")).toEqual([
      "front_brake_pads",
      "diagnostic"
    ]);
  });
});

describe("the pricing module stays deterministic", () => {
  it("produces the same estimate for the same config and vehicle", () => {
    const pricing = {
      serviceKey: "front_brake_pads",
      low: 300,
      high: 450,
      currency: "USD",
      disclaimer: "Final pricing is subject to vehicle inspection."
    };

    expect(buildEstimate(vehicle, pricing)).toEqual(buildEstimate(vehicle, pricing));
  });

  it("does not consult the database", async () => {
    const pricing = {
      serviceKey: "front_brake_pads",
      low: 300,
      high: 450,
      currency: "USD",
      disclaimer: "d"
    };

    buildEstimate(vehicle, pricing);

    // Pricing receives resolved config; it never looks anything up itself.
    expect(mockGetBusiness).not.toHaveBeenCalled();
    expect(mockGetService).not.toHaveBeenCalled();
  });
});
