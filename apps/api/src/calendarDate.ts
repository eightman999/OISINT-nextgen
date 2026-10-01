const JAPAN_TIME_ZONE = "Asia/Tokyo";

const jstDateFormatter = new Intl.DateTimeFormat("en-US", {
  calendar: "gregory",
  timeZone: JAPAN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type CalendarDateParts = {
  year: string;
  month: string;
  day: string;
};

function jstCalendarDateParts(now: Date): CalendarDateParts | null {
  if (!Number.isFinite(now.getTime())) return null;

  const parts = Object.fromEntries(
    jstDateFormatter.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  if (!year || !month || !day) return null;
  return { year: year.padStart(4, "0"), month, day };
}

/** Return the calendar date at `now` in Japan Standard Time. */
export function formatJstCalendarDate(now: Date = new Date()): string | null {
  const parts = jstCalendarDateParts(now);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

/**
 * Validate a strict, real YYYY-MM-DD date that is not after the JST calendar
 * date at `now`. `now` is injectable so the API boundary remains deterministic
 * around the UTC/JST midnight boundary.
 */
export function isRealNonFutureJstDate(
  value: string,
  now: Date = new Date(),
): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // The API contract carries an AD calendar date for PostgreSQL `date`.
  // Reject ISO year 0000 rather than silently mapping it to a different era.
  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (day < 1 || day > daysInMonth) return false;

  const today = formatJstCalendarDate(now);
  return today !== null && value <= today;
}
