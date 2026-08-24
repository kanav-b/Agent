import type { BusinessHoursRow } from "../db/businesses.js";

/**
 * Whether a shop is open at a given moment.
 *
 * Pure on purpose: it takes the hours it needs rather than fetching them, so
 * the same inputs always give the same answer and every awkward case can be
 * tested without a database or a fake clock.
 *
 * Semantics, deliberately chosen:
 *
 *  - `open_time` is **inclusive**: at exactly 08:00 the shop is open.
 *  - `close_time` is **exclusive**: at exactly 17:00 the shop is closed.
 *    Treating closing time as "already shut" avoids promising a caller a slot
 *    at the moment the doors lock.
 *  - Times are wall-clock times in the shop's own timezone.
 *  - A day with no configured row is treated as closed. Silence is not an
 *    invitation to turn up.
 *
 * Not supported in this phase, and deliberately so:
 *
 *  - **Overnight shifts** (a close time earlier than the open time, e.g.
 *    22:00–02:00). A single row cannot say which day the closing time belongs
 *    to, and guessing would produce a shop that claims to be open at 3am. Such
 *    a row is treated as closed.
 *  - Split shifts, because the unique constraint allows one row per day.
 *  - Holidays and one-off closures.
 */

/** Minutes since midnight, or null when the value is not a usable time. */
function toMinutes(time: string | null): number | null {
  if (!time) {
    return null;
  }

  // Postgres `time` arrives as "08:00:00"; "08:00" is accepted too.
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

/** The local weekday and time-of-day at an instant, in the given timezone. */
export function localMoment(
  timestamp: Date,
  timezone: string
): { dayOfWeek: number; minutes: number } {
  // Intl does the timezone work, including daylight saving, with no
  // dependency and no hand-rolled offset table.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(timestamp);

  const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  const dayOfWeek = WEEKDAY_INDEX[lookup("weekday")] ?? 0;
  // Intl can report midnight as "24" in some environments.
  const hour = Number(lookup("hour")) % 24;
  const minute = Number(lookup("minute"));

  return { dayOfWeek, minutes: hour * 60 + minute };
}

export function isBusinessOpenAt(
  hours: BusinessHoursRow[],
  timestamp: Date,
  timezone: string
): boolean {
  const { dayOfWeek, minutes } = localMoment(timestamp, timezone);

  const today = hours.find((entry) => entry.dayOfWeek === dayOfWeek);

  // No row for today, or the shop says it is shut.
  if (!today || today.isClosed) {
    return false;
  }

  const open = toMinutes(today.openTime);
  const close = toMinutes(today.closeTime);

  if (open === null || close === null) {
    return false;
  }

  // An overnight or zero-length window cannot be interpreted from one row.
  if (close <= open) {
    return false;
  }

  return minutes >= open && minutes < close;
}
