// robots.txt の RFC 9309 準拠テスト (Issue #294 / spec.md §5.4)
//   - 到達可否の扱い: 5xx・ネットワークエラー・timeout → 全拒否 (§2.3.1.4)、
//     4xx → 全許可 (§2.3.1.3)
//   - parse 上限 500 KiB (§2.5)
//   - group 結合 / product token の case-insensitive 照合 (§2.2.1)
//   - Allow / 最長一致 (§2.2.2)・ワイルドカード (§2.2.3)・percent-encoding 正規化
//   - same-origin redirect の hop ごとの再判定
//   - fetcher と egress gateway の User-Agent 一致 (UA 二系統の解消)
// fetch は全てスタブ (実ネットワークなし)。
import { assert, assertEquals } from "@std/assert";
import {
  fetchPageTextWithDependencies,
  robotsTxtAllows,
  type SafeFetchDependencies,
  USER_AGENT,
} from "../functions/_shared/providers/fetcher.ts";

const u = (path: string) => new URL(`https://site.example${path}`);

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

const PAGE_HTML = "<html><body><p>本文テキスト</p></body></html>";

// ============================================================
// 到達可否 (RFC §2.3.1): 5xx / ネットワークエラー / timeout / 4xx
// ============================================================

Deno.test("robots: 5xx は全拒否として扱い、本文へ接続しない (§2.3.1.4)", async () => {
  const { calls, dependencies } = fixture((url) =>
    url.endsWith("/robots.txt")
      ? new Response("server error", { status: 500 })
      : htmlRes(PAGE_HTML)
  );
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/menu",
      dependencies,
    ),
    null,
  );
  assertEquals(calls, ["https://site.example/robots.txt"]);
});

Deno.test("robots: 503 も全拒否 (5xx 全般)", async () => {
  const { calls, dependencies } = fixture((url) =>
    url.endsWith("/robots.txt")
      ? new Response("busy", { status: 503 })
      : htmlRes(PAGE_HTML)
  );
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/menu",
      dependencies,
    ),
    null,
  );
  assertEquals(calls, ["https://site.example/robots.txt"]);
});

Deno.test("robots: ネットワークエラーは全拒否 (§2.3.1.4)", async () => {
  const { calls, dependencies } = fixture((url) => {
    if (url.endsWith("/robots.txt")) throw new Error("connection reset");
    return htmlRes(PAGE_HTML);
  });
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/menu",
      dependencies,
    ),
    null,
  );
  assertEquals(calls, ["https://site.example/robots.txt"]);
});

Deno.test("robots: timeout (AbortError) も全拒否 (§2.3.1.4)", async () => {
  const { calls, dependencies } = fixture((url) => {
    if (url.endsWith("/robots.txt")) {
      throw new DOMException("The signal has been aborted", "AbortError");
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
  assertEquals(calls, ["https://site.example/robots.txt"]);
});

Deno.test("robots: 4xx (403/404) は robots なしとみなし許可 (§2.3.1.3)", async () => {
  for (const status of [403, 404]) {
    const { dependencies } = fixture((url) =>
      url.endsWith("/robots.txt")
        ? new Response("unavailable", { status })
        : htmlRes(PAGE_HTML)
    );
    const out = await fetchPageTextWithDependencies(
      "https://site.example/menu",
      dependencies,
    );
    assert(out !== null, `status=${status} は許可扱いであるべき`);
  }
});

// ============================================================
// parse 上限 500 KiB = 512,000 bytes (RFC §2.5)
// ============================================================

Deno.test("robots: 先頭 512,000 bytes までの rule は適用し、超過分は無視する (§2.5)", async () => {
  // 構成 (ASCII のみ = 1 文字 1 byte):
  //   [0..)        User-agent: * と /blocked の rule
  //   [..512,000)  コメント行のパディングの後、ちょうど 512,000 byte 目で
  //                /near の rule が終わる (上限ちょうどまで解析されること)
  //   [512,000..)  /late の rule (無視されること)
  const head = "User-agent: *\nDisallow: /blocked\n";
  const nearRule = "Disallow: /near\n";
  const padding = "#".repeat(512_000 - head.length - nearRule.length - 1) +
    "\n";
  const lateRule = "Disallow: /late\n";
  const body = head + padding + nearRule + lateRule + "#".repeat(1_000);
  assertEquals(head.length + padding.length + nearRule.length, 512_000);

  const { dependencies } = fixture((url) =>
    url.endsWith("/robots.txt")
      ? new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
      : htmlRes(PAGE_HTML)
  );
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/blocked",
      dependencies,
    ),
    null,
  );
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/near",
      dependencies,
    ),
    null, // 512,000 byte 目までは解析対象
  );
  assert(
    (await fetchPageTextWithDependencies(
      "https://site.example/late",
      dependencies,
    )) !== null, // 上限超過分の rule は適用されない
  );
});

// ============================================================
// group 結合と product token の case-insensitive 照合 (RFC §2.2.1)
// ============================================================

Deno.test("robots: product token は case-insensitive で照合し、同名 group の rule を結合する", () => {
  const body = [
    "User-agent: Googlebot",
    "Disallow: /g",
    "",
    "User-agent: oisint-fetcher",
    "User-agent: OtherBot",
    "Disallow: /a",
    "",
    "User-Agent: OISINT-FETCHER",
    "Disallow: /b",
  ].join("\n");
  assertEquals(robotsTxtAllows(body, u("/a/page")), false);
  assertEquals(robotsTxtAllows(body, u("/b")), false);
  assertEquals(robotsTxtAllows(body, u("/g")), true); // 他 UA group は適用しない
});

Deno.test("robots: 連続する user-agent 行は 1 group として全 UA に rule を適用する", () => {
  const body = [
    "User-agent: *",
    "User-agent: OISINT-Fetcher",
    "Disallow: /shared",
  ].join("\n");
  assertEquals(robotsTxtAllows(body, u("/shared/x")), false);
});

Deno.test("robots: 一致 group があるときは '*' group を併用しない (§2.2.1)", () => {
  const body = [
    "User-agent: *",
    "Disallow: /x",
    "",
    "User-agent: OISINT-Fetcher",
    "Disallow: /y",
  ].join("\n");
  assertEquals(robotsTxtAllows(body, u("/x")), true); // '*' の rule は見ない
  assertEquals(robotsTxtAllows(body, u("/y")), false);
});

Deno.test("robots: 一致 group が無ければ '*' group へフォールバックする (§2.2.1)", () => {
  const body = "User-agent: *\nDisallow: /w";
  assertEquals(robotsTxtAllows(body, u("/w")), false);
  assertEquals(robotsTxtAllows(body, u("/ok")), true);
});

Deno.test("robots: version 付きの user-agent 行 (OISINT-Fetcher/0.2) も product token で一致する", () => {
  const body = "User-agent: OISINT-Fetcher/0.2\nDisallow: /v";
  assertEquals(robotsTxtAllows(body, u("/v")), false);
});

Deno.test("robots: rule ゼロの一致 group は全許可 ('*' group より優先)", () => {
  const body = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: OISINT-Fetcher",
  ].join("\n");
  assertEquals(robotsTxtAllows(body, u("/anything")), true);
});

// ============================================================
// Allow と最長一致 (RFC §2.2.2)
// ============================================================

Deno.test("robots: Allow は Disallow より長い一致なら勝つ (most specific match)", () => {
  const body = "User-agent: *\nDisallow: /private\nAllow: /private/menu";
  assertEquals(robotsTxtAllows(body, u("/private/menu")), true);
  assertEquals(robotsTxtAllows(body, u("/private/other")), false);
});

Deno.test("robots: 同長の Allow と Disallow は Allow を優先する (§2.2.2)", () => {
  const tie = "User-agent: *\nDisallow: /page\nAllow: /page";
  assertEquals(robotsTxtAllows(tie, u("/page")), true);
  const reversed = "User-agent: *\nAllow: /page\nDisallow: /page";
  assertEquals(robotsTxtAllows(reversed, u("/page")), true);
});

Deno.test("robots: どの rule にも一致しないパスは許可", () => {
  const body = "User-agent: *\nDisallow: /private";
  assertEquals(robotsTxtAllows(body, u("/public")), true);
});

// ============================================================
// ワイルドカード '*' / '$' (RFC §2.2.3)
// ============================================================

Deno.test("robots: '*' は任意長に一致する", () => {
  const body = "User-agent: *\nDisallow: /private*/data";
  assertEquals(robotsTxtAllows(body, u("/private123/data")), false);
  assertEquals(robotsTxtAllows(body, u("/private/data")), false);
  assertEquals(robotsTxtAllows(body, u("/private123/other")), true);
});

Deno.test("robots: 末尾 '$' は終端一致になる", () => {
  const body = "User-agent: *\nDisallow: /*.pdf$";
  assertEquals(robotsTxtAllows(body, u("/doc.pdf")), false);
  assertEquals(robotsTxtAllows(body, u("/a/b.pdf")), false);
  assertEquals(robotsTxtAllows(body, u("/doc.pdfx")), true);
  assertEquals(robotsTxtAllows(body, u("/doc.pdf.html")), true);
});

Deno.test("robots: '$' 単体の終端一致 (/exact$) はそのパスのみ拒否する", () => {
  const body = "User-agent: *\nDisallow: /exact$";
  assertEquals(robotsTxtAllows(body, u("/exact")), false);
  assertEquals(robotsTxtAllows(body, u("/exact/sub")), true);
});

Deno.test("robots: query を含む一致 (/*?q= 形式) も評価する", () => {
  const body = "User-agent: *\nDisallow: /*?q=secret";
  assertEquals(robotsTxtAllows(body, u("/search?q=secret")), false);
  assertEquals(robotsTxtAllows(body, u("/search?q=open")), true);
});

// ============================================================
// percent-encoding 正規化 (RFC §2.2.2)
// ============================================================

Deno.test("robots: percent-encoding は大文字小文字・生 UTF-8 の表記差を吸収する", () => {
  // URL 側は WHATWG URL により /caf%C3%A9 へ正規化される
  const encodedLower = "User-agent: *\nDisallow: /caf%c3%a9";
  assertEquals(robotsTxtAllows(encodedLower, u("/café")), false);
  const rawUtf8 = "User-agent: *\nDisallow: /café";
  assertEquals(robotsTxtAllows(rawUtf8, u("/caf%c3%a9")), false);
  assertEquals(robotsTxtAllows(rawUtf8, u("/cafe")), true);
});

Deno.test("robots: unreserved 文字の %XX (%61 = a) は復号して比較する", () => {
  const body = "User-agent: *\nDisallow: /%61dmin";
  assertEquals(robotsTxtAllows(body, u("/admin")), false);
});

Deno.test("robots: 予約文字の %2F (encoded slash) は '/' と区別する", () => {
  const body = "User-agent: *\nDisallow: /a%2Fb";
  assertEquals(robotsTxtAllows(body, u("/a/b")), true);
  assertEquals(robotsTxtAllows(body, u("/a%2Fb")), false);
});

// ============================================================
// same-origin redirect の hop ごとの再判定
// ============================================================

Deno.test("robots: redirect 先のパスも robots で再判定し、拒否 hop へは接続しない", async () => {
  const { calls, dependencies } = fixture((url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nDisallow: /blocked", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (url === "https://site.example/start") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/blocked" },
      });
    }
    return htmlRes(PAGE_HTML);
  });
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://site.example/start",
      dependencies,
    ),
    null,
  );
  // robots.txt は 1 回だけ取得し、/blocked へは接続しない
  assertEquals(calls, [
    "https://site.example/robots.txt",
    "https://site.example/start",
  ]);
});

Deno.test("robots: redirect 先が許可パスなら追跡して最終 URL を返す", async () => {
  const { dependencies } = fixture((url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nDisallow: /blocked", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (url === "https://site.example/start") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/open" },
      });
    }
    return htmlRes(PAGE_HTML);
  });
  const out = await fetchPageTextWithDependencies(
    "https://site.example/start",
    dependencies,
  );
  assert(out !== null);
  assertEquals(out.url, "https://site.example/open");
});

// ============================================================
// User-Agent の一元化 (fetcher と egress gateway の値一致)
// ============================================================

Deno.test("UA: fetcher の USER_AGENT と apps/api/src/egress.ts の EGRESS_USER_AGENT が同一値", async () => {
  // egress.ts は拡張子なし import (./ip) を含み Deno から import できないため、
  // ソースを読んで定数値を照合する (別ランタイム間の最小の一致検証)。
  const egressSource = await Deno.readTextFile(
    new URL("../../apps/api/src/egress.ts", import.meta.url),
  );
  const match = egressSource.match(/EGRESS_USER_AGENT\s*=\s*\n?\s*"([^"]+)"/);
  assert(match !== null, "egress.ts に EGRESS_USER_AGENT 定数が必要");
  assertEquals(match[1], USER_AGENT);
});

Deno.test("UA: product token は OISINT-Fetcher (robots.txt 照合と spec.md §5.4 の表記)", () => {
  assertEquals(USER_AGENT.split("/")[0], "OISINT-Fetcher");
  assertEquals(
    USER_AGENT,
    "OISINT-Fetcher/0.2 (+https://oisint.com; research bot)",
  );
});
