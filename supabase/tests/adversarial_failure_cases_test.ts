import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMember } from "../functions/_shared/db.ts";
import { DatabaseOperationError } from "../functions/_shared/database_error.ts";
import {
  fetchPageTextWithDependencies,
  type SafeFetchDependencies,
} from "../functions/_shared/providers/fetcher.ts";
import { isTerminalizedCompleteResponse } from "../functions/_shared/queue_drain.ts";
import { readRequestBodyLimited } from "../functions/_shared/request_body.ts";

const POLICY = "deny-private-public-egress-v1" as const;
const PUBLIC_V4 = "93.184.216.34";
const runSource = await Deno.readTextFile(
  new URL("../functions/run-investigation/index.ts", import.meta.url),
);
const rerankSource = await Deno.readTextFile(
  new URL("../functions/rerank-investigation/index.ts", import.meta.url),
);
const anchorAtomicityMigration = await Deno.readTextFile(
  new URL(
    "../migrations/202608300002_location_anchor_required_atomicity.sql",
    import.meta.url,
  ),
);

type Settlement = "settled" | "timeout-observed";

async function observeSettlement<T>(
  promise: Promise<T>,
  timeoutMs = 50,
): Promise<Settlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((): Settlement => "settled", (): Settlement => "settled"),
      new Promise<Settlement>((resolve) => {
        timer = setTimeout(() => resolve("timeout-observed"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function closeStream(
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
): void {
  try {
    controller?.close();
  } catch {
    // 修正後に読者側が先にcancelしても再現テストの後始末は継続する。
  }
}

Deno.test("Edge request bodyの途中停止はdeadlineでcancelされる", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelCount = 0;
  const request = new Request("https://edge.example", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelCount += 1;
      },
    }),
  });
  const pending = readRequestBodyLimited(request, 16 * 1024, {
    timeoutMs: 20,
  });
  try {
    assertEquals(await observeSettlement(pending, 100), "settled");
    const result = await pending;
    assertEquals(result.timedOut, true);
    assertEquals(result.readError, false);
    await Promise.resolve();
    assertEquals(cancelCount, 1);
  } finally {
    closeStream(controller);
    await pending.catch(() => undefined);
  }
});

Deno.test("fetcherのDNS停止はfetch hard deadlineへ収束する", async () => {
  let releaseDns!: () => void;
  const dnsGate = new Promise<readonly string[]>((resolve) => {
    releaseDns = () => resolve([PUBLIC_V4]);
  });
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => dnsGate,
    fetchHop: () => Promise.resolve(new Response("", { status: 404 })),
  };
  const pending = fetchPageTextWithDependencies(
    "https://public.example/page",
    dependencies,
    undefined,
    { fetchTimeoutMs: 20, robotsTimeoutMs: 10 },
  );
  try {
    assertEquals(await observeSettlement(pending, 100), "settled");
    assertEquals(await pending, null);
  } finally {
    releaseDns();
    await pending.catch(() => undefined);
  }
});

Deno.test("fetcherのrobots本文停止は3秒契約相当でcancelしてfail-closed", async () => {
  let robotsController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let robotsCancelCount = 0;
  const encoder = new TextEncoder();
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => Promise.resolve([PUBLIC_V4]),
    fetchHop: (url) => {
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                robotsController = controller;
                controller.enqueue(encoder.encode("User-agent: *\nAllow: /"));
              },
              cancel() {
                robotsCancelCount += 1;
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response("<p>ok</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    },
  };
  const pending = fetchPageTextWithDependencies(
    "https://public.example/page",
    dependencies,
    undefined,
    { fetchTimeoutMs: 100, robotsTimeoutMs: 20 },
  );
  try {
    assertEquals(await observeSettlement(pending, 100), "settled");
    assertEquals(await pending, null);
    await Promise.resolve();
    assertEquals(robotsCancelCount, 1);
  } finally {
    closeStream(robotsController);
    await pending.catch(() => undefined);
  }
});

Deno.test("fetcherのページ本文停止は全体hard deadlineでcancelする", async () => {
  let pageController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pageCancelCount = 0;
  const encoder = new TextEncoder();
  const dependencies: SafeFetchDependencies = {
    connectionPolicy: POLICY,
    resolveDns: () => Promise.resolve([PUBLIC_V4]),
    fetchHop: (url) => {
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              pageController = controller;
              controller.enqueue(encoder.encode("<p>partial</p>"));
            },
            cancel() {
              pageCancelCount += 1;
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
      );
    },
  };
  const pending = fetchPageTextWithDependencies(
    "https://public.example/page",
    dependencies,
    undefined,
    { fetchTimeoutMs: 30, robotsTimeoutMs: 10 },
  );
  try {
    assertEquals(await observeSettlement(pending, 100), "settled");
    assertEquals(await pending, null);
    await Promise.resolve();
    assertEquals(pageCancelCount, 1);
  } finally {
    closeStream(pageController);
    await pending.catch(() => undefined);
  }
});

Deno.test("queue drainの409本文停止はdeadlineでcancelされる", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelCount = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(
          new TextEncoder().encode('{"status":"complete"'),
        );
      },
      cancel() {
        cancelCount += 1;
      },
    }),
    { status: 409 },
  );
  const pending = isTerminalizedCompleteResponse(response, undefined, {
    timeoutMs: 20,
  });
  try {
    assertEquals(await observeSettlement(pending, 100), "settled");
    assertEquals(await pending, false);
    await Promise.resolve();
    assertEquals(cancelCount, 1);
  } finally {
    closeStream(controller);
    await pending.catch(() => undefined);
  }
});

Deno.test("DB障害はisMemberの不在falseと区別してtyped errorになる", async () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () =>
      Promise.resolve({
        data: null,
        error: { message: "database unavailable" },
      }),
  };
  const db = {
    from: () => chain,
  } as unknown as SupabaseClient;

  await assertRejects(
    () =>
      isMember(
        db,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ),
    DatabaseOperationError,
    "investigation_members.membership_select",
  );

  const absentChain = {
    select: () => absentChain,
    eq: () => absentChain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  const absentDb = {
    from: () => absentChain,
  } as unknown as SupabaseClient;
  assertFalse(
    await isMember(
      absentDb,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ),
  );
});

Deno.test("run/rerankはDB障害を404/401ではなく503再試行へ写像する", () => {
  for (const source of [runSource, rerankSource]) {
    assertStringIncludes(source, "error: investigationError");
    assertStringIncludes(source, ".maybeSingle()");
    assertStringIncludes(source, '"調査情報を確認できませんでした"');
    assertStringIncludes(source, '"参加状態を確認できませんでした"');
    assertStringIncludes(source, "503");
    assertStringIncludes(source, '"Retry-After": "1"');
    assertStringIncludes(source, '"調査が見つかりません"');
    assertStringIncludes(source, '"この調査のメンバーではありません"');
  }
});

Deno.test("runのcurrent-location未指定経路もrate limitを先に消費する", () => {
  const anchorGuard = runSource.indexOf(
    'queryMentionsCurrentLocation(inv.raw_query ?? "")',
  );
  const rateLimitCall = runSource.indexOf(
    "const rateLimit = await waitForReceipt(",
  );
  assert(anchorGuard >= 0, "current-location guardがない");
  assert(
    rateLimitCall >= 0 && rateLimitCall < anchorGuard,
    "rate limitが早期202より後ろ",
  );
  const rateLimitBlock = runSource.slice(rateLimitCall, anchorGuard);
  assertStringIncludes(rateLimitBlock, "checkRateLimit(");
  assertStringIncludes(rateLimitBlock, "limited ? 429 : 503");
  assertStringIncludes(rateLimitBlock, '"Retry-After"');
});

Deno.test("run公開受付は5秒hard deadline、内部drainは別budgetに分離する", () => {
  assertStringIncludes(runSource, "Deno.serve(async (req) =>");
  assertStringIncludes(runSource, "async function handleRunReceipt(");
  assertStringIncludes(runSource, "withAbortTimeout(");
  assertStringIncludes(runSource, "EDGE_TIMEOUT_POLICY.receipt");
  assertStringIncludes(runSource, "OperationTimeoutError");
  assertStringIncludes(runSource, '"調査の受付がタイムアウトしました"');
  assertStringIncludes(runSource, "504");
  assertStringIncludes(runSource, '{ "Retry-After": "1" }');
  const drainBranch = runSource.indexOf("return await drainQueuedRuns(");
  const receiptDeadline = runSource.lastIndexOf("withAbortTimeout(");
  assert(drainBranch >= 0 && drainBranch < receiptDeadline);
});

Deno.test("runのanchor不足はrow lock付きRPCでstatus/eventを原子的に確定する", () => {
  const start = runSource.indexOf(
    "async function persistLocationAnchorRequired",
  );
  const end = runSource.indexOf("function enqueueRun", start);
  assert(start >= 0 && end > start, "anchor persistence関数が見つからない");
  const block = runSource.slice(start, end);
  assertStringIncludes(
    block,
    'db.rpc("persist_investigation_location_anchor_required"',
  );
  assertStringIncludes(block, "rpcRow(data)?.persisted !== true");
  assertFalse(block.includes('.from("investigations").update'));
  assertFalse(block.includes('.from("investigation_events")'));

  assertStringIncludes(anchorAtomicityMigration, "for update;");
  assertStringIncludes(anchorAtomicityMigration, "where not exists (");
  assertStringIncludes(anchorAtomicityMigration, "return query select true;");
  assertStringIncludes(
    anchorAtomicityMigration,
    "to service_role;",
  );
  assertStringIncludes(
    anchorAtomicityMigration,
    "from public, anon, authenticated;",
  );
});
