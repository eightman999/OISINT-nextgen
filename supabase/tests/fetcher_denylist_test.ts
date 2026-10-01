// fetch 対象ドメイン denylist のテスト (Issue #287 / spec.md §5.4)
//   - 利用規約で自動収集を明示的に禁止しているドメイン (サブドメイン含む) は
//     robots.txt の取得を含め一切 fetch しない (robots 判定より前に弾く)
//   - redirect で denylist ドメインへ逃がしても接続しない
//   - 非対象ドメインや、ドメイン名を含むだけの別ドメインは通常どおり fetch する
// fetch は全てスタブ (実ネットワークなし)。
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  fetchPageTextWithDependencies,
  type SafeFetchDependencies,
} from "../functions/_shared/providers/fetcher.ts";
import {
  createFetchDenylistPolicy,
  DEFAULT_FETCH_DENYLIST_POLICY,
  FETCH_DENYLIST_DOMAINS,
  isFetchDenylisted,
} from "../functions/_shared/providers/fetch_denylist.ts";

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

const htmlRes = (html: string) =>
  new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const PAGE_HTML = "<html><body><p>営業時間 15:00〜23:00</p></body></html>";

// robots.txt 404 (= robots 上は全許可) + 本文 200 を返す寛容なサイト。
// これでも denylist 対象なら接続ゼロであることを検証する。
const openSite: FetchHandler = (url) =>
  url.endsWith("/robots.txt")
    ? new Response("nf", { status: 404 })
    : htmlRes(PAGE_HTML);

// ============================================================
// isFetchDenylisted (単体)
// ============================================================

Deno.test("denylist: 初期リストは規約で自動収集を禁止している主要口コミサイトを含む", () => {
  for (
    const domain of [
      "tabelog.com",
      "retty.me",
      "hitosara.com",
      "gnavi.co.jp",
      "hotpepper.jp",
    ]
  ) {
    assert(FETCH_DENYLIST_DOMAINS.includes(domain), domain);
  }
});

Deno.test("isFetchDenylisted: 完全一致とサブドメインのみ true (label 境界で判定)", () => {
  assert(isFetchDenylisted(new URL("https://tabelog.com/tokyo/A1305/")));
  assert(isFetchDenylisted(new URL("https://www.tabelog.com/rst/")));
  assert(isFetchDenylisted(new URL("https://a.b.retty.me/area/")));
  // 大文字・末尾 dot は正規化して判定する
  assert(isFetchDenylisted(new URL("https://TABELOG.com./x")));
  // ドメイン名を含むだけの別ドメインは対象外 (source_quality と同じ label 境界)
  assertEquals(
    isFetchDenylisted(new URL("https://eviltabelog.com/shop/1")),
    false,
  );
  assertEquals(
    isFetchDenylisted(new URL("https://tabelog.example.com/shop")),
    false,
  );
  assertEquals(
    isFetchDenylisted(new URL("https://tabelog.com.evil.example/x")),
    false,
  );
});

Deno.test("denylist policy: 明示的な空配列は許可リストへ補完しない", () => {
  const policy = createFetchDenylistPolicy([]);
  assertEquals(policy.domains, []);
  // 空設定は「owner 未決定」を表すだけで、別のドメインを推測して拒否しない。
  // これは許可リスト判定ではなく、robots / SSRF / egress の別境界を残すための
  // deny-only 設定である。
  assertEquals(
    isFetchDenylisted(new URL("https://tabelog.com/shop/1"), policy),
    false,
  );
  assertEquals(
    isFetchDenylisted(new URL("https://site.example/shop/1"), policy),
    false,
  );
  assertEquals(
    isFetchDenylisted(new URL("https://tabelog.com/shop/1")),
    isFetchDenylisted(
      new URL("https://tabelog.com/shop/1"),
      DEFAULT_FETCH_DENYLIST_POLICY,
    ),
  );
});

Deno.test("denylist policy: owner 設定のドメインだけを正規化して保持する", () => {
  const policy = createFetchDenylistPolicy([
    "Example.COM.",
    "example.com",
    "sub.example.jp",
  ]);
  assertEquals(policy.domains, ["example.com", "sub.example.jp"]);
  assert(isFetchDenylisted(new URL("https://www.example.com/x"), policy));
  assert(isFetchDenylisted(new URL("https://sub.example.jp/x"), policy));
  assertEquals(
    isFetchDenylisted(new URL("https://example.com.evil.example/x"), policy),
    false,
  );
});

Deno.test("denylist policy: owner が明示した追加ドメインは DNS より前に遮断する", async () => {
  const { calls, dependencies } = fixture(openSite);
  const configured = {
    ...dependencies,
    fetchDenylistPolicy: createFetchDenylistPolicy(["owner-selected.example"]),
  };
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://owner-selected.example/shop/1",
      configured,
    ),
    null,
  );
  assertEquals(calls, []);
});

Deno.test("denylist policy: URL / wildcard /空ラベルを含む設定は黙って採用しない", () => {
  for (
    const value of [
      "https://example.com",
      "*.example.com",
      "example..com",
      " example.com",
    ]
  ) {
    assertThrows(() => createFetchDenylistPolicy([value]), TypeError);
  }
});

// ============================================================
// fetchPageText 前段の判定 (robots.txt 取得より前・対象ホストへ接続ゼロ)
// ============================================================

Deno.test("denylist: 対象ドメイン直下の URL は robots.txt を含め一切 fetch しない", async () => {
  for (const domain of FETCH_DENYLIST_DOMAINS) {
    const { calls, dependencies } = fixture(openSite);
    assertEquals(
      await fetchPageTextWithDependencies(
        `https://${domain}/shop/1`,
        dependencies,
      ),
      null,
      domain,
    );
    assertEquals(calls, [], domain); // robots.txt にも触れない
  }
});

Deno.test("denylist policy: 空でも robots 取得失敗は fail-closed で、許可リストへ補完しない", async () => {
  const { calls, dependencies } = fixture((url) => {
    if (url.endsWith("/robots.txt")) throw new Error("robots unavailable");
    return htmlRes(PAGE_HTML);
  });
  const configured = {
    ...dependencies,
    fetchDenylistPolicy: createFetchDenylistPolicy([]),
  };
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/shop/1",
      configured,
    ),
    null,
  );
  assertEquals(calls, ["https://site.example/robots.txt"]);
});

Deno.test("denylist: サブドメイン (www / m / r など) も弾く", async () => {
  for (
    const url of [
      "https://www.tabelog.com/tokyo/A1305/",
      "https://m.tabelog.com/tokyo/A1305/",
      "https://user.retty.me/1/",
      "https://r.gnavi.co.jp/abc123/",
      "https://www.hotpepper.jp/strJ001177996/",
    ]
  ) {
    const { calls, dependencies } = fixture(openSite);
    assertEquals(
      await fetchPageTextWithDependencies(url, dependencies),
      null,
      url,
    );
    assertEquals(calls, [], url);
  }
});

Deno.test("denylist: redirect で対象ドメインへ逃がしても接続しない", async () => {
  const { calls, dependencies } = fixture((url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("nf", { status: 404 });
    }
    if (url === "https://site.example/menu") {
      return new Response(null, {
        status: 301,
        headers: { Location: "https://tabelog.com/rst/12345/" },
      });
    }
    return htmlRes(PAGE_HTML);
  });
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/menu",
      dependencies,
    ),
    null,
  );
  // 接続したのは site.example の robots.txt と初回 URL のみ。denylist ドメイン
  // への hop は発生しない (cross-origin 拒否と hop ごとの denylist 再判定の
  // 二重防御。どちらか一方が緩んでも対象ホストへは接続しない)
  assertEquals(calls, [
    "https://site.example/robots.txt",
    "https://site.example/menu",
  ]);
});

Deno.test("denylist: 非対象ドメインは通常どおり fetch できる (正例)", async () => {
  const { dependencies } = fixture(openSite);
  const out = await fetchPageTextWithDependencies(
    "https://site.example/menu",
    dependencies,
  );
  assert(out !== null);
  assertEquals(out.url, "https://site.example/menu");
});

Deno.test("denylist: ドメイン名を含むだけの別ドメイン (eviltabelog.com) は弾かない", async () => {
  const { calls, dependencies } = fixture(openSite);
  const out = await fetchPageTextWithDependencies(
    "https://eviltabelog.com/shop/1",
    dependencies,
  );
  assert(out !== null);
  assertEquals(calls, [
    "https://eviltabelog.com/robots.txt",
    "https://eviltabelog.com/shop/1",
  ]);
});
