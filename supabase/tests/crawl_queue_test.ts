// crawl queue / worker fixture test (#117)。外部fetchは全て注入fixture。
import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import {
  type CrawlQueueEnqueueInput,
  InMemoryCrawlQueue,
} from "../functions/_shared/crawl_queue.ts";
import { runCrawlWorker } from "../functions/_shared/crawl_worker.ts";
import { sha256Hex } from "../functions/_shared/crawler.ts";
import type { CrawlFetchResult } from "../functions/_shared/providers/fetcher.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const WINDOW = "2026-08-30T00";
const HASH_A = "a".repeat(64);

function input(
  url: string,
  key = url,
  origin = new URL(url).origin,
): CrawlQueueEnqueueInput {
  return {
    idempotencyKey: key,
    jobId: JOB_ID,
    canonicalUrl: url,
    origin,
    purpose: "discover",
    depth: 0,
    placeId: null,
    scheduleWindow: WINDOW,
    enqueuedBy: "fixture",
    queryPathKey: `${origin}${new URL(url).pathname}`,
    queryVariantKey: new URL(url).search,
    budgetSnapshot: {
      policyVersion: "safe-crawl-v1",
      remainingPagesTotal: 49,
      remainingBytesTotal: 10_000_000,
      remainingPagesForOrigin: 9,
      remainingQueryVariantsForPath: 2,
    },
  };
}

Deno.test("queue idempotency: 同じkeyのenqueueとcompleteを再実行しても1件", async () => {
  const queue = new InMemoryCrawlQueue(() => 1_000_000);
  const first = await queue.enqueue(input("https://example.com/a"));
  const second = await queue.enqueue(input("https://example.com/a"));
  assertEquals(first.inserted, true);
  assertEquals(second.inserted, false);
  assertEquals(queue.list().length, 1);

  const leased = await queue.lease("worker-a");
  assertNotEquals(leased, null);
  if (!leased) return;
  assertEquals(
    await queue.complete(leased, HASH_A, 100),
    { completed: true, duplicateContent: false, budgetExceeded: false },
  );
  assertEquals(
    await queue.complete(leased, HASH_A, 100),
    { completed: true, duplicateContent: false, budgetExceeded: false },
  );
  assertEquals(queue.list()[0].status, "done");
});

Deno.test("queue canonical dedupe: active URLはschedule windowを跨いで1件、terminal履歴は保持", async () => {
  const now = 1_500_000;
  const queue = new InMemoryCrawlQueue(() => now);
  const url = "https://example.com/windowed";
  const [first, activeNextWindow] = await Promise.all([
    queue.enqueue({
      ...input(url),
      purpose: "refresh",
      scheduleWindow: "2026-08-30T00",
      idempotencyKey: `refresh:2026-08-30T00:${url}`,
    }),
    queue.enqueue({
      ...input(url),
      purpose: "refresh",
      scheduleWindow: "2026-08-30T01",
      idempotencyKey: `refresh:2026-08-30T01:${url}`,
    }),
  ]);
  assertEquals(first.inserted, true);
  assertEquals(activeNextWindow.inserted, false);
  assertEquals(activeNextWindow.item.id, first.item.id);
  assertEquals(queue.list().length, 1);

  const leased = await queue.lease("window-worker");
  assertNotEquals(leased, null);
  if (!leased) return;
  await queue.complete(leased, HASH_A, 100);

  const laterWindow = await queue.enqueue({
    ...input(url),
    purpose: "refresh",
    scheduleWindow: "2026-08-30T02",
    idempotencyKey: `refresh:2026-08-30T02:${url}`,
  });
  assertEquals(laterWindow.inserted, true);
  assertEquals(queue.list().length, 2);
  assertEquals(
    queue.list().find((item) => item.id === first.item.id)?.status,
    "done",
  );
});

Deno.test("queue lease: 期限切れはpendingへ戻り、attemptを増やして再取得する", async () => {
  let now = 2_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  await queue.enqueue(input("https://example.com/expired"));
  const first = await queue.lease("worker-a", 30);
  assertNotEquals(first, null);
  now += 30_001;
  const second = await queue.lease("worker-b", 30);
  assertNotEquals(second, null);
  assertEquals(second?.attempt, 2);
  assertEquals(second?.leaseOwner, "worker-b");
});

Deno.test("queue retry: 指数backoffと4回attempt上限後deadを再現する", async () => {
  let now = 3_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  await queue.enqueue(input("https://example.com/retry"));
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const item = await queue.lease(`worker-${attempt}`);
    assertNotEquals(item, null);
    if (!item) return;
    const result = await queue.fail(item, "timeout", true);
    assertEquals(result.status, attempt < 4 ? "pending" : "dead");
    if (result.retryAt) now = Date.parse(result.retryAt) + 1;
  }
  assertEquals(queue.list()[0].status, "dead");
  assertEquals(queue.list()[0].attempt, 4);
});

Deno.test("queue origin policy: 同一originはconcurrency=1とrate間隔10秒を守る", async () => {
  let now = 4_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  await queue.enqueue(input("https://example.com/one", "one"));
  await queue.enqueue(input("https://example.com/two", "two"));
  const first = await queue.lease("worker-a");
  assertNotEquals(first, null);
  assertEquals(await queue.lease("worker-b"), null);
  if (!first) return;
  assertEquals(
    await queue.complete(first, HASH_A, 10),
    { completed: true, duplicateContent: false, budgetExceeded: false },
  );
  await queue.recordOriginPolicy("https://example.com", 25);
  now += 24_999;
  assertEquals(await queue.lease("worker-b"), null);
  now += 1;
  assertNotEquals(await queue.lease("worker-b"), null);
});

Deno.test("queue origin circuit: fail-closed 5回で同一originのpendingをdeadへ倒す", async () => {
  let now = 5_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  for (let index = 0; index < 6; index += 1) {
    await queue.enqueue(
      input(`https://blocked.example/page-${index}`, `k-${index}`),
    );
  }
  for (let index = 0; index < 5; index += 1) {
    const item = await queue.lease(`worker-${index}`);
    assertNotEquals(item, null);
    if (!item) return;
    const result = await queue.fail(item, "robots_denied", false);
    if (index < 4) assertEquals(result.originCircuitOpen, false);
    now += 10_001;
  }
  assertEquals(
    queue.originSnapshot("https://blocked.example").circuitOpen,
    true,
  );
  assertEquals(
    queue.list().filter((item) => item.status === "dead").length,
    1,
  );
  assert(
    queue.list().some((item) => item.lastErrorCode === "origin_circuit_open"),
  );
  assertEquals(await queue.lease("worker-last"), null);
});

Deno.test("queue content dedupe: 別URLでも同じcontent hashは重複扱い", async () => {
  let now = 6_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  await queue.enqueue(input("https://one.example/page"));
  await queue.enqueue(
    input("https://two.example/page", "two", "https://two.example"),
  );
  const first = await queue.lease("worker-a");
  assertNotEquals(first, null);
  if (!first) return;
  await queue.complete(first, HASH_A, 10);
  now += 10_001;
  const second = await queue.lease("worker-b");
  assertNotEquals(second, null);
  if (!second) return;
  assertEquals(
    await queue.complete(second, HASH_A, 10),
    { completed: true, duplicateContent: true, budgetExceeded: false },
  );
});

Deno.test("worker: fixture HTMLのリンクをdepth付きdiscoverへ渡し、refresh seedは冪等", async () => {
  let now = 7_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  const rootUrl = "https://fixture.example/root";
  const childUrl = "https://fixture.example/child";
  const pages: Record<string, CrawlFetchResult> = {
    [rootUrl]: {
      ok: true,
      page: {
        url: rootUrl,
        text: "root content",
        html:
          `<html><title>root</title><body><a href="${childUrl}">child</a></body></html>`,
        contentType: "text/html",
        byteLength: 80,
        nofollow: false,
        crawlDelaySeconds: null,
      },
    },
    [childUrl]: {
      ok: true,
      page: {
        url: childUrl,
        text: "child content",
        html: "<html><body>child</body></html>",
        contentType: "text/html",
        byteLength: 32,
        nofollow: false,
        crawlDelaySeconds: null,
      },
    },
  };
  const fetchPage = (url: string): Promise<CrawlFetchResult> => {
    const result = pages[url];
    if (!result) return Promise.resolve({ ok: false, reason: "http_error" });
    return Promise.resolve(result);
  };
  const job = {
    jobId: JOB_ID,
    purpose: "refresh" as const,
    seeds: [{
      url: `${rootUrl}?utm_source=fixture`,
      placeId: null,
      depth: 0,
      scheduleWindow: WINDOW,
      enqueuedBy: "fixture",
    }],
    maxItems: 1,
  };

  const first = await runCrawlWorker(
    job,
    { queue, fetchPage, now: () => now, workerId: "worker-first" },
  );
  assertEquals(first.seedAccepted, 1);
  assertEquals(first.completed, 1);
  assertEquals(first.enqueued, 2);
  assertEquals(
    queue.list().find((item) => item.canonicalUrl === childUrl)?.depth,
    1,
  );

  now += 10_001;
  const second = await runCrawlWorker(
    job,
    { queue, fetchPage, now: () => now, workerId: "worker-second" },
  );
  assertEquals(second.seedDuplicates, 1);
  assertEquals(second.processed, 1);
  assertEquals(second.completed, 1);
  assertEquals(
    queue.list().find((item) => item.canonicalUrl === childUrl)?.status,
    "done",
  );
});

Deno.test("worker: crawl成功はraw本文なしのEvidence handoffへ接続し、重複contentは抑止", async () => {
  let now = 8_500_000;
  const queue = new InMemoryCrawlQueue(() => now);
  const url = "https://fixture.example/evidence";
  const placeId = "11111111-1111-4111-8111-111111111111";
  const handoffs: unknown[] = [];
  const fetchPage = (): Promise<CrawlFetchResult> =>
    Promise.resolve({
      ok: true,
      page: {
        url,
        text: "public fixture",
        html: "<html><body>public fixture</body></html>",
        contentType: "text/html",
        byteLength: 40,
        nofollow: false,
        crawlDelaySeconds: null,
      },
    });
  const job = {
    jobId: JOB_ID,
    purpose: "refresh" as const,
    seeds: [{
      url,
      placeId,
      depth: 0,
      scheduleWindow: "2026-08-30T03",
      enqueuedBy: "fixture",
    }],
    maxItems: 1,
  };
  const first = await runCrawlWorker(job, {
    queue,
    fetchPage,
    now: () => now,
    workerId: "evidence-worker",
    evidenceWriter: (handoff) => {
      handoffs.push(handoff);
      return Promise.resolve();
    },
  });
  assertEquals(first.evidencePersisted, 1);
  assertEquals(first.evidenceFailed, 0);
  assertEquals(handoffs.length, 1);
  const handoff = handoffs[0] as {
    evidence: { source_url: string; structured_claims: unknown[] };
  };
  assertEquals(handoff.evidence.source_url, url);
  assertEquals(handoff.evidence.structured_claims, []);
  assertFalse("html" in handoff);

  // 別URLでも同じ本文hashなら queue complete が duplicate と判定し、
  // Evidence handoffへは二重に渡さない。
  now += 10_001;
  const second = await runCrawlWorker({
    ...job,
    seeds: [{
      ...job.seeds[0],
      url: "https://fixture.example/evidence-mirror",
      scheduleWindow: "2026-08-30T04",
    }],
  }, {
    queue,
    fetchPage: () =>
      Promise.resolve({
        ok: true,
        page: {
          url: "https://fixture.example/evidence-mirror",
          text: "public fixture",
          html: "<html><body>public fixture</body></html>",
          contentType: "text/html",
          byteLength: 40,
          nofollow: false,
          crawlDelaySeconds: null,
        },
      }),
    now: () => now,
    workerId: "evidence-worker-2",
    evidenceWriter: (next) => {
      handoffs.push(next);
      return Promise.resolve();
    },
  });
  assertEquals(second.evidencePersisted, 0);
  assertEquals(second.duplicateContent, 1);
  assertEquals(handoffs.length, 1);
});

Deno.test("worker: hashはSHA-256で計算し、外部fetch失敗はretry/dead契約へ渡す", async () => {
  assertEquals(
    await sha256Hex("fixture"),
    "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
  );
  // 上の固定値を手計算で維持しないため、実際の形式も確認する。
  assertEquals((await sha256Hex("fixture")).length, 64);

  const now = 8_000_000;
  const queue = new InMemoryCrawlQueue(() => now);
  await queue.enqueue(input("https://fixture.example/fails"));
  const item = await queue.lease("worker");
  assertNotEquals(item, null);
  if (item) {
    const result = await queue.fail(item, "network_error", true);
    assertEquals(result.status, "pending");
    assertFalse(result.retryAt === null);
  }
});
