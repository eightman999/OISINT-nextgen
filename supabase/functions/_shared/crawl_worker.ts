// Safe crawler worker (#117)
//
// このworkerは lease された queue item を1件ずつ処理するだけで、schedulerを持たない。
// scheduler (#123) は purpose=refresh と scheduleWindow を指定してこの境界を呼び出す。
// 外部fetchの実装は注入し、fixtureでは fetchPageForCrawlWithDependencies を使う。
import {
  buildCrawlEvidenceHandoff,
  buildCrawlObservation,
  canonicalizeCrawlUrl,
  canRecordCrawlResponseBytes,
  CrawlBudgetLedger,
  type CrawlBudgetLimits,
  type CrawlErrorCode,
  type CrawlEvidenceHandoff,
  type CrawlObservation,
  crawlOrigin,
  crawlPathKey,
  crawlQueryVariantKey,
  DEFAULT_CRAWL_BUDGET,
  extractCrawlLinks,
  isRetryableCrawlFailure,
  sha256Hex,
} from "./crawler.ts";
import {
  type CrawlPurpose,
  type CrawlQueueItem,
  type CrawlQueueStore,
} from "./crawl_queue.ts";
import {
  type CrawlFetchResult,
  fetchPageForCrawl,
} from "./providers/fetcher.ts";

const WORKER_LEASE_SECONDS = 60;
const DEFAULT_MAX_ITEMS = 10;
const MAX_WORKER_ITEMS = 10;

export interface CrawlSeed {
  url: string;
  placeId: string | null;
  depth: number;
  scheduleWindow: string;
  enqueuedBy: string;
}

export interface CrawlWorkerJob {
  jobId: string;
  purpose: CrawlPurpose;
  seeds: readonly CrawlSeed[];
  maxItems?: number;
  budget?: Partial<CrawlBudgetLimits>;
}

export interface CrawlWorkerDependencies {
  queue: CrawlQueueStore;
  fetchPage?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<CrawlFetchResult>;
  now?: () => number;
  workerId?: string;
  /** raw本文ではなく、検証済み handoff だけを既存Evidence経路へ渡す。 */
  evidenceWriter?: (handoff: CrawlEvidenceHandoff) => Promise<void>;
}

export interface CrawlWorkerSummary {
  seedAccepted: number;
  seedDuplicates: number;
  seedRejected: number;
  processed: number;
  completed: number;
  failed: number;
  retried: number;
  dead: number;
  duplicateContent: number;
  budgetExceeded: number;
  enqueued: number;
  evidencePersisted: number;
  evidenceFailed: number;
  observations: CrawlObservation[];
}

function safeToken(value: string, fallback: string, maxLength: number): string {
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && normalized.length <= maxLength &&
      /^[\x20-\x7e]+$/.test(normalized)
    ? normalized
    : fallback;
}

function idempotencyKey(
  purpose: CrawlPurpose,
  scheduleWindow: string,
  canonicalUrl: string,
): string {
  return `${purpose}:${scheduleWindow}:${canonicalUrl}`;
}

function observe(
  summary: CrawlWorkerSummary,
  input: Parameters<typeof buildCrawlObservation>[0],
): void {
  summary.observations.push(buildCrawlObservation(input));
}

function emptySummary(): CrawlWorkerSummary {
  return {
    seedAccepted: 0,
    seedDuplicates: 0,
    seedRejected: 0,
    processed: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    dead: 0,
    duplicateContent: 0,
    budgetExceeded: 0,
    enqueued: 0,
    evidencePersisted: 0,
    evidenceFailed: 0,
    observations: [],
  };
}

function countFailure(
  summary: CrawlWorkerSummary,
  status: "pending" | "failed" | "dead",
): void {
  if (status === "pending") summary.retried += 1;
  else if (status === "dead") summary.dead += 1;
  else summary.failed += 1;
}

interface EnqueueCandidateInput {
  rawUrl: string;
  depth: number;
  purpose: CrawlPurpose;
  placeId: string | null;
  scheduleWindow: string;
  enqueuedBy: string;
}

async function enqueueCandidate(
  job: CrawlWorkerJob,
  candidate: EnqueueCandidateInput,
  ledger: CrawlBudgetLedger,
  summary: CrawlWorkerSummary,
  deps: CrawlWorkerDependencies,
): Promise<CrawlQueueItem | null> {
  const decision = ledger.reserve(candidate.rawUrl, candidate.depth);
  if (!decision.accepted) {
    summary.seedRejected += 1;
    const errorCode = decision.reason === "invalid_url"
      ? "bad_url"
      : decision.reason === "duplicate_url"
      ? undefined
      : "budget_exceeded";
    observe(summary, {
      provider: "crawler",
      operation: "enqueue",
      url: candidate.rawUrl,
      outcome: "skipped",
      ...(errorCode ? { errorCode } : {}),
      depth: candidate.depth,
    });
    return null;
  }

  const canonicalUrl = decision.url.href;
  const scheduleWindow = safeToken(
    candidate.scheduleWindow,
    "unspecified",
    80,
  );
  const enqueuedBy = safeToken(candidate.enqueuedBy, "worker", 128);
  const result = await deps.queue.enqueue({
    idempotencyKey: idempotencyKey(
      candidate.purpose,
      scheduleWindow,
      canonicalUrl,
    ),
    jobId: job.jobId,
    canonicalUrl,
    origin: crawlOrigin(decision.url),
    purpose: candidate.purpose,
    depth: candidate.depth,
    placeId: candidate.placeId,
    scheduleWindow,
    enqueuedBy,
    queryPathKey: crawlPathKey(decision.url),
    queryVariantKey: crawlQueryVariantKey(decision.url),
    budgetSnapshot: decision.snapshot,
  });
  observe(summary, {
    provider: "crawler",
    operation: "enqueue",
    url: canonicalUrl,
    outcome: result.inserted ? "ok" : "skipped",
    depth: candidate.depth,
  });
  if (result.inserted) summary.enqueued += 1;
  return result.inserted ? result.item : null;
}

async function failLeasedItem(
  item: CrawlQueueItem,
  errorCode: CrawlErrorCode,
  summary: CrawlWorkerSummary,
  deps: CrawlWorkerDependencies,
): Promise<void> {
  const result = await deps.queue.fail(
    item,
    errorCode,
    isRetryableCrawlFailure(errorCode),
  );
  countFailure(summary, result.status as "pending" | "failed" | "dead");
  if (result.deadCount > 0 && result.status !== "dead") {
    summary.dead += result.deadCount;
  }
  if (result.status === "dead" && result.deadCount > 1) {
    summary.dead += result.deadCount - 1;
  }
  observe(summary, {
    provider: "crawler",
    operation: result.status === "pending" ? "retry" : "dead",
    url: item.canonicalUrl,
    outcome: result.status === "pending" ? "ok" : "error",
    errorCode,
    depth: item.depth,
    attempt: item.attempt,
  });
}

function fetchFailureReason(result: CrawlFetchResult): CrawlErrorCode {
  return result.ok ? "empty_body" : result.reason;
}

/**
 * queueをleaseして安全に処理する。DB/RPCを直接呼ぶのはqueue adapterだけであり、
 * この関数はSupabaseや特定の実行時間制限を知らない。raw HTMLはこの関数のローカル
 * 変数でリンク抽出に消費し、summary/queue/observationsへ渡さない。
 */
export async function runCrawlWorker(
  job: CrawlWorkerJob,
  deps: CrawlWorkerDependencies,
  signal?: AbortSignal,
): Promise<CrawlWorkerSummary> {
  const summary = emptySummary();
  const limits = job.budget ?? DEFAULT_CRAWL_BUDGET;
  const ledger = new CrawlBudgetLedger(limits);
  const workerId = deps.workerId ?? crypto.randomUUID();
  const fetchPage = deps.fetchPage ?? fetchPageForCrawl;
  const maxItems = Number.isSafeInteger(job.maxItems) && (job.maxItems ?? 0) > 0
    ? Math.min(job.maxItems as number, MAX_WORKER_ITEMS)
    : DEFAULT_MAX_ITEMS;

  for (const seed of job.seeds) {
    if (signal?.aborted) break;
    const item = await enqueueCandidate(
      job,
      {
        rawUrl: seed.url,
        depth: seed.depth,
        purpose: job.purpose,
        placeId: seed.placeId,
        scheduleWindow: seed.scheduleWindow,
        enqueuedBy: seed.enqueuedBy,
      },
      ledger,
      summary,
      deps,
    );
    if (item) summary.seedAccepted += 1;
    else {
      const canonical = canonicalizeCrawlUrl(seed.url);
      if (canonical && ledger.state.reservedUrls.has(canonical.href)) {
        summary.seedDuplicates += 1;
      }
    }
  }

  while (summary.processed < maxItems && !signal?.aborted) {
    const item = await deps.queue.lease(workerId, WORKER_LEASE_SECONDS);
    if (!item) break;
    summary.processed += 1;
    observe(summary, {
      provider: "crawler",
      operation: "lease",
      url: item.canonicalUrl,
      outcome: "ok",
      depth: item.depth,
      attempt: item.attempt,
    });

    const startedAt = (deps.now ?? Date.now)();
    let result: CrawlFetchResult;
    try {
      result = await fetchPage(item.canonicalUrl, signal);
    } catch {
      result = { ok: false, reason: "network_error" };
    }
    const durationMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
    if (!result.ok) {
      if (result.crawlDelaySeconds !== undefined) {
        await deps.queue.recordOriginPolicy(
          item.origin,
          result.crawlDelaySeconds,
        );
      }
      observe(summary, {
        provider: "safe_fetch",
        operation: "fetch",
        url: item.canonicalUrl,
        outcome: "error",
        errorCode: result.reason,
        depth: item.depth,
        attempt: item.attempt,
        durationMs,
      });
      // cancellation lets the lease expire and be reclaimed; it must not be turned
      // into a permanent failure caused by the caller aborting the worker.
      if (result.reason === "aborted" && signal?.aborted) break;
      await failLeasedItem(item, fetchFailureReason(result), summary, deps);
      continue;
    }

    const page = result.page;
    await deps.queue.recordOriginPolicy(
      item.origin,
      page.crawlDelaySeconds,
    );
    const contentHash = await sha256Hex(page.text);
    if (!canRecordCrawlResponseBytes(ledger.state, page.byteLength, limits)) {
      summary.budgetExceeded += 1;
      const marked = await deps.queue.markDead(item, "budget_exceeded");
      if (marked) summary.dead += 1;
      observe(summary, {
        provider: "crawler",
        operation: "dead",
        url: item.canonicalUrl,
        outcome: "skipped",
        errorCode: "budget_exceeded",
        depth: item.depth,
        attempt: item.attempt,
        bytes: page.byteLength,
        durationMs,
      });
      continue;
    }

    const completed = await deps.queue.complete(
      item,
      contentHash,
      page.byteLength,
    );
    if (!completed.completed) {
      observe(summary, {
        provider: "crawler",
        operation: "complete",
        url: item.canonicalUrl,
        outcome: "error",
        errorCode: "lease_lost",
        depth: item.depth,
        attempt: item.attempt,
        bytes: page.byteLength,
        durationMs,
      });
      continue;
    }
    if (!completed.budgetExceeded) ledger.recordBytes(page.byteLength);
    summary.completed += 1;
    if (completed.budgetExceeded) summary.budgetExceeded += 1;
    if (completed.duplicateContent) summary.duplicateContent += 1;
    observe(summary, {
      provider: "crawler",
      operation: "complete",
      url: item.canonicalUrl,
      outcome: completed.budgetExceeded || completed.duplicateContent
        ? "skipped"
        : "ok",
      errorCode: completed.budgetExceeded
        ? "budget_exceeded"
        : completed.duplicateContent
        ? "duplicate_content"
        : undefined,
      depth: item.depth,
      attempt: item.attempt,
      bytes: page.byteLength,
      durationMs,
    });

    if (
      deps.evidenceWriter && item.placeId && !completed.budgetExceeded &&
      !completed.duplicateContent
    ) {
      const observedAt = new Date((deps.now ?? Date.now)()).toISOString();
      const handoff = buildCrawlEvidenceHandoff({
        placeId: item.placeId,
        sourceUrl: page.url,
        observedAt,
        contentHash,
        // Claim extraction belongs to the existing provider/Evidence path. A
        // crawler success without that extraction is a neutral citation only.
        structuredClaims: [],
      }, new Date(observedAt));
      if (handoff) {
        try {
          await deps.evidenceWriter(handoff);
          summary.evidencePersisted += 1;
        } catch {
          // Queue completion is already durable; keep the failure observable
          // without exposing provider/DB details or raw page content.
          summary.evidenceFailed += 1;
          console.error("crawl evidence handoff failed");
        }
      }
    }

    if (
      completed.budgetExceeded || completed.duplicateContent || page.nofollow
    ) {
      continue;
    }
    if (item.depth >= ledger.limits.maxDepth) continue;

    const links = extractCrawlLinks(
      page.html,
      page.url,
      ledger.limits.maxLinksPerPage,
    );
    for (const link of links) {
      if (signal?.aborted) break;
      await enqueueCandidate(
        job,
        {
          rawUrl: link,
          depth: item.depth + 1,
          purpose: "discover",
          placeId: item.placeId,
          scheduleWindow: item.scheduleWindow,
          enqueuedBy: "worker",
        },
        ledger,
        summary,
        deps,
      );
    }
  }
  return summary;
}
