// Pre-Rank ステージのテスト (issue #552)。
// 最重要契約は「unknown != mismatch」— 情報不足の候補を pre-rank で落とさないこと。
import { assert, assertEquals } from "@std/assert";
import {
  computePreliminaryScore,
  deterministicPreRank,
  hardFilter,
  mergePreRankResults,
  NEUTRAL_PRE_SCORE,
  type PreRankCandidate,
  type PreRankRequirement,
  type PreRankResult,
  selectResearchCandidates,
} from "../functions/_shared/prerank.ts";

function req(
  over: Partial<PreRankRequirement> & { id: string },
): PreRankRequirement {
  return {
    kind: "budget",
    priority: "must",
    weight: 1,
    normalizedText: "予算は3000円以内",
    originalText: "予算は3000円以内",
    ...over,
  };
}

function cand(
  over: Partial<PreRankCandidate> & { id: string },
): PreRankCandidate {
  return {
    name: `店${over.id}`,
    provider: "geoapify",
    distanceM: null,
    categories: [],
    knownClaims: [],
    ...over,
  };
}

// ============================================================
// deterministicPreRank
// ============================================================

Deno.test("computePreliminaryScore: unknownを含めず既知分だけを予備scoreへ写す", () => {
  assertEquals(computePreliminaryScore(2, 0), 1);
  assertEquals(computePreliminaryScore(0, 2), 0);
  assertEquals(computePreliminaryScore(0, 0), NEUTRAL_PRE_SCORE);
  assertEquals(computePreliminaryScore(Number.NaN, 0), NEUTRAL_PRE_SCORE);
});

Deno.test("deterministicPreRank: 既知情報が無い候補は中立スコアで unknown に積む", () => {
  const [r] = deterministicPreRank([cand({ id: "a" })], [req({ id: "r1" })]);
  assertEquals(r.preScore, NEUTRAL_PRE_SCORE);
  assertEquals(r.knownMatch, []);
  assertEquals(r.knownMismatch, []);
  assertEquals(r.unknown, ["r1"]);
  assertEquals(r.researchPriority, 1);
  assert(r.reasonCodes.includes("MISSING_BUDGET"));
});

Deno.test("deterministicPreRank: 既知 claim が要件を満たせば加点する", () => {
  const [r] = deterministicPreRank(
    [
      cand({
        id: "a",
        knownClaims: [
          {
            key: "budget_dinner",
            value: { min: 2000, max: 2800 },
            rawText: "2000〜2800円",
          },
        ],
      }),
    ],
    [req({ id: "r1" })],
  );
  assertEquals(r.knownMatch, ["r1"]);
  assertEquals(r.knownMismatch, []);
  assert(r.preScore > NEUTRAL_PRE_SCORE);
  assertEquals(r.researchPriority, 0); // 全 requirement が既知 = 調べる必要が薄い
  assert(r.reasonCodes.includes("BUDGET_MATCH"));
});

Deno.test("deterministicPreRank: 既知 claim が要件と矛盾すれば減点する", () => {
  const [r] = deterministicPreRank(
    [
      cand({
        id: "a",
        knownClaims: [
          {
            key: "budget_dinner",
            value: { min: 8000, max: 12000 },
            rawText: "8000〜12000円",
          },
        ],
      }),
    ],
    [req({ id: "r1" })],
  );
  assertEquals(r.knownMismatch, ["r1"]);
  assert(r.preScore < NEUTRAL_PRE_SCORE);
  assert(r.reasonCodes.includes("BUDGET_MISMATCH"));
});

Deno.test("deterministicPreRank: 朝の必須時間条件は夜営業を降格し、根拠なしはunknownに残す", () => {
  const requirements = [
    req({
      id: "r-time",
      kind: "time",
      normalizedText: "朝",
      originalText: "朝",
    }),
  ];
  const [night] = deterministicPreRank([
    cand({
      id: "night",
      knownClaims: [{
        key: "opening_hours",
        value: "17:00-23:30",
        rawText: "mock 夜営業",
      }],
    }),
  ], requirements);
  const [unknown] = deterministicPreRank(
    [cand({ id: "unknown" })],
    requirements,
  );

  assertEquals(night.knownMismatch, ["r-time"]);
  assertEquals(night.unknown, []);
  assert(night.preScore < unknown.preScore);
  assertEquals(unknown.knownMismatch, []);
  assertEquals(unknown.unknown, ["r-time"]);
  assertEquals(unknown.preScore, NEUTRAL_PRE_SCORE);
});

Deno.test("deterministicPreRank: unknown は分母に入らず既知 mismatch と同列に減点しない", () => {
  const requirements = [
    req({ id: "r1" }),
    req({
      id: "r2",
      kind: "time",
      normalizedText: "18時に開いている",
      originalText: "18時に開いている",
    }),
  ];
  const known = deterministicPreRank(
    [
      cand({
        id: "known",
        knownClaims: [
          {
            key: "budget_dinner",
            value: { min: 2000, max: 2800 },
            rawText: "2000〜2800円",
          },
        ],
      }),
    ],
    requirements,
  )[0];
  const [blank] = deterministicPreRank([cand({ id: "blank" })], requirements);

  // r2 が unknown でも、既知の r1 が match なら満点扱い (unknown で薄まらない)
  assertEquals(known.preScore, 1);
  assertEquals(known.unknown, ["r2"]);
  // 情報ゼロの候補は中立に留まり、mismatch より上に来る
  assert(blank.preScore > 0);
  assertEquals(blank.preScore, NEUTRAL_PRE_SCORE);
});

// ============================================================
// hardFilter
// ============================================================

Deno.test("hardFilter: must への既知 mismatch のみ除外する", () => {
  const candidates = [cand({ id: "a" }), cand({ id: "b" }), cand({ id: "c" })];
  const requirements = [req({ id: "r1", priority: "must" })];
  const results: PreRankResult[] = [
    base("a", { knownMismatch: ["r1"] }),
    base("b", { unknown: ["r1"] }),
    base("c", { knownMatch: ["r1"] }),
  ];
  const out = hardFilter(candidates, requirements, results);
  assertEquals(out.kept.map((c) => c.id), ["b", "c"]);
  assertEquals(out.droppedIds, ["a"]);
  assertEquals(out.failOpen, false);
});

Deno.test("hardFilter: unknown を除外理由にしない", () => {
  const candidates = [cand({ id: "a" }), cand({ id: "b" })];
  const requirements = [req({ id: "r1", priority: "must" })];
  const out = hardFilter(candidates, requirements, [
    base("a", { unknown: ["r1"] }),
    base("b", { unknown: ["r1"] }),
  ]);
  assertEquals(out.kept.length, 2);
  assertEquals(out.droppedIds, []);
});

Deno.test("hardFilter: should への mismatch では除外しない", () => {
  const requirements = [req({ id: "r1", priority: "should" })];
  const out = hardFilter([cand({ id: "a" })], requirements, [
    base("a", { knownMismatch: ["r1"] }),
  ]);
  assertEquals(out.kept.map((c) => c.id), ["a"]);
});

Deno.test("hardFilter: 全滅したら fail-open して候補を残す", () => {
  const candidates = [cand({ id: "a" }), cand({ id: "b" })];
  const requirements = [req({ id: "r1", priority: "must" })];
  const out = hardFilter(candidates, requirements, [
    base("a", { knownMismatch: ["r1"] }),
    base("b", { knownMismatch: ["r1"] }),
  ]);
  assertEquals(out.kept.length, 2);
  assertEquals(out.failOpen, true);
});

// ============================================================
// selectResearchCandidates
// ============================================================

Deno.test("selectResearchCandidates: preScore 上位を exploitation に取る", () => {
  const candidates = ["a", "b", "c", "d"].map((id) => cand({ id }));
  const results = [
    base("a", { preScore: 0.9 }),
    base("b", { preScore: 0.3 }),
    base("c", { preScore: 0.7 }),
    base("d", { preScore: 0.1 }),
  ];
  const sel = selectResearchCandidates(candidates, results, {
    researchLimit: 2,
    explorationSlots: 0,
  });
  assertEquals(sel.selected, ["a", "c"]);
  assertEquals(sel.exploration, []);
});

Deno.test("selectResearchCandidates: exploration 枠に情報が薄い候補を必ず残す", () => {
  const candidates = [
    cand({ id: "top1", categories: ["yakiniku"] }),
    cand({ id: "top2", categories: ["yakiniku"] }),
    cand({ id: "dark", provider: "geoapify", categories: ["izakaya"] }),
  ];
  const results = [
    base("top1", { preScore: 0.95, researchPriority: 0.1 }),
    base("top2", { preScore: 0.9, researchPriority: 0.1 }),
    base("dark", { preScore: 0.5, researchPriority: 1 }),
  ];
  const sel = selectResearchCandidates(candidates, results, {
    researchLimit: 2,
    explorationSlots: 1,
  });
  assertEquals(sel.exploitation, ["top1"]);
  assertEquals(sel.exploration, ["dark"]);
  assert(sel.selected.includes("dark"));
});

Deno.test("selectResearchCandidates: exploration は exploitation と異なる provider/category を優先する", () => {
  const candidates = [
    cand({ id: "a", provider: "geoapify", categories: ["yakiniku"] }),
    cand({ id: "b", provider: "geoapify", categories: ["yakiniku"] }),
    cand({ id: "c", provider: "mock", categories: ["cafe"] }),
  ];
  const results = [
    base("a", { preScore: 0.9, researchPriority: 0.1 }),
    base("b", { preScore: 0.5, researchPriority: 1 }),
    base("c", { preScore: 0.5, researchPriority: 1 }),
  ];
  const sel = selectResearchCandidates(candidates, results, {
    researchLimit: 2,
    explorationSlots: 1,
  });
  assertEquals(sel.exploitation, ["a"]);
  assertEquals(sel.exploration, ["c"]);
});

Deno.test("selectResearchCandidates: 決定論 — 入力順を変えても結果が同じ", () => {
  const candidates = ["a", "b", "c", "d", "e"].map((id) => cand({ id }));
  const results = candidates.map((c) => base(c.id, { preScore: 0.5 }));
  const config = { researchLimit: 3, explorationSlots: 1 };
  const first = selectResearchCandidates(candidates, results, config);
  const second = selectResearchCandidates(
    [...candidates].reverse(),
    [...results].reverse(),
    config,
  );
  assertEquals(first.selected, second.selected);
});

Deno.test("selectResearchCandidates: 探索枠が埋まらなくても定員を割らない", () => {
  const candidates = [cand({ id: "a" }), cand({ id: "b" })];
  const results = [base("a", { preScore: 0.9 }), base("b", { preScore: 0.8 })];
  const sel = selectResearchCandidates(candidates, results, {
    researchLimit: 4, // 候補数より多い
    explorationSlots: 2,
  });
  assertEquals(new Set(sel.selected).size, 2);
});

// ============================================================
// mergePreRankResults (AI 出力の取り込み)
// ============================================================

Deno.test("mergePreRankResults: 入力に無い id を捨てる (候補の捏造を通さない)", () => {
  const det = [base("a", { preScore: 0.5 })];
  const merged = mergePreRankResults(det, [
    base("a", { preScore: 0.8 }),
    base("ghost", { preScore: 0.99 }),
  ]);
  assertEquals(merged.merged.map((r) => r.id), ["a"]);
  assertEquals(merged.acceptedIds, ["a"]);
  assertEquals(merged.rejectedIds, ["ghost"]);
  assertEquals(merged.merged[0].preScore, 0.8);
});

Deno.test("mergePreRankResults: 範囲外スコアは clamp せずその候補だけ決定論へ落とす", () => {
  const det = [base("a", { preScore: 0.5 }), base("b", { preScore: 0.4 })];
  const merged = mergePreRankResults(det, [
    base("a", { preScore: 1.7 }),
    base("b", { preScore: 0.9, researchPriority: -0.2 }),
  ]);
  assertEquals(merged.merged[0].preScore, 0.5);
  assertEquals(merged.merged[1].preScore, 0.4);
  assertEquals(merged.acceptedIds, []);
  assertEquals(merged.rejectedIds.sort(), ["a", "b"]);
});

Deno.test("mergePreRankResults: 決定論で match 済みの要件を AI が mismatch へ覆せない", () => {
  const det = [base("a", { knownMatch: ["r1"], preScore: 1 })];
  const merged = mergePreRankResults(det, [
    base("a", { preScore: 0.2, knownMismatch: ["r1"] }),
  ]);
  assertEquals(merged.merged[0].knownMismatch, []);
});

Deno.test("mergePreRankResults: 決定論で mismatch 済みの要件を AI が match へ覆せない", () => {
  const candidates = [cand({ id: "a" }), cand({ id: "b" }), cand({ id: "c" })];
  const requirements = [req({ id: "r1", priority: "must" })];
  const det = [
    base("a", { knownMismatch: ["r1"], preScore: 0 }),
    base("b", { knownMismatch: ["r1"], preScore: 0 }),
    base("c", { unknown: ["r1"] }),
  ];
  const merged = mergePreRankResults(det, [
    base("a", { knownMatch: ["r1"], knownMismatch: [], preScore: 1 }),
    base("b", { knownMatch: [], knownMismatch: [], preScore: 1 }),
  ]);

  assertEquals(merged.merged[0].knownMatch, []);
  assertEquals(merged.merged[0].knownMismatch, ["r1"]);
  assertEquals(merged.merged[1].knownMismatch, ["r1"]);
  const filtered = hardFilter(candidates, requirements, merged.merged);
  assertEquals(filtered.kept.map((candidate) => candidate.id), ["c"]);
  assertEquals(filtered.droppedIds, ["a", "b"]);
});

Deno.test("mergePreRankResults: AI が返さなかった候補は決定論結果のまま残る", () => {
  const det = [base("a", { preScore: 0.5 }), base("b", { preScore: 0.6 })];
  const merged = mergePreRankResults(det, [base("a", { preScore: 0.9 })]);
  assertEquals(merged.merged.length, 2);
  assertEquals(merged.merged[1].preScore, 0.6);
});

function base(id: string, over: Partial<PreRankResult> = {}): PreRankResult {
  return {
    id,
    preScore: NEUTRAL_PRE_SCORE,
    knownMatch: [],
    knownMismatch: [],
    unknown: [],
    researchPriority: 0.5,
    reasonCodes: [],
    ...over,
  };
}
