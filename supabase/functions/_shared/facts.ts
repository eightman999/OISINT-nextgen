// place_facts フライホイール (spec.md §44.5 / issue #104)
// 複数 Evidence の structured_claims を突き合わせ、「現時点で最も確からしい値」を
// place 単位で決定論的に集約する。AI は使わない (§15 と同じ方針)。
// - L1 原文 (rawText / excerpt) は保存しない (§44.3 Hard Rule 1)。value は L2 のみ
// - 矛盾 (§15) は潰さず conflicting=true で残す (両論併記は Evidence 側で行う)
// - feedback 由来キー (noise_level / space_comfort / value_for_money / service_quality) は
//   place_feedback 集計 RPC (別実装) が所有するため、本モジュールは upsert しない
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimKey, Contradiction, StructuredClaim } from "./types.ts";
import {
  contradictedKeys,
  detectCombinedContradictions,
  detectInternalContradictions,
} from "./contradiction.ts";
import { clamp } from "./source_quality.ts";
import { throwIfDatabaseError } from "./database_error.ts";
import {
  filterReusableSafeSharedEvidence,
  isReusableSafeSharedEvidence,
} from "./evidence_content.ts";
import { isEvidenceWithinTtl } from "./provider_ttl.ts";
import { filterValidClaims, type StructuredClaimInput } from "./validation.ts";

// facts 集約に使う shared Evidence の上限 (新しい順)。全履歴を舐めない決定論的上限
const FACTS_EVIDENCE_LIMIT = 50;

// feedback 集計 (§44.5 来店後フィードバック) が所有するキー。
// ClaimKey と衝突するのは noise_level のみだが、将来の追加に備え 4 つとも列挙する
export const FEEDBACK_OWNED_KEYS: ReadonlySet<string> = new Set([
  "noise_level",
  "space_comfort",
  "value_for_money",
  "service_quality",
]);

export interface FactSourceEvidence {
  id: string;
  sourceQuality: number;
  observedAt: string; // ISO
  structuredClaims: StructuredClaim[];
}

// 条件評価へ再利用する Evidence。ID と URL を claims から切り離さず保持し、
// requirement_evaluations と監査ログの双方が実在 source へ戻れるようにする (#312)。
export interface ReusableEvidence extends FactSourceEvidence {
  sourceUrl: string;
  sourceType?: string;
}

// place_facts 1 行分 (place_id / last_verified_at は upsert 時に付与)
export interface PlaceFactValue {
  key: ClaimKey;
  value: unknown;
  confidence: number; // 支持 Evidence の source_quality の最大値 (§44.5)
  evidenceCount: number; // 支持 Evidence 件数 (採用した値を支持する distinct Evidence 数)
  conflicting: boolean; // §15 矛盾検出結果
}

// 値の同一性判定用の正準文字列化 (object キー順に依存しない決定論比較)
export function canonicalValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${
    keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(obj[k])}`).join(",")
  }}`;
}

// Evidence 群 + 矛盾検出結果 → place_facts 値の決定論集約 (§44.5)。純関数。
// 値の採用規則 (決定論):
//   1. 同一値 (canonicalValue) ごとに支持 Evidence を集め、source_quality 合計が最大の値を採用
//   2. 同点なら observed_at が新しい方
//   3. なお同点なら canonical 文字列の昇順
export function buildPlaceFacts(
  evidence: FactSourceEvidence[],
  contradictions: Contradiction[],
): PlaceFactValue[] {
  const internalContradictions = detectInternalContradictions(
    evidence.map((item) => ({
      id: item.id,
      placeId: "place-facts",
      sourceQuality: item.sourceQuality,
      structuredClaims: item.structuredClaims,
    })),
  );
  const conflictKeys = contradictedKeys([
    ...contradictions,
    ...internalContradictions,
  ]);

  interface ValueGroup {
    value: unknown;
    evidenceIds: Set<string>;
    qualitySum: number;
    maxQuality: number;
    latestObservedAt: string;
  }
  const byKey = new Map<ClaimKey, Map<string, ValueGroup>>();

  for (const ev of evidence) {
    for (const claim of ev.structuredClaims) {
      if (FEEDBACK_OWNED_KEYS.has(claim.key)) continue; // feedback 側の所有キーは触らない
      const groups = byKey.get(claim.key) ?? new Map<string, ValueGroup>();
      const ck = canonicalValue(claim.value);
      const g = groups.get(ck) ?? {
        value: claim.value,
        evidenceIds: new Set<string>(),
        qualitySum: 0,
        maxQuality: 0,
        latestObservedAt: "",
      };
      // 同一 Evidence が同じ key+value を複数回主張しても支持は 1 回 (二重加算防止)
      if (!g.evidenceIds.has(ev.id)) {
        g.evidenceIds.add(ev.id);
        g.qualitySum += ev.sourceQuality;
        g.maxQuality = Math.max(g.maxQuality, ev.sourceQuality);
        if (ev.observedAt > g.latestObservedAt) {
          g.latestObservedAt = ev.observedAt;
        }
      }
      groups.set(ck, g);
      byKey.set(claim.key, groups);
    }
  }

  const facts: PlaceFactValue[] = [];
  for (const [key, groups] of byKey) {
    const ranked = [...groups.entries()].sort((a, b) => {
      if (b[1].qualitySum !== a[1].qualitySum) {
        return b[1].qualitySum - a[1].qualitySum;
      }
      if (a[1].latestObservedAt !== b[1].latestObservedAt) {
        return b[1].latestObservedAt.localeCompare(a[1].latestObservedAt);
      }
      return a[0].localeCompare(b[0]);
    });
    const win = ranked[0][1];
    facts.push({
      key,
      value: win.value,
      confidence: clamp(win.maxQuality, 0, 1),
      evidenceCount: win.evidenceIds.size,
      conflicting: conflictKeys.has(key), // 矛盾は潰さず flag で残す (§44.5)
    });
  }
  // 出力順も決定論に (key 昇順)
  return facts.sort((a, b) => a.key.localeCompare(b.key));
}

// ============================================================
// DB 連携 (service role 前提。place_facts への書き込みは service role のみ)
// ============================================================

// 候補 commit 後に呼ぶ place_facts 更新 (issue #104)。
// scope='shared' の Evidence のみを入力にする (§44.3 Hard Rule 2: 共有資産は
// investigation に紐づかない形のみ)。失敗しても呼び出し元の候補 commit は失敗させない。
export interface RefreshPlaceFactsOptions {
  // demand refresh は run metrics で storage failure を provider failure と
  // 分離する必要があるため、同じ集約ロジックを再利用しつつ呼び出し元へ返す。
  throwOnError?: boolean;
  // provider cache 経由の観測では、adapter が保持する fetchedAt を
  // place_facts.last_verified_at に引き継ぐ。未指定の既存呼び出しは現在時刻。
  lastVerifiedAt?: string;
}

export async function refreshPlaceFacts(
  db: SupabaseClient,
  placeId: string,
  options: RefreshPlaceFactsOptions = {},
): Promise<void> {
  try {
    const { data: rows, error: evidenceError } = await db
      .from("evidence")
      .select(
        "id, source_url, source_type, source_title, excerpt, source_quality, observed_at, structured_claims",
      )
      .eq("place_id", placeId)
      .eq("scope", "shared")
      .is("investigation_id", null)
      .order("observed_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(FACTS_EVIDENCE_LIMIT);
    throwIfDatabaseError(evidenceError, "evidence.facts_select");
    const evidence: FactSourceEvidence[] = filterReusableSafeSharedEvidence(
      rows ?? [],
    ).map((e) => ({
      id: e.id,
      sourceQuality: e.source_quality ?? 0.4,
      observedAt: e.observed_at,
      structuredClaims: (e.structured_claims ?? []) as StructuredClaim[],
    }));
    if (evidence.length === 0) return;

    const contradictions = detectCombinedContradictions(
      evidence.map((e) => ({
        id: e.id,
        placeId,
        sourceQuality: e.sourceQuality,
        structuredClaims: e.structuredClaims as never[],
      })),
    );
    const facts = buildPlaceFacts(evidence, contradictions);
    if (facts.length === 0) return;

    const lastVerifiedAt = options.lastVerifiedAt ?? new Date().toISOString();
    const { error } = await db.from("place_facts").upsert(
      facts.map((f) => ({
        place_id: placeId,
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        evidence_count: f.evidenceCount,
        conflicting: f.conflicting,
        last_verified_at: lastVerifiedAt,
      })),
      { onConflict: "place_id,key" },
    );
    throwIfDatabaseError(error, "place_facts.upsert");
  } catch (e) {
    // place_facts は集積用の副次テーブル。失敗は調査本体を止めない (§31 と同じ方針)
    console.error(
      `refreshPlaceFacts failed (place=${placeId}): ${
        e instanceof Error ? e.message : e
      }`,
    );
    if (options.throwOnError) throw e;
  }
}

// ============================================================
// 参照側 (#312: 既存 Evidence を条件単位で再利用)
// ============================================================

export interface FreshFact {
  key: ClaimKey;
  value: unknown;
  confidence: number;
}

// RequirementKind → 判定に使う ClaimKey (pipeline.ts CLAIM_TO_KIND の逆引き。
// 循環 import を避けるため独立定義)
const FACT_KEYS_FOR_KIND: Record<string, ClaimKey[]> = {
  time: ["opening_hours", "closed_days"],
  budget: ["budget_dinner"],
  payment: ["card_accepted"],
  reservation: ["reservation", "private_room"],
  party_size: ["capacity", "private_room"],
  dietary: ["non_smoking"],
  atmosphere: ["non_smoking", "child_friendly"],
  access: ["wifi_available", "nearest_station_walk_minutes"],
  other: [
    "non_smoking",
    "wifi_available",
    "child_friendly",
    "nearest_station_walk_minutes",
  ],
};

export interface FactEvaluation {
  requirementId: string;
  state: "match" | "partial" | "mismatch" | "unknown";
  confidence: number;
  explanation: string;
  evidenceIds: string[];
}

export interface FactRequirement {
  id: string;
  originalText: string;
  normalizedText: string;
  kind: string;
  priority: string;
}

// facts から requirement を決定論評価する。
// 判定できない場合は推測せず unknown (§12 Critical Rule)。
export function evaluateFromFacts(
  requirements: FactRequirement[],
  facts: FreshFact[],
  evidence: FactSourceEvidence[],
): FactEvaluation[] {
  const factByKey = new Map(facts.map((f) => [f.key, f]));

  // fact の値を支持する Evidence id (key + canonical value 一致)。match/mismatch の根拠に使う
  const supportingIds = (key: ClaimKey, value: unknown): string[] => {
    const ck = canonicalValue(value);
    return evidence
      .filter((ev) =>
        ev.structuredClaims.some((c) =>
          c.key === key && canonicalValue(c.value) === ck
        )
      )
      .map((ev) => ev.id);
  };

  return requirements.map((req) => {
    const judged = judgeRequirement(req, factByKey);
    if (judged.state === "unknown") {
      return {
        requirementId: req.id,
        state: "unknown" as const,
        confidence: 0,
        explanation: "蓄積済みの調査結果からは判定できません",
        evidenceIds: [],
      };
    }
    const evidenceIds = judged.usedFacts.flatMap((f) =>
      supportingIds(f.key, f.value)
    );
    const uniqueIds = [...new Set(evidenceIds)].sort();
    // Evidence 0 件で match/mismatch を断定しない (§12, §30 の実装上の担保と同方針)
    if (uniqueIds.length === 0) {
      return {
        requirementId: req.id,
        state: "unknown" as const,
        confidence: 0,
        explanation: "蓄積済みの調査結果に対応する根拠が見つかりませんでした",
        evidenceIds: [],
      };
    }
    const confidence = clamp(
      Math.min(...judged.usedFacts.map((f) => f.confidence)),
      0,
      1,
    );
    return {
      requirementId: req.id,
      state: judged.state,
      confidence,
      explanation: judged.explanation,
      evidenceIds: uniqueIds,
    };
  });
}

export interface EvidenceEvaluationPlan {
  resolvedEvaluations: FactEvaluation[];
  unresolvedRequirements: FactRequirement[];
  usedEvidenceSources: Array<{ id: string; sourceUrl: string }>;
}

// TTL 判定済みの shared Evidence を直接集約し、requirement ごとに安全に判定する。
// - 矛盾した claim は一方へ丸めず、対応 requirement を未解決のまま残す (§15)
// - Evidence ID が引けない断定は evaluateFromFacts 側で unknown へ落とす (§12)
// - 未対応 kind / 文面解釈が必要な条件は未解決として既存検索/Gemini 経路へ返す
export function evaluateFromEvidence(
  requirements: FactRequirement[],
  evidence: ReusableEvidence[],
): EvidenceEvaluationPlan {
  if (requirements.length === 0 || evidence.length === 0) {
    return {
      resolvedEvaluations: [],
      unresolvedRequirements: [...requirements],
      usedEvidenceSources: [],
    };
  }

  const contradictions = detectCombinedContradictions(
    evidence.map((e) => ({
      id: e.id,
      placeId: "reused-evidence",
      sourceQuality: e.sourceQuality,
      structuredClaims: e.structuredClaims,
    })),
  );
  const facts: FreshFact[] = buildPlaceFacts(evidence, contradictions)
    .filter((f) => !f.conflicting)
    .map((f) => ({
      key: f.key,
      value: f.value,
      confidence: f.confidence,
    }));
  const evaluations = evaluateFromFacts(requirements, facts, evidence);
  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  // buildPlaceFacts の quality winner だけで断定すると、矛盾判定の閾値未満で
  // 共存できる値（重なる予算帯・近い定員など）が異なるstateを示す場合に、
  // qualityの僅差だけでmatch/mismatchが決まる。各Evidenceを同じjudgeへ通し、
  // stateが割れた条件は部分適合へ収束させる。真の矛盾keyは上でfactsから除外
  // されているため、ここで未解決から断定へ戻すことはない。
  const reconciledEvaluations = evaluations.map((evaluation) => {
    if (evaluation.state === "unknown") return evaluation;
    const requirement = requirementById.get(evaluation.requirementId);
    if (!requirement) return evaluation;
    const rowEvaluations = evidence.flatMap((row) => {
      const rowFacts = buildPlaceFacts([row], [])
        .filter((fact) => !fact.conflicting)
        .map((fact) => ({
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
        }));
      const rowEvaluation = evaluateFromFacts(
        [requirement],
        rowFacts,
        [row],
      )[0];
      return rowEvaluation.state === "unknown" ? [] : [rowEvaluation];
    }).sort((left, right) =>
      (left.evidenceIds[0] ?? "").localeCompare(right.evidenceIds[0] ?? "")
    );
    if (rowEvaluations.length === 0) return evaluation;

    const evidenceIds = [
      ...new Set(rowEvaluations.flatMap((item) => item.evidenceIds)),
    ].sort();
    const confidence = clamp(
      Math.min(...rowEvaluations.map((item) => item.confidence)),
      0,
      1,
    );
    const states = new Set(rowEvaluations.map((item) => item.state));
    if (states.size > 1) {
      return {
        requirementId: evaluation.requirementId,
        state: "partial" as const,
        confidence,
        explanation: "複数のEvidenceで適合度が異なるため部分適合です",
        evidenceIds,
      };
    }
    const representative = rowEvaluations[0];
    return {
      ...representative,
      confidence,
      evidenceIds,
    };
  });
  const resolvedEvaluations = reconciledEvaluations.filter((e) =>
    e.state !== "unknown"
  );
  const resolvedIds = new Set(
    resolvedEvaluations.map((e) => e.requirementId),
  );
  const unresolvedRequirements = requirements.filter((r) =>
    !resolvedIds.has(r.id)
  );
  const usedEvidenceIds = new Set(
    resolvedEvaluations.flatMap((e) => e.evidenceIds),
  );
  const usedEvidenceSources = evidence
    .filter((e) => usedEvidenceIds.has(e.id))
    .map((e) => ({ id: e.id, sourceUrl: e.sourceUrl }))
    .sort((left, right) =>
      left.id.localeCompare(right.id) ||
      left.sourceUrl.localeCompare(right.sourceUrl)
    );

  return {
    resolvedEvaluations,
    unresolvedRequirements,
    usedEvidenceSources,
  };
}

interface Judged {
  state: "match" | "partial" | "mismatch" | "unknown";
  usedFacts: FreshFact[];
  explanation: string;
}

export type BudgetRequirement =
  | { operator: "max_inclusive"; amount: number }
  | { operator: "max_strict"; amount: number }
  | { operator: "min_inclusive"; amount: number }
  | { operator: "around"; amount: number }
  | { operator: "range"; min: number; max: number };

export type StructuredFilterRequirementIntent =
  | {
    kind: "boolean_filter";
    key: "non_smoking" | "wifi_available" | "child_friendly";
    desired: boolean;
  }
  | { kind: "walk_limit"; maxMinutes: number };

type DeterministicRequirementIntent =
  | { kind: "payment"; desired: boolean }
  | { kind: "budget"; requirement: BudgetRequirement }
  | { kind: "party_size"; people: number }
  | {
    kind: "reservation";
    subject: "reservation" | "private_room";
    desired: boolean;
  }
  | StructuredFilterRequirementIntent;

function parseAmount(raw: string, tenThousands = false): number | null {
  const amount = Number(raw.replaceAll(",", "")) *
    (tenThousands ? 10_000 : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function canonicalRequirementText(text: string): string {
  return text.normalize("NFKC").trim().replaceAll(/\s+/g, "");
}

/**
 * #334 のfilter chipを自由文の部分一致ではなく、明示された単一条件だけから
 * 決定論的intentへ変換する。複合文、選言、推測した徒歩時間は受理しない。
 */
export function parseStructuredFilterRequirement(
  text: string,
): StructuredFilterRequirementIntent | null {
  const canonical = canonicalRequirementText(text);
  const lower = canonical.toLowerCase().replaceAll(/[‐‑‒–—−]/g, "-");

  if (
    /^(?:全席)?禁煙(?:席)?(?:がいい|を希望|希望です|希望)?$/.test(canonical)
  ) {
    return { kind: "boolean_filter", key: "non_smoking", desired: true };
  }
  if (/^(?:喫煙可|喫煙可能|喫煙席あり)$/.test(canonical)) {
    return { kind: "boolean_filter", key: "non_smoking", desired: false };
  }
  if (
    /^(?:無料)?(?:wi-?fi|無線lan)(?:あり|利用可能|利用可|対応|希望)?$/.test(
      lower,
    )
  ) {
    return { kind: "boolean_filter", key: "wifi_available", desired: true };
  }
  if (/^(?:wi-?fi|無線lan)(?:なし|無し|利用不可|非対応)$/.test(lower)) {
    return { kind: "boolean_filter", key: "wifi_available", desired: false };
  }
  if (/^(?:子ども|子供|子)連れ(?:ok|可|歓迎|対応|希望)?$/.test(lower)) {
    return { kind: "boolean_filter", key: "child_friendly", desired: true };
  }
  if (/^(?:子ども|子供|子)連れ(?:不可|非対応|ng)$/.test(lower)) {
    return { kind: "boolean_filter", key: "child_friendly", desired: false };
  }
  const walk = canonical.match(
    /^(?:(?:最寄り)?駅から)?徒歩([0-9]+)分(?:以内|以下|まで)$/,
  );
  if (walk) {
    const maxMinutes = Number(walk[1]);
    if (Number.isSafeInteger(maxMinutes) && maxMinutes >= 0) {
      return { kind: "walk_limit", maxMinutes };
    }
  }
  return null;
}

export function structuredFilterClaimKeyForRequirement(
  originalText: string,
  normalizedText: string,
): ClaimKey | null {
  const original = parseStructuredFilterRequirement(originalText);
  const normalized = parseStructuredFilterRequirement(normalizedText);
  if (
    !original || !normalized ||
    canonicalValue(original) !== canonicalValue(normalized)
  ) return null;
  return normalized.kind === "walk_limit"
    ? "nearest_station_walk_minutes"
    : normalized.key;
}

// 原文source gateでraw_queryとの同一intentが確認された後に呼ばれる。明示operatorに
// 加え、予算文脈の裸金額はnormalizedTextと一致する場合だけaroundとして扱う。
// 否定・除外・選言など残余文字があれば全体matchしないため unknownへ倒す。
export function parseBudgetRequirement(text: string): BudgetRequirement | null {
  const canonical = canonicalRequirementText(text);
  const prefix = "(?:(?:希望)?予算(?:は|:)?|(?:一人|1人)(?:あたり)?(?:は|:)?)?";
  const suffix = "(?:を希望|が希望|希望です|希望|でお願いします|がいい|で)?";
  // live query で使われる英語の円上限も、日本語へ正規化された同じ intent と
  // 比較できる形へ揃える。通貨が明示された単純な上限制約だけを受理する。
  const englishMaximum = canonical.toLowerCase().match(
    /^(?:under|below|atmost|upto)(?:¥|jpy)?([0-9][0-9,]*)(?:yen|円)?$/,
  );
  if (
    englishMaximum &&
    /(?:¥|jpy|yen|円)/i.test(canonical)
  ) {
    const amount = parseAmount(englishMaximum[1]);
    return amount === null ? null : { operator: "max_inclusive", amount };
  }
  const range = canonical.match(
    new RegExp(
      `^${prefix}([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円?(?:〜|~|－|–|—|-|から)([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円(?:まで)?${suffix}$`,
    ),
  );
  if (range) {
    const min = parseAmount(range[1], range[2] === "万");
    const max = parseAmount(range[3], range[4] === "万");
    if (min === null || max === null || min > max) return null;
    return { operator: "range", min, max };
  }

  const operation = canonical.match(
    new RegExp(
      `^${prefix}([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円(以下|以内|まで|未満|以上|前後)${suffix}$`,
    ),
  );
  if (!operation) {
    const around = canonical.match(
      new RegExp(
        `^${prefix}([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円(?:くらい|程度)?${suffix}$`,
      ),
    );
    const amount = around ? parseAmount(around[1], around[2] === "万") : null;
    return amount === null ? null : { operator: "around", amount };
  }
  const amount = parseAmount(operation[1], operation[2] === "万");
  if (amount === null) return null;
  const operator = operation[3];
  if (operator === "以下" || operator === "以内" || operator === "まで") {
    return { operator: "max_inclusive", amount };
  }
  if (operator === "未満") return { operator: "max_strict", amount };
  if (operator === "以上") return { operator: "min_inclusive", amount };
  return { operator: "around", amount };
}

export function compareBudgetRequirement(
  requirement: BudgetRequirement,
  range: { min: number; max: number },
): "match" | "partial" | "mismatch" {
  if (requirement.operator === "max_inclusive") {
    return range.max <= requirement.amount
      ? "match"
      : range.min > requirement.amount
      ? "mismatch"
      : "partial";
  }
  if (requirement.operator === "max_strict") {
    return range.max < requirement.amount
      ? "match"
      : range.min >= requirement.amount
      ? "mismatch"
      : "partial";
  }
  if (requirement.operator === "min_inclusive") {
    return range.min >= requirement.amount
      ? "match"
      : range.max < requirement.amount
      ? "mismatch"
      : "partial";
  }
  if (requirement.operator === "around") {
    return range.min <= requirement.amount && requirement.amount <= range.max
      ? "match"
      : "mismatch";
  }
  return range.min >= requirement.min && range.max <= requirement.max
    ? "match"
    : range.max < requirement.min || range.min > requirement.max
    ? "mismatch"
    : "partial";
}

function explicitBooleanIntent(
  text: string,
  subject: "card" | "reservation" | "private_room",
): boolean | null {
  const canonical = canonicalRequirementText(text);
  if (subject === "card") {
    // 許容prefixは「支払い/支払い方法」のみ。subject + canonicalな可否表現を
    // normalizedText全体で受理し、現金・除外・後置否定等を部分一致させない。
    const prefix = "(?:支払い(?:方法)?(?:は|:)?)?";
    const card = "(?:クレジットカード|クレカ|カード)";
    const positive = new RegExp(
      `^${prefix}${card}(?:利用可能|利用可|利用できる|払い可能|払い可|払いしたい|で払いたい|を使いたい|決済可能|決済可|が使える|は使える|対応|可)(?:がいい|が希望|を希望|希望です|希望)?$`,
    );
    const negative = new RegExp(
      `^${prefix}${card}(?:利用不可|利用できない|払い不可|決済不可|が使えない|は使えない|非対応|不可)$`,
    );
    if (negative.test(canonical)) return false;
    if (positive.test(canonical)) return true;
    return null;
  }

  if (subject === "reservation") {
    if (/^予約(?:が|は)?(?:不可|できない|できません|非対応)$/.test(canonical)) {
      return false;
    }
    if (
      /^予約(?:が|は)?(?:可能|できる|対応|受付中|可)(?:がいい|が希望|を希望|希望です|希望)?$/
        .test(canonical)
    ) {
      return true;
    }
    if (/^予約(?:したい|希望)?(?:です)?$/.test(canonical)) return true;
    return null;
  }

  if (
    /^個室(?:が|は)?(?:なし|無し|ありません|不可|利用不可|利用できない|非対応)$/
      .test(canonical)
  ) {
    return false;
  }
  if (
    /^個室(?:が|は)?(?:あり|有り|あります|利用可能|利用可|可能|可|希望)?(?:です)?$/
      .test(canonical)
  ) {
    return true;
  }
  if (/^個室で(?:静か|落ち着いた)(?:店|ところ)?$/.test(canonical)) {
    return true;
  }
  return null;
}

export function parsePartySizeRequirement(text: string): number | null {
  const match = canonicalRequirementText(text).match(
    /^(?:人数(?:は|:)?)?([0-9]+)人(?:で)?(?:利用可能|利用可|利用できる|予約可能|予約可|行きたい|予約したい|希望)?(?:です)?$/,
  );
  if (!match) return null;
  const people = Number(match[1]);
  return Number.isSafeInteger(people) && people > 0 ? people : null;
}

export interface ReservationRequirementIntent {
  kind: "reservation";
  subject: "reservation" | "private_room";
  desired: boolean;
}

export function parseReservationRequirement(
  text: string,
): ReservationRequirementIntent | null {
  const canonical = canonicalRequirementText(text);
  const asksReservation = canonical.includes("予約");
  const asksPrivateRoom = canonical.includes("個室");
  // 複合条件や対象不明を一つのboolean claimへORしない。
  if (asksReservation === asksPrivateRoom) return null;
  const subject = asksPrivateRoom ? "private_room" : "reservation";
  const desired = explicitBooleanIntent(text, subject);
  return desired === null ? null : { kind: "reservation", subject, desired };
}

export function parsePaymentRequirement(text: string): boolean | null {
  return explicitBooleanIntent(text, "card");
}

function parseDeterministicRequirementIntent(
  kind: string,
  text: string,
): DeterministicRequirementIntent | null {
  const structuredFilter = parseStructuredFilterRequirement(text);
  if (structuredFilter) return structuredFilter;
  if (kind === "payment") {
    const desired = parsePaymentRequirement(text);
    return desired === null ? null : { kind: "payment", desired };
  }
  if (kind === "budget") {
    const requirement = parseBudgetRequirement(text);
    return requirement === null ? null : { kind: "budget", requirement };
  }
  if (kind === "party_size") {
    const people = parsePartySizeRequirement(text);
    return people === null ? null : { kind: "party_size", people };
  }
  if (kind === "reservation") return parseReservationRequirement(text);
  return null;
}

// AI正規化が否定・対象・数値operatorを落としても決定論評価へ進めない。
// DBに保存した原文とnormalizedTextの双方を独立parseし、同じ明示intentになった場合だけ使う。
function consistentDeterministicIntent(
  requirement: FactRequirement,
): DeterministicRequirementIntent | null {
  const original = parseDeterministicRequirementIntent(
    requirement.kind,
    requirement.originalText,
  );
  const normalized = parseDeterministicRequirementIntent(
    requirement.kind,
    requirement.normalizedText,
  );
  if (!original || !normalized) return null;
  return canonicalValue(original) === canonicalValue(normalized)
    ? normalized
    : null;
}

// kind は候補 claim の範囲を絞るためだけに使い、最終判定はoriginalTextとnormalizedTextで
// 一致した明示的な対象・operatorとfact valueの組で行う。曖昧・不一致はunknownに倒す。
function judgeRequirement(
  req: FactRequirement,
  factByKey: Map<ClaimKey, FreshFact>,
): Judged {
  const unknown: Judged = { state: "unknown", usedFacts: [], explanation: "" };
  const keys = FACT_KEYS_FOR_KIND[req.kind];
  if (!keys) return unknown;
  const intent = consistentDeterministicIntent(req);
  if (!intent) return unknown;

  if (intent.kind === "payment") {
    const desired = intent.desired;
    const f = factByKey.get("card_accepted");
    if (!f || typeof f.value !== "boolean") return unknown;
    const matched = f.value === desired;
    return {
      state: matched ? "match" : "mismatch",
      usedFacts: [f],
      explanation: matched
        ? `蓄積済みの調査結果がクレジットカード${
          desired ? "利用可" : "利用不可"
        }の条件と一致します`
        : `蓄積済みの調査結果はクレジットカード${
          f.value ? "利用可" : "利用不可"
        }で、条件と一致しません`,
    };
  }
  if (intent.kind === "budget") {
    const parsed = intent.requirement;
    const f = factByKey.get("budget_dinner");
    const range = f?.value as { min?: number; max?: number } | undefined;
    if (
      !f || typeof range?.min !== "number" ||
      typeof range?.max !== "number" || range.min > range.max
    ) return unknown;

    const state = compareBudgetRequirement(parsed, {
      min: range.min,
      max: range.max,
    });
    return {
      state,
      usedFacts: [f],
      explanation:
        `蓄積済みの予算帯は ${range.min}〜${range.max}円で、明示された予算条件との判定は${state}です`,
    };
  }
  if (intent.kind === "party_size") {
    const f = factByKey.get("capacity");
    if (!f || typeof f.value !== "number") return unknown;
    const n = intent.people;
    const enoughTotalSeats = f.value >= n;
    return {
      state: enoughTotalSeats ? "partial" : "mismatch",
      usedFacts: [f],
      explanation: enoughTotalSeats
        ? `蓄積済みの総席数は ${f.value}席で ${n}人以上ですが、同時利用や同一テーブルの可否までは確認できません`
        : `蓄積済みの席数 (${f.value}席) では ${n}人に不足します`,
    };
  }
  if (intent.kind === "reservation") {
    const { subject, desired } = intent;
    const f = factByKey.get(subject);
    if (!f || typeof f.value !== "boolean") return unknown;
    const matched = f.value === desired;
    return {
      state: matched ? "match" : "mismatch",
      usedFacts: [f],
      explanation: `蓄積済みの調査結果が${
        subject === "private_room" ? "個室" : "予約"
      }${desired ? "可" : "不可"}の条件と${
        matched ? "一致します" : "一致しません"
      }`,
    };
  }
  if (intent.kind === "boolean_filter") {
    const f = factByKey.get(intent.key);
    if (!f || typeof f.value !== "boolean") return unknown;
    const matched = f.value === intent.desired;
    const label = intent.key === "non_smoking"
      ? "禁煙"
      : intent.key === "wifi_available"
      ? "Wi-Fi"
      : "子連れ対応";
    return {
      state: matched ? "match" : "mismatch",
      usedFacts: [f],
      explanation: "蓄積済みの調査結果が" + label +
        (intent.desired ? "あり" : "なし") + "の条件と" +
        (matched ? "一致します" : "一致しません"),
    };
  }
  if (intent.kind === "walk_limit") {
    const f = factByKey.get("nearest_station_walk_minutes");
    if (
      !f || typeof f.value !== "number" ||
      !Number.isSafeInteger(f.value) || f.value < 0
    ) return unknown;
    const matched = f.value <= intent.maxMinutes;
    return {
      state: matched ? "match" : "mismatch",
      usedFacts: [f],
      explanation: "公開情報の最寄り駅から徒歩" + f.value + "分は、徒歩" +
        intent.maxMinutes + "分以内の条件と" +
        (matched ? "一致します" : "一致しません"),
    };
  }
  // time (営業時間の適合は文面解釈が必要) やその他はここでは断定しない
  return unknown;
}

export interface EvidenceReuseResult extends EvidenceEvaluationPlan {
  knownEvidence: ReusableEvidence[];
}

// 候補の fresh shared Evidence を ID / source_url 付きで読み、判定できた requirement
// と未解決 requirement のplanだけを返す。永続化はpipelineの候補単位commitに統合する (#312)。
export async function planKnownEvidenceForCandidate(
  db: SupabaseClient,
  candidate: { place_id: string },
  requirements: FactRequirement[],
): Promise<EvidenceReuseResult> {
  if (requirements.length === 0) {
    return {
      knownEvidence: [],
      resolvedEvaluations: [],
      unresolvedRequirements: [],
      usedEvidenceSources: [],
    };
  }

  const { data: rows, error } = await db
    .from("evidence")
    .select(
      "id, source_url, source_type, source_title, excerpt, source_quality, observed_at, structured_claims",
    )
    .eq("place_id", candidate.place_id)
    .eq("scope", "shared")
    .is("investigation_id", null)
    .order("observed_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(FACTS_EVIDENCE_LIMIT);
  throwIfDatabaseError(error, "evidence.shared_select");
  const knownEvidence: ReusableEvidence[] = (rows ?? [])
    .filter((e) => isEvidenceWithinTtl(e) && isReusableSafeSharedEvidence(e))
    .map((e) => ({
      id: e.id,
      sourceUrl: e.source_url,
      sourceType: typeof e.source_type === "string" ? e.source_type : undefined,
      sourceQuality: e.source_quality ?? 0.4,
      observedAt: e.observed_at,
      structuredClaims: filterValidClaims(
        (e.structured_claims ?? []) as StructuredClaimInput[],
      ) as StructuredClaim[],
    }));
  const plan = evaluateFromEvidence(requirements, knownEvidence);
  return { knownEvidence, ...plan };
}
