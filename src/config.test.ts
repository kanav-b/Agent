import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SMS master switch.
 *
 * getConfig() caches, so each test loads a fresh copy of the module.
 */

const BASE_ENV = {
  SUPABASE_URL: "https://test.invalid",
  SUPABASE_SECRET_KEY: "test-supabase-key-not-real",
  VAPI_TOOL_SECRET: "test-vapi-secret-not-real"
};

async function loadConfig(smsEnabled: string) {
  vi.resetModules();
  Object.assign(process.env, BASE_ENV);
  process.env.SMS_ENABLED = smsEnabled;
  return import("./config.js");
}

beforeEach(() => {
  Object.assign(process.env, BASE_ENV);
});

afterEach(() => {
  process.env.SMS_ENABLED = "";
});

describe("SMS_ENABLED", () => {
  it("defaults to off when unset", async () => {
    const { isSmsEnabled } = await loadConfig("");

    expect(isSmsEnabled()).toBe(false);
  });

  it('is on only for exactly "true"', async () => {
    const { isSmsEnabled } = await loadConfig("true");

    expect(isSmsEnabled()).toBe(true);
  });

  it('is off for "false"', async () => {
    const { isSmsEnabled } = await loadConfig("false");

    expect(isSmsEnabled()).toBe(false);
  });

  it("ignores surrounding whitespace and case", async () => {
    const { isSmsEnabled } = await loadConfig("  TRUE  ");

    expect(isSmsEnabled()).toBe(true);
  });

  it("fails clearly on a malformed value", async () => {
    const { getConfig } = await loadConfig("yes");

    expect(() => getConfig()).toThrow(/SMS_ENABLED must be exactly "true" or "false"/);
  });

  it("does not echo the malformed value", async () => {
    const { getConfig } = await loadConfig("hunter2");

    expect(() => getConfig()).toThrow();
    try {
      getConfig();
    } catch (err) {
      expect((err as Error).message).not.toContain("hunter2");
    }
  });

  it("is not turned on merely because Twilio credentials exist", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_test_sid_not_real";
    process.env.TWILIO_AUTH_TOKEN = "test_twilio_token_not_real";
    process.env.TWILIO_FROM_NUMBER = "+15550000001";
    process.env.SHOP_NOTIFICATION_NUMBER = "+15550000002";

    const { isSmsEnabled, missingSmsConfig } = await loadConfig("");

    expect(missingSmsConfig()).toEqual([]);
    expect(isSmsEnabled()).toBe(false);
  });
});
