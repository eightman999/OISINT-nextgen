// place_facts 需要駆動 refresh (#123) の純粋な境界。
//
// TTL・重み・batch/rate はこのモジュールで補完しない。DB の owner config を
// parse した値だけを受け取り、欠落・不正値は fail-closed にする。provider 呼出し
// や Supabase 書き込みは worker 側に置き、ここは選定・観測分類の決定論だけを持つ。
import type { PlaceSearchResult } from "./providers/types.ts";

const CONFIG_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const PROVIDER_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{0,251}$/;
const PLACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class DemandRefreshConfigError extends Error {
  constructor(message: string) {
    super(`demand refresh config is unavailable: ${message}`);
    this.name = "DemandRefreshConfigError";
  }
}

export interface DemandRefreshConfig {
  configVersion: string;
  provider: string;
  providerDomain: string;
  providerTtlHours: number;
  factTtlHours: number;
  recentUsageWindowHours: number;
  batchSize: number;
  leaseSeconds: number;
  providerCooldownSeconds: number;
  usageWeight: number;
  freshnessWeight: number;
  factImportanceWeight: number;
  enabled: true;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value);
}

function requiredString(
  row: UnknownRecord,
  key: string,
  pattern: RegExp,
): string {
  const value = row[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DemandRefreshConfigError(`${key} is missing or invalid`);
  }
  return value;
}

function requiredInteger(
  row: UnknownRecord,
  key: string,
  minimum: number,
): number {
  const value = row[key];
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new DemandRefreshConfigError(`${key} is missing or invalid`);
  }
  return value;
}

function requiredWeight(row: UnknownRecord, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0
  ) {
    throw new DemandRefreshConfigError(`${key} is missing or invalid`);
  }
  return value;
}

/**
 * DB の owner config を補完なしで検証する。enabled=false と欠落 config は
 * 同じ停止側へ倒し、worker が暗黙の TTL/重みで provider を呼ばないようにする。
 */
export function parseDemandRefreshConfig(
  raw: unknown,
): DemandRefreshConfig {
  if (!isRecord(raw)) {
    throw new DemandRefreshConfigError("row is missing");
  }
  const enabled = raw.enabled;
  if (enabled !== true) {
    throw new DemandRefreshConfigError("config is disabled");
  }
  const usageWeight = requiredWeight(raw, "usage_weight");
  const freshnessWeight = requiredWeight(raw, "freshness_weight");
  const factImportanceWeight = requiredWeight(
    raw,
    "fact_importance_weight",
  );
  if (usageWeight + freshnessWeight + factImportanceWeight <= 0) {
    throw new DemandRefreshConfigError("all weights are zero");
  }
  return {
    configVersion: requiredString(raw, "config_version", CONFIG_VERSION_RE),
    provider: requiredString(raw, "provider", PROVIDER_RE),
    providerDomain: requiredString(
      raw,
      "provider_domain",
      PROVIDER_DOMAIN_RE,
    ),
    providerTtlHours: requiredInteger(raw, "provider_ttl_hours", 1),
    factTtlHours: requiredInteger(raw, "fact_ttl_hours", 1),
    recentUsageWindowHours: requiredInteger(
      raw,
      "recent_usage_window_hours",
      1,
    ),
    batchSize: requiredInteger(raw, "batch_size", 1),
    leaseSeconds: requiredInteger(raw, "lease_seconds", 1),
    providerCooldownSeconds: requiredInteger(
      raw,
      "provider_cooldown_seconds",
      0,
    ),
    usageWeight,
    freshnessWeight,
    factImportanceWeight,
    enabled: true,
  };
}

export interface RefreshTargetCandidate {
  placeId: string;
  provider: string;
  providerPlaceId: string;
  sourceUrl: string | null;
  lastUsedAt: string;
  lastVerifiedAt: string;
  refreshedAt: string;
  factImportance: number;
  leaseExpiresAt: string | null;
  lastAttemptedAt: string | null;
  vectorSourceVersion: string | null;
}

export interface SelectedRefreshTarget extends RefreshTargetCandidate {
  priorityScore: number;
}

function timestampMs(value: string): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function validCandidateIdentity(candidate: RefreshTargetCandidate): boolean {
  return PLACE_ID_RE.test(candidate.placeId) &&
    typeof candidate.provider === "string" && candidate.provider.length > 0 &&
    typeof candidate.providerPlaceId === "string" &&
    candidate.providerPlaceId.length > 0 &&
    (typeof candidate.sourceUrl === "string" || candidate.sourceUrl === null);
}

/** SQL select_refresh_targets と同じ score を純粋に計算する。 */
export function demandRefreshPriorityScore(
  candidate: RefreshTargetCandidate,
  config: DemandRefreshConfig,
  now: Date,
): number | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !validCandidateIdentity(candidate)) {
    return null;
  }
  if (
    !Number.isFinite(candidate.factImportance) ||
    candidate.factImportance < 0 || candidate.factImportance > 1
  ) return null;
  const lastUsedMs = timestampMs(candidate.lastUsedAt);
  const lastVerifiedMs = timestampMs(candidate.lastVerifiedAt);
  const refreshedMs = timestampMs(candidate.refreshedAt);
  if (lastUsedMs === null || lastVerifiedMs === null || refreshedMs === null) {
    return null;
  }
  const recentWindowMs = config.recentUsageWindowHours * 3_600_000;
  const factTtlMs = config.factTtlHours * 3_600_000;
  const usageAge = nowMs - lastUsedMs;
  const factAge = nowMs - lastVerifiedMs;
  const usageScore = clamp01(1 - usageAge / recentWindowMs);
  const freshnessUrgency = clamp01(factAge / factTtlMs);
  return usageScore * config.usageWeight +
    freshnessUrgency * config.freshnessWeight +
    candidate.factImportance * config.factImportanceWeight;
}

/**
 * indexed place_refresh_demand から渡された行だけを選ぶ。全 places/candidates の
 * blind scan はこの関数の責務に含めず、DB 側の demand aggregate が境界になる。
 */
export function selectRefreshTargets(
  rows: readonly RefreshTargetCandidate[],
  limit: number,
  config: DemandRefreshConfig,
  now: Date,
): SelectedRefreshTarget[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.batchSize) {
    throw new RangeError("refresh limit is outside configured batch size");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("refresh time is invalid");
  const recentCutoff = nowMs - config.recentUsageWindowHours * 3_600_000;
  const providerCutoff = nowMs - config.providerTtlHours * 3_600_000;
  const factCutoff = nowMs - config.factTtlHours * 3_600_000;
  const attemptCutoff = nowMs - config.providerCooldownSeconds * 1_000;

  const eligible: SelectedRefreshTarget[] = [];
  for (const row of rows) {
    const lastUsedMs = timestampMs(row.lastUsedAt);
    const lastVerifiedMs = timestampMs(row.lastVerifiedAt);
    const refreshedMs = timestampMs(row.refreshedAt);
    if (
      row.provider !== config.provider || lastUsedMs === null ||
      lastVerifiedMs === null || refreshedMs === null ||
      lastUsedMs < recentCutoff || refreshedMs > providerCutoff ||
      lastVerifiedMs > factCutoff ||
      (row.leaseExpiresAt !== null &&
        (timestampMs(row.leaseExpiresAt) ?? Infinity) > nowMs) ||
      (row.lastAttemptedAt !== null &&
        (timestampMs(row.lastAttemptedAt) ?? Infinity) > attemptCutoff)
    ) continue;
    const priorityScore = demandRefreshPriorityScore(row, config, now);
    if (priorityScore === null || !Number.isFinite(priorityScore)) continue;
    eligible.push({ ...row, priorityScore });
  }
  eligible.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    const used = timestampMs(b.lastUsedAt)! - timestampMs(a.lastUsedAt)!;
    if (used !== 0) return used;
    const verified = timestampMs(a.lastVerifiedAt)! -
      timestampMs(b.lastVerifiedAt)!;
    if (verified !== 0) return verified;
    return compareText(a.placeId, b.placeId);
  });
  return eligible.slice(0, limit);
}

// SQL RPC の名前を使う監査・テストからも同じ純粋関数へ到達できるようにする。
export const select_refresh_targets = selectRefreshTargets;

export type RefreshObservationKind =
  | "found"
  | "provider_error"
  | "closure_suspected";

export interface RefreshObservationResolution {
  kind: RefreshObservationKind;
  result: PlaceSearchResult | null;
  errorCode: string | null;
}

function isPlaceSearchResult(value: unknown): value is PlaceSearchResult {
  if (!isRecord(value)) return false;
  const coordinates = ["lat", "lng"] as const;
  if (
    typeof value.provider !== "string" ||
    typeof value.providerPlaceId !== "string" ||
    value.providerPlaceId.length === 0 ||
    typeof value.name !== "string" || typeof value.address !== "string" ||
    typeof value.url !== "string" || !Array.isArray(value.structuredClaims) ||
    !isRecord(value.metadata)
  ) return false;
  for (const coordinate of coordinates) {
    const point = value[coordinate];
    if (
      point !== null &&
      (typeof point !== "number" || !Number.isFinite(point))
    ) return false;
  }
  return value.fetchedAt === undefined || typeof value.fetchedAt === "string";
}

export function isValidRefreshResultBatch(
  value: unknown,
): value is PlaceSearchResult[] {
  return Array.isArray(value) && value.every(isPlaceSearchResult);
}

/** Provider error と「結果が無い」を別 outcome に固定する。 */
export function resolveRefreshObservation(
  target: Pick<RefreshTargetCandidate, "provider" | "providerPlaceId">,
  results: readonly PlaceSearchResult[] | unknown,
  providerError: unknown | null | undefined,
): RefreshObservationResolution {
  if (providerError !== null && providerError !== undefined) {
    return {
      kind: "provider_error",
      result: null,
      errorCode: "provider_error",
    };
  }
  if (!isValidRefreshResultBatch(results)) {
    return {
      kind: "provider_error",
      result: null,
      errorCode: "invalid_provider_result",
    };
  }
  const matches = results.filter((result) =>
    result.providerPlaceId === target.providerPlaceId
  );
  if (matches.length === 0) {
    return {
      kind: "closure_suspected",
      result: null,
      errorCode: "provider_missing_place",
    };
  }
  if (matches.length !== 1 || matches[0].provider !== target.provider) {
    return {
      kind: "provider_error",
      result: null,
      errorCode: "invalid_provider_result",
    };
  }
  return { kind: "found", result: matches[0], errorCode: null };
}

/** place_facts の semantic digest の変化だけを vector dirty として扱う。 */
export function factSourceVersionChanged(
  before: string | null,
  after: string | null,
): boolean {
  return before !== after;
}

export function refreshObservationKey(
  runId: string,
  placeId: string,
  kind: "provider" | "closure",
): string {
  return `refresh:${runId}:${placeId}:${kind}`;
}

export interface DemandRefreshMetrics {
  selected: number;
  processed: number;
  unchanged: number;
  changed: number;
  providerErrors: number;
  closureSuspected: number;
  storageErrors: number;
  evidenceAppended: number;
  providerCalls: number;
  providerItems: number;
  providerDurationMs: number;
}

export function emptyDemandRefreshMetrics(): DemandRefreshMetrics {
  return {
    selected: 0,
    processed: 0,
    unchanged: 0,
    changed: 0,
    providerErrors: 0,
    closureSuspected: 0,
    storageErrors: 0,
    evidenceAppended: 0,
    providerCalls: 0,
    providerItems: 0,
    providerDurationMs: 0,
  };
}

export function addObservationMetric(
  metrics: DemandRefreshMetrics,
  kind:
    | "unchanged"
    | "changed"
    | "provider_error"
    | "closure_suspected"
    | "storage_error",
  evidenceAppended = false,
): DemandRefreshMetrics {
  return {
    ...metrics,
    processed: metrics.processed + 1,
    unchanged: metrics.unchanged + (kind === "unchanged" ? 1 : 0),
    changed: metrics.changed + (kind === "changed" ? 1 : 0),
    providerErrors: metrics.providerErrors +
      (kind === "provider_error" ? 1 : 0),
    closureSuspected: metrics.closureSuspected +
      (kind === "closure_suspected" ? 1 : 0),
    storageErrors: metrics.storageErrors +
      (kind === "storage_error" ? 1 : 0),
    evidenceAppended: metrics.evidenceAppended + (evidenceAppended ? 1 : 0),
  };
}
