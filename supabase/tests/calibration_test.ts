// issue #121 / §44.6: evidence 時系列からの source reliability calibration。
// 外部通信・DB更新なし。観測境界、同一原典排除、既存 contradiction 再利用、
// Beta prior shrinkage、snapshot fail-closed を固定する。
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  buildCalibrationDataset,
  buildSourceReliabilitySnapshot,
  type CalibrationEvidence,
  calibrationMetrics,
  type CalibrationObservation,
  effectiveSourceQuality,
  evaluateCalibrationMetrics,
  SOURCE_RELIABILITY_ALGORITHM_VERSION,
  sourceQualityWithCalibration,
  spearmanRankCorrelation,
} from "../functions/_shared/calibration.ts";
import { sourceQuality } from "../functions/_shared/source_quality.ts";
import type {
  ClaimKey,
  SourceType,
  StructuredClaim,
} from "../functions/_shared/types.ts";

const claim = (key: ClaimKey, value: unknown): StructuredClaim => ({
  key,
  value,
  rawText: "fixture",
});

const evidence = (
  id: string,
  placeId: string,
  sourceType: SourceType,
  sourceUrl: string,
  observedAt: string,
  claims: StructuredClaim[],
): CalibrationEvidence => ({
  id,
  placeId,
  sourceType,
  sourceUrl,
  observedAt,
  structuredClaims: claims,
});

const HORIZON = 30;
const PRIOR_STRENGTH = 10;

function outcomeByEvidence(
  observations: CalibrationObservation[],
): Map<string, CalibrationObservation> {
  return new Map(observations.map((item) => [item.evidenceId, item]));
}

Deno.test("calibration: 後続の同等以上・別hostnameの矛盾だけを contradicted とする", () => {
  const rows = [
    // official_site 同士の異なる hostname。先行 claim は覆される。
    evidence(
      "official-early",
      "place-1",
      "official_site",
      "https://shop-a.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    evidence(
      "official-later",
      "place-1",
      "official_site",
      "https://shop-b.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("card_accepted", false)],
    ),
    // 同一 claim 値は confirmed。後続行自身は未解決。
    evidence(
      "confirmed-early",
      "place-2",
      "official_site",
      "https://shop-c.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    evidence(
      "confirmed-later",
      "place-2",
      "official_site",
      "https://shop-d.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    // 同一 hostname は転載/同一原典の可能性があるので比較しない。
    evidence(
      "same-host-early",
      "place-3",
      "official_site",
      "https://same.example/a",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    evidence(
      "same-host-later",
      "place-3",
      "official_site",
      "https://same.example/b",
      "2026-08-02T00:00:00Z",
      [claim("card_accepted", false)],
    ),
    // より弱い後続 source は earlier official_site の判定材料にしない。
    evidence(
      "weaker-later",
      "place-4",
      "other_public_page",
      "https://weak.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("card_accepted", false)],
    ),
    evidence(
      "weaker-early",
      "place-4",
      "official_site",
      "https://strong.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    // horizon 外の後続 evidence は比較しない。
    evidence(
      "old-early",
      "place-5",
      "official_site",
      "https://old-a.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    evidence(
      "old-later",
      "place-5",
      "official_site",
      "https://old-b.example/menu",
      "2026-10-01T00:00:00Z",
      [claim("card_accepted", false)],
    ),
    // 同一 Evidence 内で同じkeyが相反する場合は、後続Evidence側も比較票にしない。
    evidence(
      "internal-early",
      "place-6",
      "official_site",
      "https://internal-a.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true), claim("card_accepted", false)],
    ),
    evidence(
      "internal-later",
      "place-6",
      "official_site",
      "https://internal-b.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("card_accepted", true)],
    ),
  ];

  const observations = buildCalibrationDataset(rows, { horizonDays: HORIZON });
  const byEvidence = outcomeByEvidence(observations);
  assertEquals(byEvidence.get("official-early")?.outcome, "contradicted");
  assertEquals(byEvidence.get("official-later")?.outcome, "unresolved");
  assertEquals(byEvidence.get("confirmed-early")?.outcome, "confirmed");
  assertEquals(byEvidence.get("confirmed-later")?.outcome, "unresolved");
  assertEquals(byEvidence.get("same-host-early")?.outcome, "unresolved");
  assertEquals(byEvidence.get("same-host-later")?.outcome, "unresolved");
  assertEquals(byEvidence.get("weaker-early")?.outcome, "unresolved");
  assertEquals(byEvidence.get("old-early")?.outcome, "unresolved");
  assert(!byEvidence.has("internal-early"));
  assertEquals(byEvidence.get("internal-later")?.outcome, "unresolved");
  assertEquals(
    byEvidence.get("confirmed-early")?.comparedEvidenceIds,
    ["confirmed-later"],
  );
});

Deno.test("calibration: 既存 contradiction ルールを再利用し、比較不能claim/不正入力を除外する", () => {
  const rows = [
    evidence(
      "hours-early",
      "place-hours",
      "official_site",
      "https://hours-a.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("opening_hours", "17:00-22:00")],
    ),
    evidence(
      "hours-later",
      "place-hours",
      "official_site",
      "https://hours-b.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("opening_hours", "17:00-23:00")],
    ),
    evidence(
      "hours-near-later",
      "place-hours-near",
      "official_site",
      "https://hours-c.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("opening_hours", "17:00-22:29")],
    ),
    evidence(
      "hours-near-early",
      "place-hours-near",
      "official_site",
      "https://hours-d.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("opening_hours", "17:00-22:00")],
    ),
    // genre は §15 で比較しないので、異なる値でも票にしない。
    evidence(
      "genre-early",
      "place-genre",
      "official_site",
      "https://genre-a.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("genre", ["焼肉"])],
    ),
    evidence(
      "genre-later",
      "place-genre",
      "official_site",
      "https://genre-b.example/menu",
      "2026-08-02T00:00:00Z",
      [claim("genre", ["寿司"])],
    ),
    // invalid opening_hours / URL / observed_at は calibration 対象外。
    evidence(
      "invalid-claim",
      "place-invalid",
      "official_site",
      "https://invalid.example/menu",
      "2026-08-01T00:00:00Z",
      [claim("opening_hours", "not-a-time")],
    ),
    evidence(
      "invalid-url",
      "place-invalid",
      "official_site",
      "not-a-url",
      "2026-08-01T00:00:00Z",
      [claim("card_accepted", true)],
    ),
    evidence(
      "invalid-date",
      "place-invalid",
      "official_site",
      "https://invalid-date.example/menu",
      "not-a-date",
      [claim("card_accepted", true)],
    ),
  ];

  const observations = buildCalibrationDataset(rows, { horizonDays: HORIZON });
  const ids = new Set(observations.map((item) => item.evidenceId));
  assert(ids.has("hours-early"));
  assert(ids.has("hours-later"));
  assert(ids.has("hours-near-early"));
  assert(ids.has("hours-near-later"));
  assert(!ids.has("genre-early"));
  assert(!ids.has("genre-later"));
  assert(!ids.has("invalid-claim"));
  assert(!ids.has("invalid-url"));
  assert(!ids.has("invalid-date"));
  assertEquals(
    observations.find((item) => item.evidenceId === "hours-early")?.outcome,
    "contradicted",
  );
  assertEquals(
    observations.find((item) => item.evidenceId === "hours-near-early")
      ?.outcome,
    "confirmed",
  );
});

Deno.test("calibration: prior strengthを明示したBeta shrinkageと覆却率を再現する", () => {
  const observations: CalibrationObservation[] = [
    {
      evidenceId: "a",
      placeId: "place-1",
      sourceType: "official_site",
      claimKey: "card_accepted",
      observedAt: "2026-08-01T00:00:00Z",
      outcome: "confirmed",
      comparedEvidenceIds: ["b"],
    },
    {
      evidenceId: "b",
      placeId: "place-2",
      sourceType: "official_site",
      claimKey: "card_accepted",
      observedAt: "2026-08-02T00:00:00Z",
      outcome: "confirmed",
      comparedEvidenceIds: ["c"],
    },
    {
      evidenceId: "c",
      placeId: "place-3",
      sourceType: "official_site",
      claimKey: "card_accepted",
      observedAt: "2026-08-03T00:00:00Z",
      outcome: "contradicted",
      comparedEvidenceIds: ["d"],
    },
    {
      evidenceId: "unresolved",
      placeId: "place-4",
      sourceType: "official_site",
      claimKey: "card_accepted",
      observedAt: "2026-08-04T00:00:00Z",
      outcome: "unresolved",
      comparedEvidenceIds: [],
    },
  ];
  const policy = { horizonDays: HORIZON, priorStrength: PRIOR_STRENGTH };
  const snapshot = buildSourceReliabilitySnapshot(observations, policy);
  if (snapshot === null) throw new Error("snapshot should be built");
  const official = snapshot.estimates.find((item) =>
    item.sourceType === "official_site"
  );
  if (official === undefined) throw new Error("official estimate is missing");
  assertEquals(official.confirmedCount, 2);
  assertEquals(official.contradictedCount, 1);
  assertEquals(official.resolvedCount, 3);
  assertAlmostEquals(official.overturnedRate ?? -1, 1 / 3);
  // (baseline 1.0 × prior 10 + confirmed 2) / (10 + resolved 3) = 12 / 13
  assertAlmostEquals(official.quality, 12 / 13);
  assertAlmostEquals(
    sourceQualityWithCalibration("official_site", snapshot),
    12 / 13,
  );
  assertEquals(
    sourceQualityWithCalibration("major_review_platform", snapshot),
    sourceQuality("major_review_platform"),
  );
  assertEquals(snapshot.algorithmVersion, SOURCE_RELIABILITY_ALGORITHM_VERSION);
  for (const estimate of snapshot.estimates) {
    assert(Number.isFinite(estimate.quality));
    assert(estimate.quality >= 0 && estimate.quality <= 1);
  }
});

Deno.test("calibration: snapshot不在観測境界なら固定heuristicへfail-closedする", () => {
  const observation: CalibrationObservation = {
    evidenceId: "a",
    placeId: "place-1",
    sourceType: "official_site",
    claimKey: "card_accepted",
    observedAt: "2026-08-01T00:00:00Z",
    outcome: "confirmed",
    comparedEvidenceIds: ["b"],
  };
  const snapshot = buildSourceReliabilitySnapshot(
    [observation],
    { horizonDays: HORIZON, priorStrength: PRIOR_STRENGTH },
  );
  if (snapshot === null) throw new Error("snapshot should be built");
  assertEquals(
    effectiveSourceQuality("official_site", undefined),
    sourceQuality("official_site"),
  );
  assertEquals(
    effectiveSourceQuality("official_site", null),
    sourceQuality("official_site"),
  );

  const wrongVersion = {
    ...snapshot,
    algorithmVersion: "unknown-v2",
  } as never;
  assertEquals(
    effectiveSourceQuality("official_site", wrongVersion),
    sourceQuality("official_site"),
  );

  const tampered: typeof snapshot = {
    ...snapshot,
    estimates: snapshot.estimates.map((estimate) =>
      estimate.sourceType === "official_site"
        ? { ...estimate, quality: 0.01 }
        : estimate
    ),
  };
  assertEquals(
    effectiveSourceQuality("official_site", tampered),
    sourceQuality("official_site"),
  );

  assertEquals(
    buildSourceReliabilitySnapshot([observation], {
      horizonDays: HORIZON,
      priorStrength: 0,
    }),
    null,
  );
  assertEquals(
    buildSourceReliabilitySnapshot([observation, observation], {
      horizonDays: HORIZON,
      priorStrength: PRIOR_STRENGTH,
    }),
    null,
  );
  assertEquals(
    buildSourceReliabilitySnapshot([
      { ...observation, comparedEvidenceIds: [] },
    ], {
      horizonDays: HORIZON,
      priorStrength: PRIOR_STRENGTH,
    }),
    null,
  );
});

Deno.test("calibration evaluator: Brier/ECEは解決済みラベルだけを測定する", () => {
  const points = [
    { probability: 0.8, outcome: "confirmed" as const },
    { probability: 0.2, outcome: "contradicted" as const },
  ];
  const metrics = calibrationMetrics(points, 2);
  if (metrics === null) throw new Error("metrics should be built");
  assertAlmostEquals(metrics.brierScore, 0.04);
  assertAlmostEquals(metrics.expectedCalibrationError, 0.2);
  assertEquals(metrics.resolvedCount, 2);
  assertEquals(calibrationMetrics([], 2), null);
  assertEquals(calibrationMetrics(points, 0), null);
  assertEquals(
    calibrationMetrics([
      { probability: Number.NaN, outcome: "confirmed" as const },
    ], 2),
    null,
  );

  const observation: CalibrationObservation = {
    evidenceId: "metric-1",
    placeId: "place-1",
    sourceType: "major_review_platform",
    claimKey: "card_accepted",
    observedAt: "2026-08-01T00:00:00Z",
    outcome: "confirmed",
    comparedEvidenceIds: ["metric-2"],
  };
  const evaluated = evaluateCalibrationMetrics([observation], null, 2);
  if (evaluated.baseline === null || evaluated.measured === null) {
    throw new Error("evaluation metrics should be built");
  }
  assertEquals(evaluated.baseline.resolvedCount, 1);
  assertEquals(evaluated.measured.resolvedCount, 1);
  assertEquals(evaluated.baseline.brierScore, evaluated.measured.brierScore);
  assertEquals(
    evaluateCalibrationMetrics(
      [
        { ...observation, outcome: "unknown" as never },
      ],
      null,
      2,
    ),
    { baseline: null, measured: null },
  );
});

Deno.test("calibration evaluator: ranking scoreのSpearman順位相関を決定論的に計算する", () => {
  assertAlmostEquals(
    spearmanRankCorrelation([0.9, 0.5, 0.1], [0.8, 0.4, 0.2]) ?? 0,
    1,
  );
  assertAlmostEquals(
    spearmanRankCorrelation([0.9, 0.5, 0.1], [0.1, 0.4, 0.8]) ?? 0,
    -1,
  );
  assertEquals(spearmanRankCorrelation([1], [1]), null);
  assertEquals(spearmanRankCorrelation([1, 1], [1, 2]), null);
  assertEquals(spearmanRankCorrelation([1, 2], [1]), null);
  assertEquals(spearmanRankCorrelation([1, Number.NaN], [1, 2]), null);
});
