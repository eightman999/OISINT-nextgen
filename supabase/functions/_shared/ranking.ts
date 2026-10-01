// スコア計算 (spec.md §17)。AI ではなくコードで行う。純関数。
// UIに表示できる程度に単純に保つこと (説明可能性が本アプリの価値)。
import type { MatchState, RequirementPriority } from "./types.ts";
import { clamp } from "./source_quality.ts";

// §17 stateScore。unknown = 0 は意図的 (「調べきれていない店」を上に出さない)
const STATE_SCORE: Record<MatchState, number> = {
  match: 1.0,
  partial: 0.5,
  mismatch: 0.0,
  unknown: 0.0,
};

const PRIORITY_WEIGHT: Record<RequirementPriority, number> = {
  must: 1.0,
  should: 0.6,
  nice: 0.3,
};

export interface RankingRequirement {
  id: string;
  priority: RequirementPriority;
  weight: number;
}

export interface RankingEvaluation {
  requirementId: string;
  state: MatchState;
  confidence: number; // 0..1 (範囲外は呼び出し側で unknown に落とし済み §30)
}

export interface RankingInput {
  requirements: RankingRequirement[];
  evaluations: RankingEvaluation[]; // 評価が無い requirement は unknown 扱い
  evidenceQualities: number[]; // 候補に紐づく evidence の source_quality
  evidenceFreshness: number[]; // 候補に紐づく evidence の freshness_score
  voteValues: number[]; // その候補への vote.value (-1|0|1)
  memberCount: number;
  semanticMatch: number; // 0..1。P0 代用式で事前計算 (contracts/run-investigation.md step 5)
}

// requirement_match (§17)
export function requirementMatch(
  requirements: RankingRequirement[],
  evaluations: RankingEvaluation[],
): number {
  if (requirements.length === 0) return 0;
  const byReq = new Map(evaluations.map((e) => [e.requirementId, e]));
  let num = 0;
  let den = 0;
  for (const r of requirements) {
    const pw = PRIORITY_WEIGHT[r.priority] * r.weight;
    den += pw;
    const ev = byReq.get(r.id);
    if (ev) num += STATE_SCORE[ev.state] * ev.confidence * pw;
    // 評価なし = unknown = 0 加算
  }
  return den > 0 ? num / den : 0;
}

// evidence_quality (§17): source_quality の上位3件の平均
export function evidenceQuality(qualities: number[]): number {
  if (qualities.length === 0) return 0;
  const top3 = [...qualities].sort((a, b) => b - a).slice(0, 3);
  return top3.reduce((s, q) => s + q, 0) / top3.length;
}

// freshness (§17): 候補単位では evidence の平均
export function freshness(freshnessScores: number[]): number {
  if (freshnessScores.length === 0) return 0;
  return freshnessScores.reduce((s, f) => s + f, 0) / freshnessScores.length;
}

// group_vote (§17): 投票0件は 0.5 (中立)。0にすると調査結果が正しく見えなくなる。
export function groupVote(voteValues: number[], memberCount: number): number {
  if (voteValues.length === 0) return 0.5;
  const raw = voteValues.reduce((s, v) => s + v, 0) / Math.max(memberCount, 1);
  return clamp((raw + 1) / 2, 0, 1);
}

// hard_penalty (§17): must が mismatch のとき 1件につき 0.40。unknown では減算しない。
export function hardPenalty(
  requirements: RankingRequirement[],
  evaluations: RankingEvaluation[],
): number {
  const byReq = new Map(evaluations.map((e) => [e.requirementId, e]));
  let penalty = 0;
  for (const r of requirements) {
    if (r.priority !== "must") continue;
    const ev = byReq.get(r.id);
    if (ev && ev.state === "mismatch") penalty += 0.4;
  }
  return penalty;
}

// §17 確定式
export function computeScore(input: RankingInput): number {
  const score = requirementMatch(input.requirements, input.evaluations) * 0.55 +
    clamp(input.semanticMatch, 0, 1) * 0.15 +
    evidenceQuality(input.evidenceQualities) * 0.1 +
    freshness(input.evidenceFreshness) * 0.1 +
    groupVote(input.voteValues, input.memberCount) * 0.1 -
    hardPenalty(input.requirements, input.evaluations);
  return clamp(score, 0, 1);
}

// cosine similarity → [0,1] 写像 (§17 semantic_match): (x+1)/2
export function cosineToUnit(cos: number): number {
  return clamp((cos + 1) / 2, 0, 1);
}

// §17 semantic_match 正式版 (P1 / issue #103):
// requirement.embedding と、その候補の evidence.embedding 群との cosine similarity の
// 最大値を requirement ごとに取り、平均する。similarity は (x+1)/2 で [0,1] に写す。
// evidence embedding (または requirement embedding) が 1 件も無い場合は null を返し、
// 呼び出し側が P0 代用式 (normalized_query × place.embedding) へフォールバックする (§17 決定事項)。
export function semanticMatchScore(
  requirementEmbeddings: number[][],
  evidenceEmbeddings: number[][],
): number | null {
  const reqs = requirementEmbeddings.filter((v) => v.length > 0);
  const evs = evidenceEmbeddings.filter((v) => v.length > 0);
  if (reqs.length === 0 || evs.length === 0) return null;
  let sum = 0;
  for (const r of reqs) {
    let best = -1;
    for (const e of evs) best = Math.max(best, cosineSimilarity(r, e));
    sum += cosineToUnit(best);
  }
  return clamp(sum / reqs.length, 0, 1);
}

// ============================================================
// 過去グループ嗜好の加点 (P1 / issue #105, §3 P1)
// §17 の基本式・重みは一切変えない「独立の加点項」。上限 +0.05。
// 最終 score は呼び出し側で clamp(0,1) を維持する。
// ============================================================

export const RECALL_BONUS_MAX = 0.05;

export interface RecallPlacePreference {
  placeId: string;
  avgVote: number; // 類似調査での vote.value の平均 (RPC は投票合計が正の place のみ返す)
  similarity: number; // 類似調査との cosine similarity (0..1)
}

// 加点 = 上限 × avgVote × similarity (いずれも [0,1] に clamp)。
// 説明可能性のため単純な積に保つ (§17「UIに表示できる程度に単純に保つ」)。
export function recallBonus(
  placeId: string,
  prefs: RecallPlacePreference[],
): number {
  const hit = prefs.find((p) => p.placeId === placeId);
  if (!hit) return 0;
  const avgVote = clamp(hit.avgVote, 0, 1);
  const similarity = clamp(hit.similarity, 0, 1);
  return clamp(RECALL_BONUS_MAX * avgVote * similarity, 0, RECALL_BONUS_MAX);
}

// 加点理由の日本語1行 (candidates.pros へ追記する説明。§17 説明可能性)
export function recallBonusLine(bonus: number): string {
  return `過去の類似調査でこのメンバーに高評価だった店です（+${
    (bonus * 100).toFixed(1)
  }点）`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// rank 付与 (§17 最終処理): score 降順、同点は created_at 昇順
export interface RankableCandidate {
  id: string;
  score: number;
  createdAt: string; // ISO
}

export function assignRanks(
  candidates: RankableCandidate[],
): Map<string, number> {
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const ranks = new Map<string, number>();
  sorted.forEach((c, i) => ranks.set(c.id, i + 1));
  return ranks;
}
