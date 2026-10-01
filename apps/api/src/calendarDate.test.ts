import { describe, expect, it } from "vitest";
import { formatJstCalendarDate, isRealNonFutureJstDate } from "./calendarDate";

const JST_MIDNIGHT = new Date("2026-08-24T15:00:00.000Z");
const JST_AFTER_MIDNIGHT = new Date("2026-08-24T15:30:00.000Z");

describe("JST calendar date helper", () => {
  it("uses Asia/Tokyo at the UTC/JST date boundary", () => {
    expect(formatJstCalendarDate(new Date("2026-08-24T14:59:59.999Z"))).toBe(
      "2026-08-24",
    );
    expect(formatJstCalendarDate(JST_MIDNIGHT)).toBe("2026-08-25");
    expect(formatJstCalendarDate(JST_AFTER_MIDNIGHT)).toBe("2026-08-25");
  });

  it.each([
    ["2026-08-25", true],
    ["2026-08-26", false],
    ["2026-08-24", true],
    ["2026-02-30", false],
    ["2024-02-29", true],
    ["2023-02-29", false],
    ["0000-01-01", false],
    ["0001-01-01", true],
    ["2026-2-05", false],
    ["2026-13-01", false],
  ])("validates %s as %s at the injected JST date", (value, expected) => {
    expect(isRealNonFutureJstDate(value, JST_AFTER_MIDNIGHT)).toBe(expected);
  });

  it("fails closed for an invalid injected now", () => {
    const invalidNow = new Date(Number.NaN);
    expect(formatJstCalendarDate(invalidNow)).toBeNull();
    expect(isRealNonFutureJstDate("2026-08-24", invalidNow)).toBe(false);
  });
});
