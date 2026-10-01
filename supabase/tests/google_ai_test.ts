// providers/google_ai.ts のテスト (spec.md §5 Gemini REST / §30 リトライ 1 回 / §16.3 768 次元)
// fetch は全てスタブ (実ネットワークなし)。GEMINI_API_KEY はダミー値を Deno.env.set してから使う。
// GEMINI_MAX_CONCURRENCY は各module instanceの初回slot取得時に読まれるため、
// クエリ付きdynamic importでinstanceを分離し、実測中もenvを保持して検証する。
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { z } from "zod";
import {
  classifyGeminiHttpError,
  GoogleAIClient,
  identifyGeminiSchemaField,
  INVESTIGATION_SCHEMA,
  modelInvestigationSchema,
  structuredCall,
} from "../functions/_shared/providers/google_ai.ts";
import { AI_OUTPUT_LIMITS } from "../functions/_shared/validation.ts";

function withEnv(vars: Record<string, string | null>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  return () => {
    for (const [k, old] of saved) {
      if (old === undefined) Deno.env.delete(k);
      else Deno.env.set(k, old);
    }
  };
}

type Call = { url: string; init?: RequestInit };
type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

function stubFetch(
  handler: FetchHandler,
): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch =
    (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return await handler(url, init);
    }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Interactions API 実形 (2026-08-15 実測形。thought は拾われないことの検証も兼ねる)
const interactionRes = (text: string) =>
  jsonRes({
    status: "completed",
    steps: [
      {
        type: "thought",
        content: [{ type: "text", text: "(thought は無視される)" }],
      },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
    usage: { total_tokens: 10 },
  });

const ENV = { GEMINI_API_KEY: "dummy-gem-key" };
const okSchema = z.object({ ok: z.literal(true) });

Deno.test("Gemini HTTPエラーは本文を記録せず運用分類できる", () => {
  assertEquals(classifyGeminiHttpError(401, "invalid API key"), "auth");
  assertEquals(classifyGeminiHttpError(429, "quota exceeded"), "rate_limit");
  assertEquals(
    classifyGeminiHttpError(400, "Invalid JSON schema at response_format"),
    "request_schema",
  );
  assertEquals(
    classifyGeminiHttpError(503, "temporarily unavailable"),
    "upstream",
  );
  assertEquals(classifyGeminiHttpError(400, "bad request"), "unknown");
  assertEquals(
    identifyGeminiSchemaField(
      'Invalid JSON payload: unknown name "maxLength" at response_format',
    ),
    "maxLength",
  );
  assertEquals(identifyGeminiSchemaField("invalid argument"), "none");
});

Deno.test("Gemini investigation JSON SchemaとZodは同じ文字列・件数上限を持つ", () => {
  const properties = INVESTIGATION_SCHEMA.properties;
  assertEquals(properties.summary.type, "string");
  assertEquals(properties.findings.maxItems, AI_OUTPUT_LIMITS.findings);
  assertEquals(
    properties.findings.items.properties.explanation.type,
    "string",
  );
  assertEquals(
    properties.findings.items.properties.sourcePages.maxItems,
    AI_OUTPUT_LIMITS.sourceUrls,
  );
  assertEquals(
    properties.findings.items.properties.claims.maxItems,
    AI_OUTPUT_LIMITS.claimsPerFinding,
  );
  assertFalse("pattern" in properties.findings.items.properties.rid);

  const finding = {
    rid: "r1",
    state: "match",
    confidence: 0.8,
    explanation: "確認済み",
    sourcePages: [1],
    claims: [{ key: "card_accepted", value: true, rawText: "カード可" }],
  };
  assert(
    modelInvestigationSchema.safeParse({
      summary: "調査済み",
      findings: [finding],
    }).success,
  );
  assert(
    !modelInvestigationSchema.safeParse({
      summary: "要".repeat(AI_OUTPUT_LIMITS.summaryChars + 1),
      findings: [finding],
    }).success,
  );
  assert(
    !modelInvestigationSchema.safeParse({
      summary: "調査済み",
      findings: [{
        ...finding,
        sourcePages: Array(AI_OUTPUT_LIMITS.sourceUrls + 1).fill(1),
      }],
    }).success,
  );
  assert(
    !modelInvestigationSchema.safeParse({
      summary: "調査済み",
      findings: [{ ...finding, rid: "unknown-id" }],
    }).success,
  );
});

// ============================================================
// structuredCall (§30: Zod 失敗はエラーを添えて 1 回だけ再要求)
// ============================================================

Deno.test("structuredCall: steps から model_output の text を抽出し、thought は拾わない (§5)", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() => interactionRes('{"ok":true}'));
  try {
    const prompts: (string | null)[] = [];
    const out = await structuredCall(
      (prev) => {
        prompts.push(prev);
        return "プロンプト";
      },
      { type: "object" },
      (raw) => okSchema.safeParse(raw),
    );
    assertEquals(out, { ok: true });
    assertEquals(calls.length, 1); // 成功時は 1 回のみ
    assertEquals(prompts, [null]); // 初回は previousError = null
    // リクエスト形式: interactions への POST + APIキーヘッダ + 既定モデル
    assertEquals(
      calls[0].url,
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    assertEquals(headers["x-goog-api-key"], "dummy-gem-key");
    const body = JSON.parse(String(calls[0].init?.body));
    assertEquals(body.model, "gemini-3.6-flash");
    assertEquals(body.input, "プロンプト");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: steps が無く top-level text だけのレスポンスでも本文を抽出できる", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() => jsonRes({ text: '{"ok":true}' }));
  try {
    const out = await structuredCall(
      () => "p",
      {},
      (raw) => okSchema.safeParse(raw),
    );
    assertEquals(out, { ok: true });
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: content が文字列形のステップも本文として扱う", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() =>
    jsonRes({ steps: [{ type: "model_output", content: '{"ok":true}' }] })
  );
  try {
    const out = await structuredCall(
      () => "p",
      {},
      (raw) => okSchema.safeParse(raw),
    );
    assertEquals(out, { ok: true });
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: 1 回目 Zod 失敗 → エラー文言を添えて再要求 → 2 回目成功 (§30)", async () => {
  const restoreEnv = withEnv(ENV);
  let n = 0;
  const { calls, restore } = stubFetch(() =>
    interactionRes(++n === 1 ? '{"ok":false}' : '{"ok":true}')
  );
  try {
    const prompts: (string | null)[] = [];
    const out = await structuredCall(
      (prev) => {
        prompts.push(prev);
        return prev ? `修正して: ${prev}` : "初回";
      },
      {},
      (raw) => okSchema.safeParse(raw),
    );
    assertEquals(out, { ok: true });
    assertEquals(calls.length, 2);
    assertEquals(prompts[0], null);
    assert(prompts[1] !== null && prompts[1].length > 0); // Zod のエラー内容が渡る
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: 2 回とも不正なら失敗 (試行はちょうど 2 回。3 回目は無い §30 無限リトライ禁止)", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() => interactionRes('{"ok":false}'));
  try {
    await assertRejects(
      () => structuredCall(() => "p", {}, (raw) => okSchema.safeParse(raw)),
      Error,
      "Structured Output の検証に 2 回失敗",
    );
    assertEquals(calls.length, 2); // ちょうど 2 回。決して 3 回にしない
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: JSON parse 不能な本文も検証失敗として 1 回だけ再試行する", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() =>
    interactionRes("これは JSON ではない")
  );
  try {
    await assertRejects(
      () => structuredCall(() => "p", {}, (raw) => okSchema.safeParse(raw)),
      Error,
      "検証に 2 回失敗",
    );
    assertEquals(calls.length, 2);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: HTTP 429/500 は再試行せず即エラー伝播 (リトライは Zod 失敗専用)", async () => {
  // callInteraction の throw は structuredCall の try の外なので伝播する。実測挙動のピン留め:
  // レート制限 (429) もネットワーク由来として §30 のリトライ枠を消費しない
  for (const status of [429, 500]) {
    const restoreEnv = withEnv(ENV);
    const { calls, restore } = stubFetch(() =>
      new Response("quota exceeded", { status })
    );
    try {
      await assertRejects(
        () => structuredCall(() => "p", {}, (raw) => okSchema.safeParse(raw)),
        Error,
        `Gemini API error ${status}`,
      );
      assertEquals(calls.length, 1); // 再試行しない
    } finally {
      restore();
      restoreEnv();
    }
  }
});

Deno.test("structuredCall: timeout/abort は元の Gemini fetch へ伝播し、再試行を開始しない", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(
          init.signal?.reason ?? new DOMException("aborted", "AbortError"),
        );
      }, { once: true });
    })
  );
  const controller = new AbortController();
  try {
    const pending = structuredCall(
      () => "abort fixture",
      {},
      (raw) => okSchema.safeParse(raw),
      undefined,
      controller.signal,
    );
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(calls.length, 1);
    controller.abort(new Error("candidate timeout"));
    await assertRejects(() => pending, Error, "candidate timeout");
    assertEquals(calls[0].init?.signal?.aborted, true);
    assertEquals(calls.length, 1); // abortした呼出しを重複retryしない
  } finally {
    controller.abort();
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: 本文を 1 文字も抽出できないレスポンスはエラー (thought のみ等)", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() =>
    jsonRes({
      steps: [{ type: "thought", content: [{ type: "text", text: "考え中" }] }],
    })
  );
  try {
    await assertRejects(
      () => structuredCall(() => "p", {}, (raw) => okSchema.safeParse(raw)),
      Error,
      "Gemini レスポンスから本文を抽出できませんでした",
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("structuredCall: GEMINI_API_KEY 未設定は fetch せずエラー", async () => {
  const restoreEnv = withEnv({ GEMINI_API_KEY: null });
  const { calls, restore } = stubFetch(() => interactionRes('{"ok":true}'));
  try {
    await assertRejects(
      () => structuredCall(() => "p", {}, (raw) => okSchema.safeParse(raw)),
      Error,
      "GEMINI_API_KEY が未設定",
    );
    assertEquals(calls.length, 0);
  } finally {
    restore();
    restoreEnv();
  }
});

// ============================================================
// GoogleAIClient.parseRequirements (§11 / §25.1)
// ============================================================

Deno.test("parseRequirements: 正常レスポンスを ParsedRequirements として返し、プロンプトに日付とクエリを含む", async () => {
  const parsed = {
    title: "8/23 池袋 夜飯",
    normalizedQuery: "池袋 焼肉 3000円",
    area: "池袋",
    requirements: [
      {
        text: "3000円",
        normalizedText: "予算 3000円前後",
        kind: "budget",
        priority: "must",
        weight: 1,
      },
    ],
  };
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() =>
    interactionRes(JSON.stringify(parsed))
  );
  try {
    const out = await new GoogleAIClient().parseRequirements(
      "池袋で焼肉、3000円",
    );
    assertEquals(out, parsed);
    const body = JSON.parse(String(calls[0].init?.body));
    assertStringIncludes(body.input, "今日の日付:"); // 日付捏造防止 (JST 明示)
    assertStringIncludes(body.input, "池袋で焼肉、3000円");
    assertStringIncludes(body.input, "同一内容・同一意味の条件");
    assertStringIncludes(body.input, "weight を加算しない");
    assertStringIncludes(body.input, "「好き」は原則 should");
    assertStringIncludes(body.input, "kind=location");
    assertStringIncludes(body.input, "kind=access");
    assertStringIncludes(body.input, "kind=dietary");
    assertStringIncludes(body.input, "kind=cuisine");
    assertStringIncludes(body.input, "抽象条件の weight は具体条件を超えない");
    assert(body.response_format.schema !== undefined); // Structured Output schema 添付
    assertEquals(
      body.response_format.schema.properties.title.type,
      "string",
    );
    assertEquals(
      body.response_format.schema.properties.requirements.maxItems,
      undefined,
    );
    assertEquals(
      body.response_format.schema.properties.requirements.items.properties
        .normalizedText.type,
      "string",
    );
    assertEquals(body.response_format.schema.additionalProperties, undefined);
    assertEquals(
      body.response_format.schema.properties.requirements.items
        .additionalProperties,
      undefined,
    );
    const locationScope = body.response_format.schema.properties.locationScope;
    assertEquals(locationScope.required, ["type"]);
    assertEquals(locationScope.additionalProperties, false);
    assertEquals(locationScope.properties.type.enum, [
      "current_location",
      "point",
      "any_of",
      "multi_origin",
      "line",
      "between",
      "corridor",
      "station_hops",
      "travel_time",
    ]);
    assertEquals(Object.keys(locationScope.properties), [
      "type",
      "place",
      "places",
      "origins",
      "line",
      "operator",
      "from",
      "to",
      "origin",
      "maxStops",
      "maxMinutes",
    ]);
    assertStringIncludes(
      body.input,
      "locationScope.type は「current_location」",
    );
    assertStringIncludes(body.input, "type=any_of");
    assertStringIncludes(body.input, "type=multi_origin");
    assertStringIncludes(
      body.input,
      "lat/lng やその他のGPS座標を絶対に含めない",
    );
    // Gemini Structured Output は文字列の min/maxLength・pattern を
    // 対応しないため、長さと形式の境界は Zod 側で強制する。
    assertEquals(
      body.response_format.schema.properties.title.minLength,
      undefined,
    );
    assertEquals(
      body.response_format.schema.properties.title.maxLength,
      undefined,
    );
    assertEquals(
      body.response_format.schema.properties.requirements.items.properties
        .normalizedText.maxLength,
      undefined,
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("parseRequirements: 不正な構造化応答を再要求せず1 interactionで失敗する", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() => interactionRes("{}"));
  try {
    await assertRejects(
      () => new GoogleAIClient().parseRequirements("池袋で夜飯"),
      Error,
      "1 回失敗",
    );
    assertEquals(calls.length, 1);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("parseRequirements: 注入時刻が UTC 翌日境界を越えた場合の JST 日付を prompt に含む", async () => {
  const parsed = {
    title: "8/18 池袋 夜飯",
    normalizedQuery: "池袋 夜飯",
    area: "池袋",
    requirements: [{
      text: "池袋",
      normalizedText: "池袋",
      kind: "location",
      priority: "must",
      weight: 1,
    }],
  };
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() =>
    interactionRes(JSON.stringify(parsed))
  );
  try {
    // AI 応答は固定 stub。このテストは相対日付の解釈ではなく、
    // prompt に注入される JST 基準日だけを決定的に検証する。
    await new GoogleAIClient(
      () => new Date("2026-08-17T15:30:00.000Z"),
    ).parseRequirements("池袋で夜飯");
    const body = JSON.parse(String(calls[0].init?.body));
    assertStringIncludes(body.input, "今日の日付: 2026-08-18 (JST)");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("parseRequirements: AI_MODEL 環境変数でモデルを差し替えられる", async () => {
  const parsed = {
    title: "t",
    normalizedQuery: "q",
    area: "池袋",
    requirements: [{
      text: "a",
      normalizedText: "a",
      kind: "other",
      priority: "nice",
      weight: 0.5,
    }],
  };
  const restoreEnv = withEnv({ ...ENV, AI_MODEL: "test-model-override" });
  const { calls, restore } = stubFetch(() =>
    interactionRes(JSON.stringify(parsed))
  );
  try {
    await new GoogleAIClient().parseRequirements("q");
    assertEquals(
      JSON.parse(String(calls[0].init?.body)).model,
      "test-model-override",
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("parseRequirements: Structured Output 検証後に同一条件を決定論的に統合する", async () => {
  const baseRequirement = {
    text: "好き: 肉",
    normalizedText: "好き: 肉",
    kind: "cuisine",
    priority: "should",
    weight: 0.7,
  } as const;
  const parsed = {
    title: "8/23 天神 夜飯",
    normalizedQuery: "天神 肉",
    area: "天神",
    requirements: [
      baseRequirement,
      {
        ...baseRequirement,
        normalizedText: "好き：　肉",
        priority: "must" as const,
        weight: 1,
      },
    ],
  };
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() => interactionRes(JSON.stringify(parsed)));
  try {
    const out = await new GoogleAIClient().parseRequirements(
      "好き: 肉 / 好き: 肉",
    );
    assertEquals(out.requirements, [baseRequirement]);
  } finally {
    restore();
    restoreEnv();
  }
});

// ============================================================
// GoogleAIClient.embed (§16.3: output_dimensionality=768 固定)
// ============================================================

const vec = (dim: number) => Array.from({ length: dim }, (_, i) => i / dim);

Deno.test("embed: embedding.values を 768 次元 vector として返し、テキストごとに独立リクエスト (§5)", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() =>
    jsonRes({ embedding: { values: vec(768) } })
  );
  try {
    const out = await new GoogleAIClient().embed(["文1", "文2"]);
    assertEquals(out.length, 2);
    assertEquals(out[0].length, 768);
    assertEquals(calls.length, 2); // 1 テキスト = 1 リクエスト (まとめ送りしない)
    assertStringIncludes(calls[0].url, "gemini-embedding-2:embedContent");
    const body = JSON.parse(String(calls[0].init?.body));
    assertEquals(body.outputDimensionality, 768);
    assertEquals(body.content.parts, [{ text: "文1" }]);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("Gemini instrumentation は API時間とセマフォ待ちを数値で分離し、入力本文を渡さない", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() =>
    jsonRes({ embedding: { values: vec(768) } })
  );
  const metrics: Array<Record<string, unknown>> = [];
  try {
    const out = await new GoogleAIClient(
      () => new Date(),
      { onMetric: (metric) => metrics.push({ ...metric }) },
    ).embed(["機密入力ではないfixture1", "fixture2"]);
    assertEquals(out.length, 2);
    assertEquals(metrics.length, 2);
    for (const metric of metrics) {
      assertEquals(metric.provider, "gemini");
      assertEquals(metric.operation, "embedding");
      assert(typeof metric.durationMs === "number");
      assert(typeof metric.semaphoreWaitMs === "number");
      assertEquals(metric.retryCount, 0);
      assertEquals(metric.itemCount, 1);
      assert(metric.outcome === "ok" || metric.outcome === "error");
    }
    const serialized = JSON.stringify(metrics);
    assert(!serialized.includes("機密入力ではないfixture1"));
    assert(!serialized.includes("fixture2"));
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("Gemini structured retry は API境界ごとの retry_count を1回だけ記録する", async () => {
  const restoreEnv = withEnv(ENV);
  let attempt = 0;
  const { restore } = stubFetch(() => {
    attempt += 1;
    return interactionRes(
      attempt === 1
        ? JSON.stringify({ bad: true })
        : JSON.stringify({ ok: "fixture" }),
    );
  });
  const metrics: Array<Record<string, unknown>> = [];
  try {
    const out = await structuredCall(
      () => "retry fixture prompt",
      { type: "object" },
      (raw) => z.object({ ok: z.string() }).safeParse(raw),
      { onMetric: (metric) => metrics.push({ ...metric }) },
    );
    assertEquals(out, { ok: "fixture" });
    assertEquals(attempt, 2);
    assertEquals(metrics.length, 2);
    assertEquals(metrics.map((metric) => metric.retryCount), [0, 1]);
    assert(metrics.every((metric) => typeof metric.durationMs === "number"));
    assert(!JSON.stringify(metrics).includes("retry fixture prompt"));
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("embed: 次元が 768 と一致しないレスポンスはエラー (§16.3 DB vector(768) との整合)", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() =>
    jsonRes({ embedding: { values: vec(767) } })
  );
  try {
    await assertRejects(
      () => new GoogleAIClient().embed(["文"]),
      Error,
      "embedding 次元が不正: 767 (期待 768)",
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("embed: string/null/NaN/Infinity要素をprovider ingressで拒否しPIIなしerror metricを出す", async () => {
  for (const invalid of ["0.1", null, Number.NaN, Infinity]) {
    const restoreEnv = withEnv(ENV);
    const values: unknown[] = vec(768);
    values[123] = invalid;
    const { restore } = stubFetch(() => jsonRes({ embedding: { values } }));
    const metrics: Array<Record<string, unknown>> = [];
    try {
      await assertRejects(
        () =>
          new GoogleAIClient(
            () => new Date(),
            { onMetric: (metric) => metrics.push({ ...metric }) },
          ).embed(["保存してはいけない入力fixture"]),
        Error,
        "embedding 要素が不正",
      );
      assertEquals(metrics.length, 1);
      assertEquals(metrics[0].operation, "embedding");
      assertEquals(metrics[0].outcome, "error");
      assertEquals(
        JSON.stringify(metrics).includes("保存してはいけない入力fixture"),
        false,
      );
    } finally {
      restore();
      restoreEnv();
    }
  }
});

Deno.test("embed: values 欠落 / HTTP 500 はエラー", async () => {
  const restoreEnv = withEnv(ENV);
  const missing = stubFetch(() => jsonRes({ embedding: {} }));
  try {
    await assertRejects(
      () => new GoogleAIClient().embed(["文"]),
      Error,
      "embedding 次元が不正: なし",
    );
  } finally {
    missing.restore();
    restoreEnv();
  }
  const restoreEnv2 = withEnv(ENV);
  const err = stubFetch(() => new Response("oops", { status: 500 }));
  try {
    await assertRejects(
      () => new GoogleAIClient().embed(["文"]),
      Error,
      "Embedding API error 500",
    );
  } finally {
    err.restore();
    restoreEnv2();
  }
});

Deno.test("embed: EMBEDDING_MODELは差し替え可能だが出力次元は768固定", async () => {
  const restoreEnv = withEnv({
    ...ENV,
    EMBEDDING_MODEL: "test-embed-model",
    EMBEDDING_DIM: "768",
  });
  const { calls, restore } = stubFetch(() =>
    jsonRes({ embedding: { values: vec(768) } })
  );
  try {
    const out = await new GoogleAIClient().embed(["文"]);
    assertEquals(out[0].length, 768);
    assertStringIncludes(calls[0].url, "test-embed-model:embedContent");
    assertEquals(
      JSON.parse(String(calls[0].init?.body)).outputDimensionality,
      768,
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("embed: EMBEDDING_DIMを768以外へ変更するとfetch前に拒否する", async () => {
  const restoreEnv = withEnv({ ...ENV, EMBEDDING_DIM: "8" });
  const { calls, restore } = stubFetch(() =>
    jsonRes({ embedding: { values: vec(8) } })
  );
  try {
    await assertRejects(
      () => new GoogleAIClient().embed(["文"]),
      Error,
      "768 に固定",
    );
    assertEquals(calls.length, 0);
  } finally {
    restore();
    restoreEnv();
  }
});

// ============================================================
// GEMINI_MAX_CONCURRENCY セマフォ (§5: 同時 1〜2 に制限)
// モジュール内の maxConcurrency / active はモジュール単位の状態なので、
// クエリ付き dynamic import で毎回新しいインスタンスを評価して観測する。
// env は初回使用時 (measurePeak 内の最初の embed) に読まれるため、
// measurePeak 実行中も GEMINI_MAX_CONCURRENCY を設定したままにする。
// ============================================================

interface GoogleAIModule {
  GoogleAIClient: new () => { embed(texts: string[]): Promise<number[][]> };
}

async function importFresh(concurrency: string): Promise<GoogleAIModule> {
  const url = new URL(
    `../functions/_shared/providers/google_ai.ts?conc=${
      encodeURIComponent(concurrency)
    }`,
    import.meta.url,
  ).href;
  return (await import(url)) as GoogleAIModule;
}

// 3 並列の embed を発射し、fetch の同時実行ピークを実測する
async function measurePeak(
  mod: GoogleAIModule,
  concurrency: string,
): Promise<number> {
  let active = 0;
  let peak = 0;
  let started = 0;
  const gates: Array<() => void> = [];
  const { restore } = stubFetch(() => {
    active++;
    started++;
    peak = Math.max(peak, active);
    return new Promise<Response>((resolve) => {
      gates.push(() => {
        active--;
        resolve(jsonRes({ embedding: { values: vec(768) } }));
      });
    });
  });
  const restoreEnv = withEnv({ ...ENV, GEMINI_MAX_CONCURRENCY: concurrency });
  try {
    const client = new mod.GoogleAIClient();
    const all = Promise.all([
      client.embed(["a"]),
      client.embed(["b"]),
      client.embed(["c"]),
    ]);
    // セマフォで許される分だけ fetch が始まるのを待つ (実 I/O なし。タイマーだけ)
    await new Promise((r) => setTimeout(r, 30));
    while (started < 3) {
      while (gates.length > 0) gates.shift()!();
      await new Promise((r) => setTimeout(r, 10));
    }
    while (gates.length > 0) gates.shift()!();
    await all;
    return peak;
  } finally {
    restore();
    restoreEnv();
  }
}

Deno.test("セマフォ: GEMINI_MAX_CONCURRENCY=-1 は Math.max(1,·) で同時 1 に制限される", async () => {
  const mod = await importFresh("-1");
  assertEquals(await measurePeak(mod, "-1"), 1);
});

Deno.test("セマフォ: GEMINI_MAX_CONCURRENCY=abc (数値でない) は既定 2 になる", async () => {
  const mod = await importFresh("abc");
  assertEquals(await measurePeak(mod, "abc"), 2);
});

Deno.test("セマフォ: GEMINI_MAX_CONCURRENCY=0 は既定 2 になる (`parseInt||2` で 0 は falsy のため)", async () => {
  // Math.max(1, 0) = 1 ではなく、`|| 2` が先に効いて 2。コードコメント (既定 2) 通りだが
  // 「0 で全停止/直列化したい」意図では使えないことをピン留めする
  const mod = await importFresh("0");
  assertEquals(await measurePeak(mod, "0"), 2);
});
