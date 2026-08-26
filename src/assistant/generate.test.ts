import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBusinessAssistantConfig,
  renderHours,
  type AssistantGeneratorInput
} from "./generate.js";

/** A second shop, so nothing demo-specific can hide in the output. */
const joesGarage: AssistantGeneratorInput = {
  business: {
    id: "joes-garage",
    name: "Joe's Garage",
    timezone: "America/New_York"
  },
  hours: [
    { dayOfWeek: 0, openTime: null, closeTime: null, isClosed: true },
    { dayOfWeek: 1, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
    { dayOfWeek: 2, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
    { dayOfWeek: 3, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
    { dayOfWeek: 4, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
    { dayOfWeek: 5, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
    { dayOfWeek: 6, openTime: null, closeTime: null, isClosed: true }
  ],
  services: [
    { serviceKey: "front_brake_pads", displayName: "Front Brake Pads" },
    { serviceKey: "synthetic_oil_change", displayName: "Synthetic Oil Change" }
  ]
};

const build = (overrides: Partial<AssistantGeneratorInput> = {}) =>
  buildBusinessAssistantConfig({ ...joesGarage, ...overrides });

describe("identity", () => {
  it("names the assistant after the business", () => {
    expect(build().assistantName).toBe("Joe's Garage Receptionist");
  });

  it("greets the caller with the business name", () => {
    expect(build().firstMessage).toContain("Thank you for calling Joe's Garage.");
  });

  it("says the shop is currently closed and lists what it can do", () => {
    const { firstMessage } = build();

    expect(firstMessage).toMatch(/currently closed/i);
    expect(firstMessage).toMatch(/preliminary estimates/i);
    expect(firstMessage).toMatch(/appointment requests/i);
    expect(firstMessage).toMatch(/callback requests/i);
  });

  it("carries no trace of the demo shop", () => {
    const config = build();

    for (const text of [config.assistantName, config.firstMessage, config.systemPrompt]) {
      expect(text).not.toContain("Demo Auto Repair");
      expect(text).not.toContain("demo-shop");
    }
  });

  it("uses the business name in the prompt", () => {
    expect(build().systemPrompt).toContain("Joe's Garage");
  });
});

describe("businessId", () => {
  it("is returned on the config", () => {
    expect(build().businessId).toBe("joes-garage");
  });

  it("is stated in the prompt as the value to send on every tool call", () => {
    const { systemPrompt } = build();

    expect(systemPrompt).toContain('businessId = "joes-garage"');
    expect(systemPrompt).toMatch(/EVERY backend tool call/);
    expect(systemPrompt).toMatch(/never omit it/i);
  });

  it("changes with the business", () => {
    const config = build({ business: { id: "third-shop", name: "Third", timezone: "UTC" } });

    expect(config.systemPrompt).toContain('businessId = "third-shop"');
    expect(config.systemPrompt).not.toContain("joes-garage");
  });
});

describe("services", () => {
  it("lists the display names", () => {
    const { systemPrompt } = build();

    expect(systemPrompt).toContain("SUPPORTED ESTIMATE SERVICES");
    expect(systemPrompt).toContain("- Front Brake Pads");
    expect(systemPrompt).toContain("- Synthetic Oil Change");
  });

  it("maps each display name to its tool key", () => {
    const { systemPrompt } = build();

    expect(systemPrompt).toContain("SERVICE TOOL KEYS");
    expect(systemPrompt).toContain("- Front Brake Pads -> front_brake_pads");
    expect(systemPrompt).toContain("- Synthetic Oil Change -> synthetic_oil_change");
  });

  it("keeps both the key and the display name on the config", () => {
    expect(build().supportedServices).toEqual([
      { serviceKey: "front_brake_pads", displayName: "Front Brake Pads" },
      { serviceKey: "synthetic_oil_change", displayName: "Synthetic Oil Change" }
    ]);
  });

  it("contains only the services it was given", () => {
    const { systemPrompt } = build({
      services: [{ serviceKey: "diagnostic", displayName: "Diagnostic" }]
    });

    expect(systemPrompt).toContain("- Diagnostic");
    // An inactive service is filtered out before it ever reaches the generator.
    expect(systemPrompt).not.toContain("Front Brake Pads");
  });

  it("produces a valid prompt with no services at all", () => {
    const { systemPrompt } = build({ services: [] });

    expect(systemPrompt).toContain("SUPPORTED ESTIMATE SERVICES");
    expect(systemPrompt).toMatch(/currently unavailable/i);
    // No dangling mapping heading with nothing under it.
    expect(systemPrompt).not.toContain("SERVICE TOOL KEYS");
  });

  it("invents no services when there are none", () => {
    const { systemPrompt } = build({ services: [] });

    // Scoped to the services section: the safety rules legitimately mention
    // brake failure, which is guidance rather than an offered service.
    const section = systemPrompt.split("SUPPORTED ESTIMATE SERVICES")[1].split("\n\n")[0];

    expect(section).not.toMatch(/brake|oil change|battery|tire/i);
  });
});

describe("hours", () => {
  it("collapses identical consecutive days", () => {
    expect(renderHours(joesGarage.hours)).toEqual([
      "Monday-Friday: 8:00 AM-5:00 PM",
      "Saturday: Closed",
      "Sunday: Closed"
    ]);
  });

  it("renders the hours and timezone in the prompt", () => {
    const { systemPrompt } = build();

    expect(systemPrompt).toContain("BUSINESS HOURS");
    expect(systemPrompt).toContain("Monday-Friday: 8:00 AM-5:00 PM");
    expect(systemPrompt).toContain("Saturday: Closed");
    expect(systemPrompt).toContain("Timezone: America/New_York");
  });

  it("returns the timezone on the config", () => {
    expect(build().timezone).toBe("America/New_York");
  });

  it("keeps a differing day separate", () => {
    const lines = renderHours([
      ...joesGarage.hours.filter((day) => day.dayOfWeek !== 5),
      { dayOfWeek: 5, openTime: "08:00:00", closeTime: "12:00:00", isClosed: false }
    ]);

    expect(lines).toEqual([
      "Monday-Thursday: 8:00 AM-5:00 PM",
      "Friday: 8:00 AM-12:00 PM",
      "Saturday: Closed",
      "Sunday: Closed"
    ]);
  });

  it("includes only the days it knows about", () => {
    const lines = renderHours([
      { dayOfWeek: 1, openTime: "09:00:00", closeTime: "18:00:00", isClosed: false }
    ]);

    expect(lines).toEqual(["Monday: 9:00 AM-6:00 PM"]);
  });

  it("does not merge across an unconfigured day", () => {
    const lines = renderHours([
      { dayOfWeek: 1, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
      { dayOfWeek: 3, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false }
    ]);

    expect(lines).toEqual([
      "Monday: 8:00 AM-5:00 PM",
      "Wednesday: 8:00 AM-5:00 PM"
    ]);
  });

  it("survives no hours at all", () => {
    const { systemPrompt } = build({ hours: [] });

    expect(systemPrompt).toContain("BUSINESS HOURS");
    expect(systemPrompt).toMatch(/not configured/i);
  });

  it("skips a day marked open with no times rather than guessing", () => {
    const lines = renderHours([
      { dayOfWeek: 1, openTime: null, closeTime: null, isClosed: false }
    ]);

    expect(lines).toEqual([]);
  });

  it("formats midnight and noon correctly", () => {
    const lines = renderHours([
      { dayOfWeek: 1, openTime: "00:00:00", closeTime: "12:00:00", isClosed: false }
    ]);

    expect(lines).toEqual(["Monday: 12:00 AM-12:00 PM"]);
  });
});

describe("optional shop details", () => {
  it("includes the after-hours message when there is one", () => {
    const { systemPrompt } = build({
      business: { ...joesGarage.business, afterHoursMessage: "We reopen at 8am sharp." }
    });

    expect(systemPrompt).toContain("AFTER-HOURS MESSAGE");
    expect(systemPrompt).toContain("We reopen at 8am sharp.");
    // It must not be able to override the rules that follow.
    expect(systemPrompt).toMatch(/never overrides the safety or/i);
  });

  it("omits the section entirely when there is none", () => {
    expect(build().systemPrompt).not.toContain("AFTER-HOURS MESSAGE");
  });

  it("omits it for a blank message too", () => {
    const { systemPrompt } = build({
      business: { ...joesGarage.business, afterHoursMessage: "   " }
    });

    expect(systemPrompt).not.toContain("AFTER-HOURS MESSAGE");
  });

  it("includes phone and address when configured", () => {
    const config = build({
      business: {
        ...joesGarage.business,
        phone: "+15550001111",
        addressLine1: "12 Mill Road",
        city: "Springfield",
        state: "NY",
        postalCode: "10001"
      }
    });

    expect(config.phone).toBe("+15550001111");
    expect(config.address).toBe("12 Mill Road, Springfield NY 10001");
    expect(config.systemPrompt).toContain("SHOP DETAILS");
    expect(config.systemPrompt).toContain("12 Mill Road, Springfield NY 10001");
  });

  it("omits the details section when nothing is configured", () => {
    const config = build();

    expect(config.phone).toBeNull();
    expect(config.address).toBeNull();
    expect(config.systemPrompt).not.toContain("SHOP DETAILS");
  });

  it("uses only the address parts that exist", () => {
    const config = build({
      business: { ...joesGarage.business, city: "Springfield" }
    });

    expect(config.address).toBe("Springfield");
  });
});

describe("nothing sensitive reaches the prompt", () => {
  it("never contains a notification number, because the config has no such field", () => {
    const config = build({
      business: { ...joesGarage.business, phone: "+15550001111" }
    });

    expect(config).not.toHaveProperty("notificationPhone");
    expect(config.systemPrompt).not.toContain("notification");
  });

  it("contains no prices", () => {
    const { systemPrompt } = build();

    expect(systemPrompt).not.toMatch(/\$\d/);
    expect(systemPrompt).not.toMatch(/\b\d{2,4}\s*-\s*\d{2,4}\b/);
  });
});

describe("the generator is pure", () => {
  it("produces byte-identical output for identical input", () => {
    const first = build();
    const second = build();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("still matches after time passes", async () => {
    const first = build().systemPrompt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(build().systemPrompt).toBe(first);
  });

  it("reads no clock, no randomness, no environment, and no network", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const sources = readdirSync(dir).filter(
      (file) => file === "generate.ts"
    );

    expect(sources).toEqual(["generate.ts"]);

    const source = readFileSync(join(dir, "generate.ts"), "utf8");

    expect(source).not.toMatch(/new Date\(|Date\.now|Math\.random/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bfetch\(/);
    // Imports only: the prose may mention Vapi while depending on nothing.
    const imports = source.match(/^\s*import .*$/gm) ?? [];

    expect(imports).toEqual([]);
    expect(source).not.toMatch(/require\(/);
  });
});

describe("prompt parity with the live rules", () => {
  const { systemPrompt } = build();

  it("forbids invented pricing", () => {
    expect(systemPrompt).toMatch(/Only the calculate_estimate tool may provide a price/);
    expect(systemPrompt).toMatch(/Never invent, guess,\s*\n?estimate, recall/);
  });

  it("requires preliminary estimate language", () => {
    expect(systemPrompt).toMatch(/PRELIMINARY estimate, subject to inspection/);
  });

  it("forbids claiming a confirmed appointment", () => {
    expect(systemPrompt).toMatch(/NOT a confirmed booking/);
    expect(systemPrompt).toMatch(/Never say booked,/);
  });

  it("describes a callback as pending", () => {
    expect(systemPrompt).toMatch(/callback request is pending/);
    expect(systemPrompt).toMatch(/Never say anyone has already called/);
  });

  it("requires explicit SMS consent", () => {
    expect(systemPrompt).toMatch(/Having their phone number is NOT consent/);
    expect(systemPrompt).toMatch(/Silence is NOT consent/);
    expect(systemPrompt).toMatch(/customerSmsConsent = true after an explicit yes/);
    expect(systemPrompt).toMatch(/customerConfirmation exactly equal to "sent"/);
  });

  it("forbids duplicate tool calls", () => {
    expect(systemPrompt).toMatch(/Call each tool once for a given request/);
    expect(systemPrompt).toMatch(/do not call it again for the same thing/);
  });

  it("requires tool success before claiming success", () => {
    expect(systemPrompt).toMatch(/Never say an action succeeded before the tool result/);
  });

  it("keeps the safety rules", () => {
    expect(systemPrompt).toMatch(/not a mechanic/);
    expect(systemPrompt).toMatch(/Do not diagnose/);
    expect(systemPrompt).toMatch(/NEVER tell a caller their vehicle is safe to drive/);
    expect(systemPrompt).toMatch(/emergency services or roadside/);
  });

  it("allows more than one action per conversation", () => {
    expect(systemPrompt).toMatch(/more than one action in a conversation/);
  });

  it("asks for a concise ending", () => {
    expect(systemPrompt).toContain("ENDING THE CALL");
    expect(systemPrompt).toMatch(/Do not repeat the\s*\n?\s*whole conversation/);
  });
});

describe("what an appointment request needs", () => {
  const { systemPrompt } = build();

  it("states the two things the tool actually requires", () => {
    expect(systemPrompt).toContain("WHAT AN APPOINTMENT REQUEST NEEDS");
    expect(systemPrompt).toMatch(/a service OR a description of the problem/);
    expect(systemPrompt).toMatch(/a preferred date OR a preferred time/);
  });

  it("names the tool it is describing", () => {
    expect(systemPrompt).toMatch(/create_appointment_request needs only two things/);
  });

  it("says name and phone are optional", () => {
    expect(systemPrompt).toMatch(/Name and phone number are OPTIONAL/);
  });

  it("forbids blocking a request over a missing name or number", () => {
    expect(systemPrompt).toMatch(
      /Never refuse, delay, or block an\s*\n?\s*appointment request because you do not have a name or a number/
    );
    expect(systemPrompt).toMatch(/never\s*\n?\s*insist on them/);
  });

  it("tells the assistant to call the tool once the minimum is met", () => {
    expect(systemPrompt).toMatch(
      /If you already have the two things above, call the tool/
    );
    expect(systemPrompt).toMatch(/Do not ask for\s*\n?\s*personal details first/);
  });

  it("allows an ordinary spoken time", () => {
    expect(systemPrompt).toMatch(/morning, after work, around two/);
  });
});

describe("a caller who asks for two things at once", () => {
  const { systemPrompt } = build();

  /** Just the multi-intent section, so assertions cannot match elsewhere. */
  const section = systemPrompt
    .split("WHEN A CALLER ASKS FOR TWO THINGS AT ONCE")[1]
    .split("\n\n")[0];

  it("gives a worked example of an estimate followed by an appointment", () => {
    expect(systemPrompt).toContain("WHEN A CALLER ASKS FOR TWO THINGS AT ONCE");
    expect(section).toMatch(/a preliminary estimate on one of the supported/);
    expect(section).toMatch(/would like to come in on\s*\n?\s*a particular day/);
  });

  it("calls calculate_estimate once, then reports the range", () => {
    expect(section).toMatch(/Once you have what calculate_estimate needs, call it once/);
    expect(section).toMatch(/Tell the caller the range it returned, and that it is preliminary/);
  });

  it("forbids a second estimate call for the same request", () => {
    expect(section).toMatch(
      /Do NOT call calculate_estimate again for that same estimate request/
    );
  });

  it("then calls create_appointment_request once, reusing what it knows", () => {
    expect(section).toMatch(/create_appointment_request once, reusing what the caller has already/);
    expect(section).toMatch(/Once you have what an appointment request needs/);
  });

  it("says only that the request was recorded and needs confirming", () => {
    expect(section).toMatch(/the appointment request was recorded and still needs/);
    expect(section).toMatch(/the shop to confirm it/);
  });

  it("asks only for what is genuinely missing", () => {
    expect(section).toMatch(/Ask only for something genuinely missing/);
    expect(section).toMatch(/Reuse what the caller has\s*\n?\s*already told you/);
  });

  it("names no particular service", () => {
    // The example must read the same for a shop that does not fit brakes.
    expect(section).not.toMatch(/brake|oil change|battery|tire|diagnostic/i);
    // Nor any service key from the shop's own catalog.
    for (const service of joesGarage.services) {
      expect(section).not.toContain(service.serviceKey);
      expect(section).not.toContain(service.displayName);
    }
  });

  it("names no particular vehicle", () => {
    expect(section).not.toMatch(/camry|toyota|honda|ford|civic|\bmake\b|\bmodel\b/i);
  });

  it("is identical for two shops with different services", () => {
    const other = buildBusinessAssistantConfig({
      business: { id: "third-shop", name: "Third Shop", timezone: "UTC" },
      hours: [],
      services: [{ serviceKey: "transmission_flush", displayName: "Transmission Flush" }]
    });

    const otherSection = other.systemPrompt
      .split("WHEN A CALLER ASKS FOR TWO THINGS AT ONCE")[1]
      .split("\n\n")[0];

    expect(otherSection).toBe(section);
  });

  it("keeps the general no-duplicate-tool rule as well", () => {
    expect(systemPrompt).toMatch(/Call each tool once for a given request/);
    expect(systemPrompt).toMatch(/do not call it again for the same thing/);
  });
});

describe("ending the call", () => {
  const { systemPrompt } = build();

  it("promises follow-up only when something was recorded", () => {
    expect(systemPrompt).toMatch(
      /Only say the shop will follow up when you actually recorded something/
    );
    expect(systemPrompt).toMatch(
      /an appointment request, a callback request, or another\s*\n?\s*action a tool confirmed/
    );
  });

  it("forbids promising follow-up after an estimate-only call", () => {
    expect(systemPrompt).toMatch(
      /If the call was only an estimate, or only a question you answered, do not\s*\n?\s*promise a follow-up/
    );
    expect(systemPrompt).toMatch(/do not imply anyone will be in touch/);
  });

  it("offers a request instead of inventing a follow-up", () => {
    expect(systemPrompt).toMatch(/Offer to take\s*\n?\s*an appointment or callback request if they would like one/);
  });

  it("no longer tells the assistant to always mention follow-up", () => {
    // The old wording promised a follow-up on every call.
    expect(systemPrompt).not.toMatch(/mention that the shop\s*\n?\s*will follow up, and end politely/);
  });

  it("still asks for a short close", () => {
    expect(systemPrompt).toMatch(/Summarise in one short sentence/);
  });
});
