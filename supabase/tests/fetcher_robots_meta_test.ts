// X-Robots-Tag / <meta name="robots"> の尊重テスト (Issue #293 / spec.md §5.4)
// Google「Robots meta tag, data-nosnippet, and X-Robots-Tag specifications」に従い、
//   - noindex / nosnippet / noarchive / none (= noindex, nofollow) は Evidence 化しない
//   - 仕様外の noai (AI 利用拒否の意思表示) も収集禁止の慣行への追従として
//     同様に遮断する。nofollow 単独はリンクを辿らない設計により常に充足する
//     ため遮断しない (Issue #287)
//   - rule は case-insensitive・comma 区切り
//   - 対象は robots (全 crawler) と OISINT-Fetcher (自 UA 向け指定) の両方
//   - 他 UA 向け指定 (googlebot: 等) は適用しない
// robots.txt 判定は tests/robots_test.ts / tests/fetcher_page_test.ts が担当。
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

const NO_DB = { SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null };

type FetchHandler = (url: string) => Response | Promise<Response>;

function fixture(handler: FetchHandler) {
  const calls: string[] = [];
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: "deny-private-public-egress-v1",
    resolveDns: (_hostname, recordType) =>
      Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []),
    fetchHop: async (url) => {
      calls.push(url);
      return await handler(url);
    },
  };
  return { calls, dependencies };
}

const PAGE_BODY = "<h1>にくみつ</h1><p>営業時間 15:00〜23:00</p>";

// robots.txt は 404 (全許可) とし、ページ応答の header / head だけを変える
function siteWith(
  options: { headers?: Record<string, string>; head?: string } = {},
): FetchHandler {
  return (url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      `<html><head>${
        options.head ?? ""
      }</head><body>${PAGE_BODY}</body></html>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...options.headers,
        },
      },
    );
  };
}

async function fetchVia(handler: FetchHandler) {
  const restoreEnv = withEnv(NO_DB);
  const { dependencies } = fixture(handler);
  try {
    return await fetchPageTextWithDependencies(
      "https://site.example/menu",
      dependencies,
    );
  } finally {
    restoreEnv();
  }
}

// ============================================================
// X-Robots-Tag ヘッダ
// ============================================================

Deno.test("fetchPageText: X-Robots-Tag: noindex のページは Evidence 化しない", async () => {
  const out = await fetchVia(
    siteWith({ headers: { "X-Robots-Tag": "noindex" } }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: X-Robots-Tag の comma 区切り複数 rule 中の noarchive も遮断 (case-insensitive)", async () => {
  const out = await fetchVia(
    siteWith({ headers: { "X-Robots-Tag": "nofollow, NoArchive" } }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: X-Robots-Tag: none (= noindex, nofollow) も noindex として遮断", async () => {
  const out = await fetchVia(siteWith({ headers: { "X-Robots-Tag": "none" } }));
  assertEquals(out, null);
});

Deno.test("fetchPageText: X-Robots-Tag: oisint-fetcher: noindex (自 UA 向け指定) は遮断", async () => {
  const out = await fetchVia(
    siteWith({ headers: { "X-Robots-Tag": "oisint-fetcher: noindex" } }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: X-Robots-Tag: googlebot: noindex (他 UA 向け指定) は適用せず取得する", async () => {
  const out = await fetchVia(
    siteWith({ headers: { "X-Robots-Tag": "googlebot: noindex" } }),
  );
  assert(out !== null);
  assertStringIncludes(out.text, "営業時間 15:00〜23:00");
});

Deno.test("fetchPageText: X-Robots-Tag: noai (AI 利用拒否の慣行) は Evidence 化しない (Issue #287)", async () => {
  const out = await fetchVia(siteWith({ headers: { "X-Robots-Tag": "noai" } }));
  assertEquals(out, null);
});

Deno.test("fetchPageText: X-Robots-Tag: nofollow 単独はリンクを辿らない設計により取得する", async () => {
  const out = await fetchVia(
    siteWith({ headers: { "X-Robots-Tag": "nofollow" } }),
  );
  assert(out !== null);
  assertStringIncludes(out.text, "営業時間 15:00〜23:00");
});

Deno.test("fetchPageText: X-Robots-Tag: unavailable_after (値付き directive) は遮断しない", async () => {
  const out = await fetchVia(
    siteWith({
      headers: {
        "X-Robots-Tag": "unavailable_after: 25 Jun 2030 15:00:00 PST",
      },
    }),
  );
  assert(out !== null);
});

// ============================================================
// <meta name="robots">
// ============================================================

Deno.test("fetchPageText: <meta name='robots' content='nosnippet'> は Evidence 化しない", async () => {
  const out = await fetchVia(
    siteWith({ head: '<meta name="robots" content="nosnippet">' }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: <meta name='robots' content='noarchive'> は Evidence 化しない", async () => {
  const out = await fetchVia(
    siteWith({ head: '<meta name="robots" content="noarchive">' }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: meta robots は大文字・comma 区切り・単引用符でも解釈する", async () => {
  const out = await fetchVia(
    siteWith({ head: "<META NAME='ROBOTS' CONTENT='NOFOLLOW, NOINDEX'>" }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: <meta name='oisint-fetcher' content='noindex'> (自 UA 向け) は遮断", async () => {
  const out = await fetchVia(
    siteWith({ head: '<meta name="oisint-fetcher" content="noindex">' }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: <meta name='robots' content='index, NoAI'> は comma 区切り中の noai で遮断", async () => {
  const out = await fetchVia(
    siteWith({ head: '<meta name="robots" content="index, NoAI">' }),
  );
  assertEquals(out, null);
});

Deno.test("fetchPageText: <meta name='robots' content='nofollow'> 単独は取得する", async () => {
  const out = await fetchVia(
    siteWith({ head: '<meta name="robots" content="nofollow">' }),
  );
  assert(out !== null);
  assertStringIncludes(out.text, "営業時間 15:00〜23:00");
});

Deno.test("fetchPageText: <meta name='googlebot' content='noindex'> (他 UA 向け) は適用しない", async () => {
  const out = await fetchVia(
    siteWith({ head: '<meta name="googlebot" content="noindex">' }),
  );
  assert(out !== null);
});

Deno.test("fetchPageText: description 等の無関係な meta は遮断しない", async () => {
  const out = await fetchVia(
    siteWith({
      head: '<meta name="description" content="noindex という語を含む説明">',
    }),
  );
  assert(out !== null);
});

// ============================================================
// 許可 (負例): 従来どおり本文を取得する
// ============================================================

Deno.test("fetchPageText: robots 指定が無ければ従来どおり本文を取得する", async () => {
  const out = await fetchVia(siteWith());
  assert(out !== null);
  assertStringIncludes(out.text, "営業時間 15:00〜23:00");
  assertEquals(out.url, "https://site.example/menu");
});

Deno.test("fetchPageText: 許可指定 (index, follow / max-snippet) は取得する", async () => {
  const out = await fetchVia(
    siteWith({
      headers: { "X-Robots-Tag": "max-snippet: 120" },
      head: '<meta name="robots" content="index, follow">',
    }),
  );
  assert(out !== null);
  assertStringIncludes(out.text, "営業時間 15:00〜23:00");
});
