// 予算・時間帯要件と structured claim の決定論突合 (issue #312 是正案1)。
// AI に投げず、requirement の文面を正規化して claim (§13) とコードで比較する。純関数。
// §15 (矛盾検出) / §17 (score) と同じ「判定はAIではなくコードで行う」方針の評価版。
// - 判定できた場合は AI 評価より優先する (呼び出し側 pipeline.ts が上書きする)
// - claim が無い / 文面を正規化できない場合は null を返し、従来どおり AI 評価に任せる
// - Evidence の無い断定はしない (§12 Critical Rule): evidenceIds 空の claim は使わない
import type { ClaimKey, MatchState } from "./types.ts";
import { parseOpeningHoursValue } from "./opening_hours.ts";
import { claimValuesConflict } from "./contradiction.ts";
import {
  type BudgetRequirement,
  compareBudgetRequirement,
  parseBudgetRequirement,
} from "./facts.ts";
import {
  cuisineClassMatchesGenre,
  cuisineEquivalenceClass,
  isJapaneseCuisineText,
} from "./cuisine_lexicon.ts";

// ============================================================
// 予算要件の正規化 (§11 kind=budget)
// ============================================================

// 「安い」等のあいまい語の上限金額。spec.md §11 の保守的な既定境界。
// 根拠: 国内グルメサービスの予算帯 (2001〜3000円) を境に、都内ディナー相場
// (3000〜5000円) より下の帯までを「安い」とみなす。issue #312 の実例 (夜6000〜7999円)
// は許容幅を足しても明確に超過し mismatch になる
export const VAGUE_CHEAP_MAX_YEN = 3000;

// 「3000円前後」「安い」等の幅のある表現の許容率。上限 × (1 + 0.2) までは
// mismatch と断定せず partial に留める (§12: 過信した断定を避ける)
export const BUDGET_TOLERANCE_RATIO = 0.2;

export interface BudgetConstraint {
  maxYen: number; // これ以下なら match
  toleranceYen: number; // maxYen + toleranceYen を超えて初めて mismatch
}

// あいまいな「安い」系の語 (上限金額を伴わない場合に使う)
const VAGUE_CHEAP_PATTERN =
  /安い|安め|お手頃|手頃|リーズナブル|格安|激安|コスパ/;

function toHalfWidthDigits(text: string): string {
  return text.normalize("NFKC").replace(
    /[０-９]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

// 予算 requirement の文面 → 上限金額の正規化。
// 上限が読み取れない場合 (下限指定のみ・金額もあいまい語も無い) は null。
export function normalizeBudgetRequirement(
  text: string,
): BudgetConstraint | null {
  const t = toHalfWidthDigits(text).replace(/[,，\s]/g, "");
  const prefix = "(?:(?:希望)?予算(?:は|:)?|一人|1人)?";
  // 文全体が明示rangeである場合だけ後ろの金額を上限とみなす。
  const range = t.match(
    new RegExp(
      `^${prefix}([0-9]+(?:\\.[0-9]+)?)(万)?円?(?:[〜~～-]|から)([0-9]+(?:\\.[0-9]+)?)(万)?円(?:まで)?(?:を希望)?$`,
    ),
  );
  if (range) {
    const lower = Math.round(parseFloat(range[1]) * (range[2] ? 10000 : 1));
    const upper = Math.round(parseFloat(range[3]) * (range[4] ? 10000 : 1));
    if (Number.isFinite(upper) && upper > 0) {
      if (!Number.isFinite(lower) || lower <= 0 || lower > upper) return null;
      return { maxYen: upper, toleranceYen: 0 };
    }
  }

  const amountMatch = t.match(
    new RegExp(
      `^${prefix}([0-9]+(?:\\.[0-9]+)?)(万)?円(以内|以下|まで|未満|以上|前後|くらい|程度)?(?:を希望)?$`,
    ),
  );
  const amountWithContext = amountMatch ?? t.match(
    new RegExp(
      `^${prefix}([0-9]+(?:\\.[0-9]+)?)(万)?円(以内|以下|まで|未満|以上|前後|くらい|程度)?で$`,
    ),
  );
  if (amountWithContext) {
    const amount = Math.round(
      parseFloat(amountWithContext[1]) * (amountWithContext[2] ? 10000 : 1),
    );
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const operator = amountWithContext[3];
    if (operator === "以上") return null; // 下限指定のみは本モジュールの対象外
    if (operator === "未満") {
      return { maxYen: amount - 1, toleranceYen: 0 };
    }
    if (operator === "以内" || operator === "以下" || operator === "まで") {
      return { maxYen: amount, toleranceYen: 0 };
    }
    return {
      maxYen: amount,
      toleranceYen: Math.round(amount * BUDGET_TOLERANCE_RATIO),
    };
  }

  if (
    new RegExp(
      `^(?:${VAGUE_CHEAP_PATTERN.source})(?:な)?(?:価格帯|店|お店|ところ)?$`,
    ).test(t)
  ) {
    return {
      maxYen: VAGUE_CHEAP_MAX_YEN,
      toleranceYen: Math.round(VAGUE_CHEAP_MAX_YEN * BUDGET_TOLERANCE_RATIO),
    };
  }
  return null;
}

// budget_dinner claim ({min,max} 円) と予算上限の決定論比較。
// - claim 全体が上限以下 (ちょうど上限を含む) → match
// - claim の下限すら 上限+許容幅 を超える → mismatch
// - それ以外 (上限をまたぐ) → partial
export function compareBudget(
  constraint: BudgetConstraint,
  range: { min: number; max: number },
): Extract<MatchState, "match" | "partial" | "mismatch"> {
  if (range.max <= constraint.maxYen) return "match";
  if (range.min > constraint.maxYen + constraint.toleranceYen) {
    return "mismatch";
  }
  return "partial";
}

// ============================================================
// 時間帯要件の正規化 (§11 kind=time)
// ============================================================

export interface TimeWindow {
  startMinute: number; // 0..2880。明示的な「翌日」表記にも対応
  endMinute: number; // startMinute より大きい。深夜越えは 1440 を超える
  label: string; // 説明文用
}

// キーワード → 時間帯の対応 (上から順に評価。「深夜」は「夜」を含むため先に置く)。
const TIME_WINDOWS: ReadonlyArray<{ pattern: RegExp; window: TimeWindow }> = [
  {
    pattern: /深夜|夜中/,
    window: { startMinute: 23 * 60, endMinute: 29 * 60, label: "深夜" },
  },
  {
    pattern: /モーニング|朝食|朝ご飯|朝ごはん|朝/,
    window: { startMinute: 6 * 60, endMinute: 10 * 60, label: "朝" },
  },
  {
    pattern: /ランチ|昼食|昼ご飯|昼ごはん|お昼|昼/,
    window: { startMinute: 11 * 60, endMinute: 14 * 60, label: "昼" },
  },
  {
    pattern: /夕方/,
    window: { startMinute: 16 * 60, endMinute: 18 * 60, label: "夕方" },
  },
  {
    pattern: /ディナー|夕食|晩ご飯|晩ごはん|夜/,
    window: { startMinute: 18 * 60, endMinute: 22 * 60, label: "夜" },
  },
];

// opening_hours claim は曜日別の情報を保持しないため、曜日指定を含む要件は
// generic な営業時間へ決め打ちせず unknown に倒す。closed_days が別 claim に
// あっても、曜日別の opening_hours と組み合わせる実装は本 Issue の対象外とする。
const WEEKDAY_QUALIFIER_PATTERN =
  /平日|週末|土日|毎日|毎週|休日|祝日|(?:月|火|水|木|金|土|日)(?:曜(?:日)?|[〜~～-](?:月|火|水|木|金|土|日))/;

function canonicalTimeRequirementText(text: string): string {
  return text.normalize("NFKC").trim().replaceAll(/\s+/g, "");
}

interface ClockValue {
  minute: number;
  nextDay: boolean;
}

// 明示時刻の片側を分へ変換する。単独時刻は滞在時間が不明なため、範囲側でのみ採用する。
function parseClockToken(token: string): ClockValue | null {
  const match = token.match(
    /^(翌)?(?:(午前|午後))?(\d{1,2})(?:(?::(\d{2}))|時(?:(?:(\d{1,2})分)|半)?)$/,
  );
  if (!match) return null;

  let hour = Number(match[3]);
  const minute = match[4] !== undefined
    ? Number(match[4])
    : match[5] !== undefined
    ? Number(match[5])
    : match[0].endsWith("半")
    ? 30
    : 0;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  const meridiem = match[2];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "午前") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 24 || (hour === 24 && minute !== 0)) {
    return null;
  }
  return {
    minute: hour * 60 + minute,
    nextDay: match[1] !== undefined,
  };
}

function formatClockMinute(minute: number): string {
  const nextDay = minute >= 24 * 60 ? "翌" : "";
  const withinDay = ((minute % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(withinDay / 60);
  const mins = withinDay % 60;
  return `${nextDay}${String(hour).padStart(2, "0")}:${
    String(mins).padStart(2, "0")
  }`;
}

function stripTimeRequirementDecorations(text: string): string {
  return text
    .replace(/(?:がいい|が希望|に行きたい|を希望|希望です|希望)$/, "")
    .replace(
      /^(?:希望時間帯|希望時間|時間帯|営業時間|営業|利用時間)(?:は|が|:)?/,
      "",
    )
    .replace(
      /(?:の時間帯)?(?:に)?(?:営業(?:している|する)?|やって(?:いる|る)|開いて(?:いる|る)|利用(?:したい|できる))$/,
      "",
    )
    .replace(/(?:の時間帯)$/, "");
}

function parseExplicitTimeWindow(text: string): TimeWindow | null {
  const stripped = stripTimeRequirementDecorations(text);
  const range = stripped.match(/^(.+?)(?:から|[-−‐‑‒–—〜～~])(.+?)(?:まで)?$/);
  if (!range) return null;
  const start = parseClockToken(range[1]);
  const finish = parseClockToken(range[2].replace(/まで$/, ""));
  if (!start || !finish) return null;

  const startMinute = start.minute + (start.nextDay ? 24 * 60 : 0);
  let endMinute = finish.minute + (finish.nextDay ? 24 * 60 : 0);
  if (endMinute === startMinute && !finish.nextDay) return null;
  // 「22時〜2時」のような明示範囲は翌日へ跨る。24時間以上の範囲は
  // 店舗営業時間として意味が曖昧なので採用しない。
  if (endMinute <= startMinute) endMinute += 24 * 60;
  if (
    endMinute <= startMinute ||
    endMinute - startMinute > 24 * 60
  ) return null;
  return {
    startMinute,
    endMinute,
    label: `${formatClockMinute(startMinute)}〜${formatClockMinute(endMinute)}`,
  };
}

export function normalizeTimeRequirement(text: string): TimeWindow | null {
  const normalized = canonicalTimeRequirementText(text);
  if (WEEKDAY_QUALIFIER_PATTERN.test(normalized)) return null;
  const keywordText = normalized.replace(
    /(?:がいい|が希望|に行きたい|を希望|希望です|希望)$/,
    "",
  );
  const accepted = [
    {
      pattern:
        /^(?:深夜|夜中)(?:の時間帯)?(?:に)?(?:まで)?(?:営業(?:している)?|やって(?:いる|る)(?:ところ)?|利用(?:したい|できる))?$/,
      window: TIME_WINDOWS[0].window,
    },
    {
      pattern:
        /^(?:モーニング|朝食|朝ご飯|朝ごはん|朝)(?:の時間帯)?(?:に)?(?:営業(?:している)?|やって(?:いる|る)(?:ところ)?|利用(?:したい|できる))?$/,
      window: TIME_WINDOWS[1].window,
    },
    {
      pattern:
        /^(?:ランチ|昼食|昼ご飯|昼ごはん|お昼|昼)(?:の時間帯)?(?:に)?(?:営業(?:している)?|利用(?:したい|できる)?)?$/,
      window: TIME_WINDOWS[2].window,
    },
    {
      pattern:
        /^(?:夕方)(?:の時間帯)?(?:に)?(?:営業(?:している)?|利用(?:したい|できる))?$/,
      window: TIME_WINDOWS[3].window,
    },
    {
      pattern:
        /^(?:ディナー|夕食|晩ご飯|晩ごはん|夜ごはん|夜)(?:の時間帯)?(?:に)?(?:営業(?:している)?|利用(?:したい|できる))?$/,
      window: TIME_WINDOWS[4].window,
    },
  ];
  const matched = accepted.filter(({ pattern }) => pattern.test(keywordText));
  if (matched.length === 1) return matched[0].window;
  return parseExplicitTimeWindow(normalized);
}

// 「利用できる」とみなす営業時間と時間帯の最小重なり (分)。
// 1 時間以上重ならない場合は match にしない (入店してすぐ閉店になる) ための保守的な閾値
export const TIME_MATCH_MIN_OVERLAP_MINUTES = 60;

// "H:MM-H:MM" (§13 opening_hours 形式) → 分。深夜越え (close <= open) は +24h
export function parseOpeningHours(
  value: string,
): { open: number; close: number } | null {
  return parseOpeningHoursValue(value);
}

// 時間帯要件と opening_hours claim の決定論比較。
// opening_hours claim は最初の営業時間帯のみの正規化 (§13) のため、
// 「開店時刻より前の時間帯」だけ mismatch と断定できる (営業時間は時系列順に列挙され、
// 最初の開店時刻より前の営業は無い)。閉店後の時間帯は後続営業帯の取りこぼしがあり得るため
// 断定せず null (従来どおり AI 評価) に倒す。深夜跨ぎも日付が一意でないため同様に保留する。
export function compareTimeWindow(
  window: TimeWindow,
  openingHours: string,
): Extract<MatchState, "match" | "partial" | "mismatch"> | null {
  const parsed = parseOpeningHours(openingHours);
  if (!parsed) return null;
  let best = Number.NEGATIVE_INFINITY;
  // 要件側・claim側のどちらが日付境界を跨いでも同じ日へ揃えられるよう、
  // 前後1日のシフトを比較する。これにより「0:00〜2:00」対「22:00〜2:00」も
  // 取りこぼさず、深夜跨ぎを同日営業時間と誤認しない。
  for (const windowShift of [-24 * 60, 0, 24 * 60]) {
    for (const openingShift of [-24 * 60, 0, 24 * 60]) {
      const overlap = Math.min(
        window.endMinute + windowShift,
        parsed.close + openingShift,
      ) - Math.max(
        window.startMinute + windowShift,
        parsed.open + openingShift,
      );
      best = Math.max(best, overlap);
    }
  }
  if (best >= TIME_MATCH_MIN_OVERLAP_MINUTES) return "match";
  if (best > 0) return "partial";
  // 深夜跨ぎ・24:00始まりの claim は、最初の帯の閉店後か別日の帯かを
  // 1本の claim だけでは区別できないため、mismatch を断定しない。
  if (parsed.close > 24 * 60 || parsed.open >= 24 * 60) return null;
  if (window.endMinute <= parsed.open) return "mismatch";
  return null;
}

// ============================================================
// requirement 単位の決定論評価 (pipeline.ts が AI 評価へ上書きする)
// ============================================================

// 突合に使う claim と、その根拠 Evidence id (§12: evidenceIds を必ず紐付ける)
export interface ClaimWithEvidence {
  key: ClaimKey | string;
  value: unknown;
  rawText: string;
  evidenceIds: string[];
}

export interface DeterministicEvaluation {
  state: MatchState;
  confidence: number;
  explanation: string;
  evidenceIds: string[];
}

// コード突合の confidence。構造化データ同士の決定論比較なので高めに置くが、
// 帯の近似・データ鮮度の不確かさが残るため 1.0 にはしない。
// partial は「またぎ」の程度が読めないため中間値
const CODE_MATCH_CONFIDENCE: Record<
  Extract<MatchState, "match" | "partial" | "mismatch">,
  number
> = {
  match: 0.9,
  partial: 0.6,
  mismatch: 0.9,
};

function isBudgetRange(value: unknown): value is { min: number; max: number } {
  const v = value as { min?: unknown; max?: unknown } | null;
  return typeof v?.min === "number" && typeof v?.max === "number" &&
    v.min >= 0 && v.max >= v.min;
}

function claimsContainConflict(claims: ClaimWithEvidence[]): boolean {
  return claims.some((claim, index) =>
    claims.slice(index + 1).some((other) =>
      claim.key === other.key &&
      claimValuesConflict(claim.key as ClaimKey, claim.value, other.value)
    )
  );
}

type ComparableBudgetIntent =
  | { type: "explicit"; requirement: BudgetRequirement }
  | { type: "vague"; constraint: BudgetConstraint };

function comparableBudgetIntent(
  originalText: string,
  normalizedText: string,
): ComparableBudgetIntent | null {
  const originalExplicit = parseBudgetRequirement(originalText);
  const normalizedExplicit = parseBudgetRequirement(normalizedText);
  if (originalExplicit && normalizedExplicit) {
    return JSON.stringify(originalExplicit) ===
        JSON.stringify(normalizedExplicit)
      ? { type: "explicit", requirement: normalizedExplicit }
      : null;
  }
  if (originalExplicit || normalizedExplicit) return null;
  const originalVague = normalizeBudgetRequirement(originalText);
  const normalizedVague = normalizeBudgetRequirement(normalizedText);
  return originalVague && normalizedVague &&
      originalVague.maxYen === normalizedVague.maxYen &&
      originalVague.toleranceYen === normalizedVague.toleranceYen
    ? { type: "vague", constraint: normalizedVague }
    : null;
}

function budgetIntentLabel(intent: ComparableBudgetIntent): string {
  if (intent.type === "vague") return `目安上限${intent.constraint.maxYen}円`;
  const value = intent.requirement;
  if (value.operator === "range") return `${value.min}〜${value.max}円`;
  if (value.operator === "max_strict") return `${value.amount}円未満`;
  if (value.operator === "min_inclusive") return `${value.amount}円以上`;
  if (value.operator === "around") return `${value.amount}円前後`;
  return `上限${value.amount}円`;
}

function evaluateBudgetRequirement(
  intent: ComparableBudgetIntent,
  claims: ClaimWithEvidence[],
): DeterministicEvaluation | null {
  const usable = claims.filter((c) =>
    c.key === "budget_dinner" && isBudgetRange(c.value) &&
    c.evidenceIds.length > 0
  );
  if (usable.length === 0) return null;

  const judged = usable.map((c) => ({
    claim: c,
    state: intent.type === "explicit"
      ? compareBudgetRequirement(
        intent.requirement,
        c.value as { min: number; max: number },
      )
      : compareBudget(
        intent.constraint,
        c.value as { min: number; max: number },
      ),
  }));
  const evidenceIds = [
    ...new Set(judged.flatMap((j) => j.claim.evidenceIds)),
  ].sort();
  if (claimsContainConflict(usable)) {
    return {
      state: "partial",
      confidence: CODE_MATCH_CONFIDENCE.partial,
      explanation: "情報源の夕食予算帯が矛盾するため、部分適合として扱います",
      evidenceIds,
    };
  }
  const states = new Set(judged.map((j) => j.state));
  const limit = budgetIntentLabel(intent);
  if (states.size > 1) {
    // claim 同士が食い違う場合は断定しない (§15 は別途矛盾として表示する)
    return {
      state: "partial",
      confidence: CODE_MATCH_CONFIDENCE.partial,
      explanation:
        `情報源によって価格帯が食い違うため、予算条件 (${limit}) は部分適合として扱います`,
      evidenceIds,
    };
  }
  const state = judged[0].state;
  const ranges = [
    ...new Set(judged.map(({ claim }) => {
      const value = claim.value as { min: number; max: number };
      return `${value.min}〜${value.max}円`;
    })),
  ].sort();
  const observed = ranges.join(" / ");
  const explanation = state === "match"
    ? `店舗情報の夕食予算帯 (${observed}) が予算条件 (${limit}) の範囲内です`
    : state === "mismatch"
    ? intent.type === "vague"
      ? `店舗情報の夕食予算帯 (${observed}) が予算条件 (${limit}) を上回ります`
      : `店舗情報の夕食予算帯 (${observed}) が予算条件 (${limit}) と一致しません`
    : `店舗情報の夕食予算帯 (${observed}) が予算条件 (${limit}) をまたぐため部分適合です`;
  return {
    state,
    confidence: CODE_MATCH_CONFIDENCE[state],
    explanation,
    evidenceIds,
  };
}

function evaluateTimeRequirement(
  window: TimeWindow,
  claims: ClaimWithEvidence[],
): DeterministicEvaluation | null {
  const judged: Array<{
    claim: ClaimWithEvidence;
    state: Extract<MatchState, "match" | "partial" | "mismatch">;
  }> = [];
  for (const claim of claims) {
    if (claim.key !== "opening_hours" || typeof claim.value !== "string") {
      continue;
    }
    if (claim.evidenceIds.length === 0) continue;
    const state = compareTimeWindow(window, claim.value);
    if (state !== null) judged.push({ claim, state });
  }
  if (judged.length === 0) return null;

  const evidenceIds = [
    ...new Set(judged.flatMap((j) => j.claim.evidenceIds)),
  ].sort();
  if (claimsContainConflict(judged.map(({ claim }) => claim))) {
    return {
      state: "partial",
      confidence: CODE_MATCH_CONFIDENCE.partial,
      explanation: "情報源の営業時間が矛盾するため、部分適合として扱います",
      evidenceIds,
    };
  }
  const states = new Set(judged.map((j) => j.state));
  if (states.size > 1) {
    return {
      state: "partial",
      confidence: CODE_MATCH_CONFIDENCE.partial,
      explanation:
        `情報源によって営業時間が食い違うため、「${window.label}」の時間帯は部分適合として扱います`,
      evidenceIds,
    };
  }
  const state = judged[0].state;
  const hours = [
    ...new Set(
      judged.map(({ claim }) => String(claim.value).replace("-", "〜")),
    ),
  ].sort().join(" / ");
  const explanation = state === "match"
    ? `営業時間 ${hours} が「${window.label}」の時間帯と重なるため適合です`
    : state === "mismatch"
    ? `営業時間 ${hours} は「${window.label}」の時間帯と重ならないため不適合です`
    : `営業時間 ${hours} は「${window.label}」の時間帯と一部しか重ならないため部分適合です`;
  return {
    state,
    confidence: CODE_MATCH_CONFIDENCE[state],
    explanation,
    evidenceIds,
  };
}

function normalizeSimpleIntent(text: string): string | null {
  const normalized = text.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length === 0 || normalized.length > 40 ||
    /(?:ではない|以外|除く|避け|not|except|without)/i.test(normalized)
  ) return null;
  return normalized.replaceAll(/\s+/g, "");
}

function consistentSimpleIntent(
  originalText: string,
  normalizedText: string,
): string | null {
  // model が捏造した normalizedText 単独では決定論評価しない。
  const original = normalizeSimpleIntent(originalText);
  const normalized = normalizeSimpleIntent(normalizedText);
  return original && normalized && original === normalized ? normalized : null;
}

interface CuisineIntent {
  /** 判定に使う requirement 側の表記 (正規化済み) */
  readonly term: string;
  readonly japanese: boolean;
  /** 翻訳同値クラス。決められない語は null (従来どおり部分一致のみ) */
  readonly classId: number | null;
}

// 英語入力では text が英語 span、normalizedText が日本語訳になる (#514)。
// AI の翻訳をそのまま信じず、両者が lexicon の同じ同値クラスに落ちることを確認して
// 初めて言語横断の判定を許す。別クラス (sushi → 焼肉 等の捏造) は従来どおり unknown。
function cuisineRequirementIntent(
  originalText: string,
  normalizedText: string,
): CuisineIntent | null {
  const identical = consistentSimpleIntent(originalText, normalizedText);
  if (identical) {
    return {
      term: identical,
      japanese: isJapaneseCuisineText(identical),
      classId: cuisineEquivalenceClass(identical),
    };
  }
  const original = normalizeSimpleIntent(originalText);
  const normalized = normalizeSimpleIntent(normalizedText);
  if (!original || !normalized) return null;
  const originalClass = cuisineEquivalenceClass(original);
  const normalizedClass = cuisineEquivalenceClass(normalized);
  if (originalClass === null || originalClass !== normalizedClass) return null;
  // 翻訳同値が取れた場合は、日本語側の表記を判定に使う (claim は日本語が主)
  const japaneseTerm = isJapaneseCuisineText(normalized)
    ? normalized
    : original;
  return {
    term: japaneseTerm,
    japanese: isJapaneseCuisineText(japaneseTerm),
    classId: originalClass,
  };
}

// requirement と claim の言語が違う場合だけ lexicon の翻訳同値を使う (#514)。
// 同一言語では従来どおり部分一致のみ。AI の normalizedText を根拠にはせず、
// text / normalizedText が同じ同値クラスに入ることを呼び出し側で確認済み。
function genreMatchesCuisine(
  intent: CuisineIntent,
  genre: string,
): boolean {
  const value = genre.normalize("NFKC").toLowerCase().replaceAll(/\s+/g, "");
  if (value.includes(intent.term)) return true;
  if (intent.classId === null) return false;
  if (isJapaneseCuisineText(value) === intent.japanese) return false;
  return cuisineClassMatchesGenre(intent.classId, value);
}

function evaluateCuisineRequirement(
  cuisine: CuisineIntent,
  claims: ClaimWithEvidence[],
): DeterministicEvaluation | null {
  const supporting = claims.filter((claim) =>
    claim.key === "genre" && claim.evidenceIds.length > 0 &&
    Array.isArray(claim.value) &&
    claim.value.some((genre) =>
      typeof genre === "string" && genreMatchesCuisine(cuisine, genre)
    )
  );
  if (supporting.length === 0) return null;
  return {
    state: "match",
    confidence: CODE_MATCH_CONFIDENCE.match,
    explanation: "店舗情報のジャンルが料理条件と一致します",
    evidenceIds: [...new Set(supporting.flatMap((claim) => claim.evidenceIds))]
      .sort(),
  };
}

function evaluateLocationRequirement(
  location: string,
  claims: ClaimWithEvidence[],
): DeterministicEvaluation | null {
  const supporting = claims.filter((claim) =>
    claim.key === "place_address" && claim.evidenceIds.length > 0 &&
    typeof claim.value === "string" &&
    claim.value.normalize("NFKC").toLowerCase().replaceAll(/\s+/g, "")
      .includes(location)
  );
  if (supporting.length === 0) return null;
  return {
    state: "match",
    confidence: CODE_MATCH_CONFIDENCE.match,
    explanation: "店舗情報の住所がエリア条件と一致します",
    evidenceIds: [...new Set(supporting.flatMap((claim) => claim.evidenceIds))]
      .sort(),
  };
}

// requirement 群と claim 群から、コード突合で判定できた requirement のみを返す。
// 返らなかった requirement は従来どおり AI 評価のまま (呼び出し側は上書きしない)
export function deterministicEvaluations(
  requirements: Array<{
    id: string;
    kind: string;
    normalizedText: string;
    originalText: string;
  }>,
  claims: ClaimWithEvidence[],
): Map<string, DeterministicEvaluation> {
  const out = new Map<string, DeterministicEvaluation>();
  if (claims.length === 0) return out;
  for (const req of requirements) {
    const budgetIntent = req.kind === "budget"
      ? comparableBudgetIntent(req.originalText, req.normalizedText)
      : null;
    const normalizedTime = req.kind === "time"
      ? normalizeTimeRequirement(req.normalizedText)
      : null;
    const originalTime = req.kind === "time"
      ? normalizeTimeRequirement(req.originalText)
      : null;
    const cuisineIntent = req.kind === "cuisine"
      ? cuisineRequirementIntent(req.originalText, req.normalizedText)
      : null;
    const locationIntent = req.kind === "location"
      ? consistentSimpleIntent(req.originalText, req.normalizedText)
      : null;
    const det = budgetIntent
      ? evaluateBudgetRequirement(budgetIntent, claims)
      : normalizedTime && originalTime &&
          normalizedTime.startMinute === originalTime.startMinute &&
          normalizedTime.endMinute === originalTime.endMinute
      ? evaluateTimeRequirement(normalizedTime, claims)
      : cuisineIntent
      ? evaluateCuisineRequirement(cuisineIntent, claims)
      : locationIntent
      ? evaluateLocationRequirement(locationIntent, claims)
      : null;
    if (det) out.set(req.id, det);
  }
  return out;
}
