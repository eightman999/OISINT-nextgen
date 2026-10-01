// crawl-worker (#117)
//
// service-role専用のworker入口。scheduler (#123) は実装せず、呼び出し元が
// purpose=refresh と scheduleWindow を渡したjobだけを受け取る。
import { z } from "zod";
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";
import { refreshPlaceFacts } from "../_shared/facts.ts";
import { insertCrawlEvidenceIfStale } from "../_shared/pipeline.ts";
import {
  CrawlQueueError,
  SupabaseCrawlQueue,
  SupabaseRobotsPolicyCache,
} from "../_shared/crawl_queue.ts";
import { fetchPageForCrawl } from "../_shared/providers/fetcher.ts";
import { runCrawlWorker } from "../_shared/crawl_worker.ts";

const MAX_CRAWL_WORKER_BODY_BYTES = 64 * 1024;

const crawlWorkerBodySchema = z.object({
  jobId: z.string().uuid(),
  // scheduler (#123) が決めた refresh job だけを受ける。discover はこのworkerが
  // refresh のHTMLから内部的にenqueueする queue item のpurposeとして扱う。
  purpose: z.literal("refresh"),
  scheduleWindow: z.string().trim().min(1).max(80).regex(/^[\x20-\x7e]+$/),
  seeds: z.array(
    z.object({
      url: z.string().trim().min(1).max(2_048),
      placeId: z.string().uuid().nullable().optional(),
      depth: z.number().int().min(0).max(2).optional(),
      enqueuedBy: z.string().trim().min(1).max(128).regex(/^[\x20-\x7e]+$/)
        .optional(),
    }).strict(),
  ).max(10).default([]),
  maxItems: z.number().int().min(1).max(10).optional(),
}).strict();

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, req);
  }

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.isServiceRole) {
    return json({ error: "service role が必要です" }, 401, req);
  }

  const boundedBody = await readRequestBodyLimited(
    req,
    MAX_CRAWL_WORKER_BODY_BYTES,
  );
  if (boundedBody.tooLarge) {
    return json({ error: "リクエストが大きすぎます" }, 413, req);
  }
  if (boundedBody.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  let rawBody: unknown = null;
  if (boundedBody.text.trim()) {
    try {
      rawBody = JSON.parse(boundedBody.text) as unknown;
    } catch {
      rawBody = null;
    }
  }
  const parsed = crawlWorkerBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  const queue = new SupabaseCrawlQueue(db);
  const robotsPolicyCache = new SupabaseRobotsPolicyCache(db);
  try {
    const summary = await runCrawlWorker(
      {
        jobId: parsed.data.jobId,
        purpose: parsed.data.purpose,
        seeds: parsed.data.seeds.map((seed) => ({
          url: seed.url,
          placeId: seed.placeId ?? null,
          depth: seed.depth ?? 0,
          scheduleWindow: parsed.data.scheduleWindow,
          enqueuedBy: seed.enqueuedBy ?? "refresh-job",
        })),
        maxItems: parsed.data.maxItems,
      },
      {
        queue,
        fetchPage: (url, signal) =>
          fetchPageForCrawl(url, signal, robotsPolicyCache),
        evidenceWriter: async (handoff) => {
          const evidenceId = await insertCrawlEvidenceIfStale(db, handoff);
          if (evidenceId) {
            await refreshPlaceFacts(db, handoff.evidence.place_id);
          }
        },
      },
      req.signal,
    );
    return json({ summary }, 200, req, { "Cache-Control": "no-store" });
  } catch (error) {
    if (error instanceof CrawlQueueError) {
      return json({ error: "crawl queue を実行できませんでした" }, 503, req);
    }
    return json({ error: "crawl worker を実行できませんでした" }, 500, req);
  }
});
