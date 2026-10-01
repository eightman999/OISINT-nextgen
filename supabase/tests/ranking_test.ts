// §17 スコア式の境界値テスト
import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  assignRanks,
  computeScore,
  cosineToUnit,
  evidenceQuality,
  freshness,
  groupVote,
  hardPenalty,
  type RankingInput,
  RECALL_BONUS_MAX,
  recallBonus,
  recallBonusLine,
  requirementMatch,
  semanticMatchScore,
} from "../functions/_shared/ranking.ts";

const req = (
  id: string,
  priority: "must" | "should" | "nice",
  weight = 1.0,
) => ({
  id,
  priority,
  weight,
});

Deno.test("requirement_match: 全match confidence1 で 1.0", () => {
  const rs = [req("a", "must"), req("b", "should")];
  const evs = [
    { requirementId: "a", state: "match" as const, confidence: 1 },
    { requirementId: "b", state: "match" as const, confidence: 1 },
  ];
  assertAlmostEquals(requirementMatch(rs, evs), 1.0);
});

Deno.test("requirement_match: unknown は 0 として扱う (§17 意図的)", () => {
  const rs = [req("a", "must")];
  const evs = [{
    requirementId: "a",
    state: "unknown" as const,
    confidence: 0.9,
  }];
  assertEquals(requirementMatch(rs, evs), 0);
});

Deno.test("requirement_match: 評価が無い requirement は unknown 相当 (分母のみ寄与)", () => {
  const rs = [req("a", "must"), req("b", "must")];
  const evs = [{ requirementId: "a", state: "match" as const, confidence: 1 }];
  assertAlmostEquals(requirementMatch(rs, evs), 0.5);
});

Deno.test("requirement_match: priorityWeight must=1.0 / should=0.6 / nice=0.3", () => {
  const rs = [req("a", "must"), req("b", "nice")];
  const evs = [
    { requirementId: "a", state: "mismatch" as const, confidence: 1 },
    { requirementId: "b", state: "match" as const, confidence: 1 },
  ];
  // (0*1.0 + 1*0.3) / (1.0 + 0.3)
  assertAlmostEquals(requirementMatch(rs, evs), 0.3 / 1.3);
});

Deno.test("evidence_quality: 上位3件の平均 (全件平均ではない)", () => {
  assertAlmostEquals(
    evidenceQuality([1.0, 0.9, 0.8, 0.1, 0.1]),
    (1.0 + 0.9 + 0.8) / 3,
  );
  assertEquals(evidenceQuality([]), 0);
});

Deno.test("freshness: 平均。空は 0", () => {
  assertAlmostEquals(freshness([1, 0.5]), 0.75);
  assertEquals(freshness([]), 0);
});

Deno.test("group_vote: 投票0件は 0.5 (中立)", () => {
  assertEquals(groupVote([], 3), 0.5);
});

Deno.test("group_vote: raw = Σvalue/メンバー数 → (raw+1)/2", () => {
  // 3人中 +1 と -1 → raw = 0 → 0.5
  assertAlmostEquals(groupVote([1, -1], 3), 0.5);
  // 2人全員 +1 → raw = 1 → 1.0
  assertAlmostEquals(groupVote([1, 1], 2), 1.0);
});

Deno.test("hard_penalty: must mismatch 1件につき 0.40。unknown では減算しない", () => {
  const rs = [req("a", "must"), req("b", "must"), req("c", "should")];
  const evs = [
    { requirementId: "a", state: "mismatch" as const, confidence: 1 },
    { requirementId: "b", state: "unknown" as const, confidence: 0 },
    { requirementId: "c", state: "mismatch" as const, confidence: 1 },
  ];
  assertAlmostEquals(hardPenalty(rs, evs), 0.4); // must mismatch は a のみ
});

Deno.test("computeScore: clamp 0..1 (ペナルティで負にならない)", () => {
  const input: RankingInput = {
    requirements: [req("a", "must"), req("b", "must")],
    evaluations: [
      { requirementId: "a", state: "mismatch", confidence: 1 },
      { requirementId: "b", state: "mismatch", confidence: 1 },
    ],
    evidenceQualities: [],
    evidenceFreshness: [],
    voteValues: [],
    memberCount: 1,
    semanticMatch: 0,
  };
  assertEquals(computeScore(input), 0);
});

Deno.test("computeScore: §17 の重みどおり合成される", () => {
  const input: RankingInput = {
    requirements: [req("a", "must")],
    evaluations: [{ requirementId: "a", state: "match", confidence: 1 }],
    evidenceQualities: [1.0],
    evidenceFreshness: [1.0],
    voteValues: [],
    memberCount: 1,
    semanticMatch: 1.0,
  };
  // 0.55 + 0.15 + 0.10 + 0.10 + 0.5*0.10 = 0.95
  assertAlmostEquals(computeScore(input), 0.95);
});

Deno.test("cosineToUnit: [-1,1] → [0,1]", () => {
  assertEquals(cosineToUnit(-1), 0);
  assertEquals(cosineToUnit(1), 1);
  assertEquals(cosineToUnit(0), 0.5);
});

Deno.test("assignRanks: score 降順、同点は created_at 昇順 (§17 最終処理)", () => {
  const ranks = assignRanks([
    { id: "x", score: 0.5, createdAt: "2026-08-15T00:00:02Z" },
    { id: "y", score: 0.9, createdAt: "2026-08-15T00:00:01Z" },
    { id: "z", score: 0.5, createdAt: "2026-08-15T00:00:01Z" },
  ]);
  assertEquals(ranks.get("y"), 1);
  assertEquals(ranks.get("z"), 2); // 同点は先に作られた方が上
  assertEquals(ranks.get("x"), 3);
});

// ============================================================
// semantic_match 正式版 (§16.2, §17 / issue #103)
// ============================================================

Deno.test("semanticMatchScore: requirement ごとの最大 cosine を平均し (x+1)/2 で写す", () => {
  const r1 = [1, 0, 0];
  const r2 = [0, 1, 0];
  const e1 = [1, 0, 0]; // r1 と cos=1、r2 と cos=0
  const e2 = [0, -1, 0]; // r1 と cos=0、r2 と cos=-1
  // r1: max cos = 1 → (1+1)/2 = 1.0
  // r2: max(0, -1) = 0 → (0+1)/2 = 0.5
  // 平均 = 0.75
  assertAlmostEquals(semanticMatchScore([r1, r2], [e1, e2])!, 0.75);
});

Deno.test("semanticMatchScore: 同一入力は同一出力 (決定論)", () => {
  const reqs = [[0.3, 0.4, 0.5], [0.1, -0.9, 0.2]];
  const evs = [[0.5, 0.5, 0.5], [-0.2, 0.8, 0.1]];
  assertEquals(semanticMatchScore(reqs, evs), semanticMatchScore(reqs, evs));
});

Deno.test("semanticMatchScore: evidence embedding が無ければ null (P0 代用式へフォールバック §17)", () => {
  assertEquals(semanticMatchScore([[1, 0, 0]], []), null);
});

Deno.test("semanticMatchScore: requirement embedding が無ければ null", () => {
  assertEquals(semanticMatchScore([], [[1, 0, 0]]), null);
});

Deno.test("semanticMatchScore: 反対向き evidence しか無い requirement は 0 に写る", () => {
  // cos=-1 → (−1+1)/2 = 0
  assertAlmostEquals(semanticMatchScore([[1, 0, 0]], [[-1, 0, 0]])!, 0);
});

// ============================================================
// 過去グループ嗜好の加点 (issue #105)。基本式とは独立・上限 +0.05
// ============================================================

Deno.test("recallBonus: 対象外 place は 0", () => {
  assertEquals(recallBonus("p1", []), 0);
  assertEquals(
    recallBonus("p1", [{ placeId: "p2", avgVote: 1, similarity: 1 }]),
    0,
  );
});

Deno.test("recallBonus: 満票 × 類似度1 で上限 +0.05", () => {
  assertAlmostEquals(
    recallBonus("p1", [{ placeId: "p1", avgVote: 1, similarity: 1 }]),
    RECALL_BONUS_MAX,
  );
});

Deno.test("recallBonus: avgVote と similarity の積に比例する", () => {
  assertAlmostEquals(
    recallBonus("p1", [{ placeId: "p1", avgVote: 0.5, similarity: 0.8 }]),
    0.05 * 0.5 * 0.8,
  );
});

Deno.test("recallBonus: 負の avgVote / 範囲外 similarity は clamp され上限を超えない", () => {
  assertEquals(
    recallBonus("p1", [{ placeId: "p1", avgVote: -0.5, similarity: 0.9 }]),
    0,
  );
  assertAlmostEquals(
    recallBonus("p1", [{ placeId: "p1", avgVote: 2, similarity: 2 }]),
    RECALL_BONUS_MAX, // clamp(2)=1, clamp(2)=1 → 上限止まり
  );
});

Deno.test("recallBonus: score へ加算しても最終 clamp(0,1) を維持できる (§17 の式は不変)", () => {
  const input: RankingInput = {
    requirements: [req("a", "must")],
    evaluations: [{ requirementId: "a", state: "match", confidence: 1 }],
    evidenceQualities: [1.0],
    evidenceFreshness: [1.0],
    voteValues: [1],
    memberCount: 1,
    semanticMatch: 1.0,
  };
  const base = computeScore(input); // 1.0 (0.55+0.15+0.1+0.1+0.1)
  const bonus = recallBonus("p1", [{
    placeId: "p1",
    avgVote: 1,
    similarity: 1,
  }]);
  const final = Math.min(1, Math.max(0, base + bonus));
  assertEquals(final, 1.0);
});

Deno.test("recallBonusLine: 加点値を日本語1行で説明する", () => {
  assertEquals(
    recallBonusLine(0.04),
    "過去の類似調査でこのメンバーに高評価だった店です（+4.0点）",
  );
});
