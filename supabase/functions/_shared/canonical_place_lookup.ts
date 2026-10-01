// 既存 canonical Place の先行照合 (#567 / #530)
//
// このモジュールは provider adapter ではなく、service-role の read path と
// 決定的な候補統合だけを担当する。利用者入力から候補 ID を申告させず、
// 曖昧な名称一致・推測・外部 API 呼び出しはここでは行わない。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlaceSearchResult } from "./providers/types.ts";
import type { ClaimKey, StructuredClaim } from "./types.ts";
import { formatNeutralSharedClaim } from "./evidence_content.ts";
import { isEvidenceWithinTtl } from "./provider_ttl.ts";
import { filterValidClaims, type StructuredClaimInput } from "./validation.ts";

export type CanonicalLookupOutcome =
  | "hit"
  | "partial"
  | "miss"
  | "error"
  | "skipped";

export interface CanonicalLookupInput {
  area: string;
  keyword?: string;
  requiredCount: number;
  broadLimit: number;
  currentLocationRequested?: boolean;
  searchAnchor?: { lat: number; lng: number } | null;
  now?: Date;
}

export interface CanonicalPlaceRow {
  id?: unknown;
  provider?: unknown;
  provider_place_id?: unknown;
  name?: unknown;
  address?: unknown;
  lat?: unknown;
  lng?: unknown;
  metadata?: unknown;
  embedding?: unknown;
  updated_at?: unknown;
  place_provider_links?: unknown;
  evidence?: unknown;
  place_facts?: unknown;
}

export type KnowledgeFreshness = "fresh" | "stale" | "missing";

export interface CanonicalPlaceHit {
  result: PlaceSearchResult;
  canonicalPlaceId: string;
  embedding: string | null;
  linkId: string;
  /** 同一 canonical place に紐付く全 usable provider identity。 */
  aliases: string[];
  providerLinkCount: number;
  provenanceCount: number;
  /** fact/evidenceの再利用状態。古い値をfreshとして扱わないための境界。 */
  factFreshness: KnowledgeFreshness;
  freshFactKeys: string[];
  staleFactKeys: string[];
  freshClaimKeys: string[];
  staleClaimKeys: string[];
}

export interface CanonicalLookupResult {
  outcome: CanonicalLookupOutcome;
  hits: CanonicalPlaceHit[];
  canonicalCandidateCount: number;
  providerLinkCount: number;
  provenanceCount: number;
}

export interface CanonicalDiscoveryResolution {
  outcome: CanonicalLookupOutcome;
  results: PlaceSearchResult[];
  canonicalHits: Map<string, CanonicalPlaceHit>;
  canonicalAliases: Map<string, string>;
  canonicalCandidateCount: number;
  providerLinkCount: number;
  provenanceCount: number;
  externalProviderCalls: number;
}

const CANONICAL_LOOKUP_LIMIT = 256;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAYABLE_STORAGE_POLICIES = new Set(["persistent", "ttl"]);
const PRIVATE_METADATA_KEYS = new Set([
  "rawquery",
  "rawtext",
  "query",
  "queries",
  "searchquery",
  "searchqueries",
  "normalizedquery",
  "searchanchor",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "coordinates",
  "geolocation",
  "position",
  "taste",
  "tasteprofile",
  "health",
  "allergy",
  "requirements",
  "requirement",
  "originaltext",
  "normalizedtext",
]);

const AREA_METADATA_KEYS = [
  "area",
  "canonical_area",
  "canonicalArea",
  "search_area",
  "searchArea",
];
const KEYWORD_METADATA_KEYS = [
  "keywords",
  "canonical_keywords",
  "canonicalKeywords",
  "search_keywords",
  "searchKeywords",
  "categories",
];
const CLAIM_KEYS = new Set([
  "opening_hours",
  "closed_days",
  "budget_dinner",
  "card_accepted",
  "reservation",
  "private_room",
  "capacity",
  "genre",
  "noise_level",
  "time_limit",
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

/** DB の文字列比較前に使う、曖昧さを増やさない最小正規化。 */
export function normalizeCanonicalToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[、。，．・,./\\-]+/gu, "");
}

/** provider identity を canonical ID に結び付ける内部キー。ログには出さない。 */
export function canonicalResultKey(
  result: Pick<PlaceSearchResult, "provider" | "providerPlaceId">,
): string {
  return `${
    result.provider.trim().toLocaleLowerCase("en-US")
  }\u0000${result.providerPlaceId.trim()}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((row): row is Record<string, unknown> =>
      row !== null
    );
  }
  const row = asRecord(value);
  return row ? [row] : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteCoordinate(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < min ||
    value > max
  ) {
    return undefined;
  }
  return value;
}

function normalizeMetadataKey(key: string): string {
  return key.toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "");
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadataValue(entry, depth + 1)).filter(
      (entry): entry is Exclude<typeof entry, undefined> => entry !== undefined,
    );
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (PRIVATE_METADATA_KEYS.has(normalizeMetadataKey(key))) continue;
    const sanitized = sanitizeMetadataValue(entry, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function safeMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeMetadataValue(value);
  return asRecord(sanitized) ?? {};
}

function stringValues(value: unknown, depth = 0): string[] {
  if (depth > 2) return [];
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => stringValues(entry, depth + 1));
}

function metadataValues(
  metadata: Record<string, unknown>,
  keys: string[],
): string[] {
  return keys.flatMap((key) => stringValues(metadata[key]));
}

function matchesArea(
  address: string,
  metadata: Record<string, unknown>,
  areaToken: string,
): boolean {
  if (!areaToken) return false;
  const exactMetadata = metadataValues(metadata, AREA_METADATA_KEYS)
    .some((value) => normalizeCanonicalToken(value) === areaToken);
  return exactMetadata || normalizeCanonicalToken(address).includes(areaToken);
}

function matchesKeyword(
  name: string,
  metadata: Record<string, unknown>,
  claims: StructuredClaim[],
  keyword: string | undefined,
): boolean {
  const keywordToken = normalizeCanonicalToken(keyword ?? "");
  if (!keywordToken) return true;
  const directValues = [
    name,
    ...metadataValues(metadata, KEYWORD_METADATA_KEYS),
  ];
  if (
    directValues.some((value) =>
      normalizeCanonicalToken(value).includes(keywordToken)
    )
  ) {
    return true;
  }
  return claims.some((claim) =>
    claim.key === "genre" &&
    stringValues(claim.value).some((value) =>
      normalizeCanonicalToken(value).includes(keywordToken)
    )
  );
}

function parseClaims(
  rows: Record<string, unknown>[],
  usableLinkIds: ReadonlySet<string>,
): StructuredClaim[] {
  const claims: StructuredClaim[] = [];
  for (const row of rows) {
    if (row.source_type !== "major_place_provider") continue;
    const providerLinkId = nonEmptyString(row.provider_link_id);
    // link が null/未知の Evidence は、expired/purged provider の claims を
    // canonical reuse に混ぜないため fail-closed とする。
    if (!providerLinkId || !usableLinkIds.has(providerLinkId)) continue;
    const entries = Array.isArray(row.structured_claims)
      ? row.structured_claims
      : [];
    for (const entry of entries) {
      const claim = asRecord(entry);
      const key = typeof claim?.key === "string" ? claim.key : null;
      const rawText = typeof claim?.rawText === "string" ? claim.rawText : null;
      if (!key || !CLAIM_KEYS.has(key) || !rawText) continue;
      claims.push({
        key: key as StructuredClaim["key"],
        value: claim?.value,
        rawText,
      });
    }
  }
  return claims;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")
  }}`;
}

function claimValueMatches(
  claim: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  return claim.key === key &&
    canonicalJson(claim.value) === canonicalJson(value);
}

interface FactSnapshot {
  claims: StructuredClaim[];
  factCount: number;
  freshFactKeys: string[];
  staleFactKeys: string[];
  factFreshness: KnowledgeFreshness;
}

function factSnapshot(
  row: CanonicalPlaceRow,
  trustedEvidenceRows: Record<string, unknown>[],
  now: Date,
): FactSnapshot {
  const claims: StructuredClaim[] = [];
  const freshFactKeys = new Set<string>();
  const staleFactKeys = new Set<string>();
  let factCount = 0;
  for (const fact of asRecords(row.place_facts)) {
    const key = typeof fact.key === "string" && CLAIM_KEYS.has(fact.key)
      ? fact.key
      : null;
    const lastVerifiedAt = typeof fact.last_verified_at === "string"
      ? fact.last_verified_at
      : null;
    const conflicting = fact.conflicting === true;
    if (
      !key || !lastVerifiedAt || !Number.isFinite(Date.parse(lastVerifiedAt))
    ) {
      continue;
    }
    const valid = filterValidClaims([{
      key: key as StructuredClaimInput["key"],
      value: fact.value,
      rawText: "fact",
    }]);
    if (valid.length === 0) continue;
    factCount += 1;
    const hasFreshEvidence = !conflicting &&
      trustedEvidenceRows.some((evidence) => {
        if (
          evidence.source_type !== "major_place_provider" ||
          typeof evidence.observed_at !== "string" ||
          !isEvidenceWithinTtl({
            source_type: evidence.source_type,
            observed_at: evidence.observed_at,
          }, now)
        ) return false;
        const entries = Array.isArray(evidence.structured_claims)
          ? evidence.structured_claims
          : [];
        return entries.some((entry) => {
          const claim = asRecord(entry);
          return claim !== null && claimValueMatches(claim, key, fact.value);
        });
      });
    const target = hasFreshEvidence ? freshFactKeys : staleFactKeys;
    target.add(key);
    if (hasFreshEvidence) {
      const neutral = formatNeutralSharedClaim(valid[0]);
      claims.push({
        key: key as ClaimKey,
        value: fact.value,
        rawText: neutral,
      });
    }
  }
  const freshness: KnowledgeFreshness = freshFactKeys.size > 0
    ? "fresh"
    : factCount > 0
    ? "stale"
    : "missing";
  return {
    claims,
    factCount,
    freshFactKeys: [...freshFactKeys].sort(compareStableStrings),
    staleFactKeys: [...staleFactKeys].sort(compareStableStrings),
    factFreshness: freshness,
  };
}

function usableLinks(
  row: CanonicalPlaceRow,
  now: Date,
): Record<string, unknown>[] {
  return asRecords(row.place_provider_links)
    .filter((link) => {
      const provider = nonEmptyString(link.provider);
      const providerPlaceId = nonEmptyString(link.provider_place_id);
      const linkId = nonEmptyString(link.id);
      const policy = nonEmptyString(link.storage_policy);
      const attribution = nonEmptyString(link.attribution_policy);
      const lastSeen = nonEmptyString(link.last_seen_at);
      if (
        !provider || !providerPlaceId || !linkId || !policy || !attribution ||
        !lastSeen
      ) {
        return false;
      }
      if (!Number.isFinite(Date.parse(lastSeen))) return false;
      if (provider.toLocaleLowerCase("en-US") === "mock") return false;
      if (!DISPLAYABLE_STORAGE_POLICIES.has(policy)) return false;
      const expiresAt = link.expires_at;
      if (expiresAt !== null && expiresAt !== undefined) {
        if (typeof expiresAt !== "string") return false;
        const expiryMs = Date.parse(expiresAt);
        if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime()) {
          return false;
        }
      }
      if (policy === "ttl" && (expiresAt === null || expiresAt === undefined)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftPolicy = left.storage_policy === "persistent" ? 0 : 1;
      const rightPolicy = right.storage_policy === "persistent" ? 0 : 1;
      if (leftPolicy !== rightPolicy) return leftPolicy - rightPolicy;
      const leftSeen = Date.parse(
        typeof left.last_seen_at === "string" ? left.last_seen_at : "",
      );
      const rightSeen = Date.parse(
        typeof right.last_seen_at === "string" ? right.last_seen_at : "",
      );
      if (Number.isFinite(leftSeen) !== Number.isFinite(rightSeen)) {
        return Number.isFinite(rightSeen) ? 1 : -1;
      }
      if (leftSeen !== rightSeen) return rightSeen - leftSeen;
      const leftKey = `${nonEmptyString(left.provider) ?? ""}\u0000${
        nonEmptyString(left.provider_place_id) ?? ""
      }`;
      const rightKey = `${nonEmptyString(right.provider) ?? ""}\u0000${
        nonEmptyString(right.provider_place_id) ?? ""
      }`;
      return compareStableStrings(leftKey, rightKey);
    });
}

function hitFromRow(
  row: CanonicalPlaceRow,
  input: CanonicalLookupInput,
): CanonicalPlaceHit | null {
  const canonicalPlaceId = nonEmptyString(row.id);
  const name = nonEmptyString(row.name);
  const address = nonEmptyString(row.address);
  if (!canonicalPlaceId || !name || !address) return null;

  const lat = finiteCoordinate(row.lat, -90, 90);
  const lng = finiteCoordinate(row.lng, -180, 180);
  // 両方 null は住所だけで決定できる canonical row として許可する。
  // 片方だけ、または範囲外は壊れた行なので安全側に除外する。
  if (
    lat === undefined || lng === undefined || (lat === null) !== (lng === null)
  ) return null;

  const metadata = safeMetadata(row.metadata);
  const evidenceRows = asRecords(row.evidence)
    .sort((left, right) => {
      const leftObserved = Date.parse(
        typeof left.observed_at === "string" ? left.observed_at : "",
      );
      const rightObserved = Date.parse(
        typeof right.observed_at === "string" ? right.observed_at : "",
      );
      return (Number.isFinite(rightObserved) ? rightObserved : -Infinity) -
        (Number.isFinite(leftObserved) ? leftObserved : -Infinity);
    });
  const links = usableLinks(row, input.now ?? new Date());
  if (links.length === 0) return null;
  const selected = links[0];
  const provider = nonEmptyString(selected.provider);
  const providerPlaceId = nonEmptyString(selected.provider_place_id);
  const linkId = nonEmptyString(selected.id);
  if (!provider || !providerPlaceId || !linkId) return null;
  const usableLinkIds = new Set(
    links.map((link) => nonEmptyString(link.id)).filter(
      (linkId): linkId is string => linkId !== null,
    ),
  );
  const trustedEvidenceRows = evidenceRows.filter((evidence) => {
    const providerLinkId = nonEmptyString(evidence.provider_link_id);
    // PlaceSearchResult は selected link の identity を表すため、同じ
    // canonical place の別 provider claims も混在させない。
    return providerLinkId === linkId && usableLinkIds.has(providerLinkId);
  });
  const claims = parseClaims(trustedEvidenceRows, usableLinkIds);
  const freshClaimKeys = new Set<string>();
  for (const evidence of trustedEvidenceRows) {
    if (
      evidence.source_type !== "major_place_provider" ||
      typeof evidence.observed_at !== "string" ||
      !isEvidenceWithinTtl({
        source_type: evidence.source_type,
        observed_at: evidence.observed_at,
      }, input.now ?? new Date())
    ) continue;
    const entries = Array.isArray(evidence.structured_claims)
      ? evidence.structured_claims
      : [];
    for (const entry of entries) {
      const claim = asRecord(entry);
      if (typeof claim?.key === "string" && CLAIM_KEYS.has(claim.key)) {
        freshClaimKeys.add(claim.key);
      }
    }
  }
  const snapshot = factSnapshot(
    row,
    trustedEvidenceRows,
    input.now ?? new Date(),
  );
  const mergedClaims = [...claims];
  const seenClaimValues = new Set(
    mergedClaims.map((claim) =>
      `${claim.key}\u0000${canonicalJson(claim.value)}`
    ),
  );
  for (const claim of snapshot.claims) {
    const key = `${claim.key}\u0000${canonicalJson(claim.value)}`;
    if (seenClaimValues.has(key)) continue;
    seenClaimValues.add(key);
    mergedClaims.push(claim);
  }
  for (const key of snapshot.freshFactKeys) freshClaimKeys.add(key);
  const staleClaimKeys = new Set(
    mergedClaims.map((claim) => claim.key).filter((key) =>
      !freshClaimKeys.has(key)
    ),
  );
  const areaToken = normalizeCanonicalToken(input.area);
  if (
    !matchesArea(address, metadata, areaToken) ||
    !matchesKeyword(name, metadata, mergedClaims, input.keyword)
  ) return null;

  const sourceUrl = nonEmptyString(selected.source_url) ??
    nonEmptyString(trustedEvidenceRows[0]?.source_url) ?? "";
  const fetchedAt = nonEmptyString(selected.last_seen_at) ??
    nonEmptyString(row.updated_at) ?? undefined;
  const embedding = typeof row.embedding === "string" ? row.embedding : null;
  const aliases = links.map((link) =>
    canonicalResultKey({
      provider: nonEmptyString(link.provider) ?? "",
      providerPlaceId: nonEmptyString(link.provider_place_id) ?? "",
    })
  );
  const result: PlaceSearchResult = {
    provider,
    providerPlaceId,
    name,
    address,
    lat,
    lng,
    url: sourceUrl,
    structuredClaims: mergedClaims,
    metadata,
    ...(fetchedAt ? { fetchedAt } : {}),
  };
  return {
    result,
    canonicalPlaceId,
    embedding,
    linkId,
    aliases,
    providerLinkCount: links.length,
    provenanceCount: links.length + mergedClaims.length,
    factFreshness: snapshot.factFreshness,
    freshFactKeys: snapshot.freshFactKeys,
    staleFactKeys: snapshot.staleFactKeys,
    freshClaimKeys: [...freshClaimKeys].sort(compareStableStrings),
    staleClaimKeys: [...staleClaimKeys].sort(compareStableStrings),
  };
}

/** DB responseを純粋に絞り込み、canonical IDごとに最大1候補へする。 */
export function selectCanonicalPlaceHits(
  rows: CanonicalPlaceRow[],
  input: CanonicalLookupInput,
): CanonicalLookupResult {
  // searchAnchor は current_location の provider検索時だけ意味を持つ。
  // 通常の地名queryに残った任意anchorで canonical DB lookup を迂回させない。
  if (input.currentLocationRequested) {
    return {
      outcome: "skipped",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }
  const sortedHits = rows
    .map((row) => hitFromRow(row, input))
    .filter((hit): hit is CanonicalPlaceHit => hit !== null)
    .sort((left, right) => {
      const byCanonicalId = compareStableStrings(
        left.canonicalPlaceId,
        right.canonicalPlaceId,
      );
      return byCanonicalId !== 0 ? byCanonicalId : compareStableStrings(
        canonicalResultKey(left.result),
        canonicalResultKey(right.result),
      );
    });
  const uniqueHits: CanonicalPlaceHit[] = [];
  const seenCanonicalIds = new Set<string>();
  const seenResultKeys = new Set<string>();
  for (const hit of sortedHits) {
    // DBでは id / (provider, provider_place_id) が一意だが、read pathの
    // join/fixtureが重複しても候補数を水増ししない。canonical IDを正本に
    // しつつ provider identity の重複も安全側で除外する。
    const resultKey = canonicalResultKey(hit.result);
    if (seenCanonicalIds.has(hit.canonicalPlaceId)) continue;
    if (seenResultKeys.has(resultKey)) continue;
    seenCanonicalIds.add(hit.canonicalPlaceId);
    seenResultKeys.add(resultKey);
    uniqueHits.push(hit);
  }
  const hits = uniqueHits.slice(0, Math.max(0, input.broadLimit));
  const canonicalCandidateCount = hits.length;
  return {
    outcome: canonicalCandidateCount >= Math.max(1, input.requiredCount)
      ? "hit"
      : canonicalCandidateCount > 0
      ? "partial"
      : "miss",
    hits,
    canonicalCandidateCount,
    providerLinkCount: hits.reduce(
      (sum, hit) => sum + hit.providerLinkCount,
      0,
    ),
    provenanceCount: hits.reduce((sum, hit) => sum + hit.provenanceCount, 0),
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll(
    "_",
    "\\_",
  );
}

const CANONICAL_SELECT = [
  "id,provider,provider_place_id,name,address,lat,lng,metadata,embedding,updated_at",
  "place_provider_links(id,provider,provider_place_id,source_url,storage_policy,expires_at,attribution_policy,last_seen_at)",
  "evidence(id,source_url,source_type,structured_claims,observed_at,provider_link_id)",
  "place_facts(key,value,confidence,evidence_count,conflicting,last_verified_at)",
].join(",");

/**
 * service-role DBからの canonical read path。検索対象は address の DB prefilter
 * だけに使い、最終判定は selectCanonicalPlaceHits の exact 条件で再確認する。
 */
export async function readCanonicalPlaces(
  db: SupabaseClient,
  input: CanonicalLookupInput,
): Promise<CanonicalLookupResult> {
  if (input.currentLocationRequested) {
    return selectCanonicalPlaceHits([], input);
  }
  const area = input.area.trim();
  if (!area || input.broadLimit <= 0) {
    return {
      outcome: "skipped",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }
  try {
    const { data, error } = await db
      .from("places")
      .select(CANONICAL_SELECT)
      .ilike("address", `%${escapeLike(area)}%`)
      .order("id", { ascending: true })
      .limit(CANONICAL_LOOKUP_LIMIT);
    if (error) {
      return {
        outcome: "error",
        hits: [],
        canonicalCandidateCount: 0,
        providerLinkCount: 0,
        provenanceCount: 0,
      };
    }
    return selectCanonicalPlaceHits((data ?? []) as CanonicalPlaceRow[], input);
  } catch {
    // エラー本文は raw query / provider情報を含み得るため返さない。
    return {
      outcome: "error",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }
}

/**
 * 既存 Knowledge から得た canonical place ID を同じ安全な read path で読む。
 * ID は認証済み recall RPC の集計結果からのみ渡し、任意の利用者入力を候補IDに
 * 変換しない。area/keyword の再検証も readCanonicalPlaces と同じく必ず行う。
 */
export async function readCanonicalPlacesByIds(
  db: SupabaseClient,
  input: CanonicalLookupInput,
  placeIds: readonly string[],
): Promise<CanonicalLookupResult> {
  if (input.currentLocationRequested || input.broadLimit <= 0) {
    return {
      outcome: "skipped",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }
  const ids = [
    ...new Set(
      placeIds
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => UUID_RE.test(id)),
    ),
  ]
    .slice(0, CANONICAL_LOOKUP_LIMIT);
  if (ids.length === 0) {
    return {
      outcome: "skipped",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }
  try {
    const { data, error } = await db
      .from("places")
      .select(CANONICAL_SELECT)
      .in("id", ids)
      .order("id", { ascending: true })
      .limit(CANONICAL_LOOKUP_LIMIT);
    if (error) {
      return {
        outcome: "error",
        hits: [],
        canonicalCandidateCount: 0,
        providerLinkCount: 0,
        provenanceCount: 0,
      };
    }
    return selectCanonicalPlaceHits((data ?? []) as CanonicalPlaceRow[], input);
  } catch {
    return {
      outcome: "error",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }
}

/** canonical hit不足時のみ、現在の provider search をちょうど1回呼ぶ。 */
export async function resolveCanonicalDiscovery(
  lookup: () => Promise<CanonicalLookupResult>,
  search: () => Promise<PlaceSearchResult[]>,
  options: { requiredCount: number; broadLimit: number },
): Promise<CanonicalDiscoveryResolution> {
  let canonical: CanonicalLookupResult;
  try {
    canonical = await lookup();
  } catch {
    canonical = {
      outcome: "error",
      hits: [],
      canonicalCandidateCount: 0,
      providerLinkCount: 0,
      provenanceCount: 0,
    };
  }

  const canonicalAliases = new Map<string, string>();
  const canonicalHits = new Map<string, CanonicalPlaceHit>();
  const results: PlaceSearchResult[] = [];
  const seenResultKeys = new Set<string>();
  const seenCanonicalIds = new Set<string>();
  for (const hit of canonical.hits) {
    if (seenCanonicalIds.has(hit.canonicalPlaceId)) continue;
    const resultKey = canonicalResultKey(hit.result);
    if (seenResultKeys.has(resultKey)) continue;
    seenCanonicalIds.add(hit.canonicalPlaceId);
    seenResultKeys.add(resultKey);
    canonicalHits.set(resultKey, hit);
    for (const alias of hit.aliases) {
      canonicalAliases.set(alias, hit.canonicalPlaceId);
    }
    results.push(hit.result);
  }

  // 重複行を除外した後の候補数だけを「十分」と数える。broadLimit が
  // requiredCount 未満の場合も、足りない分を従来 provider discovery で補完する。
  const canonicalResultCount = results.length;
  if (canonicalResultCount >= Math.max(1, options.requiredCount)) {
    return {
      outcome: "hit",
      results: results.slice(0, Math.max(0, options.broadLimit)),
      canonicalHits,
      canonicalAliases,
      canonicalCandidateCount: canonical.canonicalCandidateCount,
      providerLinkCount: canonical.providerLinkCount,
      provenanceCount: canonical.provenanceCount,
      externalProviderCalls: 0,
    };
  }

  const externalResults = await search();
  const externalProviderCalls = 1;
  for (const result of externalResults) {
    if (results.length >= Math.max(0, options.broadLimit)) break;
    const resultKey = canonicalResultKey(result);
    const canonicalId = canonicalAliases.get(resultKey);
    if (canonicalId && seenCanonicalIds.has(canonicalId)) continue;
    if (seenResultKeys.has(resultKey)) continue;
    seenResultKeys.add(resultKey);
    results.push(result);
  }
  return {
    outcome: canonicalResultCount > 0
      ? "partial"
      : canonical.outcome === "error"
      ? "error"
      : canonical.outcome === "skipped"
      ? "skipped"
      : "miss",
    results,
    canonicalHits,
    canonicalAliases,
    canonicalCandidateCount: canonical.canonicalCandidateCount,
    providerLinkCount: canonical.providerLinkCount,
    provenanceCount: canonical.provenanceCount,
    externalProviderCalls,
  };
}
