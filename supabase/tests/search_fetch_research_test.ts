// providers/search_fetch_research.ts のテスト (spec.md §5 Research Backend / §5.4 Hard Rule 8 / §30)
// buildQueries (純関数) と、fetch 全面スタブによる investigateCandidate のフローを検証する。
// Serper / ページ / Gemini への呼び出しはすべて globalThis.fetch スタブで捕捉 (実ネットワークなし)。
// API キーはダミー値。SUPABASE_URL 未設定で external_cache 層は無効化される。
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildQueries,
  SearchFetchResearchProvider,
} from "../functions/_shared/providers/search_fetch_research.ts";
import {
  fetchPageTextWithDependencies,
  type SafeFetchDependencies,
} from "../functions/_shared/providers/fetcher.ts";
import type { FetchedPage } from "../functions/_shared/providers/fetcher.ts";
import { groundedCandidateInvestigationSchema } from "../functions/_shared/validation.ts";
import type {
  CandidateInvestigationInput,
  ResearchEvaluationRequest,
  SearchFetchResearchDependencies,
} from "../functions/_shared/providers/types.ts";

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

function stubFetch(handler: FetchHandler): {
  calls: Call[];
  fetchPage: (url: string) => Promise<FetchedPage | null>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const invoke = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return await handler(url, init);
  };
  globalThis.fetch =
    (async (input: Request | URL | string, init?: RequestInit) =>
      await invoke(
        input instanceof Request ? input.url : String(input),
        init,
      )) as typeof fetch;
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: "deny-private-public-egress-v1",
    resolveDns: (_hostname, recordType) =>
      Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []),
    fetchHop: (url, _validatedAddresses, init) => invoke(url, init),
  };
  return {
    calls,
    fetchPage: (url) => fetchPageTextWithDependencies(url, dependencies),
    restore: () => (globalThis.fetch = original),
  };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const htmlRes = (html: string) =>
  new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
// Gemini Interactions API の実形 (google_ai.ts のコメント準拠)
const geminiRes = (text: string) =>
  jsonRes({
    status: "completed",
    steps: [
      {
        type: "thought",
        content: [{ type: "text", text: "(内部思考は拾われない)" }],
      },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
  });

const ENV = {
  SERPER_API_KEY: "test-serper-key",
  GEMINI_API_KEY: "dummy-gem-key",
  SUPABASE_URL: null,
  SUPABASE_SERVICE_ROLE_KEY: null,
};

const place = {
  name: "にくみつ 池袋店",
  address: "東京都豊島区南池袋１-27-8",
  providerPlaceId: "geoapify-test-place-001",
};
const reqOf = (id: string, kind: string) => ({
  id,
  normalizedText: `req-${kind}`,
  kind,
  priority: "must",
});
const inputOf = (kinds: string[]): CandidateInvestigationInput => ({
  place,
  requirements: kinds.map((k, i) => reqOf(`r${i + 1}`, k)),
  knownClaims: [],
});

// ============================================================
// buildQueries (§5.4 Hard Rule 8: コード側テンプレート・最大 3)
// ============================================================

Deno.test("buildQueries: 住所から市区町村を抽出し、基本 2 クエリ (公式/口コミ) を組む", () => {
  const qs = buildQueries(inputOf(["other"]));
  assertEquals(qs, [
    "にくみつ 池袋店 豊島区 公式 営業時間 支払い",
    "にくみつ 池袋店 豊島区 口コミ 雰囲気",
  ]);
});

Deno.test("buildQueries: payment があれば支払い方法queryを追加する (最大 3 本 §5.4)", () => {
  const qs = buildQueries(
    inputOf(["payment", "reservation", "dietary", "time"]),
  );
  assertEquals(qs.length, 3);
  assertEquals(
    qs[2],
    "にくみつ 池袋店 豊島区 クレジットカード 支払い方法 個室 予約 メニュー アレルギー",
  );
});

Deno.test("buildQueries: payment が無く reservation があれば個室予約クエリ、dietary のみならメニュー", () => {
  assertEquals(
    buildQueries(inputOf(["reservation", "dietary"]))[2],
    "にくみつ 池袋店 豊島区 個室 予約 メニュー アレルギー",
  );
  assertEquals(
    buildQueries(inputOf(["dietary"]))[2],
    "にくみつ 池袋店 豊島区 メニュー アレルギー",
  );
});

Deno.test("buildQueries: Geoapifyに無い予算・人数を補助queryへ明示する", () => {
  const query = buildQueries(inputOf(["budget", "party_size"]))[2];
  assertStringIncludes(query, "予算 料金 コース");
  assertStringIncludes(query, "席数 人数 個室");
});

Deno.test("buildQueries: Web補助対象が無ければ 2 本のまま", () => {
  assertEquals(
    buildQueries(inputOf(["atmosphere", "time", "other"])).length,
    2,
  );
});

Deno.test("buildQueries: 住所に都道府県が無ければ店名ベースで組む (前後空白なし)", () => {
  const qs = buildQueries({
    ...inputOf(["payment"]),
    place: { ...place, address: "池袋駅東口徒歩3分" },
  });
  assertEquals(qs.length, 3);
  for (const q of qs) {
    assertStringIncludes(q, "にくみつ 池袋店");
    assertEquals(q, q.trim());
  }
});

Deno.test("buildQueries: 同一入力は同一出力 (決定論)", () => {
  const input = inputOf(["payment", "time"]);
  assertEquals(buildQueries(input), buildQueries(input));
});

// ============================================================
// investigateCandidate フロー (fetch 全面スタブ)
// ============================================================

// 口コミサイト役の URL。tabelog.com 等の実在口コミ大手は #287 の denylist で
// fetch されなくなったため、非対象の例示ドメインを使う (SERP title はモック値)
const PAGE_A = "https://kuchikomi.example.com/tokyo/nikumitsu/";
const PAGE_B = "https://nikumitsu.example.jp/";

// serper 2 URL → 両ページ fetch 成功 → Gemini が 1 finding を返す標準ルート
function happyHandler(modelText: string): FetchHandler {
  return (url, init) => {
    if (url === "https://google.serper.dev/search") {
      return jsonRes({
        organic: [
          { title: "食べログ にくみつ", link: PAGE_A, snippet: "個室" },
          { title: "公式", link: PAGE_B },
        ],
      });
    }
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    if (url === PAGE_A) {
      return htmlRes("<html><body>カード可 個室あり</body></html>");
    }
    if (url === PAGE_B) {
      return htmlRes("<html><body>営業時間 15:00〜23:00</body></html>");
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      assert(init?.method === "POST");
      return geminiRes(modelText);
    }
    throw new Error(`予期しない URL への fetch: ${url}`);
  };
}

const modelOutput = JSON.stringify({
  summary: "公開情報を確認しました",
  findings: [
    {
      rid: "r1",
      state: "match",
      confidence: 0.9,
      explanation: "食べログでカード可を確認",
      sourcePages: [1],
      claims: [{ key: "card_accepted", value: true, rawText: "カード可" }],
    },
  ],
});

Deno.test("investigateCandidate: 検索→fetch→Gemini の evidence 組み立て。citations は実 fetch できた URL のみ (§5)", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, fetchPage, restore } = stubFetch(happyHandler(modelOutput));
  try {
    const input = inputOf(["payment"]);
    const out = await new SearchFetchResearchProvider(fetchPage)
      .investigateCandidate(input);
    assert(groundedCandidateInvestigationSchema.safeParse(out).success);
    assertEquals(out.summary, "公開情報を確認しました");
    assertEquals(out.searchQueries, buildQueries(input)); // 実行クエリ = テンプレート
    // citations は fetch 成功ページ (serper title 付き)。モデル生成 URL は採用しない
    assertEquals(out.citations, [
      { url: PAGE_A, title: "食べログ にくみつ" },
      { url: PAGE_B, title: "公式" },
    ]);
    assertEquals(out.findings.length, 1);
    assertEquals(out.findings[0].claims, [{
      key: "card_accepted",
      value: true,
      rawText: "カード可",
    }]);
    // 呼び出し内訳: serper 3 回 (payment で 3 クエリ) + robots 2 + ページ 2 + Gemini 1
    const serperCalls = calls.filter((c) =>
      c.url.includes("serper.dev")
    ).length;
    const geminiCalls = calls.filter((c) =>
      c.url.includes("generativelanguage")
    ).length;
    assertEquals(serperCalls, 3);
    assertEquals(geminiCalls, 1);
    // Gemini へのプロンプトに requirement とページ本文 (抜粋) が入る
    const geminiBody = JSON.parse(
      String(
        calls.find((c) => c.url.includes("generativelanguage"))?.init?.body,
      ),
    );
    assertStringIncludes(geminiBody.input, "rid=r1 [payment/must]");
    assertStringIncludes(geminiBody.input, "カード可 個室あり");
    assertStringIncludes(geminiBody.input, "budget_dinner:");
    assertStringIncludes(geminiBody.input, "time_limit:");
    assertStringIncludes(geminiBody.input, "genre:");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("SearchFetchResearchProvider: parser/research/embeddingをDIし、mock adapterはGeminiを呼ばない (#512)", async () => {
  const restoreEnv = withEnv({ ...ENV, GEMINI_API_KEY: null });
  const calls: string[] = [];
  const parserQueries: string[] = [];
  const embeddingInputs: string[][] = [];
  const researchRequests: Array<ResearchEvaluationRequest<unknown>> = [];
  const controller = new AbortController();
  const mockParsed = {
    title: "テスト調査",
    normalizedQuery: "池袋でカード可",
    area: "池袋",
    requirements: [{
      text: "カード可",
      normalizedText: "クレジットカード利用可能",
      kind: "payment" as const,
      priority: "must" as const,
      weight: 1,
    }],
  };
  const mockModelInvestigation = {
    summary: "注入adapterによる確認",
    findings: [{
      rid: "r1",
      state: "match" as const,
      confidence: 0.9,
      explanation: "注入したadapterの結果",
      sourcePages: [1],
      claims: [{
        key: "card_accepted" as const,
        value: true,
        rawText: "カード可",
      }],
    }],
  };
  const dependencies: SearchFetchResearchDependencies = {
    parser: {
      parseRequirements(query, signal) {
        parserQueries.push(query);
        assertEquals(signal, controller.signal);
        return Promise.resolve(mockParsed);
      },
    },
    research: {
      evaluate<T>(request: ResearchEvaluationRequest<T>, signal?: AbortSignal) {
        researchRequests.push(request as ResearchEvaluationRequest<unknown>);
        assertEquals(signal, controller.signal);
        return Promise.resolve(mockModelInvestigation as T);
      },
    },
    embedding: {
      embed(texts, signal) {
        embeddingInputs.push(texts);
        assertEquals(signal, controller.signal);
        return Promise.resolve(texts.map(() => [0.25, 0.75]));
      },
    },
  };
  const { fetchPage, restore } = stubFetch((url, init) => {
    calls.push(url);
    if (url.includes("generativelanguage.googleapis.com")) {
      throw new Error("mock adapterからGemini APIを呼び出してはいけない");
    }
    return happyHandler(modelOutput)(url, init);
  });
  try {
    const provider = new SearchFetchResearchProvider(
      fetchPage,
      undefined,
      dependencies,
    );
    assertEquals(
      await provider.parseRequirements("池袋でカード可", controller.signal),
      mockParsed,
    );
    assertEquals(
      await provider.embed(["カード可"], controller.signal),
      [[0.25, 0.75]],
    );
    const out = await provider.investigateCandidate(
      inputOf(["payment"]),
      controller.signal,
    );
    assertEquals(out.findings[0]?.state, "match");
    assertEquals(parserQueries, ["池袋でカード可"]);
    assertEquals(embeddingInputs, [["カード可"]]);
    assertEquals(researchRequests.length, 1);
    assertStringIncludes(
      researchRequests[0].buildPrompt(null),
      "rid=r1 [payment/must]",
    );
    assertEquals(
      calls.filter((url) => url.includes("generativelanguage.googleapis.com")),
      [],
    );
  } finally {
    controller.abort();
    restore();
    restoreEnv();
  }
});

Deno.test("investigateCandidate: AbortSignalをSerper・ページfetch・Geminiへ一貫伝播する", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, fetchPage, restore } = stubFetch(happyHandler(modelOutput));
  const controller = new AbortController();
  const pageSignals: Array<AbortSignal | undefined> = [];
  try {
    const out = await new SearchFetchResearchProvider((url, signal) => {
      pageSignals.push(signal);
      return fetchPage(url);
    }).investigateCandidate(inputOf(["payment"]), controller.signal);
    assertEquals(out.findings[0]?.state, "match");
    assertEquals(pageSignals.length, 2);
    assert(pageSignals.every((signal) => signal === controller.signal));
    const providerCalls = calls.filter((call) =>
      call.url.includes("serper.dev") ||
      call.url.includes("generativelanguage.googleapis.com")
    );
    assert(providerCalls.length > 0);
    assert(
      providerCalls.every((call) => call.init?.signal === controller.signal),
    );
  } finally {
    controller.abort();
    restore();
    restoreEnv();
  }
});

Deno.test("investigateCandidate: provider/API境界のstructured metricは回数を実測しPIIを含めない", async () => {
  const restoreEnv = withEnv(ENV);
  const { fetchPage, restore } = stubFetch(happyHandler(modelOutput));
  const metrics: Array<Record<string, unknown>> = [];
  try {
    await new SearchFetchResearchProvider(fetchPage, {
      onMetric(metric) {
        metrics.push({ ...metric });
      },
    }).investigateCandidate(inputOf(["payment"]));
    assertEquals(
      metrics.filter((metric) =>
        metric.provider === "serper" && metric.operation === "search_api"
      ).length,
      3,
    );
    assertEquals(
      metrics.filter((metric) =>
        metric.provider === "fetch" && metric.operation === "page_fetch"
      ).length,
      2,
    );
    assertEquals(
      metrics.filter((metric) =>
        metric.provider === "gemini" && metric.operation === "structured_output"
      ).length,
      1,
    );
    for (const metric of metrics) {
      assert(typeof metric.durationMs === "number");
      assertEquals(metric.retryCount, 0);
      assert(metric.outcome === "ok" || metric.outcome === "error");
    }
    const serialized = JSON.stringify(metrics);
    assert(!serialized.includes("にくみつ"));
    assert(!serialized.includes(PAGE_A));
    assert(!serialized.includes("カード可"));
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("investigateCandidate: 検索が全滅してもページ 0 件として全条件 unknown を返す (throw しない §31)", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, fetchPage, restore } = stubFetch((url) => {
    if (url.includes("serper.dev")) {
      return new Response("oops", { status: 500 });
    }
    throw new Error(`予期しない URL への fetch: ${url}`);
  });
  try {
    const out = await new SearchFetchResearchProvider(fetchPage)
      .investigateCandidate(
        inputOf(["payment", "time"]),
      );
    assertEquals(out.citations, []);
    assertEquals(out.findings.map((f) => f.state), ["unknown", "unknown"]);
    assertEquals(out.findings.map((f) => f.confidence), [0, 0]);
    assertStringIncludes(out.summary, "取得できませんでした");
    // ページが無ければ Gemini は呼ばれない (§12: 推測で match しない)
    assertEquals(
      calls.filter((c) => c.url.includes("generativelanguage")).length,
      0,
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("investigateCandidate: 一部ソースの失敗 (robots 拒否 / HTTP 500) は劣化で続行し、取れたページだけ使う", async () => {
  const PAGE_C = "https://blocked.example.com/private/page";
  const PAGE_D = "https://down.example.com/menu";
  const restoreEnv = withEnv(ENV);
  const { fetchPage, restore } = stubFetch((url, init) => {
    if (url === "https://google.serper.dev/search") {
      return jsonRes({
        organic: [
          { title: "拒否される", link: PAGE_C },
          { title: "落ちてる", link: PAGE_D },
          { title: "食べログ にくみつ", link: PAGE_A, snippet: "個室" },
        ],
      });
    }
    if (url === "https://blocked.example.com/robots.txt") {
      return new Response("User-agent: *\nDisallow: /private", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    if (url === PAGE_D) return new Response("err", { status: 500 });
    if (url === PAGE_A) return htmlRes("<html><body>カード可</body></html>");
    if (url.includes("generativelanguage.googleapis.com")) {
      assert(init?.method === "POST");
      return geminiRes(modelOutput);
    }
    throw new Error(`予期しない URL への fetch: ${url}`);
  });
  try {
    const out = await new SearchFetchResearchProvider(fetchPage)
      .investigateCandidate(
        inputOf(["payment"]),
      );
    // 成功した PAGE_A のみ citation になる (拒否/失敗 URL は含まれない)
    assertEquals(out.citations, [{ url: PAGE_A, title: "食べログ にくみつ" }]);
    assertEquals(out.findings[0].state, "match");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("investigateCandidate: denylist 上位結果を飛ばし、取得可能な後順位ページを使う (#297)", async () => {
  const retiredUrl = "https://www.hotpepper.jp/strJ000000001/";
  const allowedUrl = "https://official.example.jp/nikumitsu/";
  const restoreEnv = withEnv(ENV);
  const { fetchPage, restore } = stubFetch((url, _init) => {
    if (url === "https://google.serper.dev/search") {
      return jsonRes({
        organic: [
          { title: "旧 provider", link: retiredUrl },
          { title: "公式サイト", link: allowedUrl },
        ],
      });
    }
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    if (url === allowedUrl) {
      return htmlRes("<html><body>カード可</body></html>");
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return geminiRes(modelOutput);
    }
    throw new Error(`予期しない URL への fetch: ${url}`);
  });
  const requested: string[] = [];
  try {
    const out = await new SearchFetchResearchProvider((url) => {
      requested.push(url);
      return fetchPage(url);
    }).investigateCandidate(inputOf(["payment"]));
    assertEquals(requested, [allowedUrl]);
    assertEquals(out.citations, [{ url: allowedUrl, title: "公式サイト" }]);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("investigateCandidate: Gemini 出力が 1 回目 Zod 不正なら誤り内容を添えて 1 回だけ再試行する (§30)", async () => {
  const restoreEnv = withEnv(ENV);
  let geminiCall = 0;
  const prompts: string[] = [];
  const { fetchPage, restore } = stubFetch((url, init) => {
    if (url.includes("generativelanguage.googleapis.com")) {
      prompts.push(JSON.parse(String(init?.body)).input as string);
      geminiCall++;
      // 1 回目: findings の state が enum 外 → modelInvestigationSchema 失敗
      if (geminiCall === 1) {
        return geminiRes(JSON.stringify({
          summary: "x",
          findings: [{ rid: "r1", state: "yes", sourcePages: [] }],
        }));
      }
      return geminiRes(modelOutput);
    }
    return happyHandler(modelOutput)(url, init);
  });
  try {
    const out = await new SearchFetchResearchProvider(fetchPage)
      .investigateCandidate(
        inputOf(["payment"]),
      );
    assertEquals(geminiCall, 2); // 1 回だけ再試行 (3 回目は無い)
    assertStringIncludes(prompts[1], "前回の出力は検証に失敗しました");
    assertEquals(out.findings[0].state, "match"); // 2 回目の正常出力を採用
  } finally {
    restore();
    restoreEnv();
  }
});
