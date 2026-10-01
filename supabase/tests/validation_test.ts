// validation.ts のユニットテスト (spec.md §30 AI 出力の検証 / §13 StructuredClaim)
// 全エクスポート Zod schema の valid/invalid 系と filterValidClaims を検証する。
// 注意: §30 の「Zod 失敗時リトライ 1 回」ヘルパは validation.ts には無い
// (google_ai.ts の structuredCall と pipeline.ts の再試行ループ側)。google_ai_test.ts で検証する。
import { assert, assertEquals } from "@std/assert";
import {
  AI_OUTPUT_LIMITS,
  buildRunReinvokeBody,
  createInvestigationBodySchema,
  currentLocationScopeSchema,
  deleteAccountBodySchema,
  deleteInvestigationBodySchema,
  filterValidClaims,
  groundedCandidateInvestigationSchema,
  joinInvestigationBodySchema,
  locationAnchorSchema,
  parsedRequirementsSchema,
  requirementKindSchema,
  rerankInvestigationBodySchema,
  runInvestigationBodySchema,
  type StructuredClaimInput,
  structuredClaimSchema,
  validateGroundedCandidateReferences,
} from "../functions/_shared/validation.ts";

Deno.test("deleteInvestigationBodySchema: 調査IDだけを受け、user idをbodyから受けない", () => {
  assert(
    deleteInvestigationBodySchema.safeParse({
      investigationId: "00000000-0000-4000-8000-000000000001",
    }).success,
  );
  assert(
    !deleteInvestigationBodySchema.safeParse({
      investigationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
    }).success,
  );
  assert(
    !deleteInvestigationBodySchema.safeParse({ investigationId: "not-a-uuid" })
      .success,
  );
});

Deno.test("deleteAccountBodySchema: 空bodyだけを受け、削除対象user idを受けない", () => {
  assert(deleteAccountBodySchema.safeParse({}).success);
  assert(
    !deleteAccountBodySchema.safeParse({
      userId: "00000000-0000-4000-8000-000000000002",
    }).success,
  );
});

// ============================================================
// structuredClaimSchema / filterValidClaims (§13)
// ============================================================

Deno.test("structuredClaimSchema: 既知 key + rawText で通る。未知 key / rawText 欠落は弾く", () => {
  assert(
    structuredClaimSchema.safeParse({
      key: "card_accepted",
      value: true,
      rawText: "カード可",
    }).success,
  );
  assert(
    !structuredClaimSchema.safeParse({
      key: "parking",
      value: true,
      rawText: "駐車場あり",
    }).success,
  );
  assert(
    !structuredClaimSchema.safeParse({ key: "card_accepted", value: true })
      .success,
  );
});

Deno.test("filterValidClaims: §13固定ClaimKeyの正しいvalueは残る", () => {
  const claims: StructuredClaimInput[] = [
    { key: "opening_hours", value: "17:00-23:00", rawText: "営業時間" },
    { key: "closed_days", value: "月曜", rawText: "定休日" },
    { key: "closed_days", value: ["月", "火"], rawText: "定休日" },
    { key: "budget_dinner", value: { min: 3000, max: 4000 }, rawText: "予算" },
    { key: "card_accepted", value: true, rawText: "カード" },
    { key: "reservation", value: false, rawText: "予約" },
    { key: "private_room", value: true, rawText: "個室" },
    { key: "capacity", value: 36, rawText: "席数" },
    { key: "genre", value: ["焼肉"], rawText: "ジャンル" },
    { key: "noise_level", value: "quiet", rawText: "静か" },
    { key: "time_limit", value: 120, rawText: "2時間制" },
    { key: "time_limit", value: null, rawText: "時間無制限と明記" },
    { key: "non_smoking", value: true, rawText: "全席禁煙" },
    { key: "wifi_available", value: false, rawText: "Wi-Fiなし" },
    { key: "child_friendly", value: true, rawText: "子連れ対応" },
    {
      key: "nearest_station_walk_minutes",
      value: 5,
      rawText: "最寄り駅から徒歩5分",
    },
  ];
  assertEquals(filterValidClaims(claims).length, claims.length);
});

Deno.test("filterValidClaims: value が key 別 schema に合わない claim は破棄する (§13)", () => {
  const claims: StructuredClaimInput[] = [
    { key: "opening_hours", value: "17時〜23時", rawText: "形式外" }, // HH:MM-HH:MM でない
    {
      key: "budget_dinner",
      value: { min: -1, max: 4000 },
      rawText: "負の予算",
    },
    { key: "budget_dinner", value: { min: 3000 }, rawText: "max 欠落" },
    { key: "card_accepted", value: "利用可", rawText: "boolean でない" },
    { key: "capacity", value: 0, rawText: "positive でない" },
    { key: "genre", value: "焼肉", rawText: "配列でない" },
    { key: "noise_level", value: "silent", rawText: "enum 外" },
    { key: "time_limit", value: 0, rawText: "positive でない" },
    { key: "closed_days", value: 1, rawText: "型不正" },
    { key: "non_smoking", value: "yes", rawText: "booleanでない" },
    { key: "wifi_available", value: 1, rawText: "booleanでない" },
    { key: "child_friendly", value: null, rawText: "booleanでない" },
    {
      key: "nearest_station_walk_minutes",
      value: -1,
      rawText: "負数",
    },
    {
      key: "nearest_station_walk_minutes",
      value: 2.5,
      rawText: "整数でない",
    },
  ];
  assertEquals(filterValidClaims(claims), []);
});

Deno.test("filterValidClaims: 未知 key は破棄し、有効な claim だけ順序を保って残す", () => {
  const claims = [
    { key: "card_accepted", value: true, rawText: "a" },
    { key: "parking", value: true, rawText: "b" }, // ClaimKey 外
    { key: "capacity", value: 40, rawText: "c" },
  ] as unknown as StructuredClaimInput[];
  const out = filterValidClaims(claims);
  assertEquals(out.map((c) => c.key), ["card_accepted", "capacity"]);
});

// ============================================================
// parsedRequirementsSchema (§11, §25.1)
// ============================================================

const validParsed = {
  title: "8/23 池袋 夜飯",
  normalizedQuery: "池袋で焼肉 3000円 個室",
  area: "池袋",
  requirements: [
    {
      text: "3000円",
      normalizedText: "予算 3000円前後",
      kind: "budget",
      priority: "must",
      weight: 1.0,
    },
  ],
};

Deno.test("parsedRequirementsSchema: 正常フィクスチャは通る", () => {
  const r = parsedRequirementsSchema.safeParse(validParsed);
  assert(r.success);
  assertEquals(r.data.requirements[0].kind, "budget");
});

Deno.test("parsedRequirementsSchema: 必須フィールド欠落 (area / title 空) は弾く", () => {
  assert(
    !parsedRequirementsSchema.safeParse({ ...validParsed, area: undefined })
      .success,
  );
  assert(
    !parsedRequirementsSchema.safeParse({ ...validParsed, title: "" }).success,
  );
});

Deno.test("parsedRequirementsSchema: requirements は 1 件以上必須 (空配列は弾く)", () => {
  assert(
    !parsedRequirementsSchema.safeParse({ ...validParsed, requirements: [] })
      .success,
  );
});

Deno.test("parsedRequirementsSchema: query由来文字列とrequirements件数の上限を強制する", () => {
  for (
    const [field, limit] of [
      ["title", AI_OUTPUT_LIMITS.titleChars],
      ["normalizedQuery", AI_OUTPUT_LIMITS.normalizedQueryChars],
      ["area", AI_OUTPUT_LIMITS.areaChars],
    ] as const
  ) {
    assert(
      parsedRequirementsSchema.safeParse({
        ...validParsed,
        [field]: "x".repeat(limit),
      }).success,
      `${field} at limit`,
    );
    assert(
      !parsedRequirementsSchema.safeParse({
        ...validParsed,
        [field]: "x".repeat(limit + 1),
      }).success,
      `${field} over limit`,
    );
  }
  const requirementAtLimit = "x".repeat(
    AI_OUTPUT_LIMITS.requirementTextChars,
  );
  assert(
    parsedRequirementsSchema.safeParse({
      ...validParsed,
      requirements: [{
        ...validParsed.requirements[0],
        text: requirementAtLimit,
        normalizedText: requirementAtLimit,
      }],
    }).success,
  );
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      requirements: [{
        ...validParsed.requirements[0],
        text: `${requirementAtLimit}x`,
      }],
    }).success,
  );
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      requirements: Array.from(
        { length: AI_OUTPUT_LIMITS.requirements + 1 },
        () => validParsed.requirements[0],
      ),
    }).success,
  );
});

Deno.test("parsedRequirementsSchema: kind / priority の enum 外は弾く", () => {
  const withKind = (kind: string) => ({
    ...validParsed,
    requirements: [{ ...validParsed.requirements[0], kind }],
  });
  assert(!parsedRequirementsSchema.safeParse(withKind("parking")).success);
  const withPriority = (priority: string) => ({
    ...validParsed,
    requirements: [{ ...validParsed.requirements[0], priority }],
  });
  assert(!parsedRequirementsSchema.safeParse(withPriority("critical")).success);
});

Deno.test("parsedRequirementsSchema: weight は 0..1 (schema レベルで範囲拘束あり)", () => {
  const withWeight = (weight: number) => ({
    ...validParsed,
    requirements: [{ ...validParsed.requirements[0], weight }],
  });
  assert(parsedRequirementsSchema.safeParse(withWeight(0)).success);
  assert(parsedRequirementsSchema.safeParse(withWeight(1)).success);
  assert(!parsedRequirementsSchema.safeParse(withWeight(1.5)).success);
  assert(!parsedRequirementsSchema.safeParse(withWeight(-0.1)).success);
});

Deno.test("parsedRequirementsSchema: current_location scope は座標や余分キーを拒否する", () => {
  assert(
    parsedRequirementsSchema.safeParse({
      ...validParsed,
      area: "現在地",
      locationScope: { type: "current_location" },
    }).success,
  );
  assert(
    !currentLocationScopeSchema.safeParse({
      type: "current_location",
      lat: 35.7295,
      lng: 139.7109,
    }).success,
  );
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      locationScope: { type: "point", place: "現在地" },
    }).success,
  );
});

Deno.test("parsedRequirementsSchema: any_of / multi_origin は場所集合を保持する", () => {
  for (
    const locationScope of [
      { type: "any_of", places: ["渋谷", "新宿"] },
      { type: "multi_origin", origins: ["渋谷", "新宿"] },
    ]
  ) {
    assert(
      parsedRequirementsSchema.safeParse({ ...validParsed, locationScope })
        .success,
    );
  }
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      locationScope: { type: "any_of", places: ["渋谷"] },
    }).success,
  );
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      locationScope: { type: "multi_origin", origins: ["渋谷", ""] },
    }).success,
  );
});

Deno.test("requirementKindSchema: §11 の 11 kind を網羅する", () => {
  assertEquals(
    [...requirementKindSchema.options].sort(),
    [
      "access",
      "atmosphere",
      "budget",
      "cuisine",
      "dietary",
      "location",
      "other",
      "party_size",
      "payment",
      "reservation",
      "time",
    ],
  );
});

// ============================================================
// groundedCandidateInvestigationSchema (§5, §12, §30)
// ============================================================

const validInvestigation = {
  summary: "公開情報を確認しました",
  searchQueries: ["にくみつ 営業時間"],
  citations: [{ url: "https://example.com/shop", title: "店舗ページ" }],
  findings: [
    {
      requirementId: "r1",
      state: "match",
      confidence: 0.9,
      explanation: "公式サイトで確認",
      sourceUrls: ["https://example.com/shop"],
      claims: [{ key: "card_accepted", value: true, rawText: "カード可" }],
    },
  ],
};

Deno.test("groundedCandidateInvestigationSchema: 正常フィクスチャは通る", () => {
  assert(
    groundedCandidateInvestigationSchema.safeParse(validInvestigation).success,
  );
});

Deno.test("Structured Output schemaは未知キーを黙ってstripせず拒否する", () => {
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      forged: true,
    }).success,
  );
  assert(
    !parsedRequirementsSchema.safeParse({
      ...validParsed,
      requirements: [{ ...validParsed.requirements[0], forged: true }],
    }).success,
  );
  assert(
    !groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      forged: true,
    }).success,
  );
  assert(
    !groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      findings: [{ ...validInvestigation.findings[0], forged: true }],
    }).success,
  );
});

Deno.test("grounded referenceはunknown/duplicate requirementとcitation外URLを結果単位で拒否する", () => {
  const parsed = groundedCandidateInvestigationSchema.parse(validInvestigation);
  const allowed = new Set(["r1"]);
  assertEquals(validateGroundedCandidateReferences(parsed, allowed), {
    ok: true,
  });
  assertEquals(
    validateGroundedCandidateReferences({
      ...parsed,
      findings: [{ ...parsed.findings[0], requirementId: "forged" }],
    }, allowed),
    { ok: false, reason: "unknown_requirement" },
  );
  assertEquals(
    validateGroundedCandidateReferences({
      ...parsed,
      findings: [parsed.findings[0], parsed.findings[0]],
    }, allowed),
    { ok: false, reason: "duplicate_requirement" },
  );
  assertEquals(
    validateGroundedCandidateReferences({
      ...parsed,
      findings: [{
        ...parsed.findings[0],
        sourceUrls: [
          "https://example.com/shop",
          "https://fabricated.example/fake",
        ],
      }],
    }, allowed),
    { ok: false, reason: "unknown_citation" },
  );
});

Deno.test("groundedCandidateInvestigationSchema: citation/source URLはhttp(s)だけを許可する", () => {
  for (
    const url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "ftp://example.com/shop",
      "https://user:secret@example.com/shop",
    ]
  ) {
    assert(
      !groundedCandidateInvestigationSchema.safeParse({
        ...validInvestigation,
        citations: [{ url, title: "unsafe" }],
        findings: [{ ...validInvestigation.findings[0], sourceUrls: [url] }],
      }).success,
      url,
    );
  }
  assert(
    groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      citations: [{ url: "http://example.com/shop", title: "http" }],
      findings: [{
        ...validInvestigation.findings[0],
        sourceUrls: ["http://example.com/shop"],
      }],
    }).success,
  );
});

Deno.test("groundedCandidateInvestigationSchema: findings は空配列を許容する (下流で unknown 埋め §31)", () => {
  assert(
    groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      findings: [],
    }).success,
  );
});

Deno.test("groundedCandidateInvestigationSchema: 自由文とarray cardinality上限を強制する", () => {
  const overSummary = "要".repeat(AI_OUTPUT_LIMITS.summaryChars + 1);
  const overExplanation = "説".repeat(AI_OUTPUT_LIMITS.explanationChars + 1);
  const citation = { url: "https://example.com/shop", title: "店舗" };
  const claim = { key: "card_accepted", value: true, rawText: "カード可" };
  const finding = validInvestigation.findings[0];
  const invalids = [
    { ...validInvestigation, summary: overSummary },
    {
      ...validInvestigation,
      searchQueries: Array(AI_OUTPUT_LIMITS.searchQueries + 1).fill("query"),
    },
    {
      ...validInvestigation,
      searchQueries: ["q".repeat(AI_OUTPUT_LIMITS.searchQueryChars + 1)],
    },
    {
      ...validInvestigation,
      citations: Array(AI_OUTPUT_LIMITS.citations + 1).fill(citation),
    },
    {
      ...validInvestigation,
      findings: Array(AI_OUTPUT_LIMITS.findings + 1).fill(finding),
    },
    {
      ...validInvestigation,
      findings: [{ ...finding, explanation: overExplanation }],
    },
    {
      ...validInvestigation,
      findings: [{
        ...finding,
        sourceUrls: Array(AI_OUTPUT_LIMITS.sourceUrls + 1).fill(
          "https://example.com/shop",
        ),
      }],
    },
    {
      ...validInvestigation,
      findings: [{
        ...finding,
        claims: Array(AI_OUTPUT_LIMITS.claimsPerFinding + 1).fill(claim),
      }],
    },
    {
      ...validInvestigation,
      findings: [{
        ...finding,
        claims: [{
          ...claim,
          rawText: "根".repeat(AI_OUTPUT_LIMITS.claimRawTextChars + 1),
        }],
      }],
    },
  ];
  for (const invalid of invalids) {
    assert(!groundedCandidateInvestigationSchema.safeParse(invalid).success);
  }
});

Deno.test("groundedCandidateInvestigationSchema: confidence は schema レベルで範囲拘束なし (7 も通る)", () => {
  // §30: 0..1 の範囲外は clamp せず「破棄して unknown」— この破棄は pipeline.ts 側で行うため、
  // schema はあえて範囲を縛らない (縛ると §30 のリトライ 1 回を無駄に消費する)。仕様通りをピン留め。
  const withConf = (confidence: unknown) => ({
    ...validInvestigation,
    findings: [{ ...validInvestigation.findings[0], confidence }],
  });
  assert(groundedCandidateInvestigationSchema.safeParse(withConf(7)).success);
  assert(groundedCandidateInvestigationSchema.safeParse(withConf(-1)).success);
  assert(
    !groundedCandidateInvestigationSchema.safeParse(withConf("high")).success,
  ); // 型は number 必須
});

Deno.test("groundedCandidateInvestigationSchema: state の enum 外 / summary 空 / citations の不正 URL は弾く", () => {
  const withState = (state: string) => ({
    ...validInvestigation,
    findings: [{ ...validInvestigation.findings[0], state }],
  });
  assert(
    !groundedCandidateInvestigationSchema.safeParse(withState("yes")).success,
  );
  assert(
    !groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      summary: "",
    }).success,
  );
  assert(
    !groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      citations: [{ url: "not-a-url", title: null }],
    }).success,
  );
});

Deno.test("groundedCandidateInvestigationSchema: citation title は null 許容", () => {
  assert(
    groundedCandidateInvestigationSchema.safeParse({
      ...validInvestigation,
      citations: [{ url: "https://example.com/", title: null }],
    }).success,
  );
});

Deno.test("groundedCandidateInvestigationSchema: claimの余分キーをstripせず拒否する", () => {
  const r = groundedCandidateInvestigationSchema.safeParse({
    ...validInvestigation,
    findings: [
      {
        ...validInvestigation.findings[0],
        claims: [{
          key: "capacity",
          value: 36,
          rawText: "36席",
          extra: "余分",
        }],
      },
    ],
  });
  assert(!r.success);
});

Deno.test("groundedCandidateInvestigationSchema: claim の value 型はこの層では検証しない (filterValidClaims の責務)", () => {
  // card_accepted に文字列が入っていても schema は通す。DB 書き込み前に
  // filterValidClaims (§13: 失敗 claim は破棄) が落とす二段構え。
  const r = groundedCandidateInvestigationSchema.safeParse({
    ...validInvestigation,
    findings: [
      {
        ...validInvestigation.findings[0],
        claims: [{ key: "card_accepted", value: "yes", rawText: "曖昧" }],
      },
    ],
  });
  assert(r.success);
  assertEquals(
    filterValidClaims(r.data.findings[0].claims as StructuredClaimInput[]),
    [],
  );
});

// ============================================================
// Edge Functions request body schemas (contracts/*.md)
// ============================================================

Deno.test("createInvestigationBodySchema: query 1..500 / displayName 1..40", () => {
  assert(
    createInvestigationBodySchema.safeParse({
      query: "池袋で焼肉",
      displayName: "えいと",
    }).success,
  );
  assert(
    !createInvestigationBodySchema.safeParse({
      query: "",
      displayName: "えいと",
    }).success,
  );
  assert(
    !createInvestigationBodySchema.safeParse({
      query: "あ".repeat(501),
      displayName: "え",
    }).success,
  );
  assert(
    !createInvestigationBodySchema.safeParse({
      query: "焼肉",
      displayName: "あ".repeat(41),
    }).success,
  );
});

Deno.test("runInvestigationBodySchema: investigationId は UUID 必須", () => {
  assert(
    runInvestigationBodySchema.safeParse({
      investigationId: "3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22",
    }).success,
  );
  assert(
    !runInvestigationBodySchema.safeParse({ investigationId: "not-a-uuid" })
      .success,
  );
  assert(
    runInvestigationBodySchema.safeParse({
      investigationId: "3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22",
      searchAnchor: { lat: 35.7295, lng: 139.7109 },
    }).success,
  );
  assert(
    !runInvestigationBodySchema.safeParse({
      investigationId: "3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22",
      searchAnchor: { lat: 91, lng: 139.7109 },
    }).success,
  );
  assert(
    !locationAnchorSchema.safeParse({
      lat: 35.7295,
      lng: 139.7109,
      rawQuery: "座標を保存",
    }).success,
  );
});

Deno.test("自己再呼出し body は検証済み一時 anchor だけを引き継ぐ", () => {
  assertEquals(
    buildRunReinvokeBody("3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22", {
      lat: 35.7295,
      lng: 139.7109,
    }),
    {
      investigationId: "3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22",
      searchAnchor: { lat: 35.7295, lng: 139.7109 },
    },
  );
  assertEquals(
    buildRunReinvokeBody("3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22"),
    { investigationId: "3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22" },
  );
});

Deno.test("rerankInvestigationBodySchema: trigger は vote / requirement_added / requirement_removed のみ", () => {
  const base = { investigationId: "3f2c1a30-9d4b-4c6a-8f0e-2b7d5e9a1c22" };
  assert(
    rerankInvestigationBodySchema.safeParse({ ...base, trigger: "vote" })
      .success,
  );
  assert(
    rerankInvestigationBodySchema.safeParse({
      ...base,
      trigger: "requirement_added",
    }).success,
  );
  assert(
    !rerankInvestigationBodySchema.safeParse({ ...base, trigger: "recount" })
      .success,
  );
});

Deno.test("joinInvestigationBodySchema: shareToken 空は弾く", () => {
  assert(
    joinInvestigationBodySchema.safeParse({
      shareToken: "tok",
      displayName: "えいと",
    }).success,
  );
  assert(
    !joinInvestigationBodySchema.safeParse({
      shareToken: "",
      displayName: "えいと",
    }).success,
  );
});
