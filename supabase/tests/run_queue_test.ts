import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608230002_investigation_run_queue.sql",
    import.meta.url,
  ),
);
const completedRunTest = await Deno.readTextFile(
  new URL("./rls/096_completed_investigation_run_cleanup.sql", import.meta.url),
);

Deno.test("run queue は investigation ごとに active run を1件へ制約する", () => {
  assertStringIncludes(migration, "create table public.investigation_runs");
  assertStringIncludes(
    migration,
    "create unique index idx_investigation_runs_one_active",
  );
  assertStringIncludes(migration, "where status in ('queued', 'running')");
  assertStringIncludes(migration, "claim_investigation_run");
  assertStringIncludes(migration, "pg_advisory_xact_lock");
  assertStringIncludes(migration, "request_id uuid");
  assertStringIncludes(migration, "requires_transient_anchor boolean");
  assertStringIncludes(migration, "p_request_id uuid default null");
  assertStringIncludes(
    migration,
    "p_requires_transient_anchor boolean default false",
  );
  assertStringIncludes(migration, "investigation_already_complete");
});

Deno.test("stale lease / interruption は同じrunを再claimして成果物から再開できる", () => {
  const claim = migration.slice(
    migration.indexOf(
      "create or replace function public.claim_investigation_run",
    ),
  );
  assertStringIncludes(claim, "v_run.lease_expires_at > v_now");
  assertStringIncludes(claim, "status = 'running'");
  assertStringIncludes(claim, "attempts = attempts + 1");
  assertStringIncludes(claim, "p_lease_seconds is null");
  assertStringIncludes(claim, "where id = v_run.id");
  assertStringIncludes(
    migration,
    "create or replace function public.renew_investigation_run",
  );
  assertStringIncludes(migration, "p_enforce is null");
  assertStringIncludes(
    migration,
    "create or replace function public.requeue_investigation_run",
  );
  assertStringIncludes(
    migration,
    "v_run.acceptance_state = 'accepted', v_run.accepted_at",
  );
  assertStringIncludes(migration, "returning r.accepted_at into v_accepted_at");
  assertStringIncludes(
    Deno.readTextFileSync(
      new URL("../functions/run-investigation/index.ts", import.meta.url),
    ),
    "acceptedAt: claim.acceptedAt ?? Date.now()",
  );
});

Deno.test("transient anchor は検索完了後に解除し、stale配送時は安全に終端化する", () => {
  assertStringIncludes(
    migration,
    "create or replace function public.mark_investigation_run_anchor_consumed",
  );
  assertStringIncludes(
    migration,
    "create or replace function public.finish_investigation_run_location_anchor_required",
  );
  const anchorFinish = migration.slice(
    migration.indexOf(
      "create or replace function public.finish_investigation_run_location_anchor_required",
    ),
  );
  assertStringIncludes(anchorFinish, "status = 'rejected'");
  assertStringIncludes(anchorFinish, "status = 'draft'");
  assertStringIncludes(anchorFinish, "location_anchor_required");
  assertStringIncludes(anchorFinish, "metadata ->> 'run_id'");
});

Deno.test("並行duplicate は受付確定前に202を返さず、確定後だけ同じrunへ収束する", () => {
  assertStringIncludes(
    migration,
    "acceptance_state text not null default 'pending'",
  );
  assertStringIncludes(migration, "accepted_at timestamptz");
  assertStringIncludes(
    migration,
    "create or replace function public.mark_investigation_run_enqueued",
  );
  assertStringIncludes(migration, "accepted boolean");

  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  assertStringIncludes(source, "if (!claim.accepted)");
  assertStringIncludes(source, '"Retry-After": "1"');
  assertStringIncludes(source, "const accepted = new Promise<void>");
  assertStringIncludes(
    source,
    "acceptedAt = await receipt(() =>",
  );
  assertStringIncludes(source, "markRunEnqueued(");
  assertStringIncludes(
    source,
    'acceptedAtMs === null && row.status !== "complete"',
  );
  assertStringIncludes(source, "acceptanceCommitted");
  assertStringIncludes(source, "if (!ctx.acceptanceCommitted) return");
  assertStringIncludes(source, "statusError");
  assertStringIncludes(source, "checkAcceptedRunControl");
});

Deno.test("失敗回数はDBへ保存し、同一stepの上限でfailedへ遷移する", () => {
  const failure = migration.slice(
    migration.indexOf(
      "create or replace function public.record_investigation_run_failure",
    ),
  );
  assertStringIncludes(failure, "step_failures");
  assertStringIncludes(failure, "v_count >= p_max_failures");
  assertStringIncludes(failure, "then 'failed' else 'queued' end");
  assertStringIncludes(failure, "p_error_code");
  assertStringIncludes(failure, "pg_advisory_xact_lock");
  assertStringIncludes(failure, "update public.investigations");
  assertStringIncludes(failure, "lease_expires_at > clock_timestamp()");
  assertStringIncludes(
    migration,
    "create or replace function public.finish_investigation_run",
  );
  assertStringIncludes(
    migration,
    "create or replace function public.finish_investigation_run_complete",
  );
  assertStringIncludes(
    migration,
    "create or replace function public.finish_investigation_run_no_candidates",
  );
  const noCandidates = migration.slice(
    migration.indexOf(
      "create or replace function public.finish_investigation_run_no_candidates",
    ),
  );
  assertStringIncludes(noCandidates, "pg_advisory_xact_lock");
  assertStringIncludes(noCandidates, "lease_expires_at <= clock_timestamp()");
});

Deno.test("同一runのprovider予約は一度だけで、raw query等を台帳へ持ち込まない", () => {
  const reservation = migration.slice(
    migration.indexOf(
      "create or replace function public.reserve_provider_budget_for_run",
    ),
  );
  assertStringIncludes(
    reservation,
    "where pu.investigation_run_id = p_run_id and pu.action = p_action",
  );
  assertStringIncludes(
    migration,
    "create unique index idx_provider_usage_one_run_reservation",
  );
  assertStringIncludes(reservation, "investigation_run_id");
  assertFalse(reservation.includes("raw_query"));
  assertFalse(reservation.includes("user_id"));
  assertFalse(reservation.includes("Authorization"));
});

Deno.test("run failure event は外部例外本文ではなく安全なcodeだけを記録する", () => {
  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  const start = source.indexOf("async function handleStepFailure");
  const end = source.indexOf("async function runPipeline", start);
  assert(start >= 0 && end > start);
  const body = source.slice(start, end);
  assertStringIncludes(body, "code: errorCode");
  assertFalse(body.includes("{ step, message }"));
  assertFalse(source.includes("e instanceof Error ? e.message"));
  assertStringIncludes(source, 'code: "provider_refresh_error"');
});

Deno.test("候補0件は専用終端failedで、技術retry/duplicate provider再呼出しを行わない", () => {
  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  assertStringIncludes(source, "class NoCandidatesError extends Error");
  assertStringIncludes(source, "error instanceof NoCandidatesError");
  assertStringIncludes(source, "finish_investigation_run_no_candidates");
  assertStringIncludes(source, '"failed"');
  assertStringIncludes(source, "no_candidates_terminal_unavailable");
  assertStringIncludes(source, "finishNoCandidates");
  assertFalse(source.includes("no_candidates_status_unavailable"));
  assertFalse(source.includes("no_candidates_event_unavailable"));
  const searching = source.slice(source.indexOf("if (results.length === 0)"));
  assertStringIncludes(searching, "throw new NoCandidatesError()");
  assertFalse(searching.includes("scheduleNextAttempt"));
});

Deno.test("request id は UUID のみ受理し、自己再呼出しへ安全に伝播する", () => {
  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  assertStringIncludes(source, "REQUEST_ID_PATTERN");
  assertStringIncludes(
    source,
    'safeRequestId(req.headers.get("x-request-id"))',
  );
  assertStringIncludes(
    source,
    "value && REQUEST_ID_PATTERN.test(value) ? value : crypto.randomUUID()",
  );
  assertStringIncludes(source, '"x-request-id": ctx.requestId');
});

Deno.test("Cron durable consumer は新しい service invocation を作り、anchorを保存しない", () => {
  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  assertStringIncludes(
    source,
    'const QUEUE_DRAIN_HEADER = "x-queue-drain-key"',
  );
  assertStringIncludes(source, "RUN_QUEUE_DRAIN_KEY");
  assertStringIncludes(source, "drainQueuedRuns");
  assertStringIncludes(source, "isTerminalizedCompleteResponse");
  const queueDrain = Deno.readTextFileSync(
    new URL("../functions/_shared/queue_drain.ts", import.meta.url),
  );
  assertStringIncludes(queueDrain, "QUEUE_DRAIN_TERMINAL_BODY_LIMIT = 2048");
  assertStringIncludes(queueDrain, "fatal: true");
  assertStringIncludes(source, "queue_terminalized: true");
  assertStringIncludes(source, 'if (claim.status === "complete")');
  assertFalse(source.includes('if (inv.status === "complete")'));
  assertStringIncludes(source, '.eq("acceptance_state", "accepted")');
  assertStringIncludes(source, "status.eq.queued,and(status.eq.running");
  assertFalse(source.includes("lease_expires_at.is.null"));
  assertStringIncludes(source, "lease_expires_at.lte.${staleBefore}");
  assertFalse(source.includes('eq("requires_transient_anchor", false)'));
  assertStringIncludes(source, "mark_investigation_run_anchor_consumed");
  assertStringIncludes(source, "ctx.searchAnchor = undefined");
  assertStringIncludes(source, "!isTrustedWorker");
  assertStringIncludes(
    source,
    "finish_investigation_run_location_anchor_required",
  );
  assertStringIncludes(source, "Promise.allSettled");
  assertStringIncludes(source, "queue_drain");
  assertStringIncludes(source, "queueDrainResponseStatus");
  assertStringIncludes(source, "QUEUE_DRAIN_FETCH_TIMEOUT_MS");
  assertStringIncludes(source, "AbortController");
  assertStringIncludes(source, 'redirect: "error"');
  assertStringIncludes(source, "readRequestBodyLimited");
  assertStringIncludes(source, "MAX_RUN_BODY_BYTES");
  assertStringIncludes(source, "buildTrustedRunEndpoint");
  assertStringIncludes(source, "isValidGatewayJwt");
  assertStringIncludes(source, "SUPABASE_ANON_KEY");
  assertStringIncludes(source, "createInternalInvocationHeaders");
  assertStringIncludes(source, "authorizeInternalInvocation");
  assertStringIncludes(source, "const isTrustedWorker");
  assertFalse(source.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assertStringIncludes(source, "constantTimeSecretEqual");
  assertStringIncludes(source, "QUEUE_DRAIN_KEY_MIN_LENGTH = 32");
  assertStringIncludes(source, "REINVOKE_FETCH_TIMEOUT_MS");
  assertStringIncludes(source, '{ error: "キュー配送を完了できません" }');
  assertFalse(source.includes("selectAnchor"));

  assertStringIncludes(completedRunTest, "investigation_already_complete");
  assertStringIncludes(completedRunTest, "status = 'rejected'");

  const worker = Deno.readTextFileSync(
    new URL("../../apps/api/src/worker.ts", import.meta.url),
  );
  assertStringIncludes(worker, "dispatchInvestigationQueue");
  assertStringIncludes(worker, "scheduled(");
  assertStringIncludes(worker, '"x-queue-drain-key"');
  assertStringIncludes(worker, "Authorization: `Bearer ${anonKey}`");
  assertStringIncludes(worker, "buildQueueDrainUrl");
  assertStringIncludes(worker, "isValidSupabaseAnonKey");
  assertStringIncludes(worker, 'redirect: "error"');
  assertStringIncludes(worker, "QUEUE_DRAIN_TIMEOUT_MS");
  assertStringIncludes(worker, 'QUEUE_LOG_SCHEMA = "oisint.api.queue.v1"');
  assertStringIncludes(worker, 'code: "config_unavailable"');
  assertFalse(worker.includes("RUN_QUEUE_DRAIN_URL"));

  const wrangler = Deno.readTextFileSync(
    new URL("../../apps/api/wrangler.toml", import.meta.url),
  );
  assertStringIncludes(wrangler, "[triggers]");
  assertStringIncludes(wrangler, 'crons = ["* * * * *"]');
});

Deno.test("通常完了はrun/investigation/eventをatomicに確定し、再送を冪等化する", () => {
  assertStringIncludes(
    migration,
    "finish_investigation_run_complete",
  );
  const complete = migration.slice(
    migration.indexOf(
      "create or replace function public.finish_investigation_run_complete",
    ),
  );
  assertStringIncludes(complete, "set status = 'complete'");
  assertStringIncludes(complete, "update public.investigations");
  assertStringIncludes(complete, "event_type = 'step_started'");
  assertStringIncludes(complete, "metadata ->> 'run_id'");
  assertStringIncludes(complete, "p_request_id uuid default null");
  assertStringIncludes(complete, "'request_id', p_request_id");
  assertStringIncludes(complete, "if v_run.status = 'complete'");
  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  assertStringIncludes(source, "await finishComplete(ctx.db, ctx.runId");
  assertFalse(
    source.includes('finishRun(ctx.db, ctx.runId, ctx.leaseOwner, "complete")'),
  );
  const pipelineStart = source.indexOf("async function runPipeline");
  const pipelineEnd = source.indexOf(
    "// ============================================================\n// step 1",
    pipelineStart,
  );
  const pipeline = source.slice(pipelineStart, pipelineEnd);
  assertFalse(pipeline.includes('update({ status: "complete" })'));
  assertFalse(
    pipeline.includes(
      'logEvent(ctx.db, ctx.invId, "step_started", "調査が完了しました"',
    ),
  );
  assertEquals(
    [...pipeline.matchAll(/\["searching", stepSearching\]/g)].length,
    1,
  );
});

Deno.test("#579 timing metric は queue/provider/embedding/DB/retry/run の固定schemaを持つ", () => {
  const source = Deno.readTextFileSync(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  for (
    const field of [
      'logRunMetric(ctx.requestId, "queue"',
      "queue_wait_ms",
      'logRunMetric(requestId, "provider_call"',
      "provider_call_ms",
      "candidate_serper_ms",
      "candidate_fetch_ms",
      "candidate_gemini_queue_ms",
      "candidate_gemini_api_ms",
      "semaphore_wait_ms",
      "step_recalling_ms",
      "step_searching_ms",
      "step_collecting_evidence_ms",
      "step_evaluating_ms",
      "step_ranking_ms",
      "embedding_count",
      "embedding_calls",
      "embedding_items",
      "embedding_ms",
      'logRunMetric(requestId, "db_roundtrip"',
      "db_roundtrip_ms",
      "retry_count",
      "retry_layer",
      'logRunMetric(ctx.requestId, "run_total"',
      "run_total_ms",
      "outcome",
    ]
  ) {
    assertStringIncludes(source, field);
  }
  assertFalse(source.includes("rawQuery, request_id"));
  assertFalse(source.includes("searchAnchor, request_id"));
  assertStringIncludes(source, "providerInstrumentation(ctx.requestId)");
  assertStringIncludes(
    source,
    'providerInstrumentation(ctx.requestId, "candidate")',
  );
  assertStringIncludes(source, '"x-request-id": ctx.requestId');
  assertStringIncludes(source, "jsonWithRequestId");
  assertStringIncludes(source, "request_id: ctx.requestId");
  const create = Deno.readTextFileSync(
    new URL("../functions/create-investigation/index.ts", import.meta.url),
  );
  assertStringIncludes(create, "create_parse_ms");
  assertStringIncludes(create, "create_embedding_ms");
});
