import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEstimate, getEstimate, UnsupportedServiceError } from "./estimate.js";

const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

describe("getEstimate", () => {
  it("returns the correct price range for a supported service", () => {
    const result = getEstimate("front_brake_pads", vehicle);

    expect(result).toEqual({
      estimateType: "preliminary",
      service: "front_brake_pads",
      vehicle,
      low: 300,
      high: 450,
      currency: "USD",
      disclaimer: "Final pricing is subject to vehicle inspection."
    });
  });

  it("supports a flat-rate service where low equals high", () => {
    const result = getEstimate("diagnostic", vehicle);

    expect(result.low).toBe(149);
    expect(result.high).toBe(149);
  });

  it("throws UnsupportedServiceError for an unknown service", () => {
    expect(() => getEstimate("engine_rebuild", vehicle)).toThrow(UnsupportedServiceError);
  });

  it("is deterministic and does not generate an id", () => {
    const first = getEstimate("front_brake_pads", vehicle);
    const second = getEstimate("front_brake_pads", vehicle);

    // Identical inputs must give an identical result, which also means the
    // pricing layer must not put a random estimateId in here.
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty("estimateId");
  });
});

describe("the pricing module has no database access", () => {
  it("imports nothing from the database or a client anywhere in src/pricing", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const sources = readdirSync(dir).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts")
    );

    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const source = readFileSync(join(dir, file), "utf8");

      // A price must not depend on what the network did.
      expect(source).not.toMatch(/from "\.\.\/db\//);
      expect(source).not.toMatch(/supabase/i);
      expect(source).not.toMatch(/\bfetch\(/);
    }
  });
});

describe("buildEstimate", () => {
  const pricing = {
    serviceKey: "front_brake_pads",
    low: 300,
    high: 450,
    currency: "USD",
    disclaimer: "Final pricing is subject to vehicle inspection."
  };

  it("builds the estimate straight from the resolved pricing", () => {
    expect(buildEstimate(vehicle, pricing)).toEqual({
      estimateType: "preliminary",
      service: "front_brake_pads",
      vehicle,
      low: 300,
      high: 450,
      currency: "USD",
      disclaimer: "Final pricing is subject to vehicle inspection."
    });
  });

  it("uses whatever prices it is given, from any shop", () => {
    const other = buildEstimate(vehicle, { ...pricing, low: 275, high: 400, currency: "CAD" });

    expect(other.low).toBe(275);
    expect(other.high).toBe(400);
    expect(other.currency).toBe("CAD");
  });

  it("is deterministic", () => {
    expect(buildEstimate(vehicle, pricing)).toEqual(buildEstimate(vehicle, pricing));
  });

  it("generates no id, so the calculation stays pure", () => {
    expect(buildEstimate(vehicle, pricing)).not.toHaveProperty("estimateId");
  });
});
