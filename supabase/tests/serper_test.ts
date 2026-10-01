// providers/serper.ts のユニットテスト (spec.md §5.4 search_fetch backend の検索部 / §26 / §30 Zod 検証)
// fetch は全てスタブ (実ネットワークなし)。SUPABASE_URL を未設定にして external_cache 層を無効化。
import { assertEquals, assertRejects } from "@std/assert";
import { SerperSearchProvider } from "../functions/_shared/providers/serper.ts";

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

const ENV = {
  SERPER_API_KEY: "test-serper-key",
  SUPABASE_URL: null,
  SUPABASE_SERVICE_ROLE_KEY: null,
};

Deno.test("serper.search: organic を SerpResult へ変換し、リクエスト形式 (POST/ヘッダ/body) を守る", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() =>
    jsonRes({
      organic: [
        {
          title: "にくみつ 池袋店",
          link: "https://example.com/a",
          snippet: "全席個室",
        },
        { link: "https://example.com/b" }, // title / snippet 欠落は許容
      ],
      searchParameters: { q: "無関係な余分フィールドは無視される" },
    })
  );
  try {
    const out = await new SerperSearchProvider().search(
      "にくみつ 池袋 個室",
      5,
    );
    assertEquals(out, [
      {
        url: "https://example.com/a",
        title: "にくみつ 池袋店",
        snippet: "全席個室",
      },
      { url: "https://example.com/b", title: null, snippet: null },
    ]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://google.serper.dev/search");
    assertEquals(calls[0].init?.method, "POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    assertEquals(headers["X-API-KEY"], "test-serper-key");
    assertEquals(JSON.parse(String(calls[0].init?.body)), {
      q: "にくみつ 池袋 個室",
      gl: "jp",
      hl: "ja",
      num: 5,
    });
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("serper.search: num 未指定は既定 5", async () => {
  const restoreEnv = withEnv(ENV);
  const { calls, restore } = stubFetch(() => jsonRes({ organic: [] }));
  try {
    await new SerperSearchProvider().search("query");
    assertEquals(JSON.parse(String(calls[0].init?.body)).num, 5);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("serper.search: organic 欠落は空配列 (default) として扱う", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() => jsonRes({}));
  try {
    assertEquals(await new SerperSearchProvider().search("query"), []);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("serper.search: HTTP 500 はエラーとして伝播する", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() => new Response("oops", { status: 500 }));
  try {
    await assertRejects(
      () => new SerperSearchProvider().search("query"),
      Error,
      "Serper API error: 500",
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("serper.search: Zod 検証に失敗する payload (link が URL でない) はクラッシュせず Error で拒否", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() =>
    jsonRes({ organic: [{ link: "not-a-url" }] })
  );
  try {
    await assertRejects(
      () => new SerperSearchProvider().search("query"),
      Error,
      "Serper レスポンスの検証に失敗",
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("serper.search: organic が配列でない payload も Error で拒否 (型崩れ耐性)", async () => {
  const restoreEnv = withEnv(ENV);
  const { restore } = stubFetch(() => jsonRes({ organic: "broken" }));
  try {
    await assertRejects(
      () => new SerperSearchProvider().search("query"),
      Error,
      "Serper レスポンスの検証に失敗",
    );
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("serper.search: API キー未設定は fetch せずエラー", async () => {
  const restoreEnv = withEnv({ ...ENV, SERPER_API_KEY: null });
  const { calls, restore } = stubFetch(() => jsonRes({ organic: [] }));
  try {
    await assertRejects(
      () => new SerperSearchProvider().search("query"),
      Error,
      "SERPER_API_KEY が未設定",
    );
    assertEquals(calls.length, 0);
  } finally {
    restore();
    restoreEnv();
  }
});
