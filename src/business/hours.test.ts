import { describe, expect, it } from "vitest";
import { isBusinessOpenAt, localMoment } from "./hours.js";
import type { BusinessHoursRow } from "../db/businesses.js";

/**
 * Opening hours, as pure logic.
 *
 * Semantics under test: open_time inclusive, close_time exclusive, wall-clock
 * times read in the shop's own timezone.
 */

const LA = "America/Los_Angeles";

/** Demo-shop's seeded week: weekdays 08:00-17:00, weekends closed. */
const WEEK: BusinessHoursRow[] = [
  { dayOfWeek: 0, openTime: null, closeTime: null, isClosed: true },
  { dayOfWeek: 1, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
  { dayOfWeek: 2, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
  { dayOfWeek: 3, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
  { dayOfWeek: 4, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
  { dayOfWeek: 5, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false },
  { dayOfWeek: 6, openTime: null, closeTime: null, isClosed: true }
];

/** A UTC instant. Pacific is UTC-7 in August, so 16:00Z is 09:00 local. */
const at = (iso: string) => new Date(iso);

describe("isBusinessOpenAt", () => {
  it("is open during weekday hours", () => {
    // Wednesday 2026-08-19, 09:00 Pacific.
    expect(isBusinessOpenAt(WEEK, at("2026-08-19T16:00:00Z"), LA)).toBe(true);
  });

  it("is closed before opening", () => {
    // 07:59 Pacific.
    expect(isBusinessOpenAt(WEEK, at("2026-08-19T14:59:00Z"), LA)).toBe(false);
  });

  it("is closed after closing", () => {
    // 17:30 Pacific.
    expect(isBusinessOpenAt(WEEK, at("2026-08-20T00:30:00Z"), LA)).toBe(false);
  });

  it("is closed on Saturday", () => {
    // Saturday 2026-08-22, 12:00 Pacific.
    expect(isBusinessOpenAt(WEEK, at("2026-08-22T19:00:00Z"), LA)).toBe(false);
  });

  it("is closed on Sunday", () => {
    // Sunday 2026-08-23, 12:00 Pacific.
    expect(isBusinessOpenAt(WEEK, at("2026-08-23T19:00:00Z"), LA)).toBe(false);
  });
});

describe("boundaries", () => {
  it("is open at exactly the opening time", () => {
    // 08:00 Pacific exactly — inclusive.
    expect(isBusinessOpenAt(WEEK, at("2026-08-19T15:00:00Z"), LA)).toBe(true);
  });

  it("is closed at exactly the closing time", () => {
    // 17:00 Pacific exactly — exclusive, so the shop is already shut.
    expect(isBusinessOpenAt(WEEK, at("2026-08-20T00:00:00Z"), LA)).toBe(false);
  });

  it("is open one minute before closing", () => {
    // 16:59 Pacific.
    expect(isBusinessOpenAt(WEEK, at("2026-08-19T23:59:00Z"), LA)).toBe(true);
  });
});

describe("timezone", () => {
  it("reads the time in the shop's own zone, not the server's", () => {
    const instant = at("2026-08-19T16:00:00Z"); // 09:00 Pacific, 18:00 Berlin

    expect(isBusinessOpenAt(WEEK, instant, LA)).toBe(true);
    // The same instant is past closing for a Berlin shop with the same hours.
    expect(isBusinessOpenAt(WEEK, instant, "Europe/Berlin")).toBe(false);
  });

  it("moves with daylight saving rather than a fixed offset", () => {
    // 16:00Z is 09:00 in August (PDT) but 08:00 in January (PST).
    expect(localMoment(at("2026-08-19T16:00:00Z"), LA).minutes).toBe(9 * 60);
    expect(localMoment(at("2026-01-14T16:00:00Z"), LA).minutes).toBe(8 * 60);
  });

  it("reports the local weekday, which can differ from UTC's", () => {
    // Thursday 00:30 UTC is still Wednesday evening in Los Angeles.
    expect(localMoment(at("2026-08-20T00:30:00Z"), LA).dayOfWeek).toBe(3);
  });
});

describe("configuration that cannot be honoured", () => {
  it("treats a day with no row as closed", () => {
    const onlyMonday = [WEEK[1]];

    // Wednesday, which has no row at all.
    expect(isBusinessOpenAt(onlyMonday, at("2026-08-19T16:00:00Z"), LA)).toBe(false);
  });

  it("treats an overnight window as closed, since one row cannot express it", () => {
    const overnight: BusinessHoursRow[] = [
      { dayOfWeek: 3, openTime: "22:00:00", closeTime: "02:00:00", isClosed: false }
    ];

    // 23:00 Pacific Wednesday would be "open" if overnight were supported.
    expect(isBusinessOpenAt(overnight, at("2026-08-20T06:00:00Z"), LA)).toBe(false);
  });

  it("treats a day marked open with no times as closed", () => {
    const broken: BusinessHoursRow[] = [
      { dayOfWeek: 3, openTime: null, closeTime: null, isClosed: false }
    ];

    expect(isBusinessOpenAt(broken, at("2026-08-19T16:00:00Z"), LA)).toBe(false);
  });

  it("is deterministic for the same inputs", () => {
    const instant = at("2026-08-19T16:00:00Z");

    expect(isBusinessOpenAt(WEEK, instant, LA)).toBe(isBusinessOpenAt(WEEK, instant, LA));
  });
});
