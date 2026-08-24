import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The database is replaced with a stub, so these tests never reach the network
// and never need Supabase credentials.
vi.mock("../db/estimates.js", () => ({
  persistEstimate: vi.fn()
}));

vi.mock("../business/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../business/config.js")>();
  return {
    ...actual,
    resolveBusiness: vi.fn(async (id: string) => ({
      ok: true as const,
      business: {
        id,
        name: "Demo Auto Repair",
        phone: null,
        timezone: "America/Los_Angeles",
        afterHoursMessage: null,
        isActive: true,
        hours: []
      }
    })),
    resolveServicePricing: vi.fn(async (_businessId: string, serviceKey: string) => {
      const catalog: Record<string, { low: number; high: number }> = {
        synthetic_oil_change: { low: 80, high: 120 },
        front_brake_pads: { low: 300, high: 450 },
        battery_replacement: { low: 190, high: 340 },
        diagnostic: { low: 149, high: 149 },
        tire_rotation: { low: 40, high: 60 }
      };
      const found = catalog[serviceKey];
      if (!found) {
        return { ok: false as const, problem: "unknown_service" as const };
      }
      return {
        ok: true as const,
        pricing: {
          serviceKey,
          low: found.low,
          high: found.high,
          currency: "USD",
          disclaimer: "Final pricing is subject to vehicle inspection."
        }
      };
    }),
    listAvailableServiceKeys: vi.fn(async () => [
      "battery_replacement",
      "diagnostic",
      "front_brake_pads",
      "synthetic_oil_change",
      "tire_rotation"
    ])
  };
});

import { createApp } from "../app.js";
import { persistEstimate } from "../db/estimates.js";

const mockPersist = vi.mocked(persistEstimate);

const app = createApp();

beforeEach(() => {
  mockPersist.mockReset();
  mockPersist.mockImplementation(async (input) => ({
    estimateId: input.estimateId,
    reused: false
  }));
});

const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

// Matches the shape of a v4 UUID, which is what crypto.randomUUID() produces.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const priceFields = (body: Record<string, unknown>) => ({
  estimateType: body.estimateType,
  service: body.service,
  vehicle: body.vehicle,
  low: body.low,
  high: body.high,
  currency: body.currency,
  disclaimer: body.disclaimer
});

describe("POST /api/estimate", () => {
  it("returns a preliminary estimate when businessId is omitted", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(priceFields(res.body)).toEqual({
      estimateType: "preliminary",
      service: "front_brake_pads",
      vehicle,
      low: 300,
      high: 450,
      currency: "USD",
      disclaimer: "Final pricing is subject to vehicle inspection."
    });
  });

  it("accepts an explicit businessId", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ businessId: "demo-shop", service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(res.body.low).toBe(300);
    expect(res.body.high).toBe(450);
  });

  it("returns the same prices with and without businessId", async () => {
    const withoutId = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });
    const withId = await request(app)
      .post("/api/estimate")
      .send({ businessId: "another-shop", service: "front_brake_pads", vehicle });

    expect(priceFields(withId.body)).toEqual(priceFields(withoutId.body));
  });

  it("rejects an empty businessId", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ businessId: "", service: "front_brake_pads", vehicle });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body.");
  });

  it("includes a valid, non-empty estimateId", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.body.estimateId).toBeTypeOf("string");
    expect(res.body.estimateId.length).toBeGreaterThan(0);
    expect(res.body.estimateId).toMatch(UUID_PATTERN);
  });

  it("gives two separate requests different estimateIds", async () => {
    const first = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });
    const second = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(first.body.estimateId).not.toBe(second.body.estimateId);
  });

  it("returns identical prices for identical requests", async () => {
    const first = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });
    const second = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(priceFields(first.body)).toEqual(priceFields(second.body));
  });

  it("returns 400 for an unsupported service", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "engine_rebuild", vehicle });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/);
    expect(res.body.supportedServices).toContain("front_brake_pads");
  });

  it("returns 400 for an invalid request body", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({
        service: "front_brake_pads",
        vehicle: { year: "not-a-number", make: "Toyota", model: "Camry" }
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body.");
  });
});

describe("POST /api/estimate persistence", () => {
  it("saves the estimate before responding", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });

  it("passes the defaulted businessId", async () => {
    await request(app).post("/api/estimate").send({ service: "front_brake_pads", vehicle });

    expect(mockPersist.mock.calls[0][0].businessId).toBe("demo-shop");
  });

  it("passes an explicit businessId through", async () => {
    await request(app)
      .post("/api/estimate")
      .send({ businessId: "other-shop", service: "front_brake_pads", vehicle });

    expect(mockPersist.mock.calls[0][0].businessId).toBe("other-shop");
  });

  it("passes the vehicle data", async () => {
    await request(app).post("/api/estimate").send({ service: "front_brake_pads", vehicle });

    expect(mockPersist.mock.calls[0][0].vehicle).toEqual(vehicle);
  });

  it("persists the same estimateId it returns", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(mockPersist.mock.calls[0][0].estimateId).toBe(res.body.estimateId);
  });

  it("persists the calculated prices", async () => {
    await request(app).post("/api/estimate").send({ service: "front_brake_pads", vehicle });

    const { estimate } = mockPersist.mock.calls[0][0];
    expect(estimate.low).toBe(300);
    expect(estimate.high).toBe(450);
  });

  it('persists source "api"', async () => {
    await request(app).post("/api/estimate").send({ service: "front_brake_pads", vehicle });

    expect(mockPersist.mock.calls[0][0].source).toBe("api");
  });

  it("does not send a vapiToolCallId", async () => {
    await request(app).post("/api/estimate").send({ service: "front_brake_pads", vehicle });

    expect(mockPersist.mock.calls[0][0].vapiToolCallId).toBeUndefined();
  });

  it("fails with 500 and no estimate when the database fails", async () => {
    mockPersist.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(500);
    expect(res.body.estimateId).toBeUndefined();
    expect(res.body.low).toBeUndefined();
  });

  it("does not leak internal detail when the database fails", async () => {
    mockPersist.mockRejectedValueOnce(new Error("password=hunter2 at /src/db/estimates.ts:42"));

    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.body.error).toBe("Could not save the estimate. Please try again.");
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|\.ts:/);
  });

  it("persists nothing for an unsupported service", async () => {
    await request(app).post("/api/estimate").send({ service: "engine_rebuild", vehicle });

    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("persists nothing for a malformed request", async () => {
    await request(app).post("/api/estimate").send({ service: "front_brake_pads" });

    expect(mockPersist).not.toHaveBeenCalled();
  });
});
