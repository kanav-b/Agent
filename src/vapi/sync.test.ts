import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Planning and applying a sync, with both the database and the provider
 * stubbed. No test here reaches Supabase or Vapi.
 */

vi.mock("../db/businesses.js", () => ({
  getBusiness: vi.fn(),
  getBusinessHours: vi.fn(),
  getBusinessService: vi.fn(),
  getActiveBusinessServices: vi.fn()
}));
vi.mock("../db/integrations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/integrations.js")>();
  return {
    ...actual,
    getBusinessIntegration: vi.fn(),
    createBusinessIntegration: vi.fn(),
    updateBusinessIntegration: vi.fn()
  };
});
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    getAssistant: vi.fn(),
    createAssistant: vi.fn(),
    updateAssistant: vi.fn()
  };
});

process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-not-real";

import {
  getActiveBusinessServices,
  getBusiness,
  getBusinessHours
} from "../db/businesses.js";
import {
  createBusinessIntegration,
  getBusinessIntegration,
  updateBusinessIntegration,
  IntegrationError
} from "../db/integrations.js";
import { createAssistant, getAssistant, updateAssistant, VapiRequestError } from "./client.js";
import { applySync, planSync, SyncError } from "./sync.js";

const mockGetBusiness = vi.mocked(getBusiness);
const mockGetHours = vi.mocked(getBusinessHours);
const mockGetServices = vi.mocked(getActiveBusinessServices);
const mockGetIntegration = vi.mocked(getBusinessIntegration);
const mockCreateIntegration = vi.mocked(createBusinessIntegration);
const mockUpdateIntegration = vi.mocked(updateBusinessIntegration);
const mockGetAssistant = vi.mocked(getAssistant);
const mockCreateAssistant = vi.mocked(createAssistant);
const mockUpdateAssistant = vi.mocked(updateAssistant);

const FAKE_KEY = "vapi-key-not-real-abc123";

/** Provisioning present unless a test deliberately removes it. */
function setProvisioning(present: boolean): void {
  const value = present ? FAKE_KEY : "";
  process.env.VAPI_API_KEY = value;
  process.env.VAPI_ESTIMATE_TOOL_ID = present ? "tool_estimate_1" : "";
  process.env.VAPI_APPOINTMENT_REQUEST_TOOL_ID = present ? "tool_appointment_1" : "";
  process.env.VAPI_CALLBACK_REQUEST_TOOL_ID = present ? "tool_callback_1" : "";
}

const business = {
  id: "demo-shop",
  name: "Demo Auto Repair",
  phone: null,
  notificationPhone: null,
  timezone: "America/Los_Angeles",
  afterHoursMessage: null,
  isActive: true
};

const service = {
  serviceKey: "front_brake_pads",
  displayName: "Front Brake Pads",
  lowPrice: 300,
  highPrice: 450,
  currency: "USD",
  disclaimer: "Final pricing is subject to vehicle inspection.",
  isActive: true
};

const activeIntegration = {
  id: "integration-1",
  businessId: "demo-shop",
  provider: "vapi" as const,
  externalId: "assistant_abc123",
  status: "active" as const
};

beforeEach(() => {
  vi.clearAllMocks();
  setProvisioning(true);
  mockGetBusiness.mockResolvedValue(business);
  mockGetHours.mockResolvedValue([]);
  mockGetServices.mockResolvedValue([service]);
  mockGetIntegration.mockResolvedValue(null);
  mockCreateIntegration.mockResolvedValue(activeIntegration);
  mockUpdateIntegration.mockResolvedValue(undefined);
  mockGetAssistant.mockResolvedValue({ id: "assistant_abc123", model: { provider: "openai" } });
  mockCreateAssistant.mockResolvedValue({ id: "assistant_new_999" });
  mockUpdateAssistant.mockResolvedValue({ id: "assistant_abc123" });
});

describe("planning", () => {
  it("rejects an unknown business", async () => {
    mockGetBusiness.mockResolvedValue(null);

    const err = await planSync("no-such-shop").catch((e) => e);

    expect(err).toBeInstanceOf(SyncError);
    expect(err.problem).toBe("business_not_found");
  });

  it("rejects an inactive business", async () => {
    mockGetBusiness.mockResolvedValue({ ...business, isActive: false });

    const err = await planSync("demo-shop").catch((e) => e);

    expect(err.problem).toBe("business_inactive");
  });

  it("plans a CREATE when there is no integration", async () => {
    const plan = await planSync("demo-shop");

    expect(plan.operation).toBe("create");
    expect(plan.assistantId).toBeUndefined();
    expect(plan.businessName).toBe("Demo Auto Repair");
    expect(plan.serviceCount).toBe(1);
  });

  it("plans an UPDATE against the stored assistant", async () => {
    mockGetIntegration.mockResolvedValue(activeIntegration);

    const plan = await planSync("demo-shop");

    expect(plan.operation).toBe("update");
    expect(plan.assistantId).toBe("assistant_abc123");
  });

  it("rejects a disabled integration", async () => {
    mockGetIntegration.mockResolvedValue({ ...activeIntegration, status: "disabled" });

    const err = await planSync("demo-shop").catch((e) => e);

    expect(err.problem).toBe("integration_disabled");
    expect(err.message).toMatch(/never reactivated automatically/);
  });

  it("rejects an errored integration", async () => {
    mockGetIntegration.mockResolvedValue({ ...activeIntegration, status: "error" });

    const err = await planSync("demo-shop").catch((e) => e);

    expect(err.problem).toBe("integration_error_state");
  });

  it("contacts the provider not at all", async () => {
    await planSync("demo-shop");

    expect(mockGetAssistant).not.toHaveBeenCalled();
    expect(mockCreateAssistant).not.toHaveBeenCalled();
    expect(mockUpdateAssistant).not.toHaveBeenCalled();
  });

  it("writes nothing to the database", async () => {
    mockGetIntegration.mockResolvedValue(activeIntegration);

    await planSync("demo-shop");

    expect(mockCreateIntegration).not.toHaveBeenCalled();
    expect(mockUpdateIntegration).not.toHaveBeenCalled();
  });

  it("needs no provisioning configuration", async () => {
    setProvisioning(false);

    const plan = await planSync("demo-shop");

    expect(plan.operation).toBe("create");
  });
});

describe("applying a create", () => {
  it("creates the assistant and records the returned id", async () => {
    const result = await applySync(await planSync("demo-shop"));

    expect(result).toEqual({ operation: "create", assistantId: "assistant_new_999" });
    expect(mockCreateIntegration).toHaveBeenCalledWith({
      businessId: "demo-shop",
      provider: "vapi",
      externalId: "assistant_new_999"
    });
  });

  it("records nothing when the provider fails", async () => {
    mockCreateAssistant.mockRejectedValue(new VapiRequestError("create", 500, "server error"));

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.problem).toBe("provider_failed");
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });

  it("treats a response with no assistant id as a failure", async () => {
    // The client raises rather than returning an id-less body; nothing is stored.
    mockCreateAssistant.mockRejectedValue(
      new VapiRequestError("create", 200, "the response contained no assistant id")
    );

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.problem).toBe("provider_failed");
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });

  it("re-checks for an integration immediately before creating", async () => {
    const plan = await planSync("demo-shop");
    // Another operator synced in the gap between plan and apply.
    mockGetIntegration.mockResolvedValue(activeIntegration);

    const err = await applySync(plan).catch((e) => e);

    expect(err.problem).toBe("conflict");
    expect(mockCreateAssistant).not.toHaveBeenCalled();
  });

  it("never overwrites an existing mapping when two syncs race", async () => {
    const plan = await planSync("demo-shop");
    const conflict = new IntegrationError("createBusinessIntegration", "duplicate key", "23505");
    mockCreateIntegration.mockRejectedValue(conflict);
    mockGetIntegration
      .mockResolvedValueOnce(null) // the re-check
      .mockResolvedValue(activeIntegration); // the winner

    const err = await applySync(plan).catch((e) => e);

    expect(err.problem).toBe("conflict");
    // The winner's id survives, and the orphan is named for manual cleanup.
    expect(err.message).toContain("assistant_abc123");
    expect(err.message).toContain("assistant_new_999");
    expect(err.message).toMatch(/removed by hand/);
  });

  it("refuses before any network call when provisioning is missing", async () => {
    const plan = await planSync("demo-shop");
    setProvisioning(false);

    const err = await applySync(plan).catch((e) => e);

    expect(err.problem).toBe("provisioning_not_configured");
    expect(err.message).toContain("VAPI_API_KEY");
    expect(mockCreateAssistant).not.toHaveBeenCalled();
  });
});

describe("applying an update", () => {
  beforeEach(() => {
    mockGetIntegration.mockResolvedValue(activeIntegration);
  });

  it("updates the stored assistant and keeps its id", async () => {
    const result = await applySync(await planSync("demo-shop"));

    expect(result).toEqual({ operation: "update", assistantId: "assistant_abc123" });
    expect(mockUpdateAssistant.mock.calls[0][0]).toBe("assistant_abc123");
  });

  it("creates no second assistant", async () => {
    await applySync(await planSync("demo-shop"));

    expect(mockCreateAssistant).not.toHaveBeenCalled();
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });

  it("targets the same assistant when run repeatedly", async () => {
    await applySync(await planSync("demo-shop"));
    await applySync(await planSync("demo-shop"));
    await applySync(await planSync("demo-shop"));

    const targets = mockUpdateAssistant.mock.calls.map((call) => call[0]);
    expect(targets).toEqual(["assistant_abc123", "assistant_abc123", "assistant_abc123"]);
  });

  it("preserves the model the assistant already has", async () => {
    mockGetAssistant.mockResolvedValue({
      id: "assistant_abc123",
      model: { provider: "anthropic", model: "claude-sonnet-4", toolIds: ["t1"] }
    });

    await applySync(await planSync("demo-shop"));

    const payload = mockUpdateAssistant.mock.calls[0][1] as Record<string, unknown>;
    const model = payload.model as Record<string, unknown>;

    expect(model.provider).toBe("anthropic");
    expect(model.toolIds).toEqual(["t1"]);
  });

  it("does not replace an assistant that is missing remotely", async () => {
    mockGetAssistant.mockRejectedValue(new VapiRequestError("read", 404, "not found"));

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.problem).toBe("remote_missing");
    expect(err.message).toMatch(/deliberate repair/);
    expect(mockCreateAssistant).not.toHaveBeenCalled();
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });

  it("creates no integration when the update fails", async () => {
    mockUpdateAssistant.mockRejectedValue(new VapiRequestError("update", 500, "server error"));

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.problem).toBe("provider_failed");
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });
});

describe("provider errors stay safe", () => {
  it("never carry the API key", async () => {
    mockCreateAssistant.mockRejectedValue(new VapiRequestError("create", 401, "rejected"));

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toMatch(/Bearer/i);
    expect(err.message).not.toMatch(/authorization/i);
  });

  it("never carry the submitted prompt", async () => {
    mockCreateAssistant.mockRejectedValue(new VapiRequestError("create", 400, "rejected"));

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.message).not.toMatch(/businessId = /);
    expect(err.message).not.toMatch(/SUPPORTED ESTIMATE SERVICES/);
  });

  it("keep the status, which is what an operator needs", async () => {
    mockCreateAssistant.mockRejectedValue(new VapiRequestError("create", 429, "rate limited"));

    const err = await applySync(await planSync("demo-shop")).catch((e) => e);

    expect(err.message).toContain("429");
  });
});
