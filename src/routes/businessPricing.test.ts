import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Pricing driven by a shop's own configuration, exercised through the routes.
 *
 * Only the database layer is stubbed, so the real resolver and the real
 * pricing calculation both run.
 */

vi.mock("../db/businesses.js", () => ({
  getBusiness: vi.fn(),
  getBusinessHours: vi.fn(),
  getBusinessService: vi.fn(),
  getActiveBusinessServices: vi.fn()
}));
vi.mock("../db/estimates.js", () => ({ persistEstimate: vi.fn() }));

import { createApp } from "../app.js";
import {
  getActiveBusinessServices,
  getBusiness,
  getBusinessHours,
  getBusinessService
} from "../db/businesses.js";
import { persistEstimate } from "../db/estimates.js";
import { VAPI_SECRET_HEADER } from "../middleware/vapiAuth.js";

const mockGetBusiness = vi.mocked(getBusiness);
const mockGetHours = vi.mocked(getBusinessHours);
const mockGetService = vi.mocked(getBusinessService);
const mockGetActive = vi.mocked(getActiveBusinessServices);
const mockPersist = vi.mocked(persistEstimate);

const TEST_SECRET = "test-vapi-secret-not-real";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = TEST_SECRET;

const app = createApp();
const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

const shop = {
  id: "demo-shop",
  name: "Demo Auto Repair",
  phone: null,
  notificationPhone: null,
  timezone: "America/Los_Angeles",
  afterHoursMessage: null,
  isActive: true
};

/** This shop charges its own prices, not the ones the code used to hardcode. */
const brakePads = {
  serviceKey: "front_brake_pads",
  displayName: "Front Brake Pads",
  lowPrice: 275,
  highPrice: 400,
  currency: "USD",
  disclaimer: "Prices confirmed after inspection at Demo Auto Repair.",
  isActive: true
};

const apiEstimate = (body: object) => request(app).post("/api/estimate").send(body);

const toolEstimate = (args: Record<string, unknown>) =>
  request(app)
    .post("/api/vapi/tools/estimate")
    .set(VAPI_SECRET_HEADER, TEST_SECRET)
    .send({
      message: {
        type: "tool-calls",
        toolCallList: [{ id: "tc-1", name: "calculate_estimate", arguments: args }]
      }
    });

const toolPayload = (res: { body: { results: { result: string }[] } }) =>
  JSON.parse(res.body.results[0].result);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBusiness.mockResolvedValue(shop);
  mockGetHours.mockResolvedValue([]);
  mockGetService.mockResolvedValue(brakePads);
  mockGetActive.mockResolvedValue([brakePads]);
  mockPersist.mockImplementation(async (input) => ({
    estimateId: input.estimateId,
    reused: false
  }));
});

describe("prices come from the shop's configuration", () => {
  it("POST /api/estimate uses the shop's prices", async () => {
    const res = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(res.body.low).toBe(275);
    expect(res.body.high).toBe(400);
    expect(res.body.disclaimer).toBe("Prices confirmed after inspection at Demo Auto Repair.");
  });

  it("the Vapi tool uses the same shop prices", async () => {
    const res = await toolEstimate({ service: "front_brake_pads", vehicle });

    expect(toolPayload(res).low).toBe(275);
    expect(toolPayload(res).high).toBe(400);
  });

  it("both routes agree", async () => {
    const viaApi = await apiEstimate({ service: "front_brake_pads", vehicle });
    const viaTool = await toolEstimate({ service: "front_brake_pads", vehicle });

    const parsed = toolPayload(viaTool);
    expect(parsed.low).toBe(viaApi.body.low);
    expect(parsed.high).toBe(viaApi.body.high);
    expect(parsed.currency).toBe(viaApi.body.currency);
    expect(parsed.disclaimer).toBe(viaApi.body.disclaimer);
  });

  it("a different shop's configuration produces a different price", async () => {
    mockGetService.mockResolvedValue({ ...brakePads, lowPrice: 500, highPrice: 650 });

    const res = await apiEstimate({ businessId: "other-shop", service: "front_brake_pads", vehicle });

    expect(res.body.low).toBe(500);
    expect(res.body.high).toBe(650);
  });

  it("keeps the response format unchanged", async () => {
    const res = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(Object.keys(res.body).sort()).toEqual(
      [
        "currency",
        "disclaimer",
        "estimateId",
        "estimateType",
        "high",
        "low",
        "service",
        "vehicle"
      ].sort()
    );
    expect(res.body.estimateType).toBe("preliminary");
    expect(res.body.vehicle).toEqual(vehicle);
  });

  it("still returns a fresh estimateId per request", async () => {
    const first = await apiEstimate({ service: "front_brake_pads", vehicle });
    const second = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(first.body.estimateId).toBeTypeOf("string");
    expect(first.body.estimateId).not.toBe(second.body.estimateId);
  });

  it("still records the Vapi call id on the estimate", async () => {
    await request(app)
      .post("/api/vapi/tools/estimate")
      .set(VAPI_SECRET_HEADER, TEST_SECRET)
      .send({
        message: {
          type: "tool-calls",
          call: { id: "vapi-call-9" },
          toolCallList: [
            {
              id: "tc-1",
              name: "calculate_estimate",
              arguments: { service: "front_brake_pads", vehicle }
            }
          ]
        }
      });

    expect(mockPersist.mock.calls[0][0].vapiCallId).toBe("vapi-call-9");
    expect(mockPersist.mock.calls[0][0].vapiToolCallId).toBe("tc-1");
  });

  it("still returns the original estimate on a retry", async () => {
    mockPersist.mockResolvedValue({ estimateId: "original-estimate", reused: true });

    const res = await toolEstimate({ service: "front_brake_pads", vehicle });

    expect(toolPayload(res).estimateId).toBe("original-estimate");
  });
});

describe("a shop that cannot be used", () => {
  it("rejects an unknown business without persisting", async () => {
    mockGetBusiness.mockResolvedValue(null);

    const res = await apiEstimate({ businessId: "no-such-shop", service: "front_brake_pads", vehicle });

    expect(res.status).toBe(400);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("rejects an inactive business without persisting", async () => {
    mockGetBusiness.mockResolvedValue({ ...shop, isActive: false });

    const res = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(400);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("never prices for an inactive business", async () => {
    mockGetBusiness.mockResolvedValue({ ...shop, isActive: false });

    const res = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(res.body.low).toBeUndefined();
    expect(mockGetService).not.toHaveBeenCalled();
  });

  it("gives the Vapi tool a spoken error for an unknown business", async () => {
    mockGetBusiness.mockResolvedValue(null);

    const res = await toolEstimate({ businessId: "no-such-shop", service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toMatch(/not available/i);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("leaks nothing about the database when a lookup fails", async () => {
    mockGetBusiness.mockRejectedValue(new Error("relation businesses does not exist"));

    const res = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/relation|businesses does not exist|\.ts:/);
  });
});

describe("a service the shop does not offer", () => {
  it("rejects an unknown service without persisting", async () => {
    mockGetService.mockResolvedValue(null);

    const res = await apiEstimate({ service: "engine_rebuild", vehicle });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("rejects a service the shop switched off, without persisting", async () => {
    mockGetService.mockResolvedValue({ ...brakePads, isActive: false });

    const res = await apiEstimate({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("lists what the shop does offer", async () => {
    mockGetService.mockResolvedValue(null);
    mockGetActive.mockResolvedValue([brakePads, { ...brakePads, serviceKey: "diagnostic" }]);

    const res = await apiEstimate({ service: "engine_rebuild", vehicle });

    expect(res.body.supportedServices).toEqual(["front_brake_pads", "diagnostic"]);
  });

  it("tells the assistant what is available instead", async () => {
    mockGetService.mockResolvedValue(null);

    const res = await toolEstimate({ service: "engine_rebuild", vehicle });

    expect(res.body.results[0].error).toMatch(/front_brake_pads/);
    expect(mockPersist).not.toHaveBeenCalled();
  });
});
