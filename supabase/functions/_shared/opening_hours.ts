export interface ParsedOpeningHours {
  open: number;
  close: number;
}

// StructuredClaim opening_hours の唯一の時刻パーサ。24:00 は許可するが、
// 24:01以上・25時台・60分以上は保存/比較/評価の全経路で拒否する。
export function parseOpeningHoursValue(
  value: string,
): ParsedOpeningHours | null {
  const match = value.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const openHour = Number(match[1]);
  const openMinute = Number(match[2]);
  const closeHour = Number(match[3]);
  const closeMinute = Number(match[4]);
  if (
    openHour > 24 || closeHour > 24 || openMinute > 59 || closeMinute > 59 ||
    (openHour === 24 && openMinute !== 0) ||
    (closeHour === 24 && closeMinute !== 0)
  ) return null;
  const open = openHour * 60 + openMinute;
  let close = closeHour * 60 + closeMinute;
  if (close <= open) close += 24 * 60;
  return { open, close };
}
