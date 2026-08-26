import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the database is stubbed, so the real resolver and the real generator
// both run.
vi.mock("../db/businesses.js", () => ({
  getBusiness: vi.fn(),
  getBusinessHours: vi.fn(),
  getBusinessService: vi.fn(),
  getActiveBusinessServices: vi.fn()
}));

import {
  getActiveBusinessServices,
  getBusiness,
  getBusinessHours
} from "../db/businesses.js";
import { loadBusinessAssistantConfig } from "./load.js";

const mockGetBusiness = vi.mocked(getBusiness);
const mockGetHours = vi.mocked(getBusinessHours);
const mockGetActive = vi.mocked(getActiveBusinessServices);

const joesGarage = {
  id: "joes-garage",
  name: "Joe's Garage",
  phone: null,
  notificationPhone: "+15559990000",
  timezone: "America/New_York",
  afterHoursMessage: null,
  isActive: true
};

const hours = [
  { dayOfWeek: 1, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
  { dayOfWeek: 6, openTime: null, closeTime: null, isClosed: true }
];

const service = (serviceKey: string, displayName: string) => ({
  serviceKey,
  displayName,
  lowPrice: 300,
  highPrice: 450,
  currency: "USD",
  disclaimer: "Final pricing is subject to vehicle inspection.",
  isActive: true
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBusiness.mockResolvedValue(joesGarage);
  mockGetHours.mockResolvedValue(hours);
  mockGetActive.mockResolvedValue([service("front_brake_pads", "Front Brake Pads")]);
});

describe("loadBusinessAssistantConfig", () => {
  it("generates a config for a known, active business", async () => {
    const result = await loadBusinessAssistantConfig("joes-garage");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.assistantName).toBe("Joe's Garage Receptionist");
    }
  });

  it("rejects an unknown business", async () => {
    mockGetBusiness.mockResolvedValue(null);

    expect(await loadBusinessAssistantConfig("no-such-shop")).toEqual({
      ok: false,
      problem: "not_found"
    });
  });

  it("rejects an inactive business", async () => {
    mockGetBusiness.mockResolvedValue({ ...joesGarage, isActive: false });

    expect(await loadBusinessAssistantConfig("joes-garage")).toEqual({
      ok: false,
      problem: "inactive"
    });
  });

  it("generates nothing at all for an inactive business", async () => {
    mockGetBusiness.mockResolvedValue({ ...joesGarage, isActive: false });

    await loadBusinessAssistantConfig("joes-garage");

    // Not even the service list is fetched for a shop that cannot be used.
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  it("never falls back to the default shop when an explicit id was given", async () => {
    mockGetBusiness.mockResolvedValue(null);

    const result = await loadBusinessAssistantConfig("joes-garage");

    expect(result.ok).toBe(false);
    expect(mockGetBusiness).toHaveBeenCalledWith("joes-garage");
    expect(mockGetBusiness).not.toHaveBeenCalledWith("demo-shop");
  });

  it("preserves the businessId through to the prompt", async () => {
    const result = await loadBusinessAssistantConfig("joes-garage");

    expect(result.ok && result.config.businessId).toBe("joes-garage");
    expect(result.ok && result.config.systemPrompt).toContain('businessId = "joes-garage"');
  });

  it("passes the hours through", async () => {
    const result = await loadBusinessAssistantConfig("joes-garage");

    expect(result.ok && result.config.systemPrompt).toContain("Monday: 8:00 AM-5:00 PM");
    expect(result.ok && result.config.systemPrompt).toContain("Saturday: Closed");
  });

  it("passes only active services through", async () => {
    mockGetActive.mockResolvedValue([
      service("front_brake_pads", "Front Brake Pads"),
      service("diagnostic", "Diagnostic")
    ]);

    const result = await loadBusinessAssistantConfig("joes-garage");

    expect(result.ok && result.config.supportedServices).toEqual([
      { serviceKey: "front_brake_pads", displayName: "Front Brake Pads" },
      { serviceKey: "diagnostic", displayName: "Diagnostic" }
    ]);
    // The query itself filters on is_active, so nothing inactive can arrive.
    expect(mockGetActive).toHaveBeenCalledWith("joes-garage");
  });

  it("reuses the shared queries rather than its own", async () => {
    await loadBusinessAssistantConfig("joes-garage");

    expect(mockGetBusiness).toHaveBeenCalledTimes(1);
    expect(mockGetHours).toHaveBeenCalledTimes(1);
    expect(mockGetActive).toHaveBeenCalledTimes(1);
  });

  it("keeps the shop's notification number out of the generated config", async () => {
    const result = await loadBusinessAssistantConfig("joes-garage");

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("+15559990000");
    expect(serialised).not.toContain("notificationPhone");
  });

  it("carries the after-hours message when the shop has one", async () => {
    mockGetBusiness.mockResolvedValue({
      ...joesGarage,
      afterHoursMessage: "We reopen at 8am sharp."
    });

    const result = await loadBusinessAssistantConfig("joes-garage");

    expect(result.ok && result.config.systemPrompt).toContain("We reopen at 8am sharp.");
  });

  it("makes no network call of its own", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await loadBusinessAssistantConfig("joes-garage");

    // Everything it needs comes through the stubbed query layer.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
