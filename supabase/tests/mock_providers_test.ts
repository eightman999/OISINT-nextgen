// providers/mock_place.ts + mock_research.ts のテスト (spec.md §26 providers / §5.4 Fallback / §16.3)
// mock は外部 API 停止時のデモ完走を支える経路。決定論・型整合 (live と同じ interface) を検証する。
// 外部 API 非依存のため fetch スタブは不要 (呼ばれないことが仕様)。
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "@std/assert";
import { MockPlaceProvider } from "../functions/_shared/providers/mock_place.ts";
import { MockAIProvider } from "../functions/_shared/providers/mock_research.ts";
import {
  filterValidClaims,
  groundedCandidateInvestigationSchema,
  parsedRequirementsSchema,
  type StructuredClaimInput,
} from "../functions/_shared/validation.ts";
import type { CandidateInvestigationInput } from "../functions/_shared/providers/types.ts";

const query = { area: "池袋", keyword: "焼肉", limit: 3 };

// ============================================================
// MockPlaceProvider (§5.4: 固定 3 店舗のアンカー)
// ============================================================

Deno.test("mock_place: limit 件数の候補を返し、同一入力は同一出力 (決定論)", async () => {
  const p = new MockPlaceProvider();
  const a = await p.search(query);
  const b = await p.search(query);
  assertEquals(a.length, 3);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assertEquals((await p.search({ ...query, limit: 2 })).length, 2);
});

Deno.test("mock_place: PlaceSearchResult の構造を満たす (provider/id/URL/metadata #107)", async () => {
  const results = await new MockPlaceProvider().search(query);
  for (const r of results) {
    assertEquals(r.provider, "mock"); // live 調査ガードの対象 (§5.4)
    assert(r.providerPlaceId.startsWith("mock-"));
    assert(r.name.length > 0);
    assert(r.address.length > 0);
    assert(typeof r.lat === "number" && typeof r.lng === "number");
    assert(r.url.startsWith("https://"));
    // metadata は live provider と同一構造 (photoUrl / shopUrl)
    assertEquals(r.metadata.source, "mock");
    assert(typeof r.metadata.photoUrl === "string");
    assert(typeof r.metadata.shopUrl === "string");
  }
  // providerPlaceId は一意
  assertEquals(new Set(results.map((r) => r.providerPlaceId)).size, 3);
});

Deno.test("mock_place: 全 structuredClaims が §13 の key 別 schema を通る (validation.ts と整合)", async () => {
  const results = await new MockPlaceProvider().search(query);
  for (const r of results) {
    const claims = r.structuredClaims as StructuredClaimInput[];
    assertEquals(
      filterValidClaims(claims).length,
      claims.length,
      `${r.name} に schema を通らない claim がある`,
    );
  }
});

// ============================================================
// MockAIProvider.embed = pseudoEmbedding (§16.3: 768 次元固定)
// ============================================================

Deno.test("mock_research.embed: 768 次元・値域 [-1,1]・単位ノルムの vector を返す", async () => {
  const [v] = await new MockAIProvider().embed(["池袋で静かに焼肉"]);
  assertEquals(v.length, 768);
  assert(v.every((x) => x >= -1 && x <= 1));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assertAlmostEquals(norm, 1, 1e-9); // 正規化済み
});

Deno.test("mock_research.embed: 同一テキストは同一 vector (決定論)、異なるテキストは異なる vector", async () => {
  const ai = new MockAIProvider();
  const [a1] = await ai.embed(["同じテキスト"]);
  const [a2] = await ai.embed(["同じテキスト"]);
  assertEquals(a1, a2);
  const [b] = await ai.embed(["違うテキスト"]);
  assertNotEquals(a1, b);
});

Deno.test("mock_research.embed: 文字列ごとに独立した vector を返す (§5 Embedding Rule)", async () => {
  const ai = new MockAIProvider();
  const out = await ai.embed(["a", "b", "a"]);
  assertEquals(out.length, 3);
  assertEquals(out[0], out[2]); // 同一テキストは同一
  assertNotEquals(out[0], out[1]);
  assertEquals(await ai.embed([]), []);
});

// ============================================================
// MockAIProvider.parseRequirements = parseByKeywords (§11 の mock 版)
// ============================================================

Deno.test("mock_research.parse: 代表的な日本語クエリが期待どおりの kind に割れる", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "8/23に池袋で焼肉。予算3000円、個室で静か、4人、カード払いしたい。辛くないものがいい",
  );
  // parsedRequirementsSchema を通る (live と同じ型 §26)
  assert(parsedRequirementsSchema.safeParse(out).success);
  assertEquals(out.area, "池袋");
  const byKind = new Map(out.requirements.map((r) => [r.kind, r]));
  assertEquals(byKind.get("budget")?.normalizedText, "予算 3000円前後");
  assertEquals(byKind.get("budget")?.priority, "must");
  assertEquals(
    byKind.get("payment")?.normalizedText,
    "クレジットカード利用可能",
  );
  assertEquals(byKind.get("cuisine")?.normalizedText, "肉料理が主体の店");
  assertEquals(
    byKind.get("atmosphere")?.normalizedText,
    "静かで落ち着いた雰囲気",
  );
  assertEquals(byKind.get("reservation")?.normalizedText, "個室あり"); // 個室 → reservation
  assertEquals(byKind.get("party_size")?.normalizedText, "4人で利用可能");
  assertEquals(byKind.get("dietary")?.normalizedText, "辛くない料理がある");
});

Deno.test("mock_research.parse: 4種のfilter chipを独立Requirementとして保持する", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "池袋 / 禁煙 / Wi-Fi / 子連れOK / 徒歩5分以内",
  );
  assert(parsedRequirementsSchema.safeParse(out).success);
  const filters = out.requirements.filter((requirement) =>
    ["禁煙", "Wi-Fi", "子連れOK", "徒歩5分以内"].includes(
      requirement.normalizedText,
    )
  );
  assertEquals(
    filters.map((requirement) => [
      requirement.normalizedText,
      requirement.kind,
    ]),
    [
      ["禁煙", "atmosphere"],
      ["Wi-Fi", "other"],
      ["子連れOK", "other"],
      ["徒歩5分以内", "access"],
    ],
  );
});

Deno.test("mock_research.parse: 「安い」「朝」が budget / time の requirement になる (#312)", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "六本木で1人。安い店。クレジットカード利用可。朝やってるところ",
  );
  assert(parsedRequirementsSchema.safeParse(out).success);
  const byKind = new Map(out.requirements.map((r) => [r.kind, r]));
  assertEquals(byKind.get("budget")?.normalizedText, "安い価格帯");
  assertEquals(byKind.get("budget")?.priority, "must");
  assertEquals(byKind.get("time")?.normalizedText, "朝の時間帯に営業している");
  assertEquals(byKind.get("time")?.priority, "must");
});

Deno.test("mock_research.parse: 明示金額があれば「安い」より金額側を budget にする (#312)", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "安いところ。3000円くらいで",
  );
  const budgets = out.requirements.filter((r) => r.kind === "budget");
  assertEquals(budgets.length, 1);
  assertEquals(budgets[0].normalizedText, "予算 3000円前後");
});

Deno.test("mock_research.parse: provider を直接呼んでも反復条件を重複出力しない", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "池袋で肉、焼肉、ステーキ、肉料理を食べたい",
  );
  const cuisine = out.requirements.filter((r) => r.kind === "cuisine");

  assertEquals(cuisine.length, 1);
  assertEquals(cuisine[0].normalizedText, "肉料理が主体の店");
});

Deno.test("mock_research.parse: 場所context付き桁comma/まで予算をbudgetとして保持する", async () => {
  const ai = new MockAIProvider();
  for (const query of ["池袋で予算3,000円以下", "池袋で予算3000円まで"]) {
    const out = await ai.parseRequirements(query);
    const budget = out.requirements.find((requirement) =>
      requirement.kind === "budget"
    );
    assert(budget, query);
  }
});

Deno.test("mock_research.parse: 否定・除外条件を肯定deterministic kindへ反転しない", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "カードは使いたくない。4人では利用しない。予算3000円以下は避けたい",
  );
  const kinds = out.requirements.map((requirement) => requirement.kind);
  assertEquals(kinds.includes("payment"), false);
  assertEquals(kinds.includes("party_size"), false);
  assertEquals(kinds.includes("budget"), false);
  assert(kinds.includes("other"));

  const research = await new MockAIProvider().investigateCandidate(inputOf(
    "mock-002",
    out.requirements.map((requirement, index) => ({
      id: `negative-${index}`,
      normalizedText: requirement.normalizedText,
      kind: requirement.kind,
      priority: requirement.priority,
    })),
  ));
  assert(research.findings.every((finding) => finding.state === "unknown"));
});

Deno.test("mock_research.parse: エリア語が無ければ池袋へフォールバック。既知エリアは検出", async () => {
  const ai = new MockAIProvider();
  assertEquals((await ai.parseRequirements("焼肉たべたい")).area, "池袋");
  assertEquals((await ai.parseRequirements("新宿で3000円")).area, "新宿");
});

Deno.test("mock_research.parse: 現在地を池袋へ置換せずstrict scopeとして返す", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "現在地付近で寿司",
  );
  assertEquals(out.area, "現在地");
  assertEquals(out.locationScope, { type: "current_location" });
  assert(parsedRequirementsSchema.safeParse(out).success);
  assertEquals(Object.keys(out.locationScope ?? {}), ["type"]);
});

Deno.test("mock_research.parse: 複数地点scopeを保持し、areaはlegacy表示用の先頭地点にする", async () => {
  const ai = new MockAIProvider();
  const alternatives = await ai.parseRequirements("渋谷か新宿で焼肉");
  assertEquals(alternatives.area, "渋谷");
  assertEquals(alternatives.locationScope, {
    type: "any_of",
    places: ["渋谷", "新宿"],
  });
  const origins = await ai.parseRequirements("渋谷と新宿から集まりやすい店");
  assertEquals(origins.area, "渋谷");
  assertEquals(origins.locationScope, {
    type: "multi_origin",
    origins: ["渋谷", "新宿"],
  });
});

Deno.test("mock_research.parse: キーワードに一致しない入力は other 1 件のフォールバック", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "なんかいい感じのところ",
  );
  assertEquals(out.requirements.length, 1);
  assertEquals(out.requirements[0].kind, "other");
  assertEquals(out.requirements[0].priority, "should");
});

Deno.test("mock_research.parse: normalizedQuery は空白を単一スペースへ正規化。title は 'M/D エリア 夜飯'", async () => {
  const out = await new MockAIProvider().parseRequirements(
    "池袋で　 焼肉\n3000円",
  );
  assertEquals(out.normalizedQuery, "池袋で 焼肉 3000円");
  assert(
    /^\d{1,2}\/\d{1,2} 池袋 夜飯$/.test(out.title),
    `title 形式外: ${out.title}`,
  );
});

// ============================================================
// MockAIProvider.investigateCandidate (§12 / §15 矛盾デモ)
// ============================================================

function inputOf(
  providerPlaceId: string,
  requirements: CandidateInvestigationInput["requirements"],
  knownClaims: CandidateInvestigationInput["knownClaims"] = [],
): CandidateInvestigationInput {
  return {
    place: {
      name: "テスト店",
      address: "東京都豊島区池袋1-1-1",
      providerPlaceId,
    },
    requirements,
    knownClaims,
  };
}

const req = (id: string, kind: string) => ({
  id,
  normalizedText: `req-${kind}`,
  kind,
  priority: "must",
});

Deno.test("mock_research.investigate: 出力は groundedCandidateInvestigationSchema を通り、決定論", async () => {
  const ai = new MockAIProvider();
  const input = inputOf("mock-002", [
    req("r1", "payment"),
    req("r2", "atmosphere"),
  ], [
    { key: "card_accepted", value: true, rawText: "カード利用可" },
    {
      key: "noise_level",
      value: "quiet",
      rawText: "全席完全個室で落ち着いて話せる",
    },
  ]);
  const a = await ai.investigateCandidate(input);
  const b = await ai.investigateCandidate(input);
  assert(groundedCandidateInvestigationSchema.safeParse(a).success);
  assertEquals(JSON.stringify(a), JSON.stringify(b)); // 同一入力 → 同一出力
});

Deno.test("mock_research.investigate: knownClaims と一致する条件は match、根拠 URL は citations に含まれる", async () => {
  const out = await new MockAIProvider().investigateCandidate(
    inputOf("mock-002", [req("r1", "payment")], [
      { key: "card_accepted", value: true, rawText: "カード利用可" },
    ]),
  );
  const f = out.findings[0];
  assertEquals(f.state, "match");
  assertEquals(f.confidence, 0.9);
  const citationUrls = new Set(out.citations.map((c) => c.url));
  assert(
    f.sourceUrls.every((u) => citationUrls.has(u)),
    "sourceUrls が citations の外を指す",
  );
});

Deno.test("mock_research.investigate: filter chipがmock候補ごとのclaimで結果へ影響する", async () => {
  const requirements: CandidateInvestigationInput["requirements"] = [
    {
      id: "r-smoking",
      normalizedText: "禁煙",
      kind: "atmosphere",
      priority: "should",
    },
    {
      id: "r-wifi",
      normalizedText: "Wi-Fi",
      kind: "other",
      priority: "should",
    },
    {
      id: "r-child",
      normalizedText: "子連れOK",
      kind: "other",
      priority: "should",
    },
    {
      id: "r-walk",
      normalizedText: "徒歩5分以内",
      kind: "access",
      priority: "should",
    },
  ];
  const places = await new MockPlaceProvider().search(query);
  const states: Record<string, string[]> = {};
  for (const place of places) {
    const result = await new MockAIProvider().investigateCandidate(
      inputOf(place.providerPlaceId, requirements, place.structuredClaims),
    );
    states[place.providerPlaceId] = result.findings.map((finding) =>
      finding.state
    );
  }
  assertEquals(states, {
    "mock-001": ["match", "match", "match", "match"],
    "mock-002": ["match", "mismatch", "match", "mismatch"],
    "mock-003": ["mismatch", "match", "mismatch", "mismatch"],
  });
});

Deno.test("mock_research.investigate: claim 不一致は mismatch、根拠のない kind は unknown/根拠なし", async () => {
  const out = await new MockAIProvider().investigateCandidate(
    inputOf("mock-003", [req("r1", "payment"), req("r2", "access")], [
      { key: "card_accepted", value: false, rawText: "現金のみ" },
    ]),
  );
  const [payment, access] = out.findings;
  assertEquals(payment.state, "mismatch");
  assertEquals(access.state, "unknown");
  assertEquals(access.confidence, 0); // 不明は断定しない (§12)
  assertEquals(access.sourceUrls, []);
});

Deno.test("mock_research.investigate: mock-001 のみ公式サイト側 opening_hours (23:00) が注入され §15 矛盾ペアになる", async () => {
  const ai = new MockAIProvider();
  const hpClaim = {
    key: "opening_hours" as const,
    value: "11:30-24:00",
    rawText: "営業時間 11:30～翌0:00",
  };
  const withTime = await ai.investigateCandidate(
    inputOf("mock-001", [req("r1", "time")], [hpClaim]),
  );
  const timeClaims = withTime.findings[0].claims.filter((c) =>
    c.key === "opening_hours"
  );
  // place provider 側 24:00 と公式(デモ用) 23:00 の両方が残る (片方へ丸めない §15)
  assertEquals(timeClaims.map((c) => c.value).sort(), [
    "11:30-23:00",
    "11:30-24:00",
  ]);

  // mock-001 以外には注入されない
  const other = await ai.investigateCandidate(
    inputOf("mock-002", [req("r1", "time")], [
      {
        key: "opening_hours",
        value: "15:00-23:00",
        rawText: "営業時間 15:00～23:00",
      },
    ]),
  );
  assertEquals(
    other.findings[0].claims.filter((c) => c.key === "opening_hours").map((c) =>
      c.value
    ),
    ["15:00-23:00"],
  );
});

Deno.test("mock_research.investigate: time 系条件が無くても mock-001 の矛盾 claim は先頭 finding に添付される", async () => {
  const out = await new MockAIProvider().investigateCandidate(
    inputOf("mock-001", [req("r1", "payment")], [
      { key: "card_accepted", value: true, rawText: "カード利用可" },
    ]),
  );
  const first = out.findings[0];
  assert(
    first.claims.some((c) =>
      c.key === "opening_hours" && c.value === "11:30-23:00"
    ),
  );
  // 添付時は officialUrl も sourceUrls に足される
  assert(first.sourceUrls.some((u) => u.endsWith("/official")));
});

Deno.test("mock_research.investigate: atmosphere は noise_level=quiet で match、無ければ partial", async () => {
  const ai = new MockAIProvider();
  const quiet = await ai.investigateCandidate(
    inputOf("mock-002", [req("r1", "atmosphere")], [
      { key: "noise_level", value: "quiet", rawText: "静か" },
    ]),
  );
  assertEquals(quiet.findings[0].state, "match");
  assertEquals(quiet.findings[0].confidence, 0.75);

  const unknownNoise = await ai.investigateCandidate(
    inputOf("mock-003", [req("r1", "atmosphere")]),
  );
  assertEquals(unknownNoise.findings[0].state, "partial");
  assertEquals(unknownNoise.findings[0].confidence, 0.6);
});

Deno.test("mock_research.investigate: MockPlaceProvider の claims をそのまま流すと全 finding が §30 検証を通る", async () => {
  // 実運用 (run-investigation) と同じ流し方: mock place の structuredClaims を knownClaims に渡す
  const [place] = await new MockPlaceProvider().search({
    area: "池袋",
    limit: 1,
  });
  const out = await new MockAIProvider().investigateCandidate({
    place: {
      name: place.name,
      address: place.address,
      providerPlaceId: place.providerPlaceId,
    },
    requirements: [
      req("r1", "budget"),
      req("r2", "party_size"),
      req("r3", "time"),
      req("r4", "cuisine"),
    ],
    knownClaims: place.structuredClaims,
  });
  const check = groundedCandidateInvestigationSchema.safeParse(out);
  assert(check.success);
  assertEquals(check.data.findings.length, 4);
  // budget / party_size / time / cuisine すべて claim で裏付けられ match
  assertEquals(check.data.findings.map((f) => f.state), [
    "match",
    "match",
    "match",
    "match",
  ]);
});
