// Shared Evidence content boundary.
// Model-facing/user-independent rows and prompts must never reuse model prose or
// Requirement echoes as rawText. Trusted place-provider rows keep their readable
// stored prose, but are still neutralized before being sent to an AI provider.
import { filterValidClaims, type StructuredClaimInput } from "./validation.ts";
import {
  isSafeModelNeutralSharedUrl,
  parsePublicHttpUrl,
} from "./public_url.ts";

function canonicalEvidenceValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEvidenceValue).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalEvidenceValue(object[key])}`
  ).join(",");
  return `{${entries}}`;
}

export function formatNeutralSharedClaim(
  claim: StructuredClaimInput,
): string {
  if (claim.key === "card_accepted" && typeof claim.value === "boolean") {
    return `クレジットカード利用${claim.value ? "可" : "不可"}`;
  }
  if (claim.key === "reservation" && typeof claim.value === "boolean") {
    return `予約${claim.value ? "可" : "不可"}`;
  }
  if (claim.key === "private_room" && typeof claim.value === "boolean") {
    return `個室${claim.value ? "あり" : "なし"}`;
  }
  if (claim.key === "capacity" && typeof claim.value === "number") {
    return `総席数: ${claim.value}席`;
  }
  if (
    claim.key === "budget_dinner" && typeof claim.value === "object" &&
    claim.value !== null
  ) {
    const range = claim.value as { min?: unknown; max?: unknown };
    if (typeof range.min === "number" && typeof range.max === "number") {
      return `夕食予算: ${range.min}〜${range.max}円`;
    }
  }
  if (claim.key === "opening_hours" && typeof claim.value === "string") {
    return `営業時間: ${claim.value}`;
  }
  if (claim.key === "non_smoking" && typeof claim.value === "boolean") {
    return claim.value ? "全席禁煙" : "喫煙可";
  }
  if (claim.key === "wifi_available" && typeof claim.value === "boolean") {
    return `Wi-Fi${claim.value ? "あり" : "なし"}`;
  }
  if (claim.key === "child_friendly" && typeof claim.value === "boolean") {
    return `子連れ${claim.value ? "対応" : "非対応"}`;
  }
  if (
    claim.key === "nearest_station_walk_minutes" &&
    typeof claim.value === "number" && Number.isSafeInteger(claim.value) &&
    claim.value >= 0
  ) {
    return `最寄り駅から徒歩${claim.value}分`;
  }
  if (claim.key === "category" && Array.isArray(claim.value)) {
    const values = claim.value.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
    if (values.length === claim.value.length && values.length > 0) {
      return `カテゴリ: ${values.join(" / ")}`;
    }
  }
  if (
    claim.key === "price_range" && claim.value !== null &&
    typeof claim.value === "object"
  ) {
    const range = claim.value as Record<string, unknown>;
    if (
      typeof range.min === "number" && typeof range.max === "number" &&
      typeof range.currency === "string" && typeof range.unit === "string"
    ) {
      return `料金(${range.unit}): ${range.min}〜${range.max}${range.currency}`;
    }
  }
  if (claim.key === "amenities" && Array.isArray(claim.value)) {
    const values = claim.value.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
    if (values.length === claim.value.length) {
      return `設備: ${values.join(" / ")}`;
    }
  }
  if (
    (claim.key === "lodging.room_type" ||
      claim.key === "lodging.check_in_time" ||
      claim.key === "lodging.check_out_time") &&
    typeof claim.value === "string"
  ) {
    return `${claim.key}: ${claim.value}`;
  }
  if (claim.key === "rental_space.equipment" && Array.isArray(claim.value)) {
    const values = claim.value.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
    if (values.length === claim.value.length) {
      return `レンタル設備: ${values.join(" / ")}`;
    }
  }
  return `${claim.key}=${canonicalEvidenceValue(claim.value)}`;
}

export function neutralizeClaimsForModelPrompt(
  claims: readonly StructuredClaimInput[],
): StructuredClaimInput[] {
  return filterValidClaims([...claims]).map((claim) => ({
    key: claim.key,
    value: claim.value,
    rawText: formatNeutralSharedClaim(claim),
  }));
}

export function neutralCitationExcerpt(url: string): string {
  const parsed = parsePublicHttpUrl(url);
  return parsed
    ? `公開ページ (${parsed.hostname.toLowerCase()})`
    : "公開ページ";
}

// evidence.excerpt の保存上限 (pipeline.ts の insert と共有する)
export const EVIDENCE_EXCERPT_LIMIT = 500;

export interface SharedEvidenceContentRow {
  source_url: string;
  source_type: string;
  source_title?: string | null;
  excerpt?: string | null;
  structured_claims?: unknown;
}

// Evidence #0 is written directly from the place provider with this fixed title
// and excerpt contract. This distinguishes it from model citations on the same
// major-provider host without adding a schema column.
function isTrustedPlaceProviderRow(
  row: SharedEvidenceContentRow,
  claims: readonly StructuredClaimInput[],
): boolean {
  if (!parsePublicHttpUrl(row.source_url)) return false;
  if (
    row.source_type !== "major_place_provider" || claims.length === 0 ||
    typeof row.source_title !== "string"
  ) return false;
  if (!row.source_title.endsWith(" - 店舗情報")) return false;
  // excerpt は保存される claim 配列そのものから作る契約 (pipeline.ts の
  // expectedStoredExcerpt)。長い claim 群では保存時に EVIDENCE_EXCERPT_LIMIT で
  // 切られるため、切り詰め後の一致も同じ契約として許す
  const expected = claims.map((claim) => claim.rawText).join("。");
  return row.excerpt === expected ||
    row.excerpt === expected.slice(0, EVIDENCE_EXCERPT_LIMIT);
}

function isModelNeutralRow(
  row: SharedEvidenceContentRow,
  claims: readonly StructuredClaimInput[],
): boolean {
  if (!isSafeModelNeutralSharedUrl(row.source_url)) return false;
  const modelNeutralKeys = new Set([
    "card_accepted",
    "reservation",
    "private_room",
    "capacity",
    "budget_dinner",
    "opening_hours",
    "non_smoking",
    "wifi_available",
    "child_friendly",
    "nearest_station_walk_minutes",
    "category",
    "price_range",
    "amenities",
    "lodging.room_type",
    "lodging.check_in_time",
    "lodging.check_out_time",
    "rental_space.equipment",
  ]);
  if (claims.some((claim) => !modelNeutralKeys.has(claim.key))) return false;
  const expectedTitle = neutralCitationExcerpt(row.source_url);
  const expectedClaims = neutralizeClaimsForModelPrompt(claims);
  const expectedExcerpt = expectedClaims.length > 0
    ? expectedClaims.map((claim) => claim.rawText).join("。")
    : expectedTitle;
  return row.source_title === expectedTitle &&
    row.excerpt === expectedExcerpt &&
    claims.length === expectedClaims.length &&
    claims.every((claim, index) =>
      claim.rawText === expectedClaims[index]?.rawText
    );
}

export function isReusableSafeSharedEvidence(
  row: SharedEvidenceContentRow,
): boolean {
  const claims = filterValidClaims(
    Array.isArray(row.structured_claims)
      ? row.structured_claims as StructuredClaimInput[]
      : [],
  );
  return isTrustedPlaceProviderRow(row, claims) ||
    isModelNeutralRow(row, claims);
}

export function filterReusableSafeSharedEvidence<
  T extends SharedEvidenceContentRow,
>(rows: readonly T[]): T[] {
  return rows.filter(isReusableSafeSharedEvidence);
}

export interface InvestigationEvidenceContentRow
  extends SharedEvidenceContentRow {
  scope?: string | null;
  investigation_id?: string | null;
}

// Ranking may use neutral shared assets plus private Evidence belonging to the
// investigation being ranked. Incoherent scope/id pairs and another run's rows
// are fail-closed; legacy shared prose must pass the same boundary as reuse.
export function filterEvidenceForInvestigation<
  T extends InvestigationEvidenceContentRow,
>(rows: readonly T[], investigationId: string): T[] {
  return rows.filter((row) => {
    if (row.scope === "shared" && row.investigation_id === null) {
      return isReusableSafeSharedEvidence(row);
    }
    return row.scope === "investigation" &&
      row.investigation_id === investigationId;
  });
}
