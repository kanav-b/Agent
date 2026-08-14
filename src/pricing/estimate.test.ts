import { describe, expect, it } from "vitest";
import { getEstimate, UnsupportedServiceError } from "./estimate.js";

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
});
