// Pre-Rank ステージ (issue #552)。純関数のみ。外部 I/O・env 参照はここに書かない。
//
// 位置づけ: Broad Discovery で広げた候補 (#509) を、高価な Web Research + Gemini Judge へ
// 渡す前に安価に絞る段。「Gemini を弱くして安くする」のではなく「高価な Judge を呼ぶ
// 候補数を減らす」ことでコストを下げる。
//
// 契約 (issue #552 Principle):
//   known match    → 加点
//   known mismatch → 減点
//   unknown / stale → 中立。**除外理由にしない**。research priority を上げる材料にするだけ
//
// 情報不足の店を pre-rank で落とすと後段 Research で救済できないため、precision より
// recall を優先する。判定は §17 / §15 と同じく「AI ではなくコード」を正本にでき、
// AI (OpenRouter) 出力は同じ契約の上書き候補として扱う (providers/openrouter.ts)。
import type { RequirementPriority } from "./types.ts";
import {
  type ClaimWithEvidence,
  deterministicEvaluations,
} from "./requirement_matching.ts";

// ============================================================
// 入出力型
// ============================================================

export interface PreRankRequirement {
  id: string;
  kind: string;
  priority: RequirementPriority;
  weight: number; // 0..1
  normalizedText: string;
  originalText: string;
}

// pre-rank へ渡してよいのは「既知情報」だけ (issue #552 Principle:
// DeepSeek/OpenRouter を『事実の発明者』にしない)。Web 上にあるかもしれない
// 未知の情報を推測させないため、provider claims と距離・カテゴリに限定する。
export interface PreRankCandidate {
  id: string; // canonical place id、未永続化なら `${provider}:${providerPlaceId}`
  name: string;
  provider: string;
  distanceM: number | null;
  categories: string[];
  knownClaims: Array<{ key: string; value: unknown; rawText: string }>;
}

export interface PreRankResult {
  id: string;
  preScore: number; // 0..1。既知情報が無ければ 0.5 (中立)
  knownMatch: string[]; // requirement id
  knownMismatch: string[];
  unknown: string[];
  researchPriority: number; // 0..1。未知の重みが大きいほど高い
  reasonCodes: string[]; // 自由文 reason を ranking 正本にしない (issue #552)
}

// §17 と同じ priority 重み。pre-rank と最終 ranking で優先度の意味をずらさない
const PRIORITY_WEIGHT: Record<RequirementPriority, number> = {
  must: 1.0,
  should: 0.6,
  nice: 0.3,
};

// 既知情報が 1 件も無い候補の pre_score。0 にすると「情報が無いだけの店」が
// 「明確に条件外の店」と同じ扱いになり recall を落とすため中立に置く
export const NEUTRAL_PRE_SCORE = 0.5;

// 上記の理由で使う sentinel。実在の evidence.id と衝突しないよう UUID 形式にしない
export const PRERANK_CLAIM_SENTINEL = "prerank:known-claim";

/**
 * 外部Research前の予備score。final `computeScore` とは別の純関数として、
 * 既知claimのmatch/mismatchだけを比較する。unknownは分母へ入れず、情報が
 * 無い候補を「不適合」と誤認しない (#509)。
 */
export function computePreliminaryScore(
  matchedWeight: number,
  mismatchWeight: number,
): number {
  const matched = Number.isFinite(matchedWeight)
    ? Math.max(0, matchedWeight)
    : 0;
  const mismatched = Number.isFinite(mismatchWeight)
    ? Math.max(0, mismatchWeight)
    : 0;
  const knownWeight = matched + mismatched;
  return knownWeight > 0 ? clamp01(matched / knownWeight) : NEUTRAL_PRE_SCORE;
}

function requirementWeight(r: PreRankRequirement): number {
  return PRIORITY_WEIGHT[r.priority] * clamp01(r.weight);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ============================================================
// reason code
// ============================================================

// 自由文でなく機械可読な code で返す。ranking / 監査ログはこちらを正本にする
export function matchReasonCode(kind: string, state: string): string {
  return `${kind.toUpperCase()}_${state.toUpperCase()}`;
}

export function missingReasonCode(kind: string): string {
  return `MISSING_${kind.toUpperCase()}`;
}

// ============================================================
// 決定論 pre-rank (AI provider 障害時の fallback 兼、既定の provider)
// ============================================================

// 既知 claim と requirement を requirement_matching.ts のコード突合にかける。
// 判定できなかった requirement は unknown として扱い、減点しない。
export function deterministicPreRank(
  candidates: PreRankCandidate[],
  requirements: PreRankRequirement[],
): PreRankResult[] {
  return candidates.map((c) => preRankOne(c, requirements));
}

function preRankOne(
  candidate: PreRankCandidate,
  requirements: PreRankRequirement[],
): PreRankResult {
  // requirement_matching.ts は §12 (Evidence の無い断定をしない) のため
  // evidenceIds が空の claim を無視する。pre-rank の時点では Evidence #0 が
  // まだ挿入されておらず実 id を持てないので sentinel を付けて突合する。
  //
  // これが §12 に反しないのは、PreRankResult が **どの候補を調べるかの順序付けにしか
  // 使われず**、requirement_evaluations として保存されることも UI へ断定として
  // 出ることも無いため。Evidence 付きの評価は後段の Gemini Judge /
  // evaluateFromEvidence が別途やり直す。ここの結果を永続化してはならない。
  const claims: ClaimWithEvidence[] = candidate.knownClaims.map((c) => ({
    key: c.key,
    value: c.value,
    rawText: c.rawText,
    evidenceIds: [PRERANK_CLAIM_SENTINEL],
  }));
  const evaluated = deterministicEvaluations(
    requirements.map((r) => ({
      id: r.id,
      kind: r.kind,
      normalizedText: r.normalizedText,
      originalText: r.originalText,
    })),
    claims,
  );

  const knownMatch: string[] = [];
  const knownMismatch: string[] = [];
  const unknown: string[] = [];
  const reasonCodes: string[] = [];
  let matchedWeight = 0;
  let mismatchWeight = 0;
  let unknownWeight = 0;
  let totalWeight = 0;

  for (const r of requirements) {
    const w = requirementWeight(r);
    totalWeight += w;
    const det = evaluated.get(r.id);
    if (!det || det.state === "unknown") {
      unknown.push(r.id);
      unknownWeight += w;
      reasonCodes.push(missingReasonCode(r.kind));
      continue;
    }
    if (det.state === "mismatch") {
      knownMismatch.push(r.id);
      mismatchWeight += w;
    } else {
      // partial は「またぎ」で mismatch と断定できない状態。加点は半分に留める
      knownMatch.push(r.id);
      matchedWeight += det.state === "partial" ? w * 0.5 : w;
    }
    reasonCodes.push(matchReasonCode(r.kind, det.state));
  }

  // 既知分だけで [0,1] に写す。unknown は分母にも分子にも入れない = 中立
  const preScore = computePreliminaryScore(matchedWeight, mismatchWeight);
  const researchPriority = totalWeight > 0
    ? clamp01(unknownWeight / totalWeight)
    : 1;

  return {
    id: candidate.id,
    preScore,
    knownMatch,
    knownMismatch,
    unknown,
    researchPriority,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

// ============================================================
// Hard Filter (dedupe は provider 層 / places の unique 制約が担う)
// ============================================================

export interface HardFilterOutcome {
  kept: PreRankCandidate[];
  droppedIds: string[];
  // 全滅した場合に fail-open したかどうか (監査ログ用)
  failOpen: boolean;
}

// 除外してよいのは「must requirement に対する既知 mismatch」だけ。
// unknown / 情報不足は絶対に除外理由にしない (issue #552 unknown != mismatch)。
export function hardFilter(
  candidates: PreRankCandidate[],
  requirements: PreRankRequirement[],
  results: PreRankResult[],
): HardFilterOutcome {
  const mustIds = new Set(
    requirements.filter((r) => r.priority === "must").map((r) => r.id),
  );
  const byId = new Map(results.map((r) => [r.id, r]));
  const kept: PreRankCandidate[] = [];
  const droppedIds: string[] = [];
  for (const c of candidates) {
    const r = byId.get(c.id);
    const hasMustMismatch = !!r &&
      r.knownMismatch.some((id) => mustIds.has(id));
    if (hasMustMismatch) droppedIds.push(c.id);
    else kept.push(c);
  }
  // 全候補が落ちたら調査自体が成立しないため fail-open する (§5.4 Fallback と同方針)
  if (kept.length === 0 && candidates.length > 0) {
    return { kept: candidates, droppedIds: [], failOpen: true };
  }
  return { kept, droppedIds, failOpen: false };
}

// ============================================================
// Research 候補の選抜 (exploitation + exploration)
// ============================================================

export interface SelectionConfig {
  researchLimit: number; // Research へ回す総数
  explorationSlots: number; // うち探索枠
}

export interface Selection {
  exploitation: string[]; // candidate id
  exploration: string[];
  selected: string[]; // exploitation + exploration (この順)
}

// 上位 N 件だけでは structured data の薄い良店を永久に発見できないため探索枠を持つ。
// 乱数は使わない — 同じ入力からは常に同じ選抜になる (issue #552: 決定論的 selection を優先)。
export function selectResearchCandidates(
  candidates: PreRankCandidate[],
  results: PreRankResult[],
  config: SelectionConfig,
): Selection {
  const byId = new Map(results.map((r) => [r.id, r]));
  const order = [...candidates].sort((a, b) => {
    const ra = byId.get(a.id);
    const rb = byId.get(b.id);
    const sa = ra?.preScore ?? NEUTRAL_PRE_SCORE;
    const sb = rb?.preScore ?? NEUTRAL_PRE_SCORE;
    if (sa !== sb) return sb - sa;
    // 同点は researchPriority が高い方を先に (情報が薄い店ほど調べる価値がある)
    const pa = ra?.researchPriority ?? 1;
    const pb = rb?.researchPriority ?? 1;
    if (pa !== pb) return pb - pa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // 完全な決定論のための最終 tie-break
  });

  const limit = Math.max(0, Math.floor(config.researchLimit));
  const slots = Math.max(
    0,
    Math.min(Math.floor(config.explorationSlots), limit),
  );
  const exploitCount = Math.max(0, limit - slots);

  const exploitationCandidates = order.slice(0, exploitCount);
  const exploitation = exploitationCandidates.map((c) => c.id);
  const taken = new Set(exploitation);
  const rest = order.filter((c) => !taken.has(c.id));
  const exploration = pickExploration(
    rest,
    byId,
    slots,
    exploitationCandidates,
  );

  // 探索枠が埋まらなかった分は exploitation へ返す (枠を空にして候補数を減らさない)
  const filled = new Set([...exploitation, ...exploration]);
  const filler: string[] = [];
  for (const c of order) {
    if (filled.size >= limit) break;
    if (filled.has(c.id)) continue;
    filled.add(c.id);
    filler.push(c.id);
  }

  return {
    exploitation: [...exploitation, ...filler],
    exploration,
    selected: [...exploitation, ...filler, ...exploration],
  };
}

// 探索枠の選び方 (決定論):
//   1. researchPriority が高い (unknown が多い) 順
//   2. 同点なら provider / category の多様性を優先し、既選抜と被らないものを取る
function pickExploration(
  rest: PreRankCandidate[],
  byId: Map<string, PreRankResult>,
  slots: number,
  selected: PreRankCandidate[],
): string[] {
  if (slots === 0) return [];
  const ranked = [...rest].sort((a, b) => {
    const pa = byId.get(a.id)?.researchPriority ?? 1;
    const pb = byId.get(b.id)?.researchPriority ?? 1;
    if (pa !== pb) return pb - pa;
    const sa = byId.get(a.id)?.preScore ?? NEUTRAL_PRE_SCORE;
    const sb = byId.get(b.id)?.preScore ?? NEUTRAL_PRE_SCORE;
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const seenProviders = new Set<string>();
  const seenCategories = new Set<string>();
  for (const c of selected) {
    seenProviders.add(c.provider);
    for (const cat of c.categories) seenCategories.add(cat);
  }

  const out: string[] = [];
  // pass 1: provider / category が既選抜と被らない候補を優先
  for (const c of ranked) {
    if (out.length >= slots) break;
    const novel = !seenProviders.has(c.provider) ||
      c.categories.some((cat) => !seenCategories.has(cat));
    if (!novel) continue;
    out.push(c.id);
    seenProviders.add(c.provider);
    for (const cat of c.categories) seenCategories.add(cat);
  }
  // pass 2: 多様性で埋まらなければ researchPriority 順にそのまま埋める
  for (const c of ranked) {
    if (out.length >= slots) break;
    if (out.includes(c.id)) continue;
    out.push(c.id);
  }
  return out;
}

// ============================================================
// AI provider 出力の取り込み (issue #552: 出力は local schema で検証してから使う)
// ============================================================

// AI が返した pre-rank を決定論結果の上に重ねる。
// - 入力に無い id は捨てる (候補の捏造を通さない)
// - 返らなかった候補は決定論結果のまま (fail-open。候補を全削除しない)
// - preScore / researchPriority が 0..1 の外なら clamp せずその候補だけ決定論へ落とす (§30)
export function mergePreRankResults(
  deterministic: PreRankResult[],
  aiResults: PreRankResult[],
): { merged: PreRankResult[]; acceptedIds: string[]; rejectedIds: string[] } {
  const known = new Map(deterministic.map((r) => [r.id, r]));
  const accepted: string[] = [];
  const rejected: string[] = [];
  const overrides = new Map<string, PreRankResult>();

  for (const ai of aiResults) {
    if (!known.has(ai.id)) {
      rejected.push(ai.id);
      continue;
    }
    if (!inUnitRange(ai.preScore) || !inUnitRange(ai.researchPriority)) {
      rejected.push(ai.id);
      continue;
    }
    if (overrides.has(ai.id)) {
      rejected.push(ai.id); // 同一 id の重複は最初の 1 件だけ採用
      continue;
    }
    overrides.set(ai.id, ai);
    accepted.push(ai.id);
  }

  const merged = deterministic.map((det) => {
    const ai = overrides.get(det.id);
    if (!ai) return det;
    const deterministicMatches = new Set(det.knownMatch);
    const deterministicMismatches = new Set(det.knownMismatch);
    const knownMatch = [
      ...new Set([
        ...det.knownMatch,
        ...ai.knownMatch.filter((id) => !deterministicMismatches.has(id)),
      ]),
    ];
    const knownMismatch = [
      ...new Set([
        ...det.knownMismatch,
        ...ai.knownMismatch.filter((id) => !deterministicMatches.has(id)),
      ]),
    ];
    const classified = new Set([...knownMatch, ...knownMismatch]);
    return {
      ...ai,
      // AI 出力は untrusted input。コードで確定した match / mismatch を省略・反転
      // しても上書きさせない。AI は決定論で unknown の項目だけを補足できる。
      knownMatch,
      knownMismatch,
      unknown: [...new Set([...det.unknown, ...ai.unknown])].filter((id) =>
        !classified.has(id)
      ),
    };
  });
  return { merged, acceptedIds: accepted, rejectedIds: rejected };
}

function inUnitRange(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}
