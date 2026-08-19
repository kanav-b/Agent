import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The database is stubbed so an authorised request can complete without a
// network call, and so we can prove an unauthorised one never reaches it.
vi.mock("../db/estimates.js", () => ({
  persistEstimate: vi.fn()
}));

// Wrap the real pricing function so we can also prove pricing never runs for
// an unauthorised request.
vi.mock("../pricing/estimate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pricing/estimate.js")>();
  return { ...actual, getEstimate: vi.fn(actual.getEstimate) };
});

import { createApp } from "../app.js";
import { persistEstimate } from "../db/estimates.js";
import { getEstimate } from "../pricing/estimate.js";
import { VAPI_SECRET_HEADER } from "./vapiAuth.js";

const mockPersist = vi.mocked(persistEstimate);
const mockGetEstimate = vi.mocked(getEstimate);

// Fake secrets, used only here. The real value lives in .env.
const TEST_SECRET = "test-vapi-secret-not-real";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = TEST_SECRET;

const app = createApp();

const ROUTE = "/api/vapi/tools/estimate";
const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

const validCall = {
  message: {
    type: "tool-calls",
    toolCallList: [
      {
        id: "call_auth_1",
        name: "calculate_estimate",
        arguments: { service: "front_brake_pads", vehicle }
      }
    ]
  }
};

beforeEach(() => {
  mockPersist.mockReset();
  mockPersist.mockImplementation(async (input) => ({
    estimateId: input.estimateId,
    reused: false
  }));
  mockGetEstimate.mockClear();
});

describe("Vapi tool authentication", () => {
  it("lets a request through when the secret is correct", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(VAPI_SECRET_HEADER, TEST_SECRET)
      .send(validCall);

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_auth_1");
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when the header is missing", async () => {
    const res = await request(app).post(ROUTE).send(validCall);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized." });
  });

  it("returns 401 when the secret is wrong", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(VAPI_SECRET_HEADER, "completely-wrong-secret")
      .send(validCall);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized." });
  });

  it("returns 401 for a near-miss secret, with the same message", async () => {
    const missing = await request(app).post(ROUTE).send(validCall);
    const nearMiss = await request(app)
      .post(ROUTE)
      .set(VAPI_SECRET_HEADER, `${TEST_SECRET}x`)
      .send(validCall);

    // A near miss must be indistinguishable from no secret at all.
    expect(nearMiss.status).toBe(401);
    expect(nearMiss.body).toEqual(missing.body);
  });

  it("returns 401 for an empty header value", async () => {
    const res = await request(app).post(ROUTE).set(VAPI_SECRET_HEADER, "").send(validCall);

    expect(res.status).toBe(401);
  });

  it("never reveals the expected secret in the response", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(VAPI_SECRET_HEADER, "wrong")
      .send(validCall);

    expect(JSON.stringify(res.body)).not.toContain(TEST_SECRET);
  });

  it("does not persist anything for an unauthorised request", async () => {
    await request(app).post(ROUTE).send(validCall);

    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("does not price anything for an unauthorised request", async () => {
    await request(app).post(ROUTE).send(validCall);

    expect(mockGetEstimate).not.toHaveBeenCalled();
  });

  it("prices and persists once the request is authorised", async () => {
    await request(app).post(ROUTE).set(VAPI_SECRET_HEADER, TEST_SECRET).send(validCall);

    expect(mockGetEstimate).toHaveBeenCalledTimes(1);
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });
});

describe("endpoints that stay open", () => {
  it("GET /health needs no secret", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("POST /api/estimate is unchanged and needs no secret", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(res.body.low).toBe(300);
    expect(res.body.high).toBe(450);
    expect(res.body.estimateId).toBeTypeOf("string");
  });
});
