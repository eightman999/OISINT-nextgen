// ページ本文の requirement 連動抽出と knownClaims 圧縮のテスト (relevance.ts)
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compactKnownClaims,
  extractRelevantText,
  keywordsForKinds,
} from "../functions/_shared/providers/relevance.ts";
import type { StructuredClaim } from "../functions/_shared/types.ts";

Deno.test("keywordsForKinds: kind に対応するキーワードを重複なく返す", () => {
  const kws = keywordsForKinds(["time", "payment", "time", "unknown_kind"]);
  assert(kws.includes("営業時間"));
  assert(kws.includes("クレジット"));
  assertEquals(new Set(kws).size, kws.length);
});

Deno.test("extractRelevantText: 上限以下の本文はそのまま返す", () => {
  const text = "短い本文です。営業時間 17:00〜23:00";
  assertEquals(extractRelevantText(text, ["営業時間"]), text);
});

Deno.test("extractRelevantText: キーワード周辺の窓を抽出し 1,500 字以下に収める", () => {
  const filler = "あ".repeat(2_000);
  const text = `${filler}営業時間 17:00〜23:00 定休日 月曜${filler}`;
  const out = extractRelevantText(text, keywordsForKinds(["time"]));
  assertStringIncludes(out, "営業時間 17:00〜23:00");
  assertStringIncludes(out, "定休日 月曜");
  assert(out.length <= 1_500, `抽出結果が上限超過: ${out.length}`);
});

Deno.test("extractRelevantText: 冒頭 (店名等) は常に含める", () => {
  const filler = "い".repeat(3_000);
  const text =
    `居酒屋テスト家 池袋店の紹介ページ。${filler}営業時間 17:00〜23:00${filler}`;
  const out = extractRelevantText(text, ["営業時間"]);
  assertStringIncludes(out, "居酒屋テスト家 池袋店");
});

Deno.test("extractRelevantText: ヒットなしは先頭 2,000 字フォールバック", () => {
  const text = "う".repeat(5_000);
  const out = extractRelevantText(text, ["営業時間", "クレジット"]);
  assertEquals(out.length, 2_000);
  assertEquals(out, text.slice(0, 2_000));
});

Deno.test("extractRelevantText: 重複する窓はマージされ本文が二重に出ない", () => {
  const filler = "え".repeat(2_000);
  const text = `${filler}営業時間は開店 17:00 閉店 23:00 です${filler}`;
  const out = extractRelevantText(text, keywordsForKinds(["time"]));
  assertEquals(out.split("開店 17:00").length - 1, 1);
});

Deno.test("compactKnownClaims: 同一 key+value を除去し、食い違う値は両方残す (§15)", () => {
  const claims: StructuredClaim[] = [
    { key: "card_accepted", value: true, rawText: "カード可" },
    { key: "card_accepted", value: true, rawText: "クレジットカード利用可能" },
    { key: "card_accepted", value: false, rawText: "現金のみ" },
  ];
  const out = compactKnownClaims(claims);
  assertEquals(out.length, 2);
  assertEquals(out[0].value, true);
  assertEquals(out[1].value, false);
});

Deno.test("compactKnownClaims: rawText を 40 字に切り詰め、12 件で打ち切る", () => {
  const claims: StructuredClaim[] = Array.from({ length: 20 }, (_, i) => ({
    key: "genre" as const,
    value: `ジャンル${i}`,
    rawText: "長".repeat(100),
  }));
  const out = compactKnownClaims(claims);
  assertEquals(out.length, 12);
  assert(out.every((c) => c.rawText.length <= 40));
});
