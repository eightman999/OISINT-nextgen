// URL → source_type 分類と信頼度 heuristic (spec.md §14) + freshness (§17)
import type { SourceType } from "./types.ts";

// §14 の固定 heuristic。「真実度」ではなく Ranking 用のソース信頼度。
// 実測値が未提供・不正な場合の fail-closed fallback として残す。
export const SOURCE_QUALITY: Readonly<Record<SourceType, number>> = {
  official_site: 1.0,
  official_reservation: 0.95,
  major_place_provider: 0.85,
  major_review_platform: 0.75,
  other_public_page: 0.55,
  unknown: 0.4,
};

export const SOURCE_TYPES: readonly SourceType[] = [
  "official_site",
  "official_reservation",
  "major_place_provider",
  "major_review_platform",
  "other_public_page",
  "unknown",
];

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" &&
    SOURCE_TYPES.includes(value as SourceType);
}

// 判定は必ず正規化した hostname に対して行う。URL 全体の部分一致で分類すると
// query / path に大手ドメイン名を混ぜるだけで sourceQuality を吊り上げられる。
const MAJOR_PLACE_PROVIDERS = ["hotpepper.jp", "gnavi.co.jp", "hitosara.com"];
const MAJOR_REVIEW_PLATFORMS = ["tabelog.com", "retty.me", "maps.google.com"];
const GOOGLE_MAPS_HOSTS = ["google.com", "google.co.jp"];
const RESERVATION_HOSTS = ["tablecheck.com", "toreta.in"];
const RESERVATION_HOST_LABELS = new Set(["yoyaku", "reserve", "booking"]);

function isDomainOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function classifySourceType(
  url: string,
  placeName?: string,
): SourceType {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "unknown";
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const pathname = parsed.pathname.toLowerCase();
  if (
    MAJOR_PLACE_PROVIDERS.some((domain) => isDomainOrSubdomain(host, domain))
  ) {
    return "major_place_provider";
  }
  if (
    MAJOR_REVIEW_PLATFORMS.some((domain) => isDomainOrSubdomain(host, domain))
  ) {
    return "major_review_platform";
  }
  if (
    GOOGLE_MAPS_HOSTS.some((domain) => isDomainOrSubdomain(host, domain)) &&
    (pathname === "/maps" || pathname.startsWith("/maps/"))
  ) {
    return "major_review_platform";
  }
  if (
    RESERVATION_HOSTS.some((domain) => isDomainOrSubdomain(host, domain)) ||
    host.split(".").some((label) => RESERVATION_HOST_LABELS.has(label))
  ) {
    return "official_reservation";
  }

  // 店名と host の一致を厳密判定するのは難しいため、大手に該当しない独自ドメインは
  // 原則 other_public_page とする。ASCII 化した店名が host に含まれる場合だけ
  // official_site とみなす簡易判定を行う。
  if (placeName) {
    const ascii = placeName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ascii.length >= 4 && host.replace(/[^a-z0-9]/g, "").includes(ascii)) {
      return "official_site";
    }
  }
  return "other_public_page";
}

export function sourceQuality(sourceType: SourceType): number {
  return SOURCE_QUALITY[sourceType] ?? SOURCE_QUALITY.unknown;
}

// §17 freshness: ageDays = now - observed_at, clamp(1 - ageDays/180, 0, 1)
const FRESHNESS_UNKNOWN = 0.5;

export function freshnessScore(
  observedAt: Date,
  now: Date = new Date(),
): number {
  const ageDays = (now.getTime() - observedAt.getTime()) / 86_400_000;
  // 不正日時を NaN のままランキングへ伝播させず、中立値へ倒す。
  if (!Number.isFinite(ageDays)) return FRESHNESS_UNKNOWN;
  return clamp(1 - ageDays / 180, 0, 1);
}

// §32 TTL (source_type 別・時間)
const TTL_HOURS: Partial<Record<SourceType, number>> = {
  official_site: 24,
  major_place_provider: 24,
  other_public_page: 72,
};

export function ttlHours(sourceType: SourceType): number {
  return TTL_HOURS[sourceType] ?? 24;
}

export function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}
