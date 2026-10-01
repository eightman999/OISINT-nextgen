import { assertEquals } from "@std/assert";
import {
  cuisineClassMatchesGenre,
  cuisineEquivalenceClass,
  cuisineRecallTerms,
} from "../functions/_shared/cuisine_lexicon.ts";
import {
  type ClaimWithEvidence,
  deterministicEvaluations,
} from "../functions/_shared/requirement_matching.ts";

const EVIDENCE_ID = "evidence-1";

function genreClaims(...values: string[]): ClaimWithEvidence[] {
  return [{
    key: "genre",
    value: values,
    rawText: `ジャンル: ${values.join(" / ")}`,
    evidenceIds: [EVIDENCE_ID],
  }];
}

function cuisineState(
  originalText: string,
  normalizedText: string,
  ...genres: string[]
): string | undefined {
  return deterministicEvaluations(
    [{ id: "r1", kind: "cuisine", originalText, normalizedText }],
    genreClaims(...genres),
  ).get("r1")?.state;
}

Deno.test("cuisine lexicon: 同値クラスは言語をまたいで一致する", () => {
  assertEquals(
    cuisineEquivalenceClass("Yakiniku"),
    cuisineEquivalenceClass("焼肉"),
  );
  assertEquals(
    cuisineEquivalenceClass("sushi"),
    cuisineEquivalenceClass("寿司"),
  );
});

Deno.test("cuisine lexicon: 別クラス・複数クラス・未収録語は null", () => {
  // 複数クラスに跨る語はどちらの意図か決められない
  assertEquals(cuisineEquivalenceClass("韓国焼肉"), null);
  assertEquals(cuisineEquivalenceClass("sushi and ramen"), null);
  // 台帳に無い語は推測で補完しない
  assertEquals(cuisineEquivalenceClass("スペイン料理"), null);
  assertEquals(cuisineEquivalenceClass("paella"), null);
});

Deno.test("cuisine lexicon: 英語は語単位一致で bar が barbecue を拾わない", () => {
  assertEquals(
    cuisineClassMatchesGenre(cuisineEquivalenceClass("bar")!, "barbecue"),
    false,
  );
  assertEquals(
    cuisineClassMatchesGenre(cuisineEquivalenceClass("cafe")!, "coffee_shop"),
    true,
  );
});

Deno.test("cuisine lexicon: 探索用の拡張語は同値語を含む", () => {
  assertEquals(cuisineRecallTerms("焼肉"), [
    "yakiniku",
    "barbecue",
    "korean",
  ]);
  assertEquals(cuisineRecallTerms("スペイン料理"), []);
});

Deno.test("#514: 英語 requirement は翻訳同値が取れた場合だけ match する", () => {
  assertEquals(cuisineState("Yakiniku", "焼肉", "焼肉・ホルモン"), "match");
  // AI が別クラスへ翻訳 (捏造) した場合は決定論評価しない
  assertEquals(cuisineState("sushi", "焼肉", "焼肉・ホルモン"), undefined);
  // 台帳に無い語は従来どおり AI 評価へ委ねる
  assertEquals(cuisineState("paella", "パエリア", "スペイン料理"), undefined);
  // 否定・除外表現は同値以前に決定論評価しない
  assertEquals(cuisineState("not sushi", "寿司以外", "寿司"), undefined);
});

Deno.test("#514: 同一言語では従来どおり部分一致のみで判定する", () => {
  // 日本語同士: クラス内の別表記へは広げない (パスタ ≠ イタリアン)
  assertEquals(cuisineState("パスタ", "パスタ", "イタリアン"), undefined);
  assertEquals(cuisineState("パスタ", "パスタ", "パスタ・ピザ"), "match");
  // 日本語 requirement × 英語 claim は翻訳同値のみ (拡張語 barbecue では match しない)
  assertEquals(cuisineState("焼肉", "焼肉", "yakiniku"), "match");
  assertEquals(cuisineState("焼肉", "焼肉", "barbecue"), undefined);
});

Deno.test("#514: Evidence の無い claim では match しない", () => {
  const evaluations = deterministicEvaluations(
    [{
      id: "r1",
      kind: "cuisine",
      originalText: "Yakiniku",
      normalizedText: "焼肉",
    }],
    [{
      key: "genre",
      value: ["焼肉・ホルモン"],
      rawText: "ジャンル: 焼肉・ホルモン",
      evidenceIds: [],
    }],
  );
  assertEquals(evaluations.get("r1"), undefined);
});
