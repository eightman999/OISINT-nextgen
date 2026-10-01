// place_facts 決定論集約 (§44.5 / issue #104) のテスト
import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  buildPlaceFacts,
  canonicalValue,
  evaluateFromEvidence,
  evaluateFromFacts,
  type FactSourceEvidence,
  parseStructuredFilterRequirement,
  type ReusableEvidence,
} from "../functions/_shared/facts.ts";
import { filterReusableSafeSharedEvidence } from "../functions/_shared/evidence_content.ts";
import { isEvidenceWithinTtl } from "../functions/_shared/provider_ttl.ts";
import type { Contradiction } from "../functions/_shared/types.ts";

const ev = (
  id: string,
  quality: number,
  observedAt: string,
  claims: Array<{ key: string; value: unknown }>,
): FactSourceEvidence => ({
  id,
  sourceQuality: quality,
  observedAt,
  structuredClaims: claims.map((c) => ({
    key: c.key as FactSourceEvidence["structuredClaims"][number]["key"],
    value: c.value,
    rawText: `raw-${id}`, // 入力には rawText があるが facts 出力には含まれないこと (§44.3 L1)
  })),
});

Deno.test("canonicalValue: object のキー順に依存しない", () => {
  assertEquals(
    canonicalValue({ min: 1, max: 2 }),
    canonicalValue({ max: 2, min: 1 }),
  );
});

Deno.test("buildPlaceFacts: source_quality 合計が最大の値を採用する", () => {
  const facts = buildPlaceFacts(
    [
      ev("e1", 1.0, "2026-08-14T00:00:00Z", [{
        key: "card_accepted" as const,
        value: true,
      }]),
      ev("e2", 0.55, "2026-08-15T00:00:00Z", [{
        key: "card_accepted" as const,
        value: false,
      }]),
      ev("e3", 0.55, "2026-08-15T01:00:00Z", [{
        key: "card_accepted",
        value: false,
      }]),
    ],
    [],
  );
  // false 側は 0.55+0.55=1.10 > true 側 1.00 → false を採用
  assertEquals(facts.length, 1);
  assertEquals(facts[0].key, "card_accepted");
  assertEquals(facts[0].value, false);
  assertEquals(facts[0].evidenceCount, 2);
  assertAlmostEquals(facts[0].confidence, 0.55); // 支持側の最大 source_quality
  assertEquals(facts[0].conflicting, false);
});

Deno.test("buildPlaceFacts: confidence は支持 Evidence の最大 source_quality", () => {
  const facts = buildPlaceFacts(
    [
      ev("e1", 1.0, "2026-08-14T00:00:00Z", [{
        key: "reservation",
        value: true,
      }]),
      ev("e2", 0.55, "2026-08-15T00:00:00Z", [{
        key: "reservation",
        value: true,
      }]),
    ],
    [],
  );
  assertEquals(facts[0].evidenceCount, 2);
  assertAlmostEquals(facts[0].confidence, 1.0);
});

Deno.test("buildPlaceFacts: 同点なら observed_at が新しい値を採用する (決定論 tie-break)", () => {
  const facts = buildPlaceFacts(
    [
      ev("e1", 0.85, "2026-08-14T00:00:00Z", [{
        key: "opening_hours",
        value: "17:00-22:00",
      }]),
      ev("e2", 0.85, "2026-08-15T00:00:00Z", [{
        key: "opening_hours",
        value: "17:00-23:00",
      }]),
    ],
    [],
  );
  assertEquals(facts[0].value, "17:00-23:00");
});

Deno.test("buildPlaceFacts: 矛盾キーは conflicting=true で残す (潰さない §44.5)", () => {
  const contradictions: Contradiction[] = [
    {
      placeId: "p1",
      key: "opening_hours",
      entries: [
        { evidenceId: "e1", value: "17:00-22:00", sourceQuality: 0.85 },
        { evidenceId: "e2", value: "17:00-23:00", sourceQuality: 1.0 },
      ],
    },
  ];
  const facts = buildPlaceFacts(
    [
      ev("e1", 0.85, "2026-08-14T00:00:00Z", [{
        key: "opening_hours",
        value: "17:00-22:00",
      }]),
      ev("e2", 1.0, "2026-08-15T00:00:00Z", [{
        key: "opening_hours",
        value: "17:00-23:00",
      }]),
    ],
    contradictions,
  );
  assertEquals(facts.length, 1); // 矛盾しても行は残る
  assertEquals(facts[0].conflicting, true);
  assertEquals(facts[0].value, "17:00-23:00"); // 支持品質が高い方を値として保持
});

Deno.test("buildPlaceFacts: 単一 Evidence 内の相反claimも conflicting=true で残す", () => {
  const facts = buildPlaceFacts(
    [
      ev("e1", 1, "2026-08-16T00:00:00Z", [
        { key: "card_accepted", value: true },
        { key: "card_accepted", value: false },
      ]),
    ],
    [],
  );

  assertEquals(facts.length, 1);
  assertEquals(facts[0].key, "card_accepted");
  assertEquals(facts[0].value, false); // 現行tie-break値は保持するが断定不可にする
  assertEquals(facts[0].conflicting, true);
});

Deno.test("buildPlaceFacts: 旧要件依存shared rowを除外し、安全なfactだけを集約する", () => {
  const rows = filterReusableSafeSharedEvidence([
    {
      id: "unsafe",
      source_url: "https://official.example/menu",
      source_type: "other_public_page",
      source_title: "以前の利用者条件",
      excerpt: "以前の利用者はカードを避けたい",
      source_quality: 1,
      observed_at: "2026-08-16T00:00:00Z",
      structured_claims: [{
        key: "card_accepted" as const,
        value: false,
        rawText: "以前の利用者はカードを避けたい",
      }],
    },
    {
      id: "safe",
      source_url: "https://official.example/menu",
      source_type: "other_public_page",
      source_title: "公開ページ (official.example)",
      excerpt: "クレジットカード利用可",
      source_quality: 0.8,
      observed_at: "2026-08-16T00:00:01Z",
      structured_claims: [{
        key: "card_accepted" as const,
        value: true,
        rawText: "クレジットカード利用可",
      }],
    },
  ]);
  const facts = buildPlaceFacts(
    rows.map((row) => ({
      id: row.id,
      sourceQuality: row.source_quality,
      observedAt: row.observed_at,
      structuredClaims: row.structured_claims,
    })),
    [],
  );
  assertEquals(facts, [{
    key: "card_accepted",
    value: true,
    confidence: 0.8,
    evidenceCount: 1,
    conflicting: false,
  }]);
});

Deno.test("buildPlaceFacts: feedback 所有キー (noise_level) は upsert 対象にしない", () => {
  const facts = buildPlaceFacts(
    [
      ev("e1", 0.75, "2026-08-15T00:00:00Z", [
        { key: "noise_level", value: "quiet" },
        { key: "card_accepted", value: true },
      ]),
    ],
    [],
  );
  assertEquals(facts.map((f) => f.key), ["card_accepted"]);
});

Deno.test("buildPlaceFacts: L1 原文 (rawText) を出力へ含めない (§44.3 Hard Rule 1)", () => {
  const facts = buildPlaceFacts(
    [ev("e1", 1.0, "2026-08-15T00:00:00Z", [{ key: "capacity", value: 40 }])],
    [],
  );
  const serialized = JSON.stringify(facts);
  assertEquals(serialized.includes("raw-e1"), false);
  assertEquals(
    Object.keys(facts[0]).sort(),
    [
      "conflicting",
      "confidence",
      "evidenceCount",
      "key",
      "value",
    ].sort(),
  );
});

Deno.test("buildPlaceFacts: 同一 Evidence の同一 key+value は二重加算しない", () => {
  const evidence: FactSourceEvidence[] = [
    {
      id: "e1",
      sourceQuality: 0.85,
      observedAt: "2026-08-15T00:00:00Z",
      structuredClaims: [
        { key: "card_accepted", value: true, rawText: "a" },
        { key: "card_accepted", value: true, rawText: "b" },
      ],
    },
  ];
  const facts = buildPlaceFacts(evidence, []);
  assertEquals(facts[0].evidenceCount, 1);
});

Deno.test("buildPlaceFacts: 出力は key 昇順 (決定論)", () => {
  const facts = buildPlaceFacts(
    [
      ev("e1", 0.85, "2026-08-15T00:00:00Z", [
        { key: "reservation", value: true },
        { key: "capacity", value: 40 },
        { key: "card_accepted", value: true },
      ]),
    ],
    [],
  );
  assertEquals(facts.map((f) => f.key), [
    "capacity",
    "card_accepted",
    "reservation",
  ]);
});

// ============================================================
// evaluateFromFacts (既存 Evidence の決定論参照側)
// ============================================================

const reqOf = (
  id: string,
  kind: string,
  normalizedText: string,
  originalText = normalizedText,
) => ({
  id,
  kind,
  originalText,
  normalizedText,
  priority: "must",
});

const factOf = (key: string, value: unknown, confidence = 0.85) => ({
  key: key as Parameters<typeof evaluateFromFacts>[1][number]["key"],
  value,
  confidence,
});

Deno.test("structured filter parser: chipの単一条件だけを決定論intentへ変換する", () => {
  assertEquals(parseStructuredFilterRequirement("禁煙"), {
    kind: "boolean_filter",
    key: "non_smoking",
    desired: true,
  });
  assertEquals(parseStructuredFilterRequirement("Wi-Fiなし"), {
    kind: "boolean_filter",
    key: "wifi_available",
    desired: false,
  });
  assertEquals(parseStructuredFilterRequirement("子連れOK"), {
    kind: "boolean_filter",
    key: "child_friendly",
    desired: true,
  });
  assertEquals(parseStructuredFilterRequirement("駅から徒歩5分以内"), {
    kind: "walk_limit",
    maxMinutes: 5,
  });
  for (
    const ambiguous of [
      "禁煙または喫煙可",
      "Wi-Fiがあればいいかも",
      "子連れOKで静か",
      "徒歩5分くらい",
    ]
  ) {
    assertEquals(parseStructuredFilterRequirement(ambiguous), null, ambiguous);
  }
});

Deno.test("evaluateFromFacts: 4種のfilter chipが構造化claimで結果へ影響する", () => {
  const evidence = [
    ev("e-filter", 0.9, "2026-08-30T00:00:00Z", [
      { key: "non_smoking", value: true },
      { key: "wifi_available", value: false },
      { key: "child_friendly", value: true },
      { key: "nearest_station_walk_minutes", value: 6 },
    ]),
  ];
  const results = evaluateFromFacts(
    [
      reqOf("r-smoking", "atmosphere", "禁煙"),
      reqOf("r-wifi", "other", "Wi-Fi"),
      reqOf("r-child", "other", "子連れOK"),
      reqOf("r-walk", "access", "徒歩5分以内"),
    ],
    [
      factOf("non_smoking", true, 0.9),
      factOf("wifi_available", false, 0.9),
      factOf("child_friendly", true, 0.9),
      factOf("nearest_station_walk_minutes", 6, 0.9),
    ],
    evidence,
  );
  assertEquals(results.map((result) => result.state), [
    "match",
    "mismatch",
    "match",
    "mismatch",
  ]);
  assertEquals(
    results.every((result) => result.evidenceIds[0] === "e-filter"),
    true,
  );
});

Deno.test("evaluateFromFacts: chipの原文と正規化文が違うintentならunknown", () => {
  const [result] = evaluateFromFacts(
    [reqOf("r1", "other", "Wi-Fiなし", "Wi-Fi")],
    [factOf("wifi_available", true)],
    [
      ev("e1", 0.9, "2026-08-30T00:00:00Z", [{
        key: "wifi_available",
        value: true,
      }]),
    ],
  );
  assertEquals(result.state, "unknown");
});

Deno.test("evaluateFromFacts: payment は card_accepted の boolean で match/mismatch", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [{
      key: "card_accepted",
      value: true,
    }]),
  ];
  const [ok] = evaluateFromFacts(
    [reqOf("r1", "payment", "クレジットカード利用可能")],
    [factOf("card_accepted", true)],
    evidence,
  );
  assertEquals(ok.state, "match");
  assertEquals(ok.evidenceIds, ["e1"]);
  assertAlmostEquals(ok.confidence, 0.85);

  const evidenceNg = [
    ev("e2", 0.85, "2026-08-15T00:00:00Z", [{
      key: "card_accepted",
      value: false,
    }]),
  ];
  const [ng] = evaluateFromFacts(
    [reqOf("r1", "payment", "クレジットカード利用可能")],
    [factOf("card_accepted", false)],
    evidenceNg,
  );
  assertEquals(ng.state, "mismatch");

  const [cashOnlyText] = evaluateFromFacts(
    [reqOf("r1", "payment", "現金で支払える")],
    [factOf("card_accepted", true)],
    evidence,
  );
  assertEquals(cashOnlyText.state, "unknown");

  const [explicitNegative] = evaluateFromFacts(
    [reqOf("r1", "payment", "クレジットカード利用不可")],
    [factOf("card_accepted", false)],
    evidenceNg,
  );
  assertEquals(explicitNegative.state, "match");
});

Deno.test("evaluateFromFacts: source gateが許可する丁寧表現もcanonical intentで再利用する", () => {
  const evidence = [
    ev("e-card", 0.85, "2026-08-15T00:00:00Z", [{
      key: "card_accepted",
      value: true,
    }]),
    ev("e-party", 0.85, "2026-08-15T00:00:00Z", [{
      key: "capacity",
      value: 40,
    }]),
    ev("e-reservation", 0.85, "2026-08-15T00:00:00Z", [{
      key: "reservation",
      value: true,
    }, {
      key: "private_room",
      value: true,
    }]),
  ];
  const result = evaluateFromFacts(
    [
      reqOf(
        "card",
        "payment",
        "クレジットカード利用可能",
        "カード利用可がいい",
      ),
      reqOf("party", "party_size", "4人で利用可能", "4人で予約したい"),
      reqOf("reservation", "reservation", "予約可能", "予約希望"),
      reqOf("room", "reservation", "個室あり", "個室希望です"),
    ],
    [
      factOf("card_accepted", true),
      factOf("capacity", 40),
      factOf("reservation", true),
      factOf("private_room", true),
    ],
    evidence,
  );
  assertEquals(result.map((row) => row.state), [
    "match",
    "partial",
    "match",
    "match",
  ]);
  assertEquals(result.every((row) => row.evidenceIds.length > 0), true);
});

Deno.test("evaluateFromFacts: party_size は総席数だけならpartial、不足時だけmismatch", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [{ key: "capacity", value: 40 }]),
  ];
  const [ok] = evaluateFromFacts(
    [reqOf("r1", "party_size", "3人で利用可能")],
    [factOf("capacity", 40)],
    evidence,
  );
  assertEquals(ok.state, "partial");

  const [ng] = evaluateFromFacts(
    [reqOf("r1", "party_size", "50人で利用可能")],
    [factOf("capacity", 40)],
    evidence,
  );
  assertEquals(ng.state, "mismatch");

  const [ambiguousRange] = evaluateFromFacts(
    [reqOf("r1", "party_size", "3〜5人で利用可能")],
    [factOf("capacity", 40)],
    evidence,
  );
  assertEquals(ambiguousRange.state, "unknown");
});

Deno.test("evaluateFromFacts: budget の上限/下限operatorは包含=match、交差=partial、非交差=mismatch", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [{
      key: "budget_dinner",
      value: { min: 2500, max: 3500 },
    }]),
  ];
  const states = (texts: string[]) =>
    evaluateFromFacts(
      texts.map((text, i) => reqOf(`r${i}`, "budget", text)),
      [factOf("budget_dinner", { min: 2500, max: 3500 })],
      evidence,
    ).map((r) => r.state);

  assertEquals(
    states([
      "予算 4000円以下",
      "予算 3000円以内",
      "予算 2000円以下",
    ]),
    ["match", "partial", "mismatch"],
  );
  assertEquals(
    states([
      "予算 3,501円未満",
      "予算 3,500円未満",
      "予算 2,500円未満",
    ]),
    ["match", "partial", "mismatch"],
  );
  assertEquals(
    states([
      "予算 2500円以上",
      "予算 3000円以上",
      "予算 4000円以上",
    ]),
    ["match", "partial", "mismatch"],
  );
});

Deno.test("evaluateFromFacts: budget の前後/裸金額/明示範囲をparseし、逆転・選言はunknown", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [{
      key: "budget_dinner",
      value: { min: 2500, max: 3500 },
    }]),
  ];
  const facts = [factOf("budget_dinner", { min: 2500, max: 3500 })];
  const texts = [
    "予算 3000円前後",
    "予算 5000円前後",
    "予算 2000〜4000円",
    "予算 3000円から4000円",
    "予算 4000-5000円",
    "予算 3000円",
    "予算 4000〜2000円",
    "予算 3000円以下または5000円以上",
  ];
  const result = evaluateFromFacts(
    texts.map((text, i) => reqOf(`r${i}`, "budget", text)),
    facts,
    evidence,
  );
  assertEquals(result.map((r) => r.state), [
    "match",
    "mismatch",
    "match",
    "partial",
    "mismatch",
    "match",
    "unknown",
    "unknown",
  ]);
});

Deno.test("evaluateFromFacts: 個室と予約を別claimで判定し、ORしない", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [
      { key: "reservation", value: true },
      { key: "private_room", value: false },
    ]),
  ];
  const facts = [
    factOf("reservation", true),
    factOf("private_room", false),
  ];
  const result = evaluateFromFacts(
    [
      reqOf("r1", "reservation", "予約可能"),
      reqOf("r2", "reservation", "個室あり"),
      reqOf("r3", "reservation", "予約・個室を確認したい"),
      reqOf("r4", "reservation", "予約不要"),
    ],
    facts,
    evidence,
  );
  assertEquals(result.map((r) => r.state), [
    "match",
    "mismatch",
    "unknown",
    "unknown",
  ]);
  assertEquals(result[0].evidenceIds, ["e1"]);
  assertEquals(result[1].evidenceIds, ["e1"]);
});

Deno.test("evaluateFromFacts: 部分一致する否定・除外文をmatch/mismatchへ誤昇格しない", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [
      { key: "card_accepted", value: true },
      { key: "reservation", value: true },
      { key: "capacity", value: 40 },
      { key: "budget_dinner", value: { min: 2000, max: 2800 } },
    ]),
  ];
  const results = evaluateFromFacts(
    [
      reqOf("r1", "payment", "クレジットカード以外が利用可能"),
      reqOf("r2", "payment", "クレジットカード利用可能ではない"),
      reqOf("r3", "reservation", "予約可能ではない"),
      reqOf("r4", "party_size", "50人では利用しない"),
      reqOf("r5", "budget", "3000円以下は避けたい"),
    ],
    [
      factOf("card_accepted", true),
      factOf("reservation", true),
      factOf("capacity", 40),
      factOf("budget_dinner", { min: 2000, max: 2800 }),
    ],
    evidence,
  );
  assertEquals(results.map((result) => result.state), [
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
});

Deno.test("evaluateFromFacts: 原文と正規化文の明示intentが不一致なら決定論評価しない", () => {
  const requirements = [
    reqOf(
      "r-payment",
      "payment",
      "クレジットカード利用可能",
      "カードは使いたくない",
    ),
    reqOf(
      "r-payment-explicit",
      "payment",
      "クレジットカード利用可能",
      "クレジットカード利用不可",
    ),
    reqOf("r-reservation", "reservation", "予約可能", "予約したくない"),
    reqOf(
      "r-reservation-explicit",
      "reservation",
      "予約可能",
      "予約不可",
    ),
    reqOf("r-party", "party_size", "4人で利用可能", "4人では利用しない"),
    reqOf("r-budget", "budget", "3000円以下", "3000円以内は避けたい"),
  ];
  const facts = [
    factOf("card_accepted", true),
    factOf("reservation", true),
    factOf("capacity", 12),
    factOf("budget_dinner", { min: 2000, max: 2800 }),
  ];
  const evidence = [
    ev("e1", 0.9, "2026-08-16T00:00:00Z", [
      { key: "card_accepted", value: true },
      { key: "reservation", value: true },
      { key: "capacity", value: 12 },
      { key: "budget_dinner", value: { min: 2000, max: 2800 } },
    ]),
  ];

  assertEquals(
    evaluateFromFacts(requirements, facts, evidence).map((result) =>
      result.state
    ),
    ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"],
  );
});

Deno.test("evaluateFromFacts: 表記が違っても原文と正規化文が同じ明示intentなら評価する", () => {
  const requirements = [
    reqOf("r-payment", "payment", "クレジットカード利用可能", "カード利用可"),
    reqOf("r-reservation", "reservation", "予約可能", "予約できる"),
    reqOf("r-party", "party_size", "4人で利用可能", "人数は4人"),
    reqOf("r-budget", "budget", "3000円以下", "予算は3,000円以内"),
  ];
  const facts = [
    factOf("card_accepted", true),
    factOf("reservation", true),
    factOf("capacity", 12),
    factOf("budget_dinner", { min: 2000, max: 2800 }),
  ];
  const evidence = [
    ev("e1", 0.9, "2026-08-16T00:00:00Z", [
      { key: "card_accepted", value: true },
      { key: "reservation", value: true },
      { key: "capacity", value: 12 },
      { key: "budget_dinner", value: { min: 2000, max: 2800 } },
    ]),
  ];

  assertEquals(
    evaluateFromFacts(requirements, facts, evidence).map((result) =>
      result.state
    ),
    ["match", "match", "partial", "match"],
  );
});

Deno.test("evaluateFromFacts: 文面解釈が必要な kind (atmosphere / time) は unknown", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [{
      key: "opening_hours",
      value: "17:00-23:00",
    }]),
  ];
  const results = evaluateFromFacts(
    [
      reqOf("r1", "atmosphere", "静かで落ち着いた雰囲気"),
      reqOf("r2", "time", "19時から利用できる"),
    ],
    [factOf("opening_hours", "17:00-23:00")],
    evidence,
  );
  assertEquals(results.map((r) => r.state), ["unknown", "unknown"]);
});

Deno.test("evaluateFromFacts: 支持 Evidence を引き当てられない match は unknown へ落とす (§12)", () => {
  // facts はあるが対応する Evidence 行が無い (期限切れ等) → 断定しない
  const [r] = evaluateFromFacts(
    [reqOf("r1", "payment", "クレジットカード利用可能")],
    [factOf("card_accepted", true)],
    [],
  );
  assertEquals(r.state, "unknown");
  assertEquals(r.evidenceIds, []);
});

Deno.test("evaluateFromFacts: 同一入力は同一出力 (決定論)", () => {
  const evidence = [
    ev("e1", 0.85, "2026-08-15T00:00:00Z", [{
      key: "card_accepted",
      value: true,
    }]),
  ];
  const reqs = [reqOf("r1", "payment", "クレジットカード利用可能")];
  const facts = [factOf("card_accepted", true)];
  assertEquals(
    JSON.stringify(evaluateFromFacts(reqs, facts, evidence)),
    JSON.stringify(evaluateFromFacts(reqs, facts, evidence)),
  );
});

Deno.test("evaluateFromFacts: supporting Evidence ID は入力順に依存せず昇順", () => {
  const requirements = [
    reqOf("r1", "payment", "クレジットカード利用可能"),
  ];
  const facts = [factOf("card_accepted", true)];
  const first = ev("e-a", 0.9, "2026-08-15T00:00:00Z", [{
    key: "card_accepted",
    value: true,
  }]);
  const second = ev("e-b", 0.8, "2026-08-16T00:00:00Z", [{
    key: "card_accepted",
    value: true,
  }]);

  const forward = evaluateFromFacts(requirements, facts, [first, second]);
  const reversed = evaluateFromFacts(requirements, facts, [second, first]);
  assertEquals(forward, reversed);
  assertEquals(forward[0].evidenceIds, ["e-a", "e-b"]);
});

// ============================================================
// evaluateFromEvidence (#312: 条件単位の再利用)
// ============================================================

interface UnknownReductionFixture {
  seed: string;
  fixedNow: string;
  conditions: {
    candidateId: string;
    placeId: string;
    fetchedPageCount: number;
    unresolvedResearchOutcome: string;
  };
  requirements: Array<{
    id: string;
    originalText: string;
    normalizedText: string;
    kind: string;
    priority: string;
  }>;
  evidence: Array<ReusableEvidence & { sourceType: string }>;
  expected: {
    legacyAllOrNothingUnknownCount: number;
    perRequirementUnknownCount: number;
    resolvedRequirementIds: string[];
    resolvedStates: Array<{ requirementId: string; state: string }>;
    unresolvedRequirementIds: string[];
    usedEvidenceSources: Array<{ id: string; sourceUrl: string }>;
  };
}

Deno.test("evaluateFromEvidence: 同一 fixture で unknown を 5→2 に削減し、未解決条件は推測しない (#312)", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/evidence_unknown_reduction.json", import.meta.url),
    ),
  ) as UnknownReductionFixture;
  assertEquals(fixture.seed, "not-applicable-deterministic-pure-functions");
  assertEquals(fixture.fixedNow, "2026-08-16T03:00:00.000Z");
  assertEquals(fixture.conditions, {
    candidateId: "candidate-fixture-1",
    placeId: "place-fixture-1",
    fetchedPageCount: 0,
    unresolvedResearchOutcome: "unknown",
  });

  const freshEvidence = fixture.evidence.filter((e) =>
    isEvidenceWithinTtl(
      { source_type: e.sourceType, observed_at: e.observedAt },
      new Date(fixture.fixedNow),
    )
  );
  assertEquals(freshEvidence.length, 1);
  const plan = evaluateFromEvidence(fixture.requirements, freshEvidence);
  const trace = {
    resolvedRequirementIds: plan.resolvedEvaluations.map((e) =>
      e.requirementId
    ),
    unresolvedRequirementIds: plan.unresolvedRequirements.map((r) => r.id),
    usedEvidenceSources: plan.usedEvidenceSources,
  };

  // 旧経路は 1 条件でも unknown があれば Evidence 再利用を全件破棄する。
  // この固定条件では外部ページが 0 件のため、その後は全 5 条件が unknown になる。
  const legacyUnknownCount = plan.unresolvedRequirements.length > 0
    ? fixture.requirements.length
    : 0;
  const afterUnknownCount = plan.unresolvedRequirements.length;

  assertEquals(
    legacyUnknownCount,
    fixture.expected.legacyAllOrNothingUnknownCount,
  );
  assertEquals(afterUnknownCount, fixture.expected.perRequirementUnknownCount);
  assertEquals(trace, {
    resolvedRequirementIds: fixture.expected.resolvedRequirementIds,
    unresolvedRequirementIds: fixture.expected.unresolvedRequirementIds,
    usedEvidenceSources: fixture.expected.usedEvidenceSources,
  });
  assertEquals(
    plan.resolvedEvaluations.map((e) => ({
      requirementId: e.requirementId,
      state: e.state,
    })),
    fixture.expected.resolvedStates,
  );
  assertEquals(
    plan.resolvedEvaluations.every((e) => e.evidenceIds.length > 0),
    true,
  );
  // 営業時間 claim は存在しても「朝食営業」は文面解釈が必要。unknown のまま検索へ回す。
  assertEquals(
    plan.resolvedEvaluations.some((e) => e.requirementId === "req-time"),
    false,
  );

  // seed・時刻・入力が同一なら trace まで完全一致する。
  assertEquals(
    JSON.stringify(
      evaluateFromEvidence(fixture.requirements, freshEvidence),
    ),
    JSON.stringify(plan),
  );
});

Deno.test("evaluateFromEvidence: 相反する card claims は match にせず未解決へ残す", () => {
  const requirements = [reqOf("r1", "payment", "クレジットカード利用可能")];
  const evidence: ReusableEvidence[] = [
    {
      ...ev("e1", 0.85, "2026-08-16T00:00:00Z", [{
        key: "card_accepted",
        value: true,
      }]),
      sourceUrl: "https://official.example/card",
    },
    {
      ...ev("e2", 0.85, "2026-08-16T00:00:00Z", [{
        key: "card_accepted",
        value: false,
      }]),
      sourceUrl: "https://provider.example/card",
    },
  ];
  const plan = evaluateFromEvidence(requirements, evidence);
  assertEquals(plan.resolvedEvaluations, []);
  assertEquals(plan.unresolvedRequirements.map((r) => r.id), ["r1"]);
  assertEquals(plan.usedEvidenceSources, []);
});

Deno.test("evaluateFromEvidence: 単一 Evidence 内の相反 card claims も未解決へ残す", () => {
  const requirements = [reqOf("r1", "payment", "クレジットカード利用可能")];
  const evidence: ReusableEvidence[] = [
    {
      ...ev("e1", 0.85, "2026-08-16T00:00:00Z", [
        { key: "card_accepted", value: true },
        { key: "card_accepted", value: false },
      ]),
      sourceUrl: "https://official.example/card",
    },
  ];

  const plan = evaluateFromEvidence(requirements, evidence);
  assertEquals(plan.resolvedEvaluations, []);
  assertEquals(plan.unresolvedRequirements.map((r) => r.id), ["r1"]);
  assertEquals(plan.usedEvidenceSources, []);
});

Deno.test("evaluateFromEvidence: 重なる予算Evidenceの適合度が割れたらquality順によらずpartial", () => {
  const requirements = [reqOf("r-budget", "budget", "予算3000円以下")];
  const evidence = (
    matchQuality: number,
    partialQuality: number,
  ): ReusableEvidence[] => [
    {
      ...ev("e-match", matchQuality, "2026-08-15T00:00:00Z", [{
        key: "budget_dinner",
        value: { min: 1000, max: 3000 },
      }]),
      sourceUrl: "https://official.example/budget-match",
    },
    {
      ...ev("e-partial", partialQuality, "2026-08-16T00:00:00Z", [{
        key: "budget_dinner",
        value: { min: 2500, max: 3500 },
      }]),
      sourceUrl: "https://official.example/budget-partial",
    },
  ];

  const first = evaluateFromEvidence(requirements, evidence(0.9, 0.8));
  const swapped = evaluateFromEvidence(
    requirements,
    evidence(0.8, 0.9).reverse(),
  );
  assertEquals(first, swapped);
  assertEquals(first.resolvedEvaluations, [{
    requirementId: "r-budget",
    state: "partial",
    confidence: 0.8,
    explanation: "複数のEvidenceで適合度が異なるため部分適合です",
    evidenceIds: ["e-match", "e-partial"],
  }]);
  assertEquals(first.usedEvidenceSources, [
    {
      id: "e-match",
      sourceUrl: "https://official.example/budget-match",
    },
    {
      id: "e-partial",
      sourceUrl: "https://official.example/budget-partial",
    },
  ]);
});

Deno.test("evaluateFromEvidence: 近い定員Evidenceのpartial/mismatchをquality winnerで断定しない", () => {
  const requirements = [
    reqOf("r-party", "party_size", "4人で利用可能"),
  ];
  const evidence = (
    mismatchQuality: number,
    partialQuality: number,
  ): ReusableEvidence[] => [
    {
      ...ev("e-capacity-3", mismatchQuality, "2026-08-15T00:00:00Z", [{
        key: "capacity",
        value: 3,
      }]),
      sourceUrl: "https://official.example/capacity-3",
    },
    {
      ...ev("e-capacity-5", partialQuality, "2026-08-16T00:00:00Z", [{
        key: "capacity",
        value: 5,
      }]),
      sourceUrl: "https://official.example/capacity-5",
    },
  ];

  const first = evaluateFromEvidence(requirements, evidence(0.9, 0.8));
  const swapped = evaluateFromEvidence(
    requirements,
    evidence(0.8, 0.9).reverse(),
  );
  assertEquals(first, swapped);
  assertEquals(first.resolvedEvaluations, [{
    requirementId: "r-party",
    state: "partial",
    confidence: 0.8,
    explanation: "複数のEvidenceで適合度が異なるため部分適合です",
    evidenceIds: ["e-capacity-3", "e-capacity-5"],
  }]);
});
