// guardEvaluation (pipeline.ts) の §30 / §5 / §12 Critical Rule 破棄ガードのユニットテスト。
// 対象: supabase/functions/_shared/pipeline.ts guardEvaluation (純関数・DB 非依存)
// spec.md §30: 捏造 evidence は採用しない / confidence 0..1 範囲外は clamp せず破棄して unknown。
// spec.md §5, §12: Evidence 0 件の finding は match にできない。
import { assertEquals } from "@std/assert";
import {
  type EvidenceClaimReference,
  guardEvaluation as guardEvaluationWithClaims,
} from "../functions/_shared/pipeline.ts";
import type { StructuredClaimInput } from "../functions/_shared/validation.ts";

const CITATIONS = new Set(["https://a.example/menu", "https://b.example/info"]);
const URL_TO_ID = new Map([
  ["https://a.example/menu", "ev-a"],
  ["https://b.example/info", "ev-b"],
]);
const CARD_CLAIM: StructuredClaimInput = {
  key: "card_accepted",
  value: true,
  rawText: "クレジットカード利用可能",
};

// 既存の citation/Evidence ID ガードケースは同じ入力形のまま維持しつつ、
// production と同じ finding claim / Evidence claim 検査を必ず通す。
function guardEvaluation(
  finding: {
    state: "match" | "partial" | "mismatch" | "unknown";
    confidence: number;
    sourceUrls: string[];
  },
  citationUrls: ReadonlySet<string>,
  urlToEvidenceId: ReadonlyMap<string, string>,
  options: {
    requirementId?: string;
    requirementKind?: string;
    originalText?: string;
    normalizedText?: string;
    sourceAttested?: boolean;
    findingClaims?: StructuredClaimInput[];
    storedClaimsByUrl?: ReadonlyMap<string, StructuredClaimInput[]>;
    neutralCitationUrls?: readonly string[];
  } = {},
) {
  const requirementId = options.requirementId ?? "req-1";
  const normalizedText = options.normalizedText ??
    "クレジットカード利用可能";
  const urlToEvidence = new Map(
    [...urlToEvidenceId].map(([url, id]) => [
      url,
      {
        id,
        scope: "shared" as const,
        investigationId: null,
        placeId: "place-1",
        sourceUrl: url,
        structuredClaims: options.storedClaimsByUrl?.get(url) ?? [CARD_CLAIM],
        excerpt: "neutral citation title",
        sourceQuality: finding.confidence,
      },
    ]),
  );
  const neutralByUrl = new Map<string, EvidenceClaimReference>();
  for (const url of options.neutralCitationUrls ?? []) {
    const ref = urlToEvidence.get(url);
    if (ref) neutralByUrl.set(url, { ...ref, structuredClaims: [] });
  }
  const out = guardEvaluationWithClaims(
    {
      ...finding,
      requirementId,
      explanation: "fixture explanation",
      claims: options.findingClaims ?? [CARD_CLAIM],
    },
    {
      kind: options.requirementKind ?? "payment",
      originalText: options.originalText ?? normalizedText,
      normalizedText,
      sourceAttested: options.sourceAttested ?? true,
    },
    citationUrls,
    {
      placeId: "place-1",
      sharedByUrl: urlToEvidence,
      neutralCitationByRequirement: new Map([[requirementId, neutralByUrl]]),
    },
  );
  const { explanation: _explanation, ...withoutExplanation } = out;
  return withoutExplanation;
}

Deno.test("guardEvaluation: 全 URL が実 citation → そのまま通過し evidenceIds が対応する", () => {
  const out = guardEvaluation(
    {
      state: "match",
      confidence: 0.9,
      sourceUrls: ["https://a.example/menu", "https://b.example/info"],
    },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(out, {
    state: "match",
    confidence: 0.9,
    evidenceIds: ["ev-a", "ev-b"],
  });
});

Deno.test("guardEvaluation: 実URLと捏造URLの混在は評価全体をunknownへ破棄する", () => {
  const out = guardEvaluation(
    {
      state: "match",
      confidence: 0.8,
      sourceUrls: ["https://a.example/menu", "https://fabricated.example/fake"],
    },
    CITATIONS,
    URL_TO_ID,
  );
  // 捏造URLだけを取り除いてmatchを維持する部分修復は禁止する。
  assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
});

Deno.test("guardEvaluation: 全 URL 捏造 + match → unknown / confidence 0 に破棄 (§12)", () => {
  const out = guardEvaluation(
    {
      state: "match",
      confidence: 0.95,
      sourceUrls: ["https://fabricated.example/fake"],
    },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
});

Deno.test("guardEvaluation: sourceUrls 空 + match → unknown / confidence 0", () => {
  const out = guardEvaluation(
    { state: "match", confidence: 1, sourceUrls: [] },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
});

Deno.test("guardEvaluation: matchの空・invalid・無関係claimはEvidence IDを借りずunknown", () => {
  const cases: Array<{
    name: string;
    claims: StructuredClaimInput[];
  }> = [
    { name: "empty", claims: [] },
    {
      name: "invalid",
      claims: [{
        key: "card_accepted",
        value: "利用可能",
        rawText: "カード利用可能",
      }],
    },
    {
      name: "unrelated",
      claims: [{ key: "reservation", value: true, rawText: "予約可能" }],
    },
  ];

  for (const testCase of cases) {
    const out = guardEvaluation(
      {
        state: "match",
        confidence: 0.9,
        sourceUrls: ["https://a.example/menu"],
      },
      CITATIONS,
      URL_TO_ID,
      { findingClaims: testCase.claims },
    );
    assertEquals(
      out,
      { state: "unknown", confidence: 0, evidenceIds: [] },
      testCase.name,
    );
  }
});

Deno.test("guardEvaluation: matchの対応claimがEvidence参照先に無ければunknown", () => {
  const storedClaimsByUrl = new Map<string, StructuredClaimInput[]>([
    ["https://a.example/menu", [{
      key: "reservation",
      value: true,
      rawText: "予約可能",
    }]],
  ]);
  const out = guardEvaluation(
    {
      state: "match",
      confidence: 0.9,
      sourceUrls: ["https://a.example/menu"],
    },
    CITATIONS,
    URL_TO_ID,
    { storedClaimsByUrl },
  );
  assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
});

Deno.test("guardEvaluation: matchの参照先に必要claimと相反claimが同居すればunknown", () => {
  const storedClaimsByUrl = new Map<string, StructuredClaimInput[]>([
    ["https://a.example/menu", [
      CARD_CLAIM,
      {
        key: "card_accepted",
        value: false,
        rawText: "クレジットカード利用不可",
      },
    ]],
  ]);
  const out = guardEvaluation(
    {
      state: "match",
      confidence: 0.9,
      sourceUrls: ["https://a.example/menu"],
    },
    CITATIONS,
    URL_TO_ID,
    { storedClaimsByUrl },
  );
  assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
});

Deno.test("guardEvaluation: reservation kindでも個室と席予約のclaimを交換しない", () => {
  const privateRoom = {
    key: "private_room" as const,
    value: true,
    rawText: "個室あり",
  };
  const reservation = {
    key: "reservation" as const,
    value: true,
    rawText: "予約可能",
  };
  for (
    const testCase of [
      {
        normalizedText: "予約可能",
        findingClaims: [privateRoom],
      },
      {
        normalizedText: "個室あり",
        findingClaims: [reservation],
      },
    ]
  ) {
    const out = guardEvaluation(
      {
        state: "match",
        confidence: 0.9,
        sourceUrls: ["https://a.example/menu"],
      },
      CITATIONS,
      URL_TO_ID,
      {
        requirementKind: "reservation",
        normalizedText: testCase.normalizedText,
        findingClaims: testCase.findingClaims,
      },
    );
    assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
  }
});

Deno.test("guardEvaluation: AI matchは実claimの厳密判定がpartial/mismatchなら置換する", () => {
  const cases: Array<{
    name: string;
    kind: string;
    text: string;
    claim: StructuredClaimInput;
    expectedState: "partial" | "mismatch";
  }> = [
    {
      name: "card false",
      kind: "payment",
      text: "クレジットカード利用可能",
      claim: {
        key: "card_accepted",
        value: false,
        rawText: "card_accepted=false",
      },
      expectedState: "mismatch",
    },
    {
      name: "reservation false",
      kind: "reservation",
      text: "予約可能",
      claim: {
        key: "reservation",
        value: false,
        rawText: "reservation=false",
      },
      expectedState: "mismatch",
    },
    {
      name: "budget outside",
      kind: "budget",
      text: "3000円以下",
      claim: {
        key: "budget_dinner",
        value: { min: 4000, max: 5000 },
        rawText: "budget_dinner={max:5000,min:4000}",
      },
      expectedState: "mismatch",
    },
    {
      name: "capacity enough is only partial",
      kind: "party_size",
      text: "50人で利用可能",
      claim: {
        key: "capacity",
        value: 80,
        rawText: "capacity=80",
      },
      expectedState: "partial",
    },
    {
      name: "capacity shortage",
      kind: "party_size",
      text: "50人で利用可能",
      claim: {
        key: "capacity",
        value: 20,
        rawText: "capacity=20",
      },
      expectedState: "mismatch",
    },
    {
      name: "non-smoking mismatch",
      kind: "atmosphere",
      text: "禁煙",
      claim: {
        key: "non_smoking",
        value: false,
        rawText: "smoking=yes",
      },
      expectedState: "mismatch",
    },
    {
      name: "wifi mismatch",
      kind: "other",
      text: "Wi-Fi",
      claim: {
        key: "wifi_available",
        value: false,
        rawText: "internet_access=no",
      },
      expectedState: "mismatch",
    },
    {
      name: "child-friendly mismatch",
      kind: "other",
      text: "子連れOK",
      claim: {
        key: "child_friendly",
        value: false,
        rawText: "子連れ非対応",
      },
      expectedState: "mismatch",
    },
    {
      name: "walk limit mismatch",
      kind: "access",
      text: "徒歩5分以内",
      claim: {
        key: "nearest_station_walk_minutes",
        value: 6,
        rawText: "最寄り駅から徒歩6分",
      },
      expectedState: "mismatch",
    },
  ];

  for (const testCase of cases) {
    const claims = new Map<string, StructuredClaimInput[]>([
      ["https://a.example/menu", [testCase.claim]],
    ]);
    const out = guardEvaluation(
      {
        state: "match",
        confidence: 0.9,
        sourceUrls: ["https://a.example/menu"],
      },
      CITATIONS,
      URL_TO_ID,
      {
        requirementKind: testCase.kind,
        normalizedText: testCase.text,
        findingClaims: [testCase.claim],
        storedClaimsByUrl: claims,
      },
    );
    assertEquals(out.state, testCase.expectedState, testCase.name);
    assertEquals(out.confidence, 0.9, testCase.name);
    assertEquals(out.evidenceIds, ["ev-a"], testCase.name);
  }
});

Deno.test("guardEvaluation: 原文の否定を正規化が落とした4 kindはstrict確定しない", () => {
  const cases: Array<{
    name: string;
    kind: string;
    originalText: string;
    normalizedText: string;
    claim: StructuredClaimInput;
  }> = [
    {
      name: "payment",
      kind: "payment",
      originalText: "カードは使いたくない",
      normalizedText: "クレジットカード利用可能",
      claim: CARD_CLAIM,
    },
    {
      name: "payment explicit inverse",
      kind: "payment",
      originalText: "クレジットカード利用不可",
      normalizedText: "クレジットカード利用可能",
      claim: CARD_CLAIM,
    },
    {
      name: "reservation",
      kind: "reservation",
      originalText: "予約したくない",
      normalizedText: "予約可能",
      claim: { key: "reservation", value: true, rawText: "予約可能" },
    },
    {
      name: "reservation explicit inverse",
      kind: "reservation",
      originalText: "予約不可",
      normalizedText: "予約可能",
      claim: { key: "reservation", value: true, rawText: "予約可能" },
    },
    {
      name: "party size",
      kind: "party_size",
      originalText: "4人では利用しない",
      normalizedText: "4人で利用可能",
      claim: { key: "capacity", value: 20, rawText: "総席数20席" },
    },
    {
      name: "budget",
      kind: "budget",
      originalText: "3000円以内は避けたい",
      normalizedText: "3000円以下",
      claim: {
        key: "budget_dinner",
        value: { min: 2000, max: 2800 },
        rawText: "夕食予算2000〜2800円",
      },
    },
    {
      name: "filter polarity",
      kind: "other",
      originalText: "Wi-Fiなし",
      normalizedText: "Wi-Fi",
      claim: {
        key: "wifi_available",
        value: true,
        rawText: "Wi-Fiあり",
      },
    },
  ];

  for (const testCase of cases) {
    const storedClaimsByUrl = new Map<string, StructuredClaimInput[]>([
      ["https://a.example/menu", [testCase.claim]],
    ]);
    const out = guardEvaluation(
      {
        state: "match",
        confidence: 0.9,
        sourceUrls: ["https://a.example/menu"],
      },
      CITATIONS,
      URL_TO_ID,
      {
        requirementKind: testCase.kind,
        originalText: testCase.originalText,
        normalizedText: testCase.normalizedText,
        findingClaims: [testCase.claim],
        storedClaimsByUrl,
      },
    );
    assertEquals(
      out,
      { state: "unknown", confidence: 0, evidenceIds: [] },
      testCase.name,
    );
  }
});

Deno.test("guardEvaluation: strict判定はmodelのconfidence/説明をEvidence品質/fact由来へ置き換える", () => {
  const falseCard: StructuredClaimInput = {
    key: "card_accepted",
    value: false,
    rawText: "クレジットカード利用不可",
  };
  const out = guardEvaluationWithClaims(
    {
      requirementId: "req-card",
      state: "match",
      confidence: 0.13,
      explanation: "modelはmatchと説明",
      sourceUrls: ["https://a.example/menu"],
      claims: [falseCard],
    },
    {
      kind: "payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      sourceAttested: true,
    },
    CITATIONS,
    {
      placeId: "place-1",
      sharedByUrl: new Map([[
        "https://a.example/menu",
        {
          id: "ev-strict",
          scope: "shared",
          investigationId: null,
          placeId: "place-1",
          sourceUrl: "https://a.example/menu",
          structuredClaims: [falseCard],
          excerpt: "クレジットカード利用不可",
          sourceQuality: 0.84,
        },
      ]]),
      neutralCitationByRequirement: new Map(),
    },
  );
  assertEquals(out.state, "mismatch");
  assertEquals(out.confidence, 0.84);
  assertEquals(out.evidenceIds, ["ev-strict"]);
  assertEquals(out.explanation.includes("条件と一致しません"), true);
  assertEquals(out.explanation.includes("modelはmatch"), false);
});

Deno.test("guardEvaluation: AI unknown/mismatchでもsupporting claimがあればstrict matchを採用する", () => {
  for (const modelState of ["unknown", "mismatch"] as const) {
    const out = guardEvaluation(
      {
        state: modelState,
        confidence: 0.2,
        sourceUrls: ["https://a.example/menu"],
      },
      CITATIONS,
      URL_TO_ID,
    );
    assertEquals(out.state, "match", modelState);
    assertEquals(out.confidence, 0.2, modelState);
    assertEquals(out.evidenceIds, ["ev-a"], modelState);
  }
});

Deno.test("guardEvaluation: cuisine等はshared claimのkeyで断定せず今回の中立citationだけを使う", () => {
  const genreClaim: StructuredClaimInput = {
    key: "genre",
    value: ["イタリアン"],
    rawText: 'genre=["イタリアン"]',
  };
  const storedClaimsByUrl = new Map([
    ["https://a.example/menu", [genreClaim]],
  ]);
  const finding = {
    state: "match" as const,
    confidence: 0.8,
    sourceUrls: ["https://a.example/menu"],
  };
  const withoutCurrentCitation = guardEvaluation(
    finding,
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "cuisine",
      normalizedText: "寿司",
      findingClaims: [genreClaim],
      storedClaimsByUrl,
    },
  );
  assertEquals(withoutCurrentCitation, {
    state: "unknown",
    confidence: 0,
    evidenceIds: [],
  });

  const withCurrentCitation = guardEvaluation(
    finding,
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "cuisine",
      normalizedText: "寿司",
      findingClaims: [genreClaim],
      storedClaimsByUrl,
      neutralCitationUrls: ["https://a.example/menu"],
    },
  );
  assertEquals(withCurrentCitation, {
    state: "match",
    confidence: 0.8,
    evidenceIds: ["ev-a"],
  });
});

Deno.test("guardEvaluation: Evidence IDが無いmatch / partial / mismatchはすべてunknown", () => {
  const mismatch = guardEvaluation(
    { state: "mismatch", confidence: 0.7, sourceUrls: [] },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(mismatch, {
    state: "unknown",
    confidence: 0,
    evidenceIds: [],
  });
  const partial = guardEvaluation(
    { state: "partial", confidence: 0.5, sourceUrls: [] },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(partial, { state: "unknown", confidence: 0, evidenceIds: [] });

  for (const state of ["partial", "mismatch"] as const) {
    const semantic = guardEvaluation(
      { state, confidence: 0.6, sourceUrls: [] },
      CITATIONS,
      URL_TO_ID,
      { requirementKind: "cuisine", findingClaims: [] },
    );
    assertEquals(semantic, {
      state: "unknown",
      confidence: 0,
      evidenceIds: [],
    });
  }
});

Deno.test("guardEvaluation: 誤分類kindでもsource未検証なら全nonunknownをunknownへ落とす", () => {
  for (const state of ["match", "partial", "mismatch"] as const) {
    const out = guardEvaluation(
      { state, confidence: 0.9, sourceUrls: ["https://a.example/menu"] },
      CITATIONS,
      URL_TO_ID,
      {
        requirementKind: "other",
        originalText: "",
        normalizedText: "クレジットカード利用可能",
        sourceAttested: false,
        neutralCitationUrls: ["https://a.example/menu"],
      },
    );
    assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
  }
});

Deno.test("guardEvaluation: confidence > 1 は clamp せず unknown / null に破棄 (§30)", () => {
  const out = guardEvaluation(
    { state: "match", confidence: 1.5, sourceUrls: ["https://a.example/menu"] },
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "other",
      neutralCitationUrls: ["https://a.example/menu"],
    },
  );
  // clamp して 1.0 の「最高確信度 match」に化けないこと
  assertEquals(out, {
    state: "unknown",
    confidence: null,
    evidenceIds: [],
  });
});

Deno.test("guardEvaluation: confidence < 0 も unknown / null に破棄 (§30)", () => {
  const out = guardEvaluation(
    {
      state: "partial",
      confidence: -0.1,
      sourceUrls: ["https://b.example/info"],
    },
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "other",
      neutralCitationUrls: [
        "https://a.example/menu",
        "https://b.example/info",
      ],
    },
  );
  assertEquals(out, {
    state: "unknown",
    confidence: null,
    evidenceIds: [],
  });
});

Deno.test("guardEvaluation: 非有限confidenceもEvidence IDごと破棄する", () => {
  const out = guardEvaluation(
    {
      state: "match",
      confidence: Number.NaN,
      sourceUrls: ["https://a.example/menu"],
    },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(out, {
    state: "unknown",
    confidence: null,
    evidenceIds: [],
  });
});

Deno.test("guardEvaluation: 境界値 0 と 1 は有効 (破棄しない)", () => {
  const zero = guardEvaluation(
    {
      state: "mismatch",
      confidence: 0,
      sourceUrls: ["https://a.example/menu"],
    },
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "other",
      findingClaims: [],
      neutralCitationUrls: ["https://a.example/menu"],
    },
  );
  assertEquals(zero.state, "mismatch");
  assertEquals(zero.confidence, 0);
  const one = guardEvaluation(
    { state: "match", confidence: 1, sourceUrls: ["https://a.example/menu"] },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(one.state, "match");
  assertEquals(one.confidence, 1);
});

Deno.test("guardEvaluation: citation に在るが Evidence 保存に失敗した URL は evidenceIds に入らない", () => {
  // insertEvidenceIfStale が id を返さなかった URL (= urlToEvidenceId 未登録) は採用しない
  const partialMap = new Map([["https://a.example/menu", "ev-a"]]); // b.example は保存失敗扱い
  const out = guardEvaluation(
    { state: "match", confidence: 0.6, sourceUrls: ["https://b.example/info"] },
    CITATIONS,
    partialMap,
  );
  // citation には在るが evidence id が無い → 0 件 → match は demote
  assertEquals(out, { state: "unknown", confidence: 0, evidenceIds: [] });
});

Deno.test("guardEvaluation: 捏造demote後でも元の範囲外confidenceをunknown/nullに破棄する", () => {
  // demote後の0で元の不正値7を隠さない。
  const demotedFirst = guardEvaluation(
    { state: "match", confidence: 7, sourceUrls: [] },
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "other",
      neutralCitationUrls: [
        "https://a.example/menu",
        "https://b.example/info",
      ],
    },
  );
  assertEquals(demotedFirst, {
    state: "unknown",
    confidence: null,
    evidenceIds: [],
  });
  // 一方 partial + confidence 7 は第2ガードで unknown/null
  const rangeKilled = guardEvaluation(
    { state: "partial", confidence: 7, sourceUrls: [] },
    CITATIONS,
    URL_TO_ID,
  );
  assertEquals(rangeKilled, {
    state: "unknown",
    confidence: null,
    evidenceIds: [],
  });
});

Deno.test("guardEvaluation: 重複 URL は重複 evidence id になる (現状挙動のピン留め・順序保持)", () => {
  const out = guardEvaluation(
    {
      state: "partial",
      confidence: 0.4,
      sourceUrls: [
        "https://a.example/menu",
        "https://a.example/menu",
        "https://b.example/info",
      ],
    },
    CITATIONS,
    URL_TO_ID,
    {
      requirementKind: "other",
      neutralCitationUrls: [
        "https://a.example/menu",
        "https://b.example/info",
      ],
    },
  );
  assertEquals(out.evidenceIds, ["ev-a", "ev-a", "ev-b"]);
});
