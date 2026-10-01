// Gemini へ渡すページ本文の requirement 連動抽出 (トークン削減。2026-08-15 実測 86K tok/調査 対策)
// - キーワード窓抽出: requirement の kind に対応するキーワード周辺 ±WINDOW_RADIUS 字だけを渡す
// - ヒット 0 件は先頭 FALLBACK_HEAD_CHARS 字にフォールバック (取り逃し防止)
// - 抽出結果はタグ除去済み本文の部分文字列のみ (§5.4: 実 fetch 本文以外を根拠にしない)
import type { StructuredClaim } from "../types.ts";

const WINDOW_RADIUS = 150;
const HEAD_CHARS = 200; // ページ冒頭 (店名・概要) は常に含めて店舗の取り違えを防ぐ
const MAX_EXCERPT_CHARS = 1_500; // 1 ページあたり Gemini へ渡す上限 (旧: 4,000 全文)
const FALLBACK_HEAD_CHARS = 2_000;
const MAX_HITS_PER_KEYWORD = 5; // 「円」「駅」等の頻出語で窓が偏らないようにする

// RequirementKind → ページ本文中の関連キーワード (§11 の kind に対応)
const KIND_KEYWORDS: Record<string, string[]> = {
  time: [
    "営業時間",
    "定休日",
    "開店",
    "閉店",
    "ラストオーダー",
    "L.O",
    "休業",
    "営業",
  ],
  budget: ["予算", "料金", "価格", "コース", "飲み放題", "会計", "平均", "円"],
  payment: [
    "カード",
    "クレジット",
    "支払",
    "決済",
    "PayPay",
    "電子マネー",
    "現金",
    "QR",
  ],
  reservation: ["予約", "個室", "貸切", "当日", "ネット予約"],
  party_size: ["人数", "名様", "個室", "収容", "宴会", "団体", "席"],
  atmosphere: [
    "雰囲気",
    "静か",
    "賑やか",
    "落ち着",
    "デート",
    "おしゃれ",
    "口コミ",
  ],
  cuisine: ["メニュー", "料理", "名物", "おすすめ", "ジャンル"],
  dietary: ["アレルギー", "ベジタリアン", "ヴィーガン", "ハラル", "メニュー"],
  access: ["駅", "徒歩", "アクセス", "地図"],
  location: ["住所", "駅", "徒歩", "アクセス"],
  other: [],
};

export function keywordsForKinds(kinds: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const kind of kinds) {
    for (const kw of KIND_KEYWORDS[kind] ?? []) set.add(kw);
  }
  return [...set];
}

// 本文からキーワード周辺の窓を抽出して結合する。窓は重複をマージし、原文の出現順を保つ。
export function extractRelevantText(text: string, keywords: string[]): string {
  if (text.length <= MAX_EXCERPT_CHARS) return text;

  const ranges: Array<[number, number]> = [[0, HEAD_CHARS]];
  for (const kw of keywords) {
    let from = 0;
    for (let hit = 0; hit < MAX_HITS_PER_KEYWORD; hit++) {
      const i = text.indexOf(kw, from);
      if (i < 0) break;
      ranges.push([
        Math.max(0, i - WINDOW_RADIUS),
        Math.min(text.length, i + kw.length + WINDOW_RADIUS),
      ]);
      from = i + kw.length;
    }
  }
  // キーワードヒットなし: 先頭にフォールバック (§12: 根拠を失って全 unknown 化するのを防ぐ)
  if (ranges.length === 1) return text.slice(0, FALLBACK_HEAD_CHARS);

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  let out = "";
  for (const [s, e] of merged) {
    const sep = out ? " … " : "";
    const budget = MAX_EXCERPT_CHARS - out.length - sep.length;
    if (budget <= 0) break;
    out += sep + text.slice(s, e).slice(0, budget);
  }
  return out;
}

const MAX_KNOWN_CLAIMS = 12;
const MAX_RAW_TEXT_CHARS = 40;

// prompt へ渡す knownClaims の圧縮。
// 同一 key+value の完全重複のみ除去する (食い違う値は両方残す §15)。rawText は切り詰める。
// DB 上の Evidence は変更しない (prompt 入力の圧縮のみ)。
export function compactKnownClaims(
  claims: StructuredClaim[],
): StructuredClaim[] {
  const seen = new Set<string>();
  const out: StructuredClaim[] = [];
  for (const c of claims) {
    const dedupeKey = `${c.key}:${JSON.stringify(c.value) ?? "undefined"}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ ...c, rawText: (c.rawText ?? "").slice(0, MAX_RAW_TEXT_CHARS) });
    if (out.length >= MAX_KNOWN_CLAIMS) break;
  }
  return out;
}
