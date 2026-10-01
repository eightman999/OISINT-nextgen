// run-investigation (spec.md §25.2 / contracts/run-investigation.md)
// 冪等なステップ実行。各ステップ完了時に DB へ書き、status を進める。
// クライアントはこの関数の完了を待たない。進捗は Realtime (§20) で受ける。
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authenticate,
  createServiceClient,
  handleOptions,
  isMember,
  json,
  logEvent,
} from "../_shared/db.ts";
import {
  buildRunReinvokeBody,
  type LocationAnchor,
  runInvestigationBodySchema,
} from "../_shared/validation.ts";
import {
  getPreRankProvider,
  getProviders,
  limitResearchProviderCalls,
  preRankLimits,
} from "../_shared/providers/index.ts";
import {
  hardFilter,
  type PreRankCandidate,
  type PreRankRequirement,
  selectResearchCandidates,
} from "../_shared/prerank.ts";
import type { PlaceSearchResult } from "../_shared/providers/types.ts";
import { getDomainProfile } from "../_shared/domain_contract.ts";
import { selectRefreshTargets } from "../_shared/provider_ttl.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";
import {
  checkAcceptedRunControl,
  checkCostGuard,
} from "../_shared/cost_guard.ts";
import { resolveEntitlementForUser } from "../_shared/entitlement.ts";
import {
  parseResearchPolicy,
  policyForEntitlement,
  policySnapshot,
  type ResearchBudgetProfile,
} from "../_shared/research_policy.ts";
import {
  type CandidateRow,
  insertEvidenceIfStale,
  investigateAndPersist,
  loadCandidates,
  loadRequirements,
  rankInvestigation,
} from "../_shared/pipeline.ts";
import { throwIfDatabaseError } from "../_shared/database_error.ts";
import { pendingCandidateIdsForCoverage } from "../_shared/evaluation_coverage.ts";
import {
  queryMentionsCurrentLocation,
  resolveLocationScope,
} from "../_shared/rail_scope.ts";
import { isCurrentLocationArea } from "../_shared/providers/area.ts";
import { resolveRailScope } from "../_shared/rail_resolver.ts";
import {
  configuredPositiveInt,
  distanceM,
  preRankRailCandidates,
} from "../_shared/rail_discovery.ts";
import type { ProviderInstrumentation } from "../_shared/providers/types.ts";
import { policyMetricFields, queueWaitMs } from "../_shared/run_metrics.ts";
import {
  isTerminalizedCompleteResponse,
  queueDrainResponseStatus,
} from "../_shared/queue_drain.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";
import {
  EDGE_TIMEOUT_POLICY,
  OperationTimeoutError,
  throwIfAborted,
  withAbortTimeout,
} from "../_shared/timeout_policy.ts";
import {
  type CanonicalLookupResult,
  type CanonicalPlaceHit,
  canonicalResultKey,
  readCanonicalPlaces,
  readCanonicalPlacesByIds,
  resolveCanonicalDiscovery,
} from "../_shared/canonical_place_lookup.ts";
import {
  type KnowledgeCandidateMetadata,
  type KnowledgeReuseStats,
  mergeReusableKnowledgeHits,
} from "../_shared/knowledge_reuse.ts";
import {
  validateEmbedding,
  validateEmbeddingVectorString,
} from "../_shared/embedding_validation.ts";
import {
  authorizeInternalInvocation,
  createInternalInvocationHeaders,
} from "../_shared/internal_invocation.ts";

const BUDGET_MS = 100_000; // 実行上限 150s に対する安全マージン (research.md R2)
const LEASE_SECONDS = 180;
const MAX_STEP_FAILURES = 3; // §25.2
const QUEUE_DRAIN_HEADER = "x-queue-drain-key";
const QUEUE_DRAIN_LIMIT = 10;
const QUEUE_DRAIN_KEY_MIN_LENGTH = 32;
const QUEUE_DRAIN_KEY_MAX_LENGTH = 256;
const QUEUE_DRAIN_FETCH_TIMEOUT_MS = 15_000;
const REINVOKE_FETCH_TIMEOUT_MS = 15_000;
const MAX_RUN_BODY_BYTES = 16 * 1024;
const GATEWAY_JWT_MAX_LENGTH = 8192;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function logInvalidEmbedding(
  boundary: "provider_ingress" | "db_readback",
  reason: "not_array" | "wrong_dimension" | "invalid_value",
): void {
  console.warn(JSON.stringify({
    metric: "embedding_invalid",
    boundary,
    reason,
  }));
}

function safeRequestId(value: string | null): string {
  return value && REQUEST_ID_PATTERN.test(value) ? value : crypto.randomUUID();
}

function isQueueDrainKey(value: string): boolean {
  return value.length >= QUEUE_DRAIN_KEY_MIN_LENGTH &&
    value.length <= QUEUE_DRAIN_KEY_MAX_LENGTH &&
    /^[\x21-\x7e]+$/.test(value);
}

function isJwtLike(value: string, maxLength: number): boolean {
  if (value.length < 32 || value.length > maxLength) return false;
  const parts = value.split(".");
  return parts.length === 3 &&
    parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

export function isValidGatewayJwt(value: string): boolean {
  return isJwtLike(value, GATEWAY_JWT_MAX_LENGTH);
}

export function buildTrustedRunEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash ||
      !/^[a-z0-9][a-z0-9-]{0,62}\.supabase\.co$/i.test(parsed.hostname)
    ) return null;
    return `${parsed.origin}/functions/v1/run-investigation`;
  } catch {
    return null;
  }
}

function constantTimeSecretEqual(provided: string, expected: string): boolean {
  let mismatch = provided.length ^ expected.length;
  const length = Math.max(provided.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (provided.charCodeAt(index) || 0) ^
      (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function fetchAndConsumeWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    return await consume(response, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return await fetchAndConsumeWithTimeout(
    input,
    init,
    timeoutMs,
    (response) => Promise.resolve(response),
  );
}

type RunMetricValue = string | number | boolean;

// #579 の観測値は固定ラベルと数値だけを出力する。raw query、anchor、provider
// 応答、例外本文、run/user ID はログへ入れない。request_id は UUID 検証済み。
function logRunMetric(
  requestId: string,
  stage: string,
  fields: Record<string, RunMetricValue>,
): void {
  console.info(JSON.stringify({
    metric: "investigation_run",
    request_id: requestId,
    stage,
    ...fields,
  }));
}

function jsonWithRequestId(
  body: unknown,
  status: number,
  req: Request,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return json(body, status, req, {
    ...extraHeaders,
    // safeRequestId() has already rejected arbitrary header text. Returning the
    // same UUID lets API clients correlate an acceptance response with server
    // stage metrics without exposing query/anchor data.
    "x-request-id": requestId,
  });
}

function acceptedRunStatus(status: unknown): string {
  // 明示 retry の受付時点で investigation はまだ failed のままでも、run は
  // active であり、202 後の UI を一瞬 terminal 表示へ戻さない。worker が
  // recalling の status/event を永続化した後は Realtime の値が正本になる。
  return status === "failed"
    ? "recalling"
    : typeof status === "string"
    ? status
    : "recalling";
}

type QueueDrainRow = {
  investigation_id: string;
  request_id: string | null;
};

function isQueueDrainAuthorized(req: Request): boolean {
  const expected = Deno.env.get("RUN_QUEUE_DRAIN_KEY");
  const provided = req.headers.get(QUEUE_DRAIN_HEADER);
  // Edge secretが未設定の環境ではdrain境界自体を無効化する。値や比較結果は
  // ログへ出さず、通常の利用者requestと区別できる情報も返さない。
  return Boolean(
    expected && provided && isQueueDrainKey(expected) &&
      isQueueDrainKey(provided) &&
      constantTimeSecretEqual(provided, expected),
  );
}

async function drainQueuedRuns(
  req: Request,
  db: SupabaseClient,
  requestId: string,
): Promise<Response> {
  if (!isQueueDrainAuthorized(req)) {
    return jsonWithRequestId({ error: "Not found" }, 404, req, requestId);
  }

  const drainBody = await readRequestBodyLimited(req, MAX_RUN_BODY_BYTES, {
    signal: req.signal,
  });
  if (drainBody.timedOut) {
    return jsonWithRequestId(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
      requestId,
    );
  }
  if (drainBody.tooLarge) {
    return jsonWithRequestId(
      { error: "リクエストが大きすぎます" },
      413,
      req,
      requestId,
    );
  }
  if (drainBody.readError) {
    return jsonWithRequestId(
      { error: "リクエストが不正です" },
      400,
      req,
      requestId,
    );
  }
  try {
    const parsed = JSON.parse(drainBody.text || "null") as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      Array.isArray(parsed) || Object.keys(parsed).length !== 0
    ) {
      return jsonWithRequestId(
        { error: "リクエストが不正です" },
        400,
        req,
        requestId,
      );
    }
  } catch {
    return jsonWithRequestId(
      { error: "リクエストが不正です" },
      400,
      req,
      requestId,
    );
  }

  // 未期限の running を毎回先頭10件で取り続けると、queued/stale runが飢餓する。
  // cutoff は query にだけ使い、ログや永続状態へは書かない。
  const staleBefore = new Date().toISOString();
  const { data, error } = await db
    .from("investigation_runs")
    .select("investigation_id, request_id")
    // pending は cost guard / reservation / enqueue が未確定。Cron が
    // service-role で勝手に実行すると、未受付・未予約の provider 呼出しに
    // なるため、利用者または自己再呼出しで accepted になった run だけを配送する。
    .eq("acceptance_state", "accepted")
    .or(
      `status.eq.queued,and(status.eq.running,lease_expires_at.lte.${staleBefore})`,
    )
    .order("updated_at", { ascending: true })
    .limit(QUEUE_DRAIN_LIMIT);
  if (error) {
    console.error("[run] queue_drain_select_unavailable");
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }

  // Supabase gatewayのJWT検証には公開可能なanon keyを使う。関数内の権限昇格は
  // body-boundな短命HMACだけで行い、service-role keyをHTTPへ送出しない。
  const gatewayKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const endpoint = buildTrustedRunEndpoint(supabaseUrl);
  if (!isValidGatewayJwt(gatewayKey) || !endpoint) {
    console.error("[run] queue_drain_config_unavailable");
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }

  const rows = (data ?? []) as QueueDrainRow[];
  const results = await Promise.allSettled(rows.map(async (row) => {
    const body = JSON.stringify({ investigationId: row.investigation_id });
    const childRequestId = safeRequestId(row.request_id);
    const internalHeaders = await createInternalInvocationHeaders(
      body,
      childRequestId,
    );
    if (!internalHeaders) throw new Error("internal invoke unavailable");
    return await fetchAndConsumeWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(body).byteLength),
          "x-request-id": childRequestId,
          ...internalHeaders,
        },
        body,
      },
      QUEUE_DRAIN_FETCH_TIMEOUT_MS,
      async (response, signal) => {
        if (response.status === 409) {
          if (
            !await isTerminalizedCompleteResponse(
              response,
              undefined,
              { signal },
            )
          ) {
            throw new Error("queue drain terminal response invalid");
          }
          return response.status;
        }
        if (!response.ok) {
          throw new Error("queue drain dispatch rejected");
        }
        return response.status;
      },
    );
  }));
  const dispatched = results.filter((result) => result.status === "fulfilled")
    .length;
  logRunMetric(requestId, "queue_drain", {
    observed: rows.length,
    dispatched,
    failed: rows.length - dispatched,
  });
  if (queueDrainResponseStatus(rows.length, dispatched) !== 202) {
    return jsonWithRequestId(
      { error: "キュー配送を完了できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }
  return jsonWithRequestId(
    { status: "drained", observed: rows.length, dispatched },
    202,
    req,
    requestId,
  );
}

function metricLabel(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "unknown";
}

function acceptedCostGuardState(
  decision: Extract<
    Awaited<ReturnType<typeof checkCostGuard>>,
    { allowed: true }
  >,
): CostGuardState | null {
  if (decision.usageId !== null) return "reserved";
  if (Deno.env.get("DATA_PROVIDER_MODE") === "mock") return "mock_bypassed";
  if (Deno.env.get("LIVE_COST_GUARD_ENABLED")?.toLowerCase() === "false") {
    return "disabled_bypassed";
  }
  // A live run without a ledger row is never accepted. This keeps a malformed
  // or unexpectedly changed guard response fail-closed.
  return null;
}

function logStepTiming(
  requestId: string,
  step: string,
  stepMs: number,
): void {
  const fields: Record<string, RunMetricValue> = { step, step_ms: stepMs };
  switch (step) {
    case "recalling":
      fields.step_recalling_ms = stepMs;
      break;
    case "searching":
      fields.step_searching_ms = stepMs;
      break;
    case "collecting_evidence":
      fields.step_collecting_evidence_ms = stepMs;
      break;
    case "evaluating":
      fields.step_evaluating_ms = stepMs;
      break;
    case "ranking":
      fields.step_ranking_ms = stepMs;
      break;
  }
  logRunMetric(requestId, "step", fields);
}

function providerInstrumentation(
  requestId: string,
  boundary: "generic" | "candidate" | "create" = "generic",
): ProviderInstrumentation {
  return {
    onMetric(metric) {
      logRunMetric(requestId, "provider_call", {
        provider: metricLabel(metric.provider),
        operation: metricLabel(metric.operation),
        provider_call_ms: metric.durationMs,
        semaphore_wait_ms: metric.semaphoreWaitMs ?? 0,
        retry_count: metric.retryCount ?? 0,
        outcome: metric.outcome,
      });
      if (metric.retryCount && metric.retryCount > 0) {
        logRunMetric(requestId, "retry", {
          retry_layer: `${metricLabel(metric.provider)}_${
            metricLabel(metric.operation)
          }`,
          retry_count: metric.retryCount,
        });
      }
      if (metric.operation === "embedding") {
        // API boundary only. Logical calls/items are emitted once by the
        // measureEmbedding wrapper, so an API callback cannot double-count.
        logRunMetric(requestId, "embedding_api", {
          embedding_api_ms: metric.durationMs,
          embedding_queue_ms: metric.semaphoreWaitMs ?? 0,
          embedding_item_count: metric.itemCount ?? 1,
          retry_count: metric.retryCount ?? 0,
          outcome: metric.outcome,
        });
      }
      if (boundary === "candidate") {
        if (metric.provider === "serper" && metric.operation === "search_api") {
          logRunMetric(requestId, "candidate", {
            candidate_serper_ms: metric.durationMs,
            retry_count: metric.retryCount ?? 0,
            outcome: metric.outcome,
          });
        } else if (
          metric.provider === "fetch" && metric.operation === "page_fetch"
        ) {
          logRunMetric(requestId, "candidate", {
            candidate_fetch_ms: metric.durationMs,
            retry_count: metric.retryCount ?? 0,
            outcome: metric.outcome,
          });
        } else if (
          metric.provider === "gemini" &&
          metric.operation === "structured_output"
        ) {
          logRunMetric(requestId, "candidate", {
            candidate_gemini_queue_ms: metric.semaphoreWaitMs ?? 0,
            candidate_gemini_api_ms: metric.durationMs,
            retry_count: metric.retryCount ?? 0,
            outcome: metric.outcome,
          });
        }
      }
    },
  };
}

async function measureDbRoundtrip<T>(
  requestId: string,
  operation: string,
  fn: () => PromiseLike<T>,
  retryCount = 0,
): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    logRunMetric(requestId, "db_roundtrip", {
      operation,
      db_roundtrip_ms: Date.now() - started,
      retry_count: retryCount,
    });
  }
}

/**
 * 受付中のDB/API Promiseを単一の5秒signalへ収束させる。
 * Supabase clientがtransport abortを公開しないRPCでも、期限後にhandlerの
 * continuationを再開させない。既に開始したatomic RPCはrun state machineが
 * duplicate/reclaimで回収する。
 */
async function waitForReceipt<T>(
  signal: AbortSignal,
  operation: () => PromiseLike<T>,
): Promise<T> {
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(
        signal.reason ?? new DOMException("receipt aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(operation()), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function measureProviderCall<T>(
  requestId: string,
  provider: string,
  operation: string,
  fn: () => PromiseLike<T>,
): Promise<T> {
  const started = Date.now();
  let outcome = "ok";
  try {
    return await fn();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    logRunMetric(requestId, "provider_call", {
      provider: metricLabel(provider),
      operation: metricLabel(operation),
      provider_call_ms: Date.now() - started,
      outcome,
    });
  }
}

async function measureEmbedding<T>(
  requestId: string,
  embeddingItems: number,
  fn: () => PromiseLike<T>,
  embeddingCalls = 1,
): Promise<T> {
  const started = Date.now();
  let outcome = "ok";
  try {
    // ProviderInstrumentation が実際の Gemini API 境界を計測する。ここで
    // provider_call を重ねず、論理的な embedding_calls/items だけを集計する。
    return await fn();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    logRunMetric(requestId, "embedding", {
      embedding_calls: embeddingCalls,
      embedding_items: embeddingItems,
      // Keep the legacy aggregate for dashboards that already consume it.
      embedding_count: embeddingItems,
      embedding_ms: Date.now() - started,
      outcome,
    });
  }
}

export const LOCATION_ANCHOR_REQUIRED_REASON =
  "location_anchor_required" as const;
export const LOCATION_ANCHOR_REQUIRED_MESSAGE =
  "現在地を検索に使用できませんでした。駅名・地名を入力してください。";

class LocationAnchorRequiredError extends Error {
  readonly reason = LOCATION_ANCHOR_REQUIRED_REASON;

  constructor() {
    super(LOCATION_ANCHOR_REQUIRED_MESSAGE);
    this.name = "LocationAnchorRequiredError";
  }
}

async function handleRunReceipt(
  req: Request,
  requestId: string,
  requestSignal: AbortSignal,
): Promise<Response> {
  throwIfAborted(requestSignal);
  const acceptanceStarted = Date.now();
  const db = createServiceClient();
  const receipt = <T>(operation: () => PromiseLike<T>) =>
    waitForReceipt(requestSignal, operation);
  const auth = await waitForReceipt(
    requestSignal,
    () =>
      measureDbRoundtrip(
        requestId,
        "authenticate",
        () => authenticate(req, db),
      ),
  );
  const inputValidationStarted = Date.now();
  const boundedBody = await readRequestBodyLimited(req, MAX_RUN_BODY_BYTES, {
    signal: requestSignal,
  });
  let parsedBody: unknown = null;
  if (
    !boundedBody.tooLarge && !boundedBody.readError && !boundedBody.timedOut &&
    boundedBody.text.trim()
  ) {
    try {
      parsedBody = JSON.parse(boundedBody.text) as unknown;
    } catch {
      parsedBody = null;
    }
  }
  const bodyResult = runInvestigationBodySchema.safeParse(parsedBody);
  logRunMetric(requestId, "acceptance", {
    input_validate_ms: Date.now() - inputValidationStarted,
  });
  if (boundedBody.tooLarge) {
    return jsonWithRequestId(
      { error: "リクエストが大きすぎます" },
      413,
      req,
      requestId,
    );
  }
  if (boundedBody.timedOut) {
    return jsonWithRequestId(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
      requestId,
    );
  }
  if (!bodyResult.success) {
    return jsonWithRequestId(
      { error: "リクエストが不正です" },
      400,
      req,
      requestId,
    );
  }
  const invId = bodyResult.data.investigationId;
  const internalInvocation = !auth.userId && !auth.isServiceRole &&
    await authorizeInternalInvocation(
      req.headers,
      boundedBody.text,
      requestId,
    );
  const isTrustedWorker = auth.isServiceRole || internalInvocation;
  if (!auth.userId && !isTrustedWorker) {
    return jsonWithRequestId({ error: "認証が必要です" }, 401, req, requestId);
  }

  const { data: inv, error: investigationError } = await waitForReceipt(
    requestSignal,
    () =>
      measureDbRoundtrip(
        requestId,
        "investigation_select",
        () =>
          db.from("investigations").select("*").eq(
            "id",
            invId,
          ).maybeSingle(),
      ),
  );
  if (investigationError) {
    return jsonWithRequestId(
      { error: "調査情報を確認できませんでした" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }
  if (!inv) {
    return jsonWithRequestId(
      { error: "調査が見つかりません" },
      404,
      req,
      requestId,
    );
  }
  let member = true;
  if (auth.userId) {
    try {
      member = await waitForReceipt(
        requestSignal,
        () =>
          measureDbRoundtrip(
            requestId,
            "membership_check",
            () => isMember(db, invId, auth.userId!),
          ),
      );
    } catch (error) {
      if (requestSignal.aborted) throw error;
      return jsonWithRequestId(
        { error: "参加状態を確認できませんでした" },
        503,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
  }
  if (auth.userId && !member) {
    return jsonWithRequestId(
      { error: "この調査のメンバーではありません" },
      401,
      req,
      requestId,
    );
  }
  // service-role以外の全受付は、anchor不足の早期UX応答も含めて同じrate limitを
  // 消費する。DB writeを伴う202分岐より先に置き、迂回経路を作らない。
  const rateLimit = await waitForReceipt(
    requestSignal,
    () =>
      measureDbRoundtrip(
        requestId,
        "rate_limit_check",
        () =>
          checkRateLimit(
            db,
            req,
            "run",
            auth.userId,
            isTrustedWorker,
          ),
      ),
  );
  if (!rateLimit.allowed) {
    const limited = rateLimit.kind === "limited";
    return jsonWithRequestId(
      {
        error: limited
          ? "しばらく待ってからもう一度お試しください"
          : "ただいま調査を実行できません",
      },
      limited ? 429 : 503,
      req,
      requestId,
      { "Retry-After": String(rateLimit.retryAfter) },
    );
  }
  // current_location は provider 呼び出しより前に検証する。受付後に結果画面へ
  // 遷移させる契約を守りつつ、既存の location_anchor_required UX を同期区間で返す。
  if (
    !isTrustedWorker &&
    queryMentionsCurrentLocation(inv.raw_query ?? "") &&
    !bodyResult.data.searchAnchor
  ) {
    try {
      await waitForReceipt(
        requestSignal,
        () => persistLocationAnchorRequired(db, invId, requestId),
      );
    } catch (error) {
      if (requestSignal.aborted) throw error;
      return jsonWithRequestId(
        { error: "現在地の入力待ち状態を保存できませんでした" },
        503,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
    return jsonWithRequestId(
      {
        status: "draft",
        reason: LOCATION_ANCHOR_REQUIRED_REASON,
        message: LOCATION_ANCHOR_REQUIRED_MESSAGE,
      },
      202,
      req,
      requestId,
    );
  }

  const leaseOwner = crypto.randomUUID();
  let claim: RunClaim;
  try {
    claim = await waitForReceipt(
      requestSignal,
      () =>
        claimRun(
          db,
          invId,
          leaseOwner,
          requestId,
          Boolean(bodyResult.data.searchAnchor),
        ),
    );
  } catch {
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }
  if (!claim.acquired) {
    if (claim.status === "complete") {
      return jsonWithRequestId(
        {
          status: "complete",
          ...(isTrustedWorker ? { queue_terminalized: true } : {}),
        },
        409,
        req,
        requestId,
      );
    }
    // cost guard/enqueue 未確定の run へは202を返さない。先行要求が拒否される
    // raceで「受付済みなのにworkerが無い」という状態を作らないためである。
    if (!claim.accepted) {
      return jsonWithRequestId(
        { error: "調査の受付を確定できませんでした" },
        503,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
    // accepted duplicate は既存 run へ収束させる。cost reservation と worker は
    // 最初に lease を取得した呼び出しだけが担当する。
    return jsonWithRequestId(
      { status: acceptedRunStatus(inv.status) },
      202,
      req,
      requestId,
    );
  }
  if (!claim.runId) {
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }

  // service-role / internal HMAC requests are durable consumer専用。直接呼出しで
  // 未受付・未課金のrunを作成してentitlement境界を迂回させない。
  if (isTrustedWorker && !claim.accepted) {
    await receipt(() =>
      rejectRun(
        db,
        claim.runId!,
        leaseOwner,
        "service_run_not_accepted",
        requestId,
      )
    );
    return jsonWithRequestId(
      { error: "調査の受付を確定できませんでした" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }

  let policy: ResearchBudgetProfile;
  let persistedPolicy: PersistedRunPolicy | null = null;
  if (claim.accepted) {
    persistedPolicy = await receipt(() =>
      loadRunPolicy(db, claim.runId!, requestId)
    );
    if (!persistedPolicy || persistedPolicy.acceptanceState !== "accepted") {
      await receipt(() =>
        rejectRun(
          db,
          claim.runId!,
          leaseOwner,
          "entitlement_snapshot_invalid",
          requestId,
        )
      );
      return jsonWithRequestId(
        { error: "ただいま調査を実行できません" },
        503,
        req,
        requestId,
        { "Retry-After": "60" },
      );
    }
    // Accepted runs must carry an explicit cost decision. A durable service
    // retry never infers authorization from nullable provider_usage_id: mock
    // and explicitly disabled guards are the only allowed no-ledger states.
    const reservationStateValid = persistedPolicy.costGuardState === "reserved"
      ? persistedPolicy.providerUsageId !== null
      : persistedPolicy.costGuardState === "mock_bypassed" ||
          persistedPolicy.costGuardState === "disabled_bypassed" ||
          persistedPolicy.costGuardState === "legacy_bypassed"
      ? persistedPolicy.providerUsageId === null
      : false;
    if (!reservationStateValid) {
      await receipt(() =>
        rejectRun(
          db,
          claim.runId!,
          leaseOwner,
          "provider_reservation_missing",
          requestId,
        )
      );
      return jsonWithRequestId(
        { error: "ただいま調査を実行できません" },
        503,
        req,
        requestId,
        { "Retry-After": "60" },
      );
    }
    policy = persistedPolicy.policy;
  } else {
    // Only the verified JWT subject is passed to the server resolver. Resolver
    // errors, anonymous subjects, and expired rows become Free by policy.
    const entitlement = auth.userId
      ? await receipt(() => resolveEntitlementForUser(db, auth.userId!))
      : null;
    const resolvedPolicy = policyForEntitlement(entitlement);
    if (!resolvedPolicy) {
      console.error("[run] research_policy_unavailable");
      await receipt(() =>
        requeueRun(
          db,
          claim.runId!,
          leaseOwner,
          requestId,
          "research_policy_unavailable",
        )
      );
      return jsonWithRequestId(
        { error: "ただいま調査を実行できません" },
        503,
        req,
        requestId,
        { "Retry-After": "60" },
      );
    }
    policy = resolvedPolicy;
    if (
      !await receipt(() =>
        setRunPolicy(db, claim.runId!, leaseOwner, policy, requestId)
      )
    ) {
      await receipt(() =>
        requeueRun(
          db,
          claim.runId!,
          leaseOwner,
          requestId,
          "entitlement_snapshot_unavailable",
        )
      );
      return jsonWithRequestId(
        { error: "ただいま調査を実行できません" },
        503,
        req,
        requestId,
        { "Retry-After": "60" },
      );
    }
  }

  logRunMetric(requestId, "policy", {
    ...policyMetricFields(policy),
  });

  const costGuard = await receipt(() =>
    measureDbRoundtrip(
      requestId,
      "cost_guard",
      () =>
        claim.accepted ? checkAcceptedRunControl(db) : checkCostGuard(
          db,
          "run",
          invId,
          isTrustedWorker,
          policy.estimatedCostMicros,
          undefined,
          claim.runId!,
        ),
    )
  );
  if (!costGuard.allowed) {
    if (costGuard.kind === "unavailable") {
      // 台帳/RPC障害では同じrunをqueuedへ戻す。新runを作ると、provider
      // 予約の再試行が別idになり、障害復旧後に二重計上し得る。
      await receipt(() =>
        requeueRun(
          db,
          claim.runId!,
          leaseOwner,
          requestId,
          "cost_guard_unavailable",
        )
      );
    } else {
      await receipt(() =>
        rejectRun(
          db,
          claim.runId!,
          leaseOwner,
          "cost_guard_denied",
          requestId,
        )
      );
    }
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません。時間をおいてお試しください" },
      503,
      req,
      requestId,
      { "Retry-After": String(costGuard.retryAfter) },
    );
  }
  if (costGuard.usageId !== null) {
    try {
      await receipt(() =>
        linkRunUsage(
          db,
          claim.runId!,
          leaseOwner,
          costGuard.usageId!,
          requestId,
        )
      );
    } catch {
      await receipt(() =>
        requeueRun(
          db,
          claim.runId!,
          leaseOwner,
          requestId,
          "usage_link_unavailable",
        )
      );
      return jsonWithRequestId(
        { error: "ただいま調査を実行できません" },
        503,
        req,
        requestId,
        { "Retry-After": "60" },
      );
    }
  }
  const costGuardState = claim.accepted
    ? null
    : acceptedCostGuardState(costGuard);
  if (!claim.accepted && costGuardState === null) {
    await receipt(() =>
      requeueRun(
        db,
        claim.runId!,
        leaseOwner,
        requestId,
        "provider_reservation_missing",
      )
    );
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }

  const userJwt = auth.userId
    ? (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    : null;
  const ctx: RunContext = {
    db,
    invId,
    runId: claim.runId,
    leaseOwner,
    started: Date.now(),
    requestId,
    // accepted_at は最初の受付RPCで確定したDB時刻を使う。新規pending runは
    // markRunEnqueued後に必ず上書きし、Cron/self-HTTPの再claimではclaim RPCの
    // 不変値をそのまま使うため、requeue/reclaimでrun_totalをリセットしない。
    acceptedAt: claim.acceptedAt ?? Date.now(),
    userJwt,
    // Search-only fallback input. It is read from the investigation and is
    // never copied into events, logs, or another request.
    rawQuery: typeof inv.raw_query === "string" ? inv.raw_query : "",
    // Validated request-only state. Do not write this value to DB/events/logs.
    searchAnchor: bodyResult.data.searchAnchor,
    policy,
    // waitUntil登録は受付RPCより先に必要だが、受付が永続化されるまで
    // 背景taskを実行させない。失敗経路では明示的なno-opになる。
    acceptanceCommitted: claim.accepted,
  };

  // Supabase EdgeRuntime.waitUntil keeps the server-side task alive after the
  // HTTP response. Browser/tab lifetime is not part of the execution guarantee.
  let releaseWorker = () => {};
  const accepted = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  // receiptが期限切れになった場合もwaitUntilへ未解決Promiseを残さない。
  requestSignal.addEventListener("abort", releaseWorker, { once: true });
  if (!enqueueRun(ctx, accepted)) {
    await receipt(() =>
      requeueRun(
        db,
        claim.runId!,
        leaseOwner,
        requestId,
        "background_unavailable",
      )
    );
    releaseWorker();
    return jsonWithRequestId(
      { error: "ただいま調査を実行できません" },
      503,
      req,
      requestId,
      { "Retry-After": "60" },
    );
  }
  let acceptedAt = claim.acceptedAt;
  if (!claim.accepted) {
    // cost guardが確定した状態を同じacceptance RPCへ渡す。accepted runの
    // durable再配送ではこのRPCを再実行せず、既存snapshot/予約を使う。
    try {
      acceptedAt = await receipt(() =>
        markRunEnqueued(
          db,
          claim.runId!,
          leaseOwner,
          requestId,
          costGuardState!,
        )
      );
    } catch {
      acceptedAt = null;
    }
    if (acceptedAt === null) {
      await receipt(() =>
        requeueRun(
          db,
          claim.runId!,
          leaseOwner,
          requestId,
          "acceptance_persistence_error",
        )
      );
      releaseWorker();
      return jsonWithRequestId(
        { error: "ただいま調査を実行できません" },
        503,
        req,
        requestId,
        { "Retry-After": "60" },
      );
    }
    // mark RPC がDBへ確定した不変の受付時刻を使う。Promiseを解放する前に設定し、
    // 同一runtime内の競合でも負値にならないようにする。
    ctx.acceptedAt = acceptedAt;
    ctx.acceptanceCommitted = true;
  }
  // 受付状態をDBへ確定してからworkerを解放する。競合要求はここより前なら
  // 503、ここより後なら202となり、未enqueueの202を返さない。
  releaseWorker();
  logRunMetric(ctx.requestId, "acceptance", {
    request_accept_ms: Date.now() - acceptanceStarted,
  });
  return jsonWithRequestId(
    { status: acceptedRunStatus(inv.status) },
    202,
    req,
    requestId,
  );
}

Deno.serve(async (req) => {
  const requestId = safeRequestId(req.headers.get("x-request-id"));
  const options = handleOptions(req);
  if (options) return options;

  // Durable queue consumerは公開receiptとは別契約。本文deadlineは共通readerが
  // 適用するが、複数runを処理する内部drainへ5秒receipt budgetを誤適用しない。
  if (req.method === "POST" && req.headers.has(QUEUE_DRAIN_HEADER)) {
    return await drainQueuedRuns(req, createServiceClient(), requestId);
  }

  try {
    return await withAbortTimeout(
      (signal) => handleRunReceipt(req, requestId, signal),
      EDGE_TIMEOUT_POLICY.receipt,
      req.signal,
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      return jsonWithRequestId(
        { error: "調査の受付がタイムアウトしました" },
        504,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }
});

interface RunContext {
  db: SupabaseClient;
  invId: string;
  runId: string;
  leaseOwner: string;
  started: number;
  acceptedAt: number;
  requestId: string;
  userJwt: string | null;
  /** Existing investigation input used only for deterministic search repair. */
  rawQuery: string;
  /** run request boundary only; never persist or log. */
  searchAnchor?: LocationAnchor;
  /** Immutable server policy pinned before the run was accepted. */
  policy: ResearchBudgetProfile;
  acceptanceCommitted: boolean;
  step?: string;
  pendingResearch?: CandidateRow[];
  knowledgeByResultKey?: Map<string, KnowledgeCandidateMetadata>;
}

function timeExceeded(ctx: RunContext): boolean {
  return Date.now() - ctx.started > BUDGET_MS;
}

interface RunClaim {
  runId: string | null;
  acquired: boolean;
  status: string;
  leaseExpiresAt: string | null;
  accepted: boolean;
  acceptedAt: number | null;
}

interface PersistedRunPolicy {
  policy: ResearchBudgetProfile;
  providerUsageId: number | null;
  costGuardState:
    | "pending"
    | "reserved"
    | "mock_bypassed"
    | "disabled_bypassed"
    | "legacy_bypassed";
  acceptanceState: "pending" | "accepted" | "rejected";
}

type CostGuardState = Exclude<PersistedRunPolicy["costGuardState"], "pending">;

class LeaseLostError extends Error {
  constructor() {
    super("run lease lost");
    this.name = "LeaseLostError";
  }
}

// 候補0件は技術例外ではなく既存契約上の終端結果。一般のstep failure
// counter/retryを通さず、run/investigation/eventを原子的にterminalへ倒す。
class NoCandidatesError extends Error {
  constructor() {
    super("no candidates");
    this.name = "NoCandidatesError";
  }
}

function rpcRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

interface EdgeRuntimeLike {
  waitUntil(promise: Promise<unknown>): void;
}

function getEdgeRuntime(): EdgeRuntimeLike | null {
  const runtime = (globalThis as typeof globalThis & {
    EdgeRuntime?: EdgeRuntimeLike;
  }).EdgeRuntime;
  return runtime && typeof runtime.waitUntil === "function" ? runtime : null;
}

async function claimRun(
  db: SupabaseClient,
  invId: string,
  leaseOwner: string,
  requestId: string,
  requiresTransientAnchor = false,
): Promise<RunClaim> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "claim_investigation_run",
    async () =>
      await db.rpc("claim_investigation_run", {
        p_investigation_id: invId,
        p_lease_owner: leaseOwner,
        p_lease_seconds: LEASE_SECONDS,
        p_request_id: requestId,
        p_requires_transient_anchor: requiresTransientAnchor,
      }),
  );
  if (error) throw new Error("run lock unavailable");
  const row = rpcRow(data);
  if (
    !row || (row.run_id !== null && typeof row.run_id !== "string") ||
    typeof row.acquired !== "boolean" || typeof row.accepted !== "boolean"
  ) {
    throw new Error("run lock returned an invalid shape");
  }
  const acceptedAt = typeof row.accepted_at === "string"
    ? Date.parse(row.accepted_at)
    : Number.NaN;
  const acceptedAtMs = Number.isFinite(acceptedAt) ? acceptedAt : null;
  // 完了調査のreconcile応答は accepted=true でも新しいrunを作らず
  // accepted_at=null を返す。これはhandlerのqueue_terminalized 409契約であり、
  // 通常のaccepted runだけtimestampを必須にする。
  if (
    row.accepted === true && acceptedAtMs === null && row.status !== "complete"
  ) {
    throw new Error("run lock returned an invalid acceptance timestamp");
  }
  return {
    runId: row.run_id,
    acquired: row.acquired,
    status: typeof row.status === "string" ? row.status : "running",
    leaseExpiresAt: typeof row.lease_expires_at === "string"
      ? row.lease_expires_at
      : null,
    accepted: row.accepted,
    acceptedAt: acceptedAtMs,
  };
}

async function loadRunPolicy(
  db: SupabaseClient,
  runId: string,
  requestId: string,
): Promise<PersistedRunPolicy | null> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "investigation_run_policy_select",
    () =>
      db.from("investigation_runs")
        .select(
          "entitlement_tier, budget_profile, provider_usage_id, cost_guard_state, acceptance_state",
        )
        .eq("id", runId)
        .maybeSingle(),
  );
  if (error || !data) return null;
  const policy = parseResearchPolicy(data.budget_profile);
  const acceptanceState = data.acceptance_state;
  if (
    !policy ||
    data.entitlement_tier !== policy.tier ||
    (acceptanceState !== "pending" && acceptanceState !== "accepted" &&
      acceptanceState !== "rejected")
  ) return null;
  const providerUsageId = data.provider_usage_id === null
    ? null
    : Number(data.provider_usage_id);
  if (
    providerUsageId !== null &&
    (!Number.isSafeInteger(providerUsageId) || providerUsageId < 1)
  ) return null;
  const costGuardState = data.cost_guard_state;
  if (
    costGuardState !== "pending" && costGuardState !== "reserved" &&
    costGuardState !== "mock_bypassed" &&
    costGuardState !== "disabled_bypassed" &&
    costGuardState !== "legacy_bypassed"
  ) return null;
  return { policy, providerUsageId, costGuardState, acceptanceState };
}

async function setRunPolicy(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  policy: ResearchBudgetProfile,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "set_investigation_run_policy",
    () =>
      db.rpc("set_investigation_run_policy", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_entitlement_tier: policy.tier,
        p_budget_profile: policySnapshot(policy),
      }),
  );
  return !error && rpcRow(data)?.configured === true;
}

async function renewRunLease(
  ctx: RunContext,
  currentStep?: string,
): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    ctx.requestId,
    "renew_investigation_run",
    async () =>
      await ctx.db.rpc("renew_investigation_run", {
        p_run_id: ctx.runId,
        p_lease_owner: ctx.leaseOwner,
        p_lease_seconds: LEASE_SECONDS,
        ...(currentStep ? { p_current_step: currentStep } : {}),
      }),
  );
  const row = rpcRow(data);
  if (error || row?.renewed !== true) throw new LeaseLostError();
}

async function requeueRun(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  requestId: string,
  errorCode?: string,
): Promise<boolean> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "requeue_investigation_run",
    async () =>
      await db.rpc("requeue_investigation_run", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        ...(errorCode ? { p_error_code: errorCode } : {}),
      }),
  );
  return !error && rpcRow(data)?.requeued === true;
}

async function rejectRun(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  errorCode: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "reject_investigation_run",
    async () =>
      await db.rpc("reject_investigation_run", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_error_code: errorCode,
      }),
  );
  return !error && rpcRow(data)?.rejected === true;
}

async function finishLocationAnchorRequired(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "finish_investigation_run_location_anchor_required",
    async () =>
      await db.rpc("finish_investigation_run_location_anchor_required", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_request_id: requestId,
      }),
  );
  return !error && rpcRow(data)?.finished === true;
}

async function consumeRunAnchor(ctx: RunContext): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    ctx.requestId,
    "mark_investigation_run_anchor_consumed",
    async () =>
      await ctx.db.rpc("mark_investigation_run_anchor_consumed", {
        p_run_id: ctx.runId,
        p_lease_owner: ctx.leaseOwner,
      }),
  );
  if (error || rpcRow(data)?.consumed !== true) throw new LeaseLostError();
  // 検索成果物がDBへ確定した後の再入では、座標を自己HTTP bodyへ持ち越さない。
  // raw queryから再構成することも禁止し、以降は永続化済み成果物だけで進める。
  ctx.searchAnchor = undefined;
}

async function linkRunUsage(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  usageId: number,
  requestId: string,
): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "link_investigation_run_usage",
    async () =>
      await db.rpc("link_investigation_run_usage", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_usage_id: usageId,
      }),
  );
  if (error || rpcRow(data)?.linked !== true) {
    throw new Error("run usage link unavailable");
  }
}

async function markRunEnqueued(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  requestId: string,
  costGuardState: CostGuardState,
): Promise<number | null> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "mark_investigation_run_enqueued",
    async () =>
      await db.rpc("mark_investigation_run_enqueued", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_cost_guard_state: costGuardState,
      }),
  );
  const row = rpcRow(data);
  if (error || row?.marked !== true) return null;
  const acceptedAt = typeof row.accepted_at === "string"
    ? Date.parse(row.accepted_at)
    : Number.NaN;
  return Number.isFinite(acceptedAt) ? acceptedAt : null;
}

async function finishRun(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  status: "failed",
  requestId: string,
  errorCode?: string,
): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "finish_investigation_run",
    async () =>
      await db.rpc("finish_investigation_run", {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_status: status,
        ...(errorCode ? { p_error_code: errorCode } : {}),
        p_request_id: requestId,
      }),
  );
  if (error || rpcRow(data)?.finished !== true) {
    throw new Error("run terminal state unavailable");
  }
}

async function finishComplete(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  requestId: string,
): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "finish_investigation_run_complete",
    async () =>
      await db.rpc(
        "finish_investigation_run_complete",
        {
          p_run_id: runId,
          p_lease_owner: leaseOwner,
          p_request_id: requestId,
        },
      ),
  );
  if (error || rpcRow(data)?.finished !== true) {
    throw new Error("complete investigation state unavailable");
  }
}

async function finishNoCandidates(
  db: SupabaseClient,
  runId: string,
  leaseOwner: string,
  requestId: string,
): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    requestId,
    "finish_investigation_run_no_candidates",
    async () =>
      await db.rpc(
        "finish_investigation_run_no_candidates",
        {
          p_run_id: runId,
          p_lease_owner: leaseOwner,
          p_request_id: requestId,
        },
      ),
  );
  if (error || rpcRow(data)?.finished !== true) {
    throw new Error("no-candidates terminal state unavailable");
  }
}

function scheduleNextAttempt(ctx: RunContext): boolean {
  // A new Edge Function invocation is required after the time budget. Merely
  // adding another waitUntil task to this invocation would keep the same wall
  // clock and can be killed together with the current process.
  const runtime = getEdgeRuntime();
  if (!runtime) return false;
  const url = buildTrustedRunEndpoint(Deno.env.get("SUPABASE_URL") ?? "");
  const gatewayKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !isValidGatewayJwt(gatewayKey)) return false;
  const body = buildRunReinvokeBody(ctx.invId, ctx.searchAnchor);
  const encodedBody = JSON.stringify(body);
  const task = (async () => {
    const internalHeaders = await createInternalInvocationHeaders(
      encodedBody,
      ctx.requestId,
    );
    if (!internalHeaders) throw new Error("internal invoke unavailable");
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gatewayKey}`,
        "Content-Type": "application/json",
        "Content-Length": String(
          new TextEncoder().encode(encodedBody).byteLength,
        ),
        "x-request-id": ctx.requestId,
        ...internalHeaders,
      },
      body: encodedBody,
    }, REINVOKE_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error("reinvoke rejected");
  })().catch(() => {
    // queued run remains durable. The external Cron drain can reclaim it after
    // this self-invocation is rejected; an explicit /research request remains
    // an operator/user fallback when the consumer is not configured.
    console.error("[run] reinvoke_failed");
  });
  try {
    runtime.waitUntil(task);
    return true;
  } catch {
    console.error("[run] reinvoke_schedule_failed");
    return false;
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LeaseLostError) return "lease_lost";
  if (error instanceof LocationAnchorRequiredError) {
    return LOCATION_ANCHOR_REQUIRED_REASON;
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return "timeout";
  }
  if (error instanceof Error && /provider|api|fetch/i.test(error.message)) {
    return "provider_error";
  }
  return "step_error";
}

async function persistLocationAnchorRequired(
  db: SupabaseClient,
  invId: string,
  requestId?: string,
): Promise<void> {
  const { data, error } = await measureDbRoundtrip(
    requestId ?? crypto.randomUUID(),
    "persist_investigation_location_anchor_required",
    async () =>
      await db.rpc("persist_investigation_location_anchor_required", {
        p_investigation_id: invId,
        ...(requestId ? { p_request_id: requestId } : {}),
      }),
  );
  if (error || rpcRow(data)?.persisted !== true) {
    throw new Error("location anchor requirement persistence unavailable");
  }
}

function enqueueRun(ctx: RunContext, accepted: Promise<void>): boolean {
  const runtime = getEdgeRuntime();
  if (!runtime) return false;
  const task = accepted.then(() => {
    if (!ctx.acceptanceCommitted) return;
    return executeRun(ctx);
  });
  try {
    runtime.waitUntil(task);
    return true;
  } catch {
    return false;
  }
}

async function executeRun(ctx: RunContext): Promise<void> {
  const workerStartedAt = Date.now();
  ctx.started = workerStartedAt;
  logRunMetric(ctx.requestId, "queue", {
    queue_wait_ms: queueWaitMs(workerStartedAt, ctx.acceptedAt),
  });
  logRunMetric(ctx.requestId, "policy", {
    ...policyMetricFields(ctx.policy),
  });
  let outcome = "unknown";
  try {
    const status = await runPipeline(ctx);
    if (status !== "complete") {
      outcome = "requeued";
      return;
    }
    // run / investigation / complete event は1つのDB transactionで確定する。
    // pipeline 内で個別に完了を書かないため、ここでworkerが停止しても
    // run=completeだけが残る中間状態を作らない。
    await finishComplete(ctx.db, ctx.runId, ctx.leaseOwner, ctx.requestId);
    outcome = "complete";
  } catch (error) {
    if (error instanceof NoCandidatesError) {
      // run/investigation/status/event を同一 transaction で確定する。一般の
      // step failure RPC や自己再呼出しは通さず、provider を再実行しない。
      try {
        await finishNoCandidates(
          ctx.db,
          ctx.runId,
          ctx.leaseOwner,
          ctx.requestId,
        );
        outcome = "no_candidates";
      } catch {
        console.error("[run] no_candidates_terminal_unavailable");
        outcome = "no_candidates_terminal_error";
      }
      return;
    }
    if (error instanceof LocationAnchorRequiredError) {
      const rejected = await finishLocationAnchorRequired(
        ctx.db,
        ctx.runId,
        ctx.leaseOwner,
        ctx.requestId,
      );
      // leaseを失ったworkerは、新ownerの investigation status/event を
      // draftへ巻き戻さない。run/investigation/event の atomic RPC が成功した
      // 場合だけ location_anchor_required を利用者向けに永続化する。
      if (rejected) {
        outcome = "rejected";
      } else {
        outcome = "lease_lost";
      }
      return;
    }
    if (error instanceof LeaseLostError) {
      outcome = "lease_lost";
      return;
    }
    const terminal = await handleStepFailure(ctx, ctx.step ?? "unknown", error);
    if (terminal) {
      outcome = "failed";
      return;
    }
    // record_investigation_run_failure already moved a non-terminal run to
    // queued. The next attempt must be a new Edge Function invocation so its
    // wall-clock budget is independent from the failed process.
    scheduleNextAttempt(ctx);
    outcome = "requeued";
  } finally {
    logRunMetric(ctx.requestId, "run_total", {
      run_total_ms: Math.max(0, Date.now() - ctx.acceptedAt),
      outcome,
      tier: ctx.policy.tier,
      research_candidate_limit: ctx.policy.researchCandidateLimit,
    });
  }
}

async function setStatus(
  ctx: RunContext,
  status: string,
  message: string,
): Promise<void> {
  await renewRunLease(ctx, status);
  const { error: statusError } = await ctx.db
    .from("investigations")
    .update({ status })
    .eq("id", ctx.invId);
  if (statusError) throw new Error("investigation status unavailable");
  await logEvent(ctx.db, ctx.invId, "step_started", message, {
    step: status,
    request_id: ctx.requestId,
  });
}

// 同一ステップ 3 回連続失敗で failed (§25.2)
async function handleStepFailure(
  ctx: RunContext,
  step: string,
  e: unknown,
): Promise<boolean> {
  const errorCode = safeErrorCode(e);
  try {
    await logEvent(
      ctx.db,
      ctx.invId,
      "step_failed",
      `ステップ ${step} が失敗しました`,
      { step, code: errorCode, request_id: ctx.requestId },
    );
  } catch {
    // 例外本文はログへ出さず、DB failure counterの永続化を優先する。
    console.error("[run] failure_event_unavailable");
  }
  let data: unknown = null;
  let error: unknown = null;
  try {
    const result = await measureDbRoundtrip(
      ctx.requestId,
      "record_investigation_run_failure",
      async () =>
        await ctx.db.rpc("record_investigation_run_failure", {
          p_run_id: ctx.runId,
          p_lease_owner: ctx.leaseOwner,
          p_step: step,
          p_error_code: errorCode,
          p_max_failures: MAX_STEP_FAILURES,
          p_request_id: ctx.requestId,
        }),
    );
    data = result.data;
    error = result.error;
  } catch {
    error = new Error("failure counter unavailable");
  }
  const row = rpcRow(data);
  if (error || typeof row?.terminal !== "boolean") {
    try {
      await finishRun(
        ctx.db,
        ctx.runId,
        ctx.leaseOwner,
        "failed",
        ctx.requestId,
        "failure_persistence_error",
      );
      // generic finish RPC が run/investigation/event を同一transactionで
      // terminal化する。ここで個別 update/logEvent を追加すると、RPC成功後
      // のプロセス停止で部分状態を作り、stale workerが新ownerを上書きし得る。
      return true;
    } catch {
      console.error("[run] failure_terminal_unavailable");
      // DB/RPC自体が停止している場合は状態を捏造しない。呼び出し元が
      // self-HTTP/外部Cronへ再配送し、lease expiry後に同じrunを再claimする。
      return false;
    }
  }
  // record_investigation_run_failure が terminal run・investigation・event を
  // 同一 transaction で確定済み。ここで再度 status/event を書かない。
  if (row.terminal !== true) {
    logRunMetric(ctx.requestId, "retry", {
      retry_layer: "step",
      retry_count: 1,
      failure_count: typeof row.failure_count === "number"
        ? row.failure_count
        : 0,
    });
  }
  return row.terminal === true;
}

async function runPipeline(ctx: RunContext): Promise<string> {
  const steps: Array<[string, (ctx: RunContext) => Promise<void>]> = [
    ["recalling", stepRecalling],
    ["searching", stepSearching],
    ["collecting_evidence", stepCollectEvidence],
    ["evaluating", stepEvaluate],
    ["ranking", stepRanking],
  ];
  const messages: Record<string, string> = {
    recalling: "過去の類似調査を確認しています",
    searching: "候補店を探索しています",
    collecting_evidence: "根拠を収集しています",
    evaluating: "条件を評価しています",
    ranking: "ランキングを計算しています",
  };

  for (const [step, fn] of steps) {
    if (timeExceeded(ctx)) {
      if (
        await requeueRun(
          ctx.db,
          ctx.runId,
          ctx.leaseOwner,
          ctx.requestId,
          "time_budget",
        )
      ) {
        scheduleNextAttempt(ctx);
      }
      return step;
    }
    ctx.step = step;
    const stepStarted = Date.now();
    try {
      await setStatus(ctx, step, messages[step]);
      await fn(ctx);
      const { data, error } = await measureDbRoundtrip(
        ctx.requestId,
        "reset_investigation_run_failure",
        async () =>
          await ctx.db.rpc(
            "reset_investigation_run_failure",
            {
              p_run_id: ctx.runId,
              p_lease_owner: ctx.leaseOwner,
              p_step: step,
            },
          ),
      );
      if (error || rpcRow(data)?.reset !== true) throw new LeaseLostError();
    } finally {
      const stepMs = Date.now() - stepStarted;
      logStepTiming(ctx.requestId, step, stepMs);
    }
  }

  ctx.step = "complete";
  // 完了状態・調査状態・完了イベントは executeRun の atomic RPC で同時に
  // 確定する。ここでは terminal 状態を先に書かず、再入時の成果物だけを
  // 残すステップ機械として扱う。
  return "complete";
}

// ============================================================
// step 1: recalling — 類似 Investigation 検索 (§16.1, §24)
// ============================================================
async function stepRecalling(ctx: RunContext): Promise<void> {
  const { db, invId } = ctx;
  // 再入判定: recall 結果 event が既にあればスキップ
  const { count } = await db
    .from("investigation_events")
    .select("id", { count: "exact", head: true })
    .eq("investigation_id", invId)
    .eq("event_type", "recall_completed");
  if ((count ?? 0) > 0) {
    console.log("[recall] skipped=already_completed");
    return;
  }

  const { data: inv } = await db
    .from("investigations")
    .select("embedding, normalized_query, raw_query")
    .eq("id", invId)
    .single();
  if (!inv) throw new Error("investigation が消えています");

  // embedding 未計算なら補完 (create の embed 失敗時)
  let embedding: string | null = null;
  if (inv.embedding) {
    const checked = validateEmbeddingVectorString(inv.embedding);
    if (checked.ok) {
      embedding = JSON.stringify(checked.value);
    } else {
      logInvalidEmbedding("db_readback", checked.reason);
    }
  }
  if (!embedding) {
    const { ai } = getProviders(providerInstrumentation(ctx.requestId));
    const [vec] = await measureEmbedding(
      ctx.requestId,
      1,
      () => ai.embed([inv.normalized_query ?? inv.raw_query]),
    );
    const checked = validateEmbedding(vec);
    if (checked.ok) {
      embedding = JSON.stringify(checked.value);
      await db.from("investigations").update({ embedding }).eq("id", invId);
    } else {
      logInvalidEmbedding("provider_ingress", checked.reason);
    }
  }

  // match_investigations は auth.uid() でアクセス制御する (§24) ため、
  // ユーザー起点の呼び出しではユーザー JWT のクライアントで RPC を呼ぶ。
  // 自己再呼び出し (service role) でここに来た場合は recall をスキップして先へ進む。
  let similar: Array<
    { investigation_id: string; title: string; similarity: number }
  > = [];
  if (embedding && ctx.userJwt) {
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: { headers: { Authorization: `Bearer ${ctx.userJwt}` } },
        auth: { persistSession: false },
      },
    );
    const { data: similarRows, error: similarError } = await userClient.rpc(
      "match_investigations",
      {
        query_embedding: embedding,
        match_count: 4,
      },
    );
    similar = (similarRows ?? []).filter(
      (r: { investigation_id: string }) => r.investigation_id !== invId,
    ).slice(0, 3);
    console.log(
      `[recall] rpc=match_investigations rows=${similar.length} status=${
        similarError ? "error" : "ok"
      } mode=user-jwt`,
    );

    // P1 過去グループ嗜好 (issue #105 / §3 P1, §16.1)。
    // アクセス制御は match_investigations と同じ auth.uid() ベース (§24) のため、
    // ユーザー JWT のクライアントで呼ぶ (service role 再呼び出し時はこのブロックごとスキップ)。
    // 返るのは place の集計値と kind/priority の分布のみ。他人の query 本文・raw_query・
    // requirement 文面は RPC が返さない (§33)。
    // RPC 未適用環境 (migration 0008 前) でも recall step 自体は失敗させない。
    const { data: placeRows, error: placeError } = await userClient.rpc(
      "match_investigation_places",
      {
        query_embedding: embedding,
        match_count: 5,
        exclude_investigation: invId,
      },
    );
    const { data: kindRows, error: kindError } = await userClient.rpc(
      "match_requirement_kinds",
      {
        query_embedding: embedding,
        match_count: 8,
        exclude_investigation: invId,
      },
    );
    if (placeError || kindError) {
      console.error("[recall] preference RPC failed status=error");
    }
    console.log(
      `[recall] rpc=match_investigation_places rows=${
        placeRows?.length ?? 0
      } status=${placeError ? "error" : "ok"} mode=user-jwt`,
    );
    console.log(
      `[recall] rpc=match_requirement_kinds rows=${
        kindRows?.length ?? 0
      } status=${kindError ? "error" : "ok"} mode=user-jwt`,
    );
    const places = ((placeRows ?? []) as Array<
      {
        place_id: string;
        name: string;
        avg_vote: number;
        similarity: number;
        last_at: string;
      }
    >).map((r) => ({
      placeId: r.place_id,
      name: r.name,
      avgVote: r.avg_vote,
      similarity: r.similarity,
      lastAt: r.last_at,
    }));
    const kinds = ((kindRows ?? []) as Array<
      { kind: string; priority: string; count: number }
    >)
      .map((r) => ({ kind: r.kind, priority: r.priority, count: r.count }));

    // フロントの「前回このメンバーは静かな店を好んだ」表示 (issue #111) と
    // ranking の加点 (rankInvestigation) の両方がこの 1 件を消費する
    await logEvent(
      ctx.db,
      invId,
      "recall_preference",
      places.length > 0
        ? `過去の類似調査で高評価だった店が ${places.length} 件あります`
        : "過去の類似調査に嗜好の手がかりはありませんでした",
      {
        placeCount: places.length,
        kindCount: kinds.length,
        places,
        kinds,
      },
    );
  } else {
    console.log(
      `[recall] skipped=${
        embedding ? "missing_user_jwt" : "missing_embedding"
      }`,
    );
  }

  await logEvent(
    ctx.db,
    invId,
    "recall_completed",
    similar.length > 0
      ? `過去の類似調査が ${similar.length} 件見つかりました`
      : "過去の類似調査はありませんでした",
    { count: similar.length },
  );
}

const EMPTY_KNOWLEDGE_REUSE_STATS: KnowledgeReuseStats = {
  inputHitCount: 0,
  candidateCount: 0,
  duplicateCount: 0,
  similarCandidateCount: 0,
  vectorCandidateCount: 0,
  freshFactCandidateCount: 0,
  staleFactCandidateCount: 0,
  missingFactCandidateCount: 0,
  refreshCandidateCount: 0,
};

interface ReusableKnowledgeRead {
  lookup: CanonicalLookupResult;
  stats: KnowledgeReuseStats;
  metadataByResultKey: Map<string, KnowledgeCandidateMetadata>;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

/**
 * 既存 Knowledge の read boundary。類似調査の event には集計済み place ID
 * だけが残り、place本文やquery本文は含まれない。current place vector は既存
 * area内の place embedding と query embedding を決定論的に比較する。factsは
 * canonical readの nested relationで鮮度を判定し、stale/missingを別カウントする。
 */
async function readReusableKnowledge(
  db: SupabaseClient,
  invId: string,
  input: {
    area: string;
    keyword?: string;
    requiredCount: number;
    broadLimit: number;
    currentLocationRequested: boolean;
    searchAnchor?: LocationAnchor;
  },
): Promise<ReusableKnowledgeRead> {
  const now = new Date();
  const lookupInput = {
    ...input,
    now,
  };
  const base = await readCanonicalPlaces(db, lookupInput);
  if (input.currentLocationRequested) {
    return {
      lookup: base,
      stats: EMPTY_KNOWLEDGE_REUSE_STATS,
      metadataByResultKey: new Map(),
    };
  }

  let similarPlaceIds = new Set<string>();
  try {
    const { data, error } = await db
      .from("investigation_events")
      .select("metadata")
      .eq("investigation_id", invId)
      .eq("event_type", "recall_preference")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error) {
      const places = (data?.metadata as { places?: unknown[] } | null)?.places;
      similarPlaceIds = new Set(
        (Array.isArray(places) ? places : [])
          .map((place) =>
            place && typeof place === "object"
              ? (place as { placeId?: unknown }).placeId
              : null
          )
          .filter(isUuid),
      );
    }
  } catch {
    // recall eventが読めない場合も、current canonical/vectorだけで安全に続行する。
    similarPlaceIds = new Set();
  }

  let queryVector: number[] | null = null;
  try {
    const { data, error } = await db
      .from("investigations")
      .select("embedding")
      .eq("id", invId)
      .maybeSingle();
    if (!error && typeof data?.embedding === "string") {
      const checked = validateEmbeddingVectorString(data.embedding);
      if (checked.ok) queryVector = checked.value;
      else logInvalidEmbedding("db_readback", checked.reason);
    }
  } catch {
    queryVector = null;
  }

  const similar = await readCanonicalPlacesByIds(
    db,
    lookupInput,
    [...similarPlaceIds],
  );
  const merged = mergeReusableKnowledgeHits({
    hits: [...base.hits, ...similar.hits],
    similarPlaceIds,
    queryVector,
    broadLimit: input.broadLimit,
  });
  const lookup: CanonicalLookupResult = {
    outcome: merged.hits.length >= Math.max(1, input.requiredCount)
      ? "hit"
      : merged.hits.length > 0
      ? "partial"
      : base.outcome === "error" || similar.outcome === "error"
      ? "error"
      : "miss",
    hits: merged.hits,
    canonicalCandidateCount: merged.hits.length,
    providerLinkCount: merged.hits.reduce(
      (sum, hit) => sum + hit.providerLinkCount,
      0,
    ),
    provenanceCount: merged.hits.reduce(
      (sum, hit) => sum + hit.provenanceCount,
      0,
    ),
  };
  return {
    lookup,
    stats: merged.stats,
    metadataByResultKey: merged.metadataByResultKey,
  };
}

// ============================================================
// step 2: searching — Broad候補 + Evidence #0 (§5.4 / #509)
// ============================================================

// places upsert (unique(provider, provider_place_id))。provider から取得した最新値で
// 上書きし、取得時刻を refreshed_at として記録する (#289 24h キャッシュ更新)
async function upsertPlaceFromResult(
  db: SupabaseClient,
  r: PlaceSearchResult,
): Promise<
  { id: string; embedding: string | null; linkId: string | null } | null
> {
  // domain はproviderの明示値だけをmetadataへ保存する。未知値や欠落値を
  // restaurantへ補完せず、既存行との互換を保つ (#125)。
  const domain = getDomainProfile(r.domain)?.id;
  const { data: placeRow } = await db
    .from("places")
    .upsert(
      {
        provider: r.provider,
        provider_place_id: r.providerPlaceId,
        name: r.name,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        metadata: domain ? { ...r.metadata, domain } : r.metadata,
        refreshed_at: r.fetchedAt ?? new Date().toISOString(),
      },
      { onConflict: "provider,provider_place_id" },
    )
    .select("id, embedding")
    .single();
  if (!placeRow) return null;
  // provider identity は link table 側が正本 (#530)。places の legacy 列は移行期間中のみ併存
  const linkId = await upsertProviderLink(db, placeRow.id, r);
  return { ...placeRow, linkId };
}

// canonical Place (places.id) と provider identity の link を upsert する (#530)。
// provider ごとの保存可否 (storage_policy) / 表示義務 / 期限は provider adapter の
// meta をそのまま記録する。ここに provider 名の if は書かない。
// link 行が provider 停止時の列挙・TTL・purge の起点になる (#297)
async function upsertProviderLink(
  db: SupabaseClient,
  placeId: string,
  r: PlaceSearchResult,
): Promise<string | null> {
  const { meta } = getProviders().place;
  const now = r.fetchedAt ?? new Date().toISOString();
  const expiresAt = meta.ttlHours
    ? new Date(Date.parse(now) + meta.ttlHours * 3600_000).toISOString()
    : null;
  const { data, error } = await db
    .from("place_provider_links")
    .upsert(
      {
        place_id: placeId,
        provider: r.provider,
        provider_place_id: r.providerPlaceId,
        source_url: r.url,
        storage_policy: meta.storagePolicy,
        expires_at: expiresAt,
        attribution_policy: meta.attributionPolicy,
        last_seen_at: now,
      },
      { onConflict: "provider,provider_place_id" },
    )
    .select("id")
    .single();
  // link が無いと provider provenance と帰属義務が欠落するため、調査全体を成功扱いにしない。
  throwIfDatabaseError(error, "place_provider_links.upsert");
  return data?.id ?? null;
}

// Evidence #0: Place provider の構造化情報 (§5.4)。TTL 内の同一 URL があれば再利用し、
// TTL 超過なら新しい行として再生成する (§32 追記型。#289)。
// 併せて provider link への provenance を記録する (#530 / #297 purge 経路)
async function insertPlaceEvidence(
  db: SupabaseClient,
  placeId: string,
  r: PlaceSearchResult,
  linkId: string | null,
): Promise<string | null> {
  const evidenceId = await insertPlaceEvidenceRow(db, placeId, r);
  if (evidenceId && linkId) {
    await db.from("evidence").update({ provider_link_id: linkId }).eq(
      "id",
      evidenceId,
    );
  }
  return evidenceId;
}

function insertPlaceEvidenceRow(
  db: SupabaseClient,
  placeId: string,
  r: PlaceSearchResult,
): Promise<string | null> {
  // provider によっては per-record の公開ページが無い (#559 Overture)。
  // 存在しない URL を組み立てて Evidence の出所を偽装しないため、URL が無ければ
  // Evidence #0 を作らない。候補自体は残り、根拠は Serper + fetcher 側で埋める (§13 / §36 Rule 6)
  if (!r.url.trim()) return Promise.resolve(null);
  return insertEvidenceIfStale(
    db,
    placeId,
    r.url,
    `${r.name} - 店舗情報`,
    "major_place_provider",
    r.structuredClaims,
    r.structuredClaims.map((c) => c.rawText).join("。"),
    r.fetchedAt,
  );
}

// #289 の provider TTL 対応。候補確定済みの再入・再実行で TTL 付き provider の
// places を再取得して上書きし、店舗情報 Evidence (#0) を再生成する。
// persistent provider (Geoapify) は保存期限が無いため自動再取得しない。再検索は
// 明示的な discovery/cache miss に限定し、調査の再実行で API を増やさない。
// mock 行も対象外 (§5.4 Fallback 不変)。再取得の失敗は調査本体を止めない (§31 と同方針)。
async function refreshStaleProviderPlaces(ctx: RunContext): Promise<void> {
  const { db, invId } = ctx;
  try {
    const { place } = getProviders(providerInstrumentation(ctx.requestId));
    const refreshTtlHours = place.meta.ttlHours;
    if (!place.fetchByIds || refreshTtlHours === null) return;

    const { data: rows } = await db
      .from("candidates")
      .select("places (id, provider, provider_place_id, refreshed_at)")
      .eq("investigation_id", invId);
    const placeRows = (rows ?? [])
      .map((row) =>
        (row as unknown as {
          places: {
            id: string;
            provider: string;
            provider_place_id: string;
            refreshed_at: string | null;
          } | null;
        }).places
      )
      .filter((p): p is NonNullable<typeof p> => p !== null);
    // provider 切替後に残る legacy 行を除外する (#530。判定は provider_ttl.ts の純関数)
    const { targets: staleTargets, skipped: ttlSkipped } = selectRefreshTargets(
      placeRows,
      place.meta.id,
      new Date(),
      refreshTtlHours,
    );
    const stale = staleTargets.slice(0, ctx.policy.providerCallLimit);
    const skipped = ttlSkipped +
      Math.max(0, staleTargets.length - stale.length);
    if (stale.length === 0) {
      if (skipped > 0) {
        await logEvent(
          db,
          invId,
          "places_refreshed",
          `店舗情報の再取得対象を確認しました (対象外 ${skipped}件)`,
          { refreshedCount: 0, missingCount: 0, skipped },
        );
      }
      return;
    }

    const results = await measureProviderCall(
      ctx.requestId,
      place.meta.id,
      "place_fetch_by_ids",
      () => place.fetchByIds!(stale.map((p) => p.provider_place_id)),
    );
    for (const r of results) {
      const placeRow = await upsertPlaceFromResult(db, r);
      if (!placeRow) continue;
      await insertPlaceEvidence(db, placeRow.id, r, placeRow.linkId);
    }
    // 再取得できなかった店 (掲載終了など) は stale のまま残し、次回 live 実行で再試行する
    const returnedIds = new Set(results.map((r) => r.providerPlaceId));
    const missing = stale
      .map((p) => p.provider_place_id)
      .filter((id) => !returnedIds.has(id));
    await logEvent(
      db,
      invId,
      "places_refreshed",
      `店舗情報を再取得しました (${results.length}/${stale.length}件)`,
      {
        refreshedCount: returnedIds.size,
        missingCount: missing.length,
        skipped,
      },
    );
  } catch {
    await logEvent(
      db,
      invId,
      "places_refresh_failed",
      "店舗情報の再取得に失敗しました (次回実行時に再試行します)",
      { code: "provider_refresh_error" },
    );
  }
}

async function stepSearching(ctx: RunContext): Promise<void> {
  const { db, invId } = ctx;
  // area は create-investigation の parse_completed event から引き継ぐ
  const { data: parseEvent } = await db
    .from("investigation_events")
    .select("metadata")
    .eq("investigation_id", invId)
    .eq("event_type", "parse_completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const meta = parseEvent?.metadata as {
    area?: string;
    budgetMax?: number | null;
    locationScope?: unknown;
  } | null;
  let area = meta?.area ?? "池袋";
  // keyword は共有イベントへ保存せず、service-side の requirements 正本から
  // 再構成する。cuisine の自由文を joined member のイベントへ漏らさない。
  const parsedRequirements = await loadRequirements(db, invId);
  const cuisineRequirement = parsedRequirements.find((requirement) =>
    requirement.kind === "cuisine"
  );
  const keyword = cuisineRequirement?.normalizedText
    ? cuisineRequirement.normalizedText.split(/[・、,\s]/)[0]
    : undefined;
  // 予算上限 (#312 是正案2)。旧 investigation の parse_completed には無いため任意
  const budgetMax = typeof meta?.budgetMax === "number" && meta.budgetMax > 0
    ? meta.budgetMax
    : undefined;

  const rawLocationScopeResolution = resolveLocationScope(
    ctx.rawQuery,
    meta?.locationScope,
  );
  // モデルが area/locationScope へ current_location を出力しても、入力文に
  // 現在地を指す語が実在しなければ信用しない (#317: 場所語が皆無の入力に
  // モデルが current_location を自己判断で補い、GPS未選択のユーザーが
  // 必ず location_anchor_required になる regression を確認)。
  const rawQueryMentionsCurrentLocation = queryMentionsCurrentLocation(
    ctx.rawQuery,
  );
  const locationScopeResolution =
    rawLocationScopeResolution.status === "resolved" &&
      rawLocationScopeResolution.scope.type === "current_location" &&
      !rawQueryMentionsCurrentLocation
      ? { status: "absent" as const }
      : rawLocationScopeResolution;
  if (isCurrentLocationArea(area) && !rawQueryMentionsCurrentLocation) {
    area = "池袋";
  }
  const effectiveLocationScope = locationScopeResolution.status === "resolved"
    ? locationScopeResolution.scope
    : undefined;
  const currentLocationRequested = isCurrentLocationArea(area) ||
    effectiveLocationScope?.type === "current_location";
  const limits = preRankLimits(ctx.policy);
  const { count } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("investigation_id", invId);
  if ((count ?? 0) >= limits.researchLimit) {
    // 既に検索成果物が揃っていれば以降の step は anchor を必要としない。
    // stale anchor run の Cron 再配送でもここで依存フラグを原子的に解除する。
    await consumeRunAnchor(ctx);
    // 候補確定時 (再入含む)、24h 超の provider 由来 places / Evidence #0 を再取得 (#289)
    await refreshStaleProviderPlaces(ctx);
    return;
  }

  // 検索成果物が未確定の current_location run は、anchor無しで provider を呼ばない。
  // Cronからの stale再配送は executeRun の atomic location_anchor_required 終端へ送る。
  if (currentLocationRequested && !ctx.searchAnchor) {
    throw new LocationAnchorRequiredError();
  }

  const railEnabled = Deno.env.get("RAIL_LOCATION_RESOLVER_ENABLED") === "true";
  const railScope = railEnabled && locationScopeResolution.status === "resolved"
    ? locationScopeResolution.scope
    : null;

  const { place, ai } = getProviders(
    providerInstrumentation(ctx.requestId, "generic"),
  );
  const railProvenance = new Map<string, Array<Record<string, unknown>>>();
  let canonicalHitsByResultKey = new Map<string, CanonicalPlaceHit>();
  let results: PlaceSearchResult[];
  // rail は canonical address照合の対象外なので従来どおり stale refresh を
  // 行う。通常経路は canonical hit を先に判定し、hit時の provider call=0を守る。
  const railDiscoveryRequested = railEnabled && (
    locationScopeResolution.status === "invalid" ||
    (railScope !== null && railScope.type !== "point" &&
      railScope.type !== "current_location")
  );
  if (railDiscoveryRequested) await refreshStaleProviderPlaces(ctx);
  if (railEnabled && locationScopeResolution.status === "invalid") {
    await logEvent(
      db,
      invId,
      "rail_scope_invalid",
      "鉄道位置指定を検証できませんでした",
      {},
    );
    results = [];
  } else if (
    railEnabled && railScope &&
    railScope.type !== "point" &&
    railScope.type !== "current_location"
  ) {
    const resolved = await resolveRailScope(db, railScope);
    if (resolved.status !== "resolved") {
      await logEvent(db, invId, "rail_scope_unresolved", resolved.reason, {
        status: resolved.status,
      });
      results = [];
    } else {
      const configuredPerAnchorLimit = configuredPositiveInt(
        Deno.env.get("RAIL_DISCOVERY_PER_ANCHOR_LIMIT"),
      );
      const configuredMaxProviderCalls = configuredPositiveInt(
        Deno.env.get("RAIL_DISCOVERY_MAX_PROVIDER_CALLS"),
      );
      const configuredRailBroadLimit = configuredPositiveInt(
        Deno.env.get("RAIL_DISCOVERY_BROAD_LIMIT"),
      );
      const perAnchorLimit = configuredPerAnchorLimit === null
        ? null
        : Math.min(ctx.policy.providerCallLimit, configuredPerAnchorLimit);
      const maxProviderCalls = configuredMaxProviderCalls === null
        ? null
        : Math.min(ctx.policy.providerCallLimit, configuredMaxProviderCalls);
      const broadLimit = Math.min(
        limits.broadLimit,
        configuredRailBroadLimit ?? limits.broadLimit,
      );
      if (!perAnchorLimit || !maxProviderCalls || !broadLimit) {
        await logEvent(
          db,
          invId,
          "rail_scope_budget_invalid",
          "鉄道沿線探索の取得上限が設定されていません",
          {
            missingConfigCount: 2,
          },
        );
        results = [];
      } else if (resolved.anchors.length > maxProviderCalls) {
        // Never truncate the resolved station set before discovery. If the
        // configured provider-call budget cannot cover all anchors, fail
        // closed and make that trade-off observable.
        await logEvent(
          db,
          invId,
          "rail_scope_budget_exceeded",
          "鉄道沿線探索の駅anchor数がprovider呼び出し上限を超えています",
          {
            anchorCount: resolved.anchors.length,
            maxProviderCalls,
            perAnchorLimit,
            broadLimit,
          },
        );
        results = [];
      } else {
        // Every anchor is queried before dedupe and cheap pre-ranking. The
        // explicit budget bounds provider calls and intermediate candidates;
        // it is not a per-anchor top-3 shortcut.
        const merged = new Map<
          string,
          { result: PlaceSearchResult; distanceM: number }
        >();
        for (const anchor of resolved.anchors) {
          if (anchor.lat === null || anchor.lng === null) continue;
          const anchorLat = anchor.lat;
          const anchorLng = anchor.lng;
          const anchorResults = await measureProviderCall(
            ctx.requestId,
            place.meta.id,
            "place_search",
            () =>
              place.search({
                area: anchor.stationName,
                keyword,
                budgetMax,
                limit: perAnchorLimit,
                publicSearchAnchor: {
                  lat: anchorLat,
                  lng: anchorLng,
                  cacheKey: [
                    "mlit_n02",
                    resolved.datasetVersionId ?? "unknown",
                    anchor.lineId ?? "",
                    anchor.componentId ?? "",
                    anchor.pathKey ?? "main",
                    anchor.stationGroupId,
                  ].join(":"),
                },
              }),
          );
          for (const result of anchorResults.slice(0, perAnchorLimit)) {
            const key = `${result.provider}\u0000${result.providerPlaceId}`;
            const candidateDistance = distanceM(
              anchorLat,
              anchorLng,
              result.lat,
              result.lng,
            );
            const previous = merged.get(key);
            if (!previous || candidateDistance < previous.distanceM) {
              merged.set(key, { result, distanceM: candidateDistance });
            }
            const provenance = railProvenance.get(key) ?? [];
            const provenanceKey = `${anchor.lineId ?? ""}\u0000${
              anchor.componentId ?? ""
            }\u0000${anchor.pathKey ?? "main"}\u0000${anchor.stationGroupId}`;
            if (!provenance.some((item) => item.key === provenanceKey)) {
              provenance.push({
                key: provenanceKey,
                type: anchor.sourceScope === "between" ||
                    anchor.sourceScope === "corridor"
                  ? "rail_corridor"
                  : anchor.sourceScope === "station_hops"
                  ? "rail_station_hops"
                  : "rail_line",
                stationGroupId: anchor.stationGroupId,
                stationName: anchor.stationName,
                lineId: anchor.lineId ?? null,
                componentId: anchor.componentId ?? null,
                pathKey: anchor.pathKey ?? "main",
                sequence: anchor.sequence ?? null,
                distanceM: candidateDistance === Number.POSITIVE_INFINITY
                  ? null
                  : candidateDistance,
              });
            }
            railProvenance.set(key, provenance);
          }
        }
        results = preRankRailCandidates([...merged.values()], broadLimit);
      }
      await logEvent(
        db,
        invId,
        "rail_scope_resolved",
        "鉄道位置指定を駅アンカーへ解決しました",
        {
          datasetVersionId: resolved.datasetVersionId,
          anchorCount: resolved.anchors.length,
          providerCallLimit: maxProviderCalls ?? null,
          perAnchorLimit: perAnchorLimit ?? null,
          broadLimit,
          candidateCount: results.length,
        },
      );
    }
  } else {
    let knowledgeStats: KnowledgeReuseStats = EMPTY_KNOWLEDGE_REUSE_STATS;
    let knowledgeReuseMs = 0;
    const resolution = await resolveCanonicalDiscovery(
      async () => {
        const reuseStarted = Date.now();
        const reusable = await readReusableKnowledge(db, invId, {
          area,
          keyword,
          requiredCount: limits.researchLimit,
          broadLimit: limits.broadLimit,
          currentLocationRequested,
          searchAnchor: ctx.searchAnchor,
        });
        knowledgeReuseMs += Math.max(0, Date.now() - reuseStarted);
        knowledgeStats = reusable.stats;
        ctx.knowledgeByResultKey = reusable.metadataByResultKey;
        return reusable.lookup;
      },
      async () => {
        // canonical hit のときは resolver がこの callback 自体を呼ばない。
        // したがって stale fetchByIds も Geoapify search も0件にできる。
        await refreshStaleProviderPlaces(ctx);
        return await measureProviderCall(
          ctx.requestId,
          place.meta.id,
          "place_search",
          () =>
            place.search({
              area,
              keyword,
              budgetMax,
              limit: limits.broadLimit,
              ...(currentLocationRequested && ctx.searchAnchor
                ? { searchAnchor: ctx.searchAnchor }
                : {}),
            }),
        );
      },
      {
        requiredCount: limits.researchLimit,
        broadLimit: limits.broadLimit,
      },
    );
    results = resolution.results;
    canonicalHitsByResultKey = resolution.canonicalHits;
    logRunMetric(ctx.requestId, "knowledge_reuse", {
      input_hit_count: knowledgeStats.inputHitCount,
      knowledge_candidate_count: knowledgeStats.candidateCount,
      duplicate_count: knowledgeStats.duplicateCount,
      similar_candidate_count: knowledgeStats.similarCandidateCount,
      vector_candidate_count: knowledgeStats.vectorCandidateCount,
      fresh_fact_candidate_count: knowledgeStats.freshFactCandidateCount,
      stale_fact_candidate_count: knowledgeStats.staleFactCandidateCount,
      missing_fact_candidate_count: knowledgeStats.missingFactCandidateCount,
      refresh_handoff_count: knowledgeStats.refreshCandidateCount,
      external_provider_calls: resolution.externalProviderCalls,
      warm_hit: resolution.externalProviderCalls === 0,
      duration_ms: knowledgeReuseMs,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    });
    const nowMs = Date.now();
    const canonicalFreshnessAges = [...resolution.canonicalHits.values()]
      .flatMap((hit) => {
        if (
          typeof hit.result.fetchedAt !== "string" ||
          !Number.isFinite(Date.parse(hit.result.fetchedAt))
        ) return [];
        return [Math.max(0, nowMs - Date.parse(hit.result.fetchedAt))];
      });
    const canonicalFreshnessPresentCount = canonicalFreshnessAges.length;
    logRunMetric(ctx.requestId, "canonical_lookup", {
      outcome: metricLabel(resolution.outcome),
      canonical_candidate_count: resolution.canonicalCandidateCount,
      provider_link_count: resolution.providerLinkCount,
      provenance_count: resolution.provenanceCount,
      external_provider_calls: resolution.externalProviderCalls,
      cache_reused: resolution.externalProviderCalls === 0,
      canonical_freshness_present_count: canonicalFreshnessPresentCount,
      canonical_freshness_missing_count: Math.max(
        0,
        resolution.canonicalHits.size - canonicalFreshnessPresentCount,
      ),
      canonical_freshness_oldest_age_ms: canonicalFreshnessAges.length > 0
        ? Math.max(...canonicalFreshnessAges)
        : 0,
    });
  }
  if (results.length === 0) {
    // 候補0件は既存契約上の終端結果。汎用技術失敗として再試行せず、
    // executeRun の専用RPCで no_candidates/status/run を一度だけ確定する。
    throw new NoCandidatesError();
  }

  // Pre-Rank (#552): 高価な Web Research + Gemini Judge へ回す候補をここで絞る。
  // unknown を mismatch 扱いして候補を落とさない / 探索枠を必ず残す / provider 障害でも完走する
  const selected = await preRankAndSelect(ctx, results, limits);
  if (selected.length === 0) {
    // 既存の途中成果物が無いまま pre-rank が全件を落とした場合も、候補0件の
    // 契約へ揃える。技術 failure retry へ流さず、executeRun の専用RPCで
    // provider再呼出しなしに終端化する。途中成果物が既にある再入だけは続行する。
    const { count: existingCandidateCount } = await db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("investigation_id", invId);
    if ((existingCandidateCount ?? 0) === 0) throw new NoCandidatesError();
    return;
  }

  for (const r of selected) {
    const canonicalHit = canonicalHitsByResultKey.get(canonicalResultKey(r));
    // canonical hit は既存 row と provenance をそのまま再利用する。ここで
    // provider 応答を upsert すると、link の TTL/attribution や共有資産を
    // 上書きしてしまうため、write path は discovery fallback のみに限定する。
    const placeRow = canonicalHit
      ? {
        id: canonicalHit.canonicalPlaceId,
        embedding: canonicalHit.embedding,
        linkId: canonicalHit.linkId,
      }
      : await upsertPlaceFromResult(db, r);
    if (!placeRow) continue;

    // places.embedding を計算 (semantic_match §17 の入力。既存はスキップ)
    if (!canonicalHit && !placeRow.embedding) {
      try {
        const genre = r.structuredClaims.find((c) => c.key === "genre");
        const text = `${r.name} ${r.address} ${
          Array.isArray(genre?.value) ? (genre.value as string[]).join(" ") : ""
        }`;
        const [vec] = await measureEmbedding(
          ctx.requestId,
          1,
          () => ai.embed([text]),
        );
        const checked = validateEmbedding(vec);
        if (checked.ok) {
          await db.from("places").update({
            embedding: JSON.stringify(checked.value),
          }).eq("id", placeRow.id);
        } else {
          logInvalidEmbedding("provider_ingress", checked.reason);
        }
      } catch {
        // embedding 無しでも続行
      }
    }

    // candidates INSERT (冪等: unique(investigation_id, place_id))
    const provenanceKey = `${r.provider}\u0000${r.providerPlaceId}`;
    await db.from("candidates").upsert(
      {
        investigation_id: invId,
        place_id: placeRow.id,
        discovery_context: railProvenance.has(provenanceKey)
          ? {
            rail: railProvenance.get(provenanceKey),
            attributionPolicies: ["mlit_n02_attribution"],
          }
          : {},
      },
      { onConflict: "investigation_id,place_id" },
    );

    // Evidence #0: Place provider の構造化情報 (§5.4)。TTL 内の同一 URL があれば再利用 (§32)
    if (!canonicalHit) {
      await insertPlaceEvidence(db, placeRow.id, r, placeRow.linkId);
    }
  }

  const { count: persistedCandidateCount } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("investigation_id", invId);
  if ((persistedCandidateCount ?? 0) === 0) {
    // provider result があっても永続化できた候補が無ければ、成功扱いにせず
    // no_candidates の原子的終端へ送る。既に candidates がある再入は上記で除外。
    throw new NoCandidatesError();
  }

  await logEvent(
    db,
    invId,
    "search_completed",
    `候補を ${persistedCandidateCount ?? selected.length} 件見つけました`,
    {
      area,
      count: persistedCandidateCount ?? selected.length,
      // stage 別のコスト計測 (#552 Cost Strategy / #223 unit economics)
      broadCandidateCount: results.length,
      researchCandidateCount: persistedCandidateCount ?? selected.length,
    },
  );
  // candidates/search_completed の永続化後にだけ anchor 依存を解除する。
  // このRPCは owner/lease を検証し、座標自体はDBへ書き込まない。
  await consumeRunAnchor(ctx);
}

// ============================================================
// Pre-Rank (#552): Broad Discovery 候補 → Research 候補の選抜
// provider の分岐は providers/index.ts が持ち、ここには provider 名の if を書かない。
// pre-rank が失敗しても candidates を 0 件にしない (fail-open)。
// ============================================================

// pre-rank へ渡してよいのは既知情報のみ (#552 Principle: モデルを「事実の発明者」にしない)。
// 未永続化の段階なので id は provider identity から作る
function preRankKey(r: PlaceSearchResult): string {
  return `${r.provider}:${r.providerPlaceId}`;
}

function toPreRankCandidate(
  r: PlaceSearchResult,
  knowledge?: KnowledgeCandidateMetadata,
): PreRankCandidate {
  const knownClaims = knowledge?.sources.includes("canonical_place")
    ? r.structuredClaims.filter((claim) =>
      knowledge.freshClaimKeys.includes(claim.key)
    )
    : r.structuredClaims;
  const genre = knownClaims.find((c) => c.key === "genre");
  const fromClaims = Array.isArray(genre?.value) ? genre.value as string[] : [];
  const fromMetadata = Array.isArray(r.metadata?.categories)
    ? (r.metadata.categories as unknown[]).filter((c): c is string =>
      typeof c === "string"
    )
    : [];
  const distance = r.metadata?.distanceM;
  return {
    id: preRankKey(r),
    name: r.name,
    provider: r.provider,
    distanceM: typeof distance === "number" ? distance : null,
    categories: [...new Set([...fromClaims, ...fromMetadata])],
    knownClaims: knownClaims.map((c) => ({
      key: c.key,
      value: c.value,
      rawText: c.rawText,
    })),
  };
}

async function preRankAndSelect(
  ctx: RunContext,
  results: PlaceSearchResult[],
  limits: ReturnType<typeof preRankLimits>,
): Promise<PlaceSearchResult[]> {
  const { db, invId } = ctx;
  const preRankResults = results.slice(0, limits.preRankLimit);
  if (preRankResults.length <= limits.researchLimit) return preRankResults;

  const requirements = await loadRequirements(db, invId);
  const preRequirements: PreRankRequirement[] = requirements.map((r) => ({
    id: r.id,
    kind: r.kind,
    priority: (r.priority === "must" || r.priority === "nice")
      ? r.priority
      : "should",
    weight: r.weight ?? 0.5,
    normalizedText: r.normalizedText,
    originalText: r.originalText,
  }));
  const candidates = preRankResults.map((result) =>
    toPreRankCandidate(
      result,
      ctx.knowledgeByResultKey?.get(canonicalResultKey(result)),
    )
  );
  const byKey = new Map(preRankResults.map((r) => [preRankKey(r), r]));

  const provider = getPreRankProvider();
  const outcome = await measureProviderCall(
    ctx.requestId,
    provider.id,
    "pre_rank",
    () => provider.preRank(candidates, preRequirements),
  );
  // 除外してよいのは must への既知 mismatch だけ。unknown は除外理由にしない
  const filtered = hardFilter(candidates, preRequirements, outcome.results);
  const selection = selectResearchCandidates(filtered.kept, outcome.results, {
    researchLimit: limits.researchLimit,
    explorationSlots: limits.explorationSlots,
  });

  const selected = selection.selected
    .map((id) => byKey.get(id))
    .filter((r): r is PlaceSearchResult => r !== undefined);

  await logEvent(
    db,
    invId,
    "prerank_completed",
    `${preRankResults.length} 件の候補から ${selected.length} 件を詳しく調べます`,
    {
      provider: outcome.provider,
      // stage 別カウント (#552 Cost Strategy)
      broadCandidateCount: results.length,
      preRankCandidateCount: preRankResults.length,
      hardFilterCount: filtered.kept.length,
      researchCandidateCount: selected.length,
      explorationCount: selection.exploration.length,
      hardFilterDropped: filtered.droppedIds.length,
      hardFilterFailOpen: filtered.failOpen,
      // AI provider の受入 / 棄却と fallback 理由 (#552 Acceptance: drop reason の観測)
      aiAcceptedCount: outcome.acceptedIds.length,
      aiRejectedCount: outcome.rejectedIds.length,
      fallbackReason: outcome.fallbackReason,
      attempts: outcome.attempts,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      reasoningTokens: outcome.reasoningTokens,
      latencyMs: outcome.latencyMs,
    },
  );

  // 万一 0 件になったら pre-rank を無視して先頭から埋める (Investigation を落とさない)
  return selected.length > 0
    ? selected
    : preRankResults.slice(0, limits.researchLimit);
}

// ============================================================
// step 3+4: collecting_evidence / evaluating (§25.2)
// 冪等の単位は「candidate × current requirement の全評価が存在するか」。
// research 結果は step 間で持ち回れないため、coverage 未完の候補のみ
// investigateCandidate を実行し、Evidence 保存 → 評価保存を候補単位で commit する。
// ============================================================
async function pendingCandidates(ctx: RunContext): Promise<CandidateRow[]> {
  const [candidates, requirements] = await Promise.all([
    loadCandidates(ctx.db, ctx.invId),
    loadRequirements(ctx.db, ctx.invId),
  ]);
  if (candidates.length === 0 || requirements.length === 0) return [];

  const { data: rows, error } = await ctx.db
    .from("requirement_evaluations")
    .select("candidate_id, requirement_id")
    .eq("investigation_id", ctx.invId);
  throwIfDatabaseError(error, "requirement_evaluations.coverage_select");

  const pendingIds = new Set(pendingCandidateIdsForCoverage(
    candidates.map((candidate) => candidate.id),
    requirements.map((requirement) => requirement.id),
    (rows ?? []).map((row) => ({
      candidateId: row.candidate_id,
      requirementId: row.requirement_id,
    })),
  ));
  return candidates.filter((candidate) => pendingIds.has(candidate.id));
}

async function stepCollectEvidence(ctx: RunContext): Promise<void> {
  // 実処理は stepEvaluate と一体 (research 結果を使い切る §25.2 step4「追加の AI call はしない」)。
  // status 遷移の見た目 (§10) のためにステップは分けている。
  const pending = await pendingCandidates(ctx);
  if (pending.length === 0) return;
  ctx.pendingResearch = pending;
}

async function stepEvaluate(ctx: RunContext): Promise<void> {
  const pending = ctx.pendingResearch ?? (await pendingCandidates(ctx));
  if (pending.length === 0) return;

  const requirements = await loadRequirements(ctx.db, ctx.invId);
  // Candidate research must use the instrumented provider instance so the
  // Serper/fetch/Gemini queue/API boundaries are measured, not only the outer
  // Promise duration.
  const { ai } = getProviders(
    providerInstrumentation(ctx.requestId, "candidate"),
  );
  // 候補単位で並列 (policyのproviderCallLimit以内)。外部失敗は候補内でunknownへ閉じ、
  // DB等の技術失敗だけはstepを失敗させ、coverage未完の候補を次回再処理する。
  const boundedPending = limitResearchProviderCalls(pending, ctx.policy);
  if (boundedPending.length < pending.length) {
    logRunMetric(ctx.requestId, "policy", {
      ...policyMetricFields(ctx.policy),
      provider_call_limit_skipped: pending.length - boundedPending.length,
    });
  }
  const outcomes = await Promise.all(
    boundedPending.map((c) =>
      measureProviderCall(
        ctx.requestId,
        "research",
        "investigate_candidate",
        () =>
          investigateAndPersist(ctx.db, ctx.invId, c, requirements, {
            updateSummary: true,
            ai,
          }),
      )
    ),
  );
  // #509 / #223: Broad件数と外部Research件数を分離して観測する。候補本文・query・
  // URLはログへ渡さず、fresh再利用とfull researchの実測件数だけを記録する。
  logRunMetric(ctx.requestId, "research_stage", {
    candidate_count: pending.length,
    provider_call_count: boundedPending.length,
    provider_call_limit: ctx.policy.providerCallLimit,
    cached_evaluated_count: outcomes.filter((outcome) =>
      !outcome.externalResearchAttempted
    ).length,
    full_external_research_count:
      outcomes.filter((outcome) => outcome.externalResearchAttempted).length,
    reused_requirement_count: outcomes.reduce(
      (total, outcome) => total + outcome.reusedRequirementCount,
      0,
    ),
    unresolved_requirement_count: outcomes.reduce(
      (total, outcome) => total + outcome.unresolvedRequirementCount,
      0,
    ),
    unknown_requirement_count: outcomes.reduce(
      (total, outcome) => total + outcome.unknownRequirementCount,
      0,
    ),
    estimated_cost_microusd: ctx.policy.estimatedCostMicros,
  });
}

// ============================================================
// step 5: ranking — 矛盾検出 (§15) + score 計算 (§17)。常に再計算 (冪等)
// ============================================================
async function stepRanking(ctx: RunContext): Promise<void> {
  await measureDbRoundtrip(
    ctx.requestId,
    "rank_investigation",
    () => rankInvestigation(ctx.db, ctx.invId, ctx.policy.finalCandidateLimit),
  );
}
