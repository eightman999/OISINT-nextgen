// providers/fetcher.ts の fetchPageText / robots.txt 判定のテスト (spec.md §5.4 軽量フェッチャ制約)
// htmlToText 単体は既存 tests/fetcher_test.ts が担当するため重複させない。
// ここでは robots.txt 判定 (RFC 9309) を fetchPageText 経由で検証する。
// パーサ単体の網羅テストは tests/robots_test.ts が担当する。
// fetch は全てスタブ (実ネットワークなし)。SUPABASE_URL 未設定で external_cache 層を無効化。
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchPageTextWithDependencies,
  type SafeFetchDependencies,
} from "../functions/_shared/providers/fetcher.ts";

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

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

let activeStub:
  | { handler: FetchHandler; calls: string[] }
  | null = null;

function stubFetch(
  handler: FetchHandler,
): { calls: string[]; restore: () => void } {
  const previous = activeStub;
  const calls: string[] = [];
  activeStub = { handler, calls };
  return { calls, restore: () => (activeStub = previous) };
}

const TEST_DEPENDENCIES: SafeFetchDependencies = {
  connectionPolicy: "deny-private-public-egress-v1",
  resolveDns: (_hostname, recordType) =>
    Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []),
  fetchHop: async (url, _validatedAddresses, init) => {
    if (!activeStub) throw new Error("fetch stub is not installed");
    activeStub.calls.push(url);
    return await activeStub.handler(url, init);
  },
};

function fetchPageText(rawUrl: string) {
  return fetchPageTextWithDependencies(rawUrl, TEST_DEPENDENCIES);
}

const NO_DB = { SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null };

const htmlRes = (
  html: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
) => new Response(html, { status, headers: { "Content-Type": contentType } });

const PAGE_HTML =
  "<html><body><h1>にくみつ</h1><p>営業時間 15:00〜23:00</p></body></html>";

// robots.txt の内容ごとにハンドラを組み立てる
function siteWith(robots: string | null): FetchHandler {
  return (url) => {
    if (url.endsWith("/robots.txt")) {
      if (robots === null) return new Response("not found", { status: 404 });
      return htmlRes(robots, 200, "text/plain");
    }
    return htmlRes(PAGE_HTML);
  };
}

// ============================================================
// robots.txt 判定 (RFC 9309 準拠。fetchPageText 経由の統合検証)
// ============================================================

Deno.test("fetchPageText: robots.txt の 'User-agent: *' Disallow に一致するパスは fetch しない", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { calls, restore } = stubFetch(
    siteWith("User-agent: *\nDisallow: /private"),
  );
  try {
    const out = await fetchPageText("https://site.example/private/menu");
    assertEquals(out, null);
    // robots.txt のみ取得し、本文ページには触れない
    assertEquals(calls, ["https://site.example/robots.txt"]);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: Disallow 対象外のパスは fetch する", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch(siteWith("User-agent: *\nDisallow: /private"));
  try {
    const out = await fetchPageText("https://site.example/menu");
    assert(out !== null);
    assertStringIncludes(out.text, "営業時間 15:00〜23:00");
    assertEquals(out.url, "https://site.example/menu");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: robots.txt が 404 なら許可扱い", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch(siteWith(null));
  try {
    const out = await fetchPageText("https://site.example/anything");
    assert(out !== null);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: robots.txt の取得がネットワークエラーなら全拒否 (RFC 9309 §2.3.1.4)", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) throw new Error("network unreachable");
    return htmlRes(PAGE_HTML);
  });
  try {
    const out = await fetchPageText("https://site.example/menu");
    assertEquals(out, null);
    // 本文ページには触れない
    assertEquals(calls, ["https://site.example/robots.txt"]);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: 他 UA グループ (Googlebot 等) の Disallow は適用しない", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch(siteWith("User-agent: Googlebot\nDisallow: /"));
  try {
    const out = await fetchPageText("https://site.example/menu");
    assert(out !== null); // * グループではないため許可
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: 空の Disallow (全許可の慣用形) は遮断しない。# コメントは除去して解釈", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch(
    siteWith("User-agent: *\nDisallow:\nDisallow: /admin # 管理画面"),
  );
  try {
    assert((await fetchPageText("https://site.example/menu")) !== null);
    assertEquals(await fetchPageText("https://site.example/admin/login"), null); // コメント除去後も有効
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: Allow が最長一致で Disallow に勝つ (RFC 9309 §2.2.2)", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch(
    siteWith("User-agent: *\nDisallow: /private\nAllow: /private/menu"),
  );
  try {
    const out = await fetchPageText("https://site.example/private/menu");
    assert(out !== null); // Allow: /private/menu の方が長い一致
    assertEquals(
      await fetchPageText("https://site.example/private/other"),
      null, // Disallow: /private のみが一致
    );
  } finally {
    restore();
    restoreEnv();
  }
});

// ============================================================
// fetchPageText 本体 (HTML → テキスト抽出 / 上限 / 異常系)
// ============================================================

Deno.test("fetchPageText: HTML はタグ除去テキストになり、4,000 字で打ち切る (§44.3 L1: 原文 HTML を持たない)", async () => {
  const restoreEnv = withEnv(NO_DB);
  const long = `<html><body><p>${"あ".repeat(10_000)}</p></body></html>`;
  const { restore } = stubFetch((url) =>
    url.endsWith("/robots.txt")
      ? new Response("nf", { status: 404 })
      : htmlRes(long)
  );
  try {
    const out = await fetchPageText("https://site.example/long");
    assert(out !== null);
    assertEquals(out.text.length, 4_000);
    assertEquals(out.text.includes("<p>"), false);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: 本文が HTTP 500 なら null (throw しない §31)", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch((url) =>
    url.endsWith("/robots.txt")
      ? new Response("nf", { status: 404 })
      : htmlRes("err", 500)
  );
  try {
    assertEquals(await fetchPageText("https://site.example/menu"), null);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: content-type が html/text 以外 (JSON 等) は null", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch((url) =>
    url.endsWith("/robots.txt")
      ? new Response("nf", { status: 404 })
      : new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
  try {
    assertEquals(await fetchPageText("https://site.example/api"), null);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: タグ除去後に本文が空なら null (失敗はキャッシュもしない)", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch((url) =>
    url.endsWith("/robots.txt")
      ? new Response("nf", { status: 404 })
      : htmlRes("<html><body><script>var a=1;</script></body></html>")
  );
  try {
    assertEquals(await fetchPageText("https://site.example/empty"), null);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: URL 不正 / http(s) 以外のスキームは fetch せず null", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { calls, restore } = stubFetch(() => htmlRes(PAGE_HTML));
  try {
    assertEquals(await fetchPageText("not a url"), null);
    assertEquals(await fetchPageText("ftp://site.example/menu"), null);
    assertEquals(await fetchPageText("javascript:alert(1)"), null);
    assertEquals(calls.length, 0);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("fetchPageText: ネットワークエラー (本文側) は null に落ちる", async () => {
  const restoreEnv = withEnv(NO_DB);
  const { restore } = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    throw new Error("connection reset");
  });
  try {
    assertEquals(await fetchPageText("https://site.example/menu"), null);
  } finally {
    restore();
    restoreEnv();
  }
});
