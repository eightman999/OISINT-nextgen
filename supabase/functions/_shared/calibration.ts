// Evidence の時系列から source reliability を測定する offline 純関数 (issue #121 / §44.6)。
//
// ここで作る値は「真実度」ではない。後続の同等以上の独立ソースが同じ claim を
// 支持したか、既存の contradiction ルールで覆したかを集計した calibration 用の値。
// DBを更新したり、観測できない結果を推測で補ったりせず、snapshot が不正なら呼び出し側が
// sourceQuality() の既存 heuristic へ戻る境界を提供する。
import type { ClaimKey, SourceType, StructuredClaim } from "./types.ts";
import { claimValuesConflict } from "./contradiction.ts";
import { parsePublicHttpUrl } from "./public_url.ts";
import { isSourceType, SOURCE_TYPES, sourceQuality } from "./source_quality.ts";
import { filterValidClaims, type StructuredClaimInput } from "./validation.ts";

export const SOURCE_RELIABILITY_ALGORITHM_VERSION =
  "source-reliability-v1" as const;

// contradiction.ts が実際に比較するキーだけを calibration 対象にする。
// closed_days は ClaimKey ではあるが、既存の claimValuesConflict() が比較しないため、
// ここで対象に加えると「比較不能」を確認済みと誤って学習する。
export const CALIBRATABLE_CLAIM_KEYS: ReadonlySet<ClaimKey> = new Set([
  "card_accepted",
  "reservation",
  "private_room",
  "opening_hours",
  "budget_dinner",
  "capacity",
]);

const MILLISECONDS_PER_DAY = 86_400_000;

export type CalibrationOutcome =
  | "confirmed"
  | "contradicted"
  | "unresolved";

// evidence のうち calibration に必要な最小公開形。excerpt/rawText は持ち込まない。
export interface CalibrationEvidence {
  id: string;
  placeId: string;
  sourceType: SourceType;
  sourceUrl: string;
  observedAt: string;
  structuredClaims: readonly StructuredClaim[];
}

export interface CalibrationObservation {
  evidenceId: string;
  placeId: string;
  sourceType: SourceType;
  claimKey: ClaimKey;
  observedAt: string;
  outcome: CalibrationOutcome;
  // 比較に使った独立 hostname の Evidence。未解決の場合は空配列。
  comparedEvidenceIds: readonly string[];
}

// priorStrength と horizonDays は policy 側で明示的に決める。未指定の値をこの
// モジュールで補完しないことで、推測値が production weight へ混ざるのを防ぐ。
export interface SourceReliabilityPolicy {
  horizonDays: number;
  priorStrength: number;
}

export interface SourceReliabilityEstimate {
  sourceType: SourceType;
  confirmedCount: number;
  contradictedCount: number;
  resolvedCount: number;
  overturnedRate: number | null;
  quality: number;
}

export interface SourceReliabilitySnapshot {
  algorithmVersion: typeof SOURCE_RELIABILITY_ALGORITHM_VERSION;
  horizonDays: number;
  priorStrength: number;
  estimates: readonly SourceReliabilityEstimate[];
}

export interface SourceReliabilityCalibration {
  observations: readonly CalibrationObservation[];
  snapshot: SourceReliabilitySnapshot;
}

export interface CalibrationMetricPoint {
  probability: number;
  outcome: "confirmed" | "contradicted";
}

export interface CalibrationMetrics {
  brierScore: number;
  expectedCalibrationError: number;
  resolvedCount: number;
}

interface NormalizedClaim {
  evidenceId: string;
  placeId: string;
  sourceType: SourceType;
  sourceUrl: string;
  hostname: string;
  observedAt: string;
  observedMillis: number;
  claimKey: ClaimKey;
  value: unknown;
  valueSignature: string;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validPolicy(policy: SourceReliabilityPolicy): boolean {
  return !!policy && Number.isFinite(policy.horizonDays) &&
    policy.horizonDays > 0 &&
    Number.isFinite(policy.priorStrength) && policy.priorStrength > 0 &&
    Number.isFinite(policy.horizonDays * MILLISECONDS_PER_DAY);
}

function canonicalValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value !== "object") {
    try {
      return JSON.stringify(value) ?? null;
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    const values = value.map(canonicalValue);
    return values.some((item) => item === null)
      ? null
      : `[${values.join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareCodeUnits);
  const entries: string[] = [];
  for (const key of keys) {
    const item = canonicalValue(object[key]);
    if (item === null) return null;
    entries.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${entries.join(",")}}`;
}

function normalizeHostname(sourceUrl: string): string | null {
  const parsed = parsePublicHttpUrl(sourceUrl);
  if (!parsed) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return hostname.length > 0 ? hostname : null;
}

function normalizeClaims(
  evidence: readonly CalibrationEvidence[],
): NormalizedClaim[] {
  const normalized: NormalizedClaim[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(evidence)) return normalized;

  for (const item of evidence) {
    if (
      typeof item?.id !== "string" || item.id.length === 0 ||
      typeof item.placeId !== "string" || item.placeId.length === 0 ||
      !isSourceType(item.sourceType) || typeof item.observedAt !== "string" ||
      typeof item.sourceUrl !== "string" ||
      !Array.isArray(item.structuredClaims)
    ) continue;
    const hostname = normalizeHostname(item.sourceUrl);
    const observedMillis = new Date(item.observedAt).getTime();
    if (!hostname || !Number.isFinite(observedMillis)) continue;

    // Evidence は既に validator を通る契約だが、calibration 境界でも再検証し、
    // 壊れた DB read-back が確認済み票になることを防止する。
    const rawClaims = (item.structuredClaims as readonly unknown[]).filter((
      claim: unknown,
    ): claim is StructuredClaim =>
      claim !== null && typeof claim === "object" &&
      typeof (claim as Record<string, unknown>).key === "string" &&
      typeof (claim as Record<string, unknown>).rawText === "string"
    );
    const validClaims = filterValidClaims(
      rawClaims as StructuredClaimInput[],
    );
    for (const claim of validClaims) {
      if (!CALIBRATABLE_CLAIM_KEYS.has(claim.key as ClaimKey)) continue;
      const valueSignature = canonicalValue(claim.value);
      if (valueSignature === null) continue;
      const key = `${item.id}\u0000${claim.key}\u0000${valueSignature}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        evidenceId: item.id,
        placeId: item.placeId,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        hostname,
        observedAt: item.observedAt,
        observedMillis,
        claimKey: claim.key as ClaimKey,
        value: claim.value,
        valueSignature,
      });
    }
  }

  return normalized.sort((a, b) =>
    compareCodeUnits(a.placeId, b.placeId) ||
    a.observedMillis - b.observedMillis ||
    compareCodeUnits(a.evidenceId, b.evidenceId) ||
    compareCodeUnits(a.claimKey, b.claimKey) ||
    compareCodeUnits(a.valueSignature, b.valueSignature)
  );
}

function compareLaterClaims(
  earlier: NormalizedClaim,
  later: NormalizedClaim,
): "confirmed" | "contradicted" | null {
  if (earlier.claimKey !== later.claimKey) return null;
  if (earlier.valueSignature === later.valueSignature) return "confirmed";
  return claimValuesConflict(
      earlier.claimKey,
      earlier.value,
      later.value,
    )
    ? "contradicted"
    : "confirmed";
}

function observationSort(
  a: CalibrationObservation,
  b: CalibrationObservation,
): number {
  return compareCodeUnits(a.placeId, b.placeId) ||
    compareCodeUnits(a.observedAt, b.observedAt) ||
    compareCodeUnits(a.evidenceId, b.evidenceId) ||
    compareCodeUnits(a.claimKey, b.claimKey);
}

// 後続の同等以上 source_quality かつ異なる hostname の Evidence だけを比較し、
// 同じ evidence claim は一票へ dedupe する。入力順に依存しないため再実行可能。
export function buildCalibrationDataset(
  evidence: readonly CalibrationEvidence[],
  policy: Pick<SourceReliabilityPolicy, "horizonDays">,
): CalibrationObservation[] {
  if (
    !policy ||
    !Number.isFinite(policy.horizonDays) || policy.horizonDays <= 0 ||
    !Number.isFinite(policy.horizonDays * MILLISECONDS_PER_DAY)
  ) return [];

  const claims = normalizeClaims(evidence);
  const horizonMillis = policy.horizonDays * MILLISECONDS_PER_DAY;
  const observations: CalibrationObservation[] = [];
  const valuesByEvidenceClaim = new Map<string, Set<string>>();
  for (const claim of claims) {
    const identity = `${claim.evidenceId}\u0000${claim.claimKey}`;
    const values = valuesByEvidenceClaim.get(identity) ?? new Set<string>();
    values.add(claim.valueSignature);
    valuesByEvidenceClaim.set(identity, values);
  }
  const internallyConflicted = new Set<string>(
    [...valuesByEvidenceClaim.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([identity]) => identity),
  );

  for (const earlier of claims) {
    const earlierIdentity = `${earlier.evidenceId}\u0000${earlier.claimKey}`;
    if (internallyConflicted.has(earlierIdentity)) continue;
    const candidates = claims.filter((later) =>
      later.placeId === earlier.placeId &&
      later.claimKey === earlier.claimKey &&
      later.evidenceId !== earlier.evidenceId &&
      !internallyConflicted.has(
        `${later.evidenceId}\u0000${later.claimKey}`,
      ) &&
      later.hostname !== earlier.hostname &&
      later.observedMillis > earlier.observedMillis &&
      later.observedMillis - earlier.observedMillis <= horizonMillis &&
      sourceQuality(later.sourceType) >= sourceQuality(earlier.sourceType)
    );
    const comparedEvidenceIds = candidates.map((candidate) =>
      candidate.evidenceId
    )
      .sort(compareCodeUnits);
    const results = candidates.map((candidate) =>
      compareLaterClaims(earlier, candidate)
    );
    const outcome: CalibrationOutcome = results.includes("contradicted")
      ? "contradicted"
      : results.includes("confirmed")
      ? "confirmed"
      : "unresolved";
    observations.push({
      evidenceId: earlier.evidenceId,
      placeId: earlier.placeId,
      sourceType: earlier.sourceType,
      claimKey: earlier.claimKey,
      observedAt: earlier.observedAt,
      outcome,
      comparedEvidenceIds,
    });
  }

  return observations.sort(observationSort);
}

function validObservation(value: CalibrationObservation): boolean {
  return typeof value?.evidenceId === "string" && value.evidenceId.length > 0 &&
    typeof value.placeId === "string" && value.placeId.length > 0 &&
    isSourceType(value.sourceType) &&
    CALIBRATABLE_CLAIM_KEYS.has(value.claimKey) &&
    typeof value.observedAt === "string" &&
    Number.isFinite(new Date(value.observedAt).getTime()) &&
    (value.outcome === "confirmed" || value.outcome === "contradicted" ||
      value.outcome === "unresolved") &&
    Array.isArray(value.comparedEvidenceIds) &&
    value.comparedEvidenceIds.every((id) => typeof id === "string") &&
    (value.outcome === "unresolved"
      ? value.comparedEvidenceIds.length === 0
      : value.comparedEvidenceIds.length > 0);
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function expectedQuality(
  sourceType: SourceType,
  confirmedCount: number,
  contradictedCount: number,
  priorStrength: number,
): number {
  const resolvedCount = confirmedCount + contradictedCount;
  return (sourceQuality(sourceType) * priorStrength + confirmedCount) /
    (priorStrength + resolvedCount);
}

// labeled observations → Beta prior shrinkage。prior の強さは必須入力で、
// この module が適当なサンプル閾値や alpha/beta を発明することはない。
export function buildSourceReliabilitySnapshot(
  observations: readonly CalibrationObservation[],
  policy: SourceReliabilityPolicy,
): SourceReliabilitySnapshot | null {
  if (
    !validPolicy(policy) || !Array.isArray(observations) ||
    observations.some((item) => !validObservation(item))
  ) {
    return null;
  }

  const observationKeys = new Set<string>();
  for (const item of observations) {
    const key = `${item.evidenceId}\u0000${item.claimKey}`;
    if (observationKeys.has(key)) return null;
    observationKeys.add(key);
  }

  const estimates = SOURCE_TYPES.map((sourceType) => {
    let confirmedCount = 0;
    let contradictedCount = 0;
    for (const item of observations) {
      if (item.sourceType !== sourceType) continue;
      if (item.outcome === "confirmed") confirmedCount++;
      if (item.outcome === "contradicted") contradictedCount++;
    }
    const resolvedCount = confirmedCount + contradictedCount;
    return {
      sourceType,
      confirmedCount,
      contradictedCount,
      resolvedCount,
      overturnedRate: resolvedCount === 0
        ? null
        : contradictedCount / resolvedCount,
      quality: expectedQuality(
        sourceType,
        confirmedCount,
        contradictedCount,
        policy.priorStrength,
      ),
    } satisfies SourceReliabilityEstimate;
  });

  return {
    algorithmVersion: SOURCE_RELIABILITY_ALGORITHM_VERSION,
    horizonDays: policy.horizonDays,
    priorStrength: policy.priorStrength,
    estimates,
  };
}

export function calibrateSourceReliability(
  evidence: readonly CalibrationEvidence[],
  policy: SourceReliabilityPolicy,
): SourceReliabilityCalibration | null {
  if (!validPolicy(policy)) return null;
  const observations = buildCalibrationDataset(evidence, policy);
  const snapshot = buildSourceReliabilitySnapshot(observations, policy);
  return snapshot ? { observations, snapshot } : null;
}

function validSnapshot(
  snapshot: SourceReliabilitySnapshot,
): snapshot is SourceReliabilitySnapshot {
  if (
    snapshot?.algorithmVersion !== SOURCE_RELIABILITY_ALGORITHM_VERSION ||
    !validPolicy(snapshot) || !Array.isArray(snapshot.estimates) ||
    snapshot.estimates.length !== SOURCE_TYPES.length
  ) return false;

  const seen = new Set<SourceType>();
  for (const estimate of snapshot.estimates) {
    if (
      !isSourceType(estimate?.sourceType) || seen.has(estimate.sourceType) ||
      !validCount(estimate.confirmedCount) ||
      !validCount(estimate.contradictedCount) ||
      estimate.resolvedCount !==
        estimate.confirmedCount + estimate.contradictedCount ||
      !Number.isFinite(estimate.quality) || estimate.quality < 0 ||
      estimate.quality > 1
    ) return false;
    const expected = expectedQuality(
      estimate.sourceType,
      estimate.confirmedCount,
      estimate.contradictedCount,
      snapshot.priorStrength,
    );
    if (Math.abs(estimate.quality - expected) > 1e-12) return false;
    if (estimate.resolvedCount === 0) {
      if (estimate.overturnedRate !== null) return false;
    } else if (
      !Number.isFinite(estimate.overturnedRate) ||
      estimate.overturnedRate! < 0 || estimate.overturnedRate! > 1 ||
      Math.abs(
          estimate.overturnedRate! -
            estimate.contradictedCount / estimate.resolvedCount,
        ) > 1e-12
    ) return false;
    seen.add(estimate.sourceType);
  }
  return seen.size === SOURCE_TYPES.length;
}

// Rankingへ渡す最終境界。未提供・version不一致・票数/計算値不整合はすべて
// 既存の固定 heuristic へ戻し、NaNや外部入力の任意weightをランキングへ流さない。
export function sourceQualityWithCalibration(
  sourceType: SourceType,
  snapshot: SourceReliabilitySnapshot | null | undefined,
): number {
  const fallback = sourceQuality(sourceType);
  if (!snapshot || !validSnapshot(snapshot)) return fallback;
  const estimate = snapshot.estimates.find((item) =>
    item.sourceType === sourceType
  );
  if (!estimate || estimate.resolvedCount === 0) return fallback;
  return estimate.quality;
}

// 呼び出し側で「現在の sourceQuality」と読みやすい別名も公開する。
export const effectiveSourceQuality = sourceQualityWithCalibration;

function validMetricPoint(point: CalibrationMetricPoint): boolean {
  return Number.isFinite(point?.probability) && point.probability >= 0 &&
    point.probability <= 1 &&
    (point.outcome === "confirmed" || point.outcome === "contradicted");
}

// offline calibration の Brier score / ECE。binCount は評価側が明示し、
// 少数データを都合よく区切るデフォルト値をこの module で決めない。
export function calibrationMetrics(
  points: readonly CalibrationMetricPoint[],
  binCount: number,
): CalibrationMetrics | null {
  if (
    !Array.isArray(points) || points.length === 0 ||
    !Number.isInteger(binCount) || binCount <= 0 ||
    points.some((point) => !validMetricPoint(point))
  ) return null;

  let brierSum = 0;
  const bins = Array.from(
    { length: binCount },
    () => ({ probabilitySum: 0, outcomeSum: 0, count: 0 }),
  );
  for (const point of points) {
    const outcome = point.outcome === "confirmed" ? 1 : 0;
    brierSum += (point.probability - outcome) ** 2;
    const index = Math.min(
      binCount - 1,
      Math.floor(point.probability * binCount),
    );
    bins[index].probabilitySum += point.probability;
    bins[index].outcomeSum += outcome;
    bins[index].count++;
  }

  const expectedCalibrationError = bins.reduce((sum, bin) => {
    if (bin.count === 0) return sum;
    return sum + Math.abs(
          bin.probabilitySum / bin.count - bin.outcomeSum / bin.count,
        ) * bin.count / points.length;
  }, 0);
  return {
    brierScore: brierSum / points.length,
    expectedCalibrationError,
    resolvedCount: points.length,
  };
}

// 同じ観測ラベルを baseline と snapshot へ通す比較用 evaluator。実運用では
// snapshot を過去期間で作り、observations は後続の評価期間だけを渡す (時間リーク防止)。
export function evaluateCalibrationMetrics(
  observations: readonly CalibrationObservation[],
  snapshot: SourceReliabilitySnapshot | null | undefined,
  binCount: number,
): {
  baseline: CalibrationMetrics | null;
  measured: CalibrationMetrics | null;
} {
  if (!Array.isArray(observations)) {
    return { baseline: null, measured: null };
  }
  if (observations.some((item) => !validObservation(item))) {
    return { baseline: null, measured: null };
  }
  const resolved = observations.filter((
    item,
  ) => (item.outcome === "confirmed" || item.outcome === "contradicted"));
  const toPoint = (
    item: CalibrationObservation,
    probability: number,
  ): CalibrationMetricPoint => ({
    probability,
    outcome: item.outcome as "confirmed" | "contradicted",
  });
  const baseline = calibrationMetrics(
    resolved.map((item) => toPoint(item, sourceQuality(item.sourceType))),
    binCount,
  );
  const measured = calibrationMetrics(
    resolved.map((item) =>
      toPoint(item, sourceQualityWithCalibration(item.sourceType, snapshot))
    ),
    binCount,
  );
  return { baseline, measured };
}

function averageRanks(values: readonly number[]): number[] | null {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) =>
    a.value - b.value || a.index - b.index
  );
  const ranks = Array<number>(values.length);
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].value === sorted[index].value) {
      end++;
    }
    const rank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) {
      ranks[sorted[cursor].index] = rank;
    }
    index = end;
  }
  return ranks;
}

// ranking module の score 出力を baseline/calibrated 間で比較する Spearman ρ。
// 件数不一致、非有限値、全候補同点は相関を捏造せず null を返す。
export function spearmanRankCorrelation(
  baselineScores: readonly number[],
  calibratedScores: readonly number[],
): number | null {
  if (
    !Array.isArray(baselineScores) || !Array.isArray(calibratedScores) ||
    baselineScores.length < 2 ||
    baselineScores.length !== calibratedScores.length
  ) return null;
  const baselineRanks = averageRanks(baselineScores);
  const calibratedRanks = averageRanks(calibratedScores);
  if (!baselineRanks || !calibratedRanks) return null;
  const baselineMean = baselineRanks.reduce((sum, value) => sum + value, 0) /
    baselineRanks.length;
  const calibratedMean =
    calibratedRanks.reduce((sum, value) => sum + value, 0) /
    calibratedRanks.length;
  let covariance = 0;
  let baselineVariance = 0;
  let calibratedVariance = 0;
  for (let index = 0; index < baselineRanks.length; index++) {
    const baselineDelta = baselineRanks[index] - baselineMean;
    const calibratedDelta = calibratedRanks[index] - calibratedMean;
    covariance += baselineDelta * calibratedDelta;
    baselineVariance += baselineDelta ** 2;
    calibratedVariance += calibratedDelta ** 2;
  }
  const denominator = Math.sqrt(baselineVariance * calibratedVariance);
  return denominator > 0 ? covariance / denominator : null;
}
