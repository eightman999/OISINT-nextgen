import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchPageTextWithDependencies,
  htmlToText,
  isPublicIpAddress,
  normalizeFetchUrl,
  type SafeFetchDependencies,
} from "../functions/_shared/providers/fetcher.ts";

const POLICY = "deny-private-public-egress-v1" as const;
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

interface FetchCall {
  url: string;
  addresses: readonly string[];
  redirect: RequestRedirect | undefined;
}

function fixture(
  responses: Record<string, Response | (() => Response)>,
  records: Record<string, { A?: readonly string[]; AAAA?: readonly string[] }> =
    {},
) {
  const fetchCalls: FetchCall[] = [];
  const dnsCalls: string[] = [];
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: (hostname, recordType) => {
      dnsCalls.push(`${hostname}:${recordType}`);
      return Promise.resolve(records[hostname]?.[recordType] ?? []);
    },
    fetchHop: (url, addresses, init) => {
      fetchCalls.push({ url, addresses, redirect: init.redirect });
      const response = responses[url];
      if (!response) throw new Error("fixture miss");
      return Promise.resolve(
        typeof response === "function" ? response() : response,
      );
    },
  };
  return { dependencies, dnsCalls, fetchCalls };
}

Deno.test("htmlToText: script/style を除去し本文だけ残す", () => {
  const html = `<html><head><style>.a{color:red}</style>
    <script>alert("x")</script></head>
    <body><h1>営業時間</h1><p>17:00〜23:00</p></body></html>`;
  const text = htmlToText(html);
  assertStringIncludes(text, "営業時間");
  assertStringIncludes(text, "17:00〜23:00");
  assertEquals(text.includes("alert"), false);
  assertEquals(text.includes("color:red"), false);
});

Deno.test("htmlToText: ブロック要素の閉じで改行し、エンティティを戻す", () => {
  const text = htmlToText("<p>A&amp;B</p><p>C &gt; D</p>");
  assertStringIncludes(text, "A&B");
  assertStringIncludes(text, "C > D");
});

Deno.test("normalizeFetchUrl: canonical URLだけを許可する", () => {
  assertEquals(
    normalizeFetchUrl("https://EXAMPLE.com:443/a#fragment")?.href,
    "https://example.com/a",
  );
  for (
    const rejected of [
      "//example.com/a",
      "https://user:secret@example.com/a",
      "https:example.com/a",
      "http://example.com/a",
      "file:///etc/passwd",
      " https://example.com/a",
      "http://localhost/a",
      "http://service.internal/a",
      "https://oisint.com/a",
      "https://api.oisint.com/v1/health",
    ]
  ) {
    assertEquals(normalizeFetchUrl(rejected), null, rejected);
  }
});

Deno.test("isPublicIpAddress: literal private/special/mapped/NAT64を拒否する", () => {
  for (
    const rejected of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1",
      "2002:7f00:1::1",
    ]
  ) {
    assertEquals(isPublicIpAddress(rejected), false, rejected);
  }
  assertEquals(isPublicIpAddress(PUBLIC_V4), true);
  assertEquals(isPublicIpAddress(PUBLIC_V6), true);
  assertEquals(isPublicIpAddress("::ffff:93.184.216.34"), true);
  assertEquals(isPublicIpAddress("64:ff9b::5db8:d822"), true);
});

Deno.test("fetcher: DNS A+AAAAのどれか一つでも非公開なら接続しない", async () => {
  const { dependencies, dnsCalls, fetchCalls } = fixture({}, {
    "mixed.example": { A: [PUBLIC_V4], AAAA: ["fe80::1"] },
  });
  assertEquals(
    await fetchPageTextWithDependencies("https://mixed.example/", dependencies),
    null,
  );
  assertEquals(dnsCalls.sort(), ["mixed.example:A", "mixed.example:AAAA"]);
  assertEquals(fetchCalls.length, 0);
});

Deno.test("fetcher: robotsと本文を同じ公開egress境界で取得する", async () => {
  const { dependencies, dnsCalls, fetchCalls } = fixture({
    "https://public.example/robots.txt": new Response(
      "User-agent: *\nDisallow:",
      { status: 200 },
    ),
    "https://public.example/page": new Response(
      "<html><body><p>公開ページ</p></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ),
  }, {
    "public.example": { A: [PUBLIC_V4], AAAA: [PUBLIC_V6] },
  });

  const page = await fetchPageTextWithDependencies(
    "https://public.example/page#ignored",
    dependencies,
  );
  assertEquals(page, {
    url: "https://public.example/page",
    text: "公開ページ",
  });
  assertEquals(fetchCalls.map((call) => call.url), [
    "https://public.example/robots.txt",
    "https://public.example/page",
  ]);
  assertEquals(fetchCalls.every((call) => call.redirect === "manual"), true);
  assertEquals(
    fetchCalls.every((call) =>
      call.addresses.includes(PUBLIC_V4) && call.addresses.includes(PUBLIC_V6)
    ),
    true,
  );
  assertEquals(dnsCalls.length, 6); // precheck + robots + body, each A and AAAA
});

Deno.test("fetcher: same-origin redirectを再解決しDNS rebindingを拒否する", async () => {
  const fetchCalls: string[] = [];
  let aLookups = 0;
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: (_hostname, recordType) => {
      if (recordType === "AAAA") return Promise.resolve([]);
      aLookups++;
      return Promise.resolve(aLookups >= 4 ? ["169.254.169.254"] : [PUBLIC_V4]);
    },
    fetchHop: (url) => {
      fetchCalls.push(url);
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "/latest" },
        }),
      );
    },
  };

  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/start",
      dependencies,
    ),
    null,
  );
  assertEquals(fetchCalls, [
    "https://public.example/robots.txt",
    "https://public.example/start",
  ]);
  assertEquals(aLookups, 4);
});

Deno.test("fetcher: cross-origin redirectは公開IPでも拒否する", async () => {
  const { dependencies, fetchCalls } = fixture({
    "https://public.example/robots.txt": new Response("", { status: 404 }),
    "https://public.example/start": new Response(null, {
      status: 302,
      headers: { location: "https://other.example/next" },
    }),
  }, {
    "public.example": { A: [PUBLIC_V4] },
    "other.example": { A: [PUBLIC_V4] },
  });
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/start",
      dependencies,
    ),
    null,
  );
  assertEquals(fetchCalls.map((call) => call.url), [
    "https://public.example/robots.txt",
    "https://public.example/start",
  ]);
});

Deno.test("fetcher: protocol-relative redirectを拒否する", async () => {
  const { dependencies, fetchCalls } = fixture({
    "https://public.example/robots.txt": new Response("", { status: 404 }),
    "https://public.example/start": new Response(null, {
      status: 302,
      headers: { location: "//other.example/next" },
    }),
  }, {
    "public.example": { A: [PUBLIC_V4] },
    "other.example": { A: [PUBLIC_V4] },
  });

  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/start",
      dependencies,
    ),
    null,
  );
  assertEquals(fetchCalls.length, 2);
});

Deno.test("fetcher: literal内部IP URLはDNSにも接続にも進まない", async () => {
  for (
    const rejected of [
      "https://127.0.0.1/latest", // loopback
      "https://10.0.0.8/menu", // RFC1918
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6
      "https://[64:ff9b::a9fe:a9fe]/", // NAT64 well-known → metadata
      "https://[fe80::1]/", // link-local
      "https://[fc00::1]/", // ULA
      "https://0x7f000001/", // hex 表記 (URL parser が 127.0.0.1 へ正規化)
    ]
  ) {
    const { dependencies, dnsCalls, fetchCalls } = fixture({});
    assertEquals(
      await fetchPageTextWithDependencies(rejected, dependencies),
      null,
      rejected,
    );
    assertEquals(dnsCalls.length, 0, rejected);
    assertEquals(fetchCalls.length, 0, rejected);
  }
});

Deno.test("fetcher: redirectがmetadata IPやuserinfo付きURLへ向かえば接続しない", async () => {
  for (
    const location of [
      "https://169.254.169.254/latest/meta-data", // cloud metadata literal
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 literal
      "https://user:pass@public.example/next", // same-origin だが userinfo 付き
    ]
  ) {
    const { dependencies, fetchCalls } = fixture({
      "https://public.example/robots.txt": new Response("", { status: 404 }),
      "https://public.example/start": new Response(null, {
        status: 302,
        headers: { location },
      }),
    }, {
      "public.example": { A: [PUBLIC_V4] },
    });
    assertEquals(
      await fetchPageTextWithDependencies(
        "https://public.example/start",
        dependencies,
      ),
      null,
      location,
    );
    assertEquals(fetchCalls.map((call) => call.url), [
      "https://public.example/robots.txt",
      "https://public.example/start",
    ], location);
  }
});

Deno.test("fetcher: redirect上限超過・resolver/fetch失敗をnullにする", async () => {
  const responses: Record<string, () => Response> = {
    "https://public.example/robots.txt": () =>
      new Response("", { status: 404 }),
  };
  for (let hop = 0; hop <= 5; hop++) {
    responses[`https://public.example/${hop}`] = () =>
      new Response(null, {
        status: 302,
        headers: { location: `/` + (hop + 1) },
      });
  }
  const { dependencies } = fixture(responses, {
    "public.example": { A: [PUBLIC_V4] },
  });
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/0",
      dependencies,
    ),
    null,
  );

  const brokenDns: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => Promise.reject(new Error("dns unavailable")),
    fetchHop: () => Promise.reject(new Error("must not run")),
  };
  assertEquals(
    await fetchPageTextWithDependencies("https://public.example/", brokenDns),
    null,
  );
});

Deno.test("fetcher: robots拒否時は本文へ接続しない", async () => {
  const { dependencies, fetchCalls } = fixture({
    "https://public.example/robots.txt": new Response(
      "User-agent: *\nDisallow: /private",
      { status: 200 },
    ),
  }, {
    "public.example": { A: [PUBLIC_V4] },
  });
  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/private/menu",
      dependencies,
    ),
    null,
  );
  assertEquals(fetchCalls.map((call) => call.url), [
    "https://public.example/robots.txt",
  ]);
});

Deno.test("fetcher: 既にabort済みの親signalではrobots/本文の接続を開始しない", async () => {
  const controller = new AbortController();
  controller.abort(new Error("candidate timeout"));
  const { dependencies, dnsCalls, fetchCalls } = fixture({}, {
    "public.example": { A: [PUBLIC_V4] },
  });

  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/page",
      dependencies,
      controller.signal,
    ),
    null,
  );
  // hard deadlineを初回precheckより外側へ置くため、既にabort済みならDNSも開始しない。
  assertEquals(dnsCalls.length, 0);
  assertEquals(fetchCalls.length, 0);
});

Deno.test("fetcher: header停止はhard deadlineでsignal abortしてnullへ収束する", async () => {
  let headerSignal: AbortSignal | null | undefined;
  let releaseHeader!: () => void;
  const headerGate = new Promise<Response>((resolve) => {
    releaseHeader = () =>
      resolve(
        new Response("<p>late</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
  });
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => Promise.resolve([PUBLIC_V4]),
    fetchHop: (url, _addresses, init) => {
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      headerSignal = init.signal;
      return headerGate;
    },
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    fetchPageTextWithDependencies(
      "https://public.example/page",
      dependencies,
      undefined,
      { fetchTimeoutMs: 20, robotsTimeoutMs: 10 },
    ).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  assertEquals(settled, true);
  assertEquals(headerSignal?.aborted, true);
  releaseHeader();
});

Deno.test("fetcher: robots header停止は3秒契約相当でfail-closedする", async () => {
  let robotsSignal: AbortSignal | null | undefined;
  let releaseRobots!: () => void;
  const robotsGate = new Promise<Response>((resolve) => {
    releaseRobots = () => resolve(new Response("", { status: 404 }));
  });
  let pageCalls = 0;
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => Promise.resolve([PUBLIC_V4]),
    fetchHop: (url, _addresses, init) => {
      if (url.endsWith("/robots.txt")) {
        robotsSignal = init.signal;
        return robotsGate;
      }
      pageCalls += 1;
      return Promise.resolve(
        new Response("<p>must not run</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    },
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    fetchPageTextWithDependencies(
      "https://public.example/page",
      dependencies,
      undefined,
      { fetchTimeoutMs: 100, robotsTimeoutMs: 20 },
    ).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  assertEquals(settled, true);
  assertEquals(robotsSignal?.aborted, true);
  assertEquals(pageCalls, 0);
  releaseRobots();
});

Deno.test("fetcher: redirect hopのcancel停止は次hop/deadlineを保持する", async () => {
  const fetchCalls: string[] = [];
  const stalledCancelBody = new ReadableStream<Uint8Array>({
    cancel: () => new Promise<never>(() => {}),
  });
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => Promise.resolve([PUBLIC_V4]),
    fetchHop: (url) => {
      fetchCalls.push(url);
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      if (url.endsWith("/start")) {
        return Promise.resolve(
          new Response(stalledCancelBody, {
            status: 302,
            headers: { location: "/next" },
          }),
        );
      }
      return Promise.resolve(
        new Response("<p>next</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    },
  };

  assertEquals(
    await fetchPageTextWithDependencies(
      "https://public.example/start",
      dependencies,
      undefined,
      { fetchTimeoutMs: 100, robotsTimeoutMs: 10 },
    ),
    { url: "https://public.example/next", text: "next" },
  );
  assertEquals(fetchCalls, [
    "https://public.example/robots.txt",
    "https://public.example/start",
    "https://public.example/next",
  ]);
});
