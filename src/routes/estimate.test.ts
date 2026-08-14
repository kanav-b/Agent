import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

describe("POST /api/estimate", () => {
  it("returns a preliminary estimate for a valid request", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({
        service: "front_brake_pads",
        vehicle: { year: 2019, make: "Toyota", model: "Camry" }
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      estimateType: "preliminary",
      service: "front_brake_pads",
      vehicle: { year: 2019, make: "Toyota", model: "Camry" },
      low: 300,
      high: 450,
      currency: "USD",
      disclaimer: "Final pricing is subject to vehicle inspection."
    });
  });

  it("returns 400 for an unsupported service", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({
        service: "engine_rebuild",
        vehicle: { year: 2019, make: "Toyota", model: "Camry" }
      });

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
