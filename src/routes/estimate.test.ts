import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

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
