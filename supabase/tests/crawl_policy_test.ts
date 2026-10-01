// safe crawler policy の fixture test (#117)。外部サイトへは接続しない。
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  buildCrawlEvidenceHandoff,
  canonicalizeCrawlUrl,
  CrawlBudgetLedger,
  extractCrawlLinks,
  sha256Hex,
} from "../functions/_shared/crawler.ts";
import {
  fetchPageForCrawlWithDependencies,
  loadRobotsPolicyDetails,
  parseRobotsPolicy,
  type RobotsPolicyCache,
  type RobotsPolicyCacheRecord,
  type SafeFetchDependencies,
} from "../functions/_shared/providers/fetcher.ts";

const PUBLIC_IP = "93.184.216.34";
const POLICY = "deny-private-public-egress-v1" as const;
const PAGE = "<html><body><p>公開ページの本文</p></body></html>";

function fixture(
  handler: (url: string) => Response | Promise<Response>,
): { dependencies: SafeFetchDependencies; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      connectionPolicy: POLICY,
      resolveDns: (_hostname, recordType) =>
        Promise.resolve(recordType === "A" ? [PUBLIC_IP] : []),
      fetchHop: async (url) => {
        calls.push(url);
        return await handler(url);
      },
    },
  };
}

const allowRobots = () =>
  new Response("User-agent: *\nDisallow:", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });

const html = (
  body: string,
  headers: Record<string, string> = {},
) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

Deno.test("canonical URL: tracker/fragment/default port/trailing slashを統一しquery順序は保持する", () => {
  assertEquals(
    canonicalizeCrawlUrl(
      "https://EXAMPLE.com:443/a/../menu/?utm_source=x&month=8&day=30#top",
    )?.href,
    "https://example.com/menu?month=8&day=30",
  );
  assertEquals(
    canonicalizeCrawlUrl("https://example.com/menu?day=30&month=8")?.href,
    "https://example.com/menu?day=30&month=8",
  );
  assertEquals(
    canonicalizeCrawlUrl("https://example.com/menu?gclid=x")?.href,
    "https://example.com/menu",
  );
});

Deno.test("robots policy: crawl-delayは大きい方を採り、上限を86400秒へcapする", () => {
  assertEquals(
    parseRobotsPolicy(
      "User-agent: *\nCrawl-delay: 999999\nCrawl-delay: 15\n",
    ).crawlDelaySeconds,
    86_400,
  );
});

Deno.test("robots cache: raw本文ではなく解析済みpolicyだけを24時間再利用する", async () => {
  const records = new Map<string, RobotsPolicyCacheRecord>();
  const cache: RobotsPolicyCache = {
    get: (origin) => Promise.resolve(records.get(origin) ?? null),
    set: (origin, record) => {
      records.set(origin, record);
      return Promise.resolve();
    },
  };
  const site = fixture((url) =>
    url.endsWith("/robots.txt")
      ? new Response("User-agent: *\nDisallow: /private", { status: 200 })
      : html(PAGE)
  );
  const dependencies = { ...site.dependencies, robotsPolicyCache: cache };
  const first = await fetchPageForCrawlWithDependencies(
    "https://example.com/public",
    dependencies,
  );
  const second = await fetchPageForCrawlWithDependencies(
    "https://example.com/public",
    dependencies,
  );
  assert(first.ok);
  assert(second.ok);
  assertEquals(
    site.calls.filter((url) => url.endsWith("/robots.txt")).length,
    1,
  );
  assertEquals(records.get("https://example.com")?.rules, [{
    allow: false,
    pattern: "/private",
  }]);
  assertEquals(records.get("https://example.com")?.available, true);
});

Deno.test("robots本文: header後stallは独自reader境界でfail-closedする", async () => {
  const stalledResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<never>(() => {}),
      }),
      {
        status: 200,
        headers: { "content-type": "text/plain" },
      },
    );
  const site = fixture((url) =>
    url.endsWith("/robots.txt") ? stalledResponse() : html(PAGE)
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    const started = performance.now();
    const result = await fetchPageForCrawlWithDependencies(
      "https://example.com/stalled-robots",
      site.dependencies,
      controller.signal,
    );
    assertEquals(result, { ok: false, reason: "aborted" });
    assert(performance.now() - started < 1_000);
    assertEquals(site.calls, ["https://example.com/robots.txt"]);
  } finally {
    clearTimeout(timer);
  }

  // loadRobotsPolicyDetails は本文上限と safeFetch のheader timeoutとは独立した
  // reader timeoutを持つ。ここでは親signalのabortで同じfail-closed境界も確認する。
  const directController = new AbortController();
  const directTimer = setTimeout(() => directController.abort(), 50);
  try {
    const direct = await loadRobotsPolicyDetails(
      new URL("https://example.com/direct-stall"),
      site.dependencies,
      directController.signal,
    );
    assertEquals(direct.available, false);
  } finally {
    clearTimeout(directTimer);
  }
});

Deno.test("URL discovery: malicious URL/private network/denylistをfrontierに入れない", () => {
  const htmlFixture = `
    <a href="/safe">safe</a>
    <a href="https://127.0.0.1/admin">private</a>
    <a href="https://[::1]/admin">ipv6-private</a>
    <a href="https://93.184.216.34/public">literal-ip</a>
    <a href="https://user:secret@example.com/leak">userinfo</a>
    <a href="https://example.com:8443/custom-port">custom-port</a>
    <a href="https://tabelog.com/restaurant/1">denylisted</a>
    <a href="javascript:alert(1)">script</a>
    <a href="//example.com/protocol-relative">protocol-relative</a>
    <a href="/safe?utm_campaign=x">tracker-equivalent</a>
  `;
  assertEquals(
    extractCrawlLinks(htmlFixture, "https://example.com/base/index", 30),
    ["https://example.com/safe"],
  );
});

Deno.test("URL explosion/calendar trap: 同一pathのquery variantとページ数をboundedにする", () => {
  const ledger = new CrawlBudgetLedger({
    maxPagesTotal: 50,
    maxPagesPerOrigin: 50,
    maxQueryVariantsPerPath: 3,
  });
  assert(ledger.reserve("https://example.com/calendar", 0).accepted);
  assert(ledger.reserve("https://example.com/calendar?month=1", 1).accepted);
  assert(ledger.reserve("https://example.com/calendar?month=2", 1).accepted);
  assertEquals(
    ledger.reserve("https://example.com/calendar?month=3", 1),
    { accepted: false, reason: "query_variants_exceeded" },
  );
  assertEquals(
    ledger.reserve("https://example.com/calendar?month=1&utm_source=ad", 1),
    { accepted: false, reason: "duplicate_url" },
  );

  const links = extractCrawlLinks(
    Array.from(
      { length: 100 },
      (_, index) => `<a href="/explosion/${index}">${index}</a>`,
    ).join(""),
    "https://example.com/",
    30,
  );
  assertEquals(links.length, 30);
});

Deno.test("safe fetch: robots denyは本文へ到達せず、5xx/redirect loopもfail-closed", async () => {
  const denied = fixture((url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nDisallow: /private", {
        status: 200,
      });
    }
    return html(PAGE);
  });
  const deniedResult = await fetchPageForCrawlWithDependencies(
    "https://example.com/private/menu",
    denied.dependencies,
  );
  assertEquals(deniedResult, { ok: false, reason: "robots_denied" });
  assertEquals(denied.calls, ["https://example.com/robots.txt"]);

  const unavailable = fixture((url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("busy", { status: 503 });
    }
    return html(PAGE);
  });
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/menu",
      unavailable.dependencies,
    ),
    { ok: false, reason: "robots_unavailable" },
  );
  assertEquals(unavailable.calls, ["https://example.com/robots.txt"]);

  const delayed = fixture((url) =>
    url.endsWith("/robots.txt")
      ? new Response("User-agent: *\nCrawl-delay: 25", { status: 200 })
      : new Response("busy", { status: 503 })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/menu",
      delayed.dependencies,
    ),
    { ok: false, reason: "http_error", crawlDelaySeconds: 25 },
  );

  const redirectLoop = fixture((url) => {
    if (url.endsWith("/robots.txt")) return allowRobots();
    return new Response(null, {
      status: 302,
      headers: { location: "https://example.com/menu" },
    });
  });
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/menu",
      redirectLoop.dependencies,
    ),
    { ok: false, reason: "redirect_loop" },
  );
  assertEquals(
    redirectLoop.calls.filter((url) => !url.endsWith("/robots.txt")).length,
    6,
  );
});

Deno.test("safe fetch: MIME/size/auth/private network/redirectを安全側へ倒す", async () => {
  const pdf = fixture((url) =>
    url.endsWith("/robots.txt") ? allowRobots() : new Response("%PDF-1.7", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/file",
      pdf.dependencies,
    ),
    { ok: false, reason: "non_html" },
  );

  const mismatch = fixture((url) =>
    url.endsWith("/robots.txt") ? allowRobots() : html("%PDF-1.7")
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/file",
      mismatch.dependencies,
    ),
    { ok: false, reason: "mime_mismatch" },
  );

  const tooLarge = fixture((url) =>
    url.endsWith("/robots.txt") ? allowRobots() : html("A".repeat(500_001))
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/huge",
      tooLarge.dependencies,
    ),
    { ok: false, reason: "body_too_large" },
  );

  const auth = fixture((url) =>
    url.endsWith("/robots.txt")
      ? allowRobots()
      : new Response("login", { status: 403 })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/login",
      auth.dependencies,
    ),
    { ok: false, reason: "auth_required" },
  );

  const privateResult = await fetchPageForCrawlWithDependencies(
    "https://10.0.0.1/admin",
    auth.dependencies,
  );
  assertEquals(privateResult, { ok: false, reason: "non_public_address" });
  assertEquals(auth.calls.length, 2);

  const crossOrigin = fixture((url) =>
    url.endsWith("/robots.txt") ? allowRobots() : new Response(null, {
      status: 302,
      headers: { location: "https://other.example/menu" },
    })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/menu",
      crossOrigin.dependencies,
    ),
    { ok: false, reason: "redirect_rejected" },
  );

  const loginRedirect = fixture((url) =>
    url.endsWith("/robots.txt") ? allowRobots() : new Response(null, {
      status: 302,
      headers: { location: "https://example.com/login?next=%2Fmenu" },
    })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/menu",
      loginRedirect.dependencies,
    ),
    { ok: false, reason: "auth_required" },
  );
  assertEquals(loginRedirect.calls, [
    "https://example.com/robots.txt",
    "https://example.com/menu",
  ]);

  const customPortRedirect = fixture((url) =>
    url.endsWith("/robots.txt") ? allowRobots() : new Response(null, {
      status: 302,
      headers: { location: "https://example.com:8443/menu" },
    })
  );
  const customPortResult = await fetchPageForCrawlWithDependencies(
    "https://example.com/menu",
    customPortRedirect.dependencies,
  );
  assertEquals(customPortResult, { ok: false, reason: "redirect_rejected" });
  assertEquals(customPortRedirect.calls, [
    "https://example.com/robots.txt",
    "https://example.com/menu",
  ]);

  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com:8443/menu",
      customPortRedirect.dependencies,
    ),
    { ok: false, reason: "bad_url" },
  );
});

Deno.test("safe fetch: X-Robots-Tagのnoindex/noaiを本文前に遮断する", async () => {
  const denied = fixture((url) =>
    url.endsWith("/robots.txt")
      ? allowRobots()
      : html(PAGE, { "x-robots-tag": "oisint-fetcher: noindex" })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/header-deny",
      denied.dependencies,
    ),
    { ok: false, reason: "robots_meta_denied" },
  );

  const noai = fixture((url) =>
    url.endsWith("/robots.txt")
      ? allowRobots()
      : html(PAGE, { "x-robots-tag": "noai" })
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/noai",
      noai.dependencies,
    ),
    { ok: false, reason: "robots_meta_denied" },
  );
});

Deno.test("safe fetch: robots meta noindex/nofollowを区別して返す", async () => {
  const noindex = fixture((url) =>
    url.endsWith("/robots.txt")
      ? allowRobots()
      : html('<meta name="robots" content="noindex"><p>secret</p>')
  );
  assertEquals(
    await fetchPageForCrawlWithDependencies(
      "https://example.com/noindex",
      noindex.dependencies,
    ),
    { ok: false, reason: "robots_meta_denied" },
  );

  const nofollow = fixture((url) =>
    url.endsWith("/robots.txt")
      ? allowRobots()
      : html('<meta name="robots" content="nofollow"><p>public</p>')
  );
  const result = await fetchPageForCrawlWithDependencies(
    "https://example.com/nofollow",
    nofollow.dependencies,
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.page.nofollow, true);
});

Deno.test("content hash/evidence handoff: hashと既存Evidence/place_facts契約だけを渡す", async () => {
  const contentHash = await sha256Hex("公開ページの本文");
  const handoff = buildCrawlEvidenceHandoff({
    placeId: "11111111-1111-4111-8111-111111111111",
    sourceUrl: "https://example.com/menu?utm_medium=mail#section",
    sourceTitle: " 店舗メニュー ",
    placeName: "Example",
    observedAt: "2026-08-30T00:00:00Z",
    contentHash,
    structuredClaims: [
      { key: "card_accepted", value: true, rawText: "カード可" },
      { key: "opening_hours", value: "not-a-time", rawText: "壊れたclaim" },
    ],
  });
  assertNotEquals(handoff, null);
  assertEquals(handoff?.evidence.source_url, "https://example.com/menu");
  assertEquals(handoff?.evidence.excerpt, null);
  assertEquals(handoff?.evidence.structured_claims.length, 1);
  assertEquals(handoff?.evidence.structured_claims[0].key, "card_accepted");
});
