// create-investigation (spec.md §25.1 / contracts/create-investigation.md)
// spec.md §25.1: 同期createはAI構造化呼出し1回、関数全体で10秒以内。
// 外部stepの開始/結果はDBへ即時checkpointし、timeout再送で再利用する。
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import {
  createInvestigationBodySchema,
  type ParsedRequirements,
} from "../_shared/validation.ts";
import {
  queryHasExplicitLocationMarker,
  resolveLocationScope,
} from "../_shared/rail_scope.ts";
import { validateAndDedupeParsedRequirements } from "../_shared/requirement_dedupe.ts";
import { validateEmbedding } from "../_shared/embedding_validation.ts";
import { getProviders } from "../_shared/providers/index.ts";
import { attestedBudgetConstraint } from "../_shared/requirement_source.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";
import { checkCostGuard } from "../_shared/cost_guard.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";
import type { ProviderInstrumentation } from "../_shared/providers/types.ts";
import {
  CREATE_EMBEDDING_TIMEOUT_MS,
  CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS,
  EDGE_TIMEOUT_POLICY,
  OperationTimeoutError,
  throwIfAborted,
  withAbortTimeout,
} from "../_shared/timeout_policy.ts";

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const CREATE_DIGEST_VERSION = "create-investigation-v1";
const MAX_CREATE_BODY_BYTES = 16 * 1024;

type CreationDb = ReturnType<typeof createServiceClient>;
type CreationClaim = {
  claim_status:
    | "claimed"
    | "mismatch"
    | "complete"
    | "in_flight"
    | "reclaimed"
    | "failed";
  investigation_id: string | null;
  share_token: string | null;
  usage_id: number | null;
  lease_generation: number | null;
  lease_token: string | null;
  parse_checkpoint: unknown;
  parse_completed_at: string | null;
  embedding_checkpoint: number[] | null;
  embedding_completed_at: string | null;
  failure_code: string | null;
};

type ParseCheckpoint = {
  parsed: ParsedRequirements;
  budgetMax: number | null;
};
type PersistedParseCheckpoint = Omit<ParsedRequirements, "locationScope"> & {
  locationScope: ParsedRequirements["locationScope"] | null;
  budgetMax: number | null;
};

function safeRequestId(value: string | null): string {
  return value && REQUEST_ID_PATTERN.test(value) ? value : crypto.randomUUID();
}

async function digestCreateRequest(
  query: string,
  displayName: string,
): Promise<string> {
  const payload = JSON.stringify({
    version: CREATE_DIGEST_VERSION,
    query,
    displayName,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function firstClaimRow(value: unknown): CreationClaim | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const candidate = row as Record<string, unknown>;
  if (
    ![
      "claimed",
      "mismatch",
      "complete",
      "in_flight",
      "reclaimed",
      "failed",
    ].includes(
      String(candidate.claim_status),
    )
  ) return null;
  const usageId =
    candidate.usage_id === null || candidate.usage_id === undefined
      ? null
      : Number(candidate.usage_id);
  const leaseGeneration = candidate.lease_generation === null ||
      candidate.lease_generation === undefined
    ? null
    : Number(candidate.lease_generation);
  const leaseToken = typeof candidate.lease_token === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(candidate.lease_token)
    ? candidate.lease_token
    : null;
  const checkedEmbedding = validateEmbedding(candidate.embedding_checkpoint);
  const embeddingCheckpoint = checkedEmbedding.ok
    ? checkedEmbedding.value
    : null;
  if (
    candidate.embedding_checkpoint !== null &&
    candidate.embedding_checkpoint !== undefined &&
    !checkedEmbedding.ok
  ) {
    console.warn(
      `[embedding-invalid] source=create_checkpoint reason=${checkedEmbedding.reason} actual_length=${
        checkedEmbedding.actualLength ?? "none"
      }`,
    );
  }
  return {
    claim_status: candidate.claim_status as CreationClaim["claim_status"],
    investigation_id: typeof candidate.investigation_id === "string"
      ? candidate.investigation_id
      : null,
    share_token: typeof candidate.share_token === "string"
      ? candidate.share_token
      : null,
    usage_id: usageId !== null && Number.isSafeInteger(usageId) && usageId > 0
      ? usageId
      : null,
    lease_generation:
      leaseGeneration !== null && Number.isSafeInteger(leaseGeneration) &&
        leaseGeneration > 0
        ? leaseGeneration
        : null,
    lease_token: leaseToken,
    parse_checkpoint: candidate.parse_checkpoint ?? null,
    parse_completed_at: typeof candidate.parse_completed_at === "string"
      ? candidate.parse_completed_at
      : null,
    embedding_checkpoint: embeddingCheckpoint,
    embedding_completed_at: typeof candidate.embedding_completed_at === "string"
      ? candidate.embedding_completed_at
      : null,
    failure_code: typeof candidate.failure_code === "string"
      ? candidate.failure_code
      : null,
  };
}

function readParseCheckpoint(value: unknown): ParseCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parsedInput = { ...record };
  delete parsedInput.budgetMax;
  if (parsedInput.locationScope === null) delete parsedInput.locationScope;
  const checked = validateAndDedupeParsedRequirements(parsedInput);
  if (!checked.success) return null;
  const budgetMax = record.budgetMax;
  if (
    budgetMax !== null &&
    (!Number.isSafeInteger(budgetMax) || Number(budgetMax) < 0)
  ) return null;
  return {
    parsed: checked.data,
    budgetMax: budgetMax === null ? null : Number(budgetMax),
  };
}

async function releaseCreationClaim(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  requestId: string,
): Promise<void> {
  const { error } = await db.rpc("release_investigation_creation", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_lease_generation: leaseGeneration,
    p_lease_token: leaseToken,
  });
  if (error) {
    console.error(JSON.stringify({
      code: "create_idempotency_release_failed",
      request_id: requestId,
    }));
  }
}

async function touchCreationClaim(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  usageId: number | null,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("touch_investigation_creation", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_lease_generation: leaseGeneration,
    p_lease_token: leaseToken,
    p_usage_id: usageId,
  });
  if (!error && data === true) return true;
  console.error(JSON.stringify({
    code: "create_idempotency_touch_failed",
    request_id: requestId,
  }));
  return false;
}

async function createInvestigationForClaim(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  title: string,
  rawQuery: string,
  normalizedQuery: string,
  requestId: string,
): Promise<{ id: string; shareToken: string } | null> {
  const { data, error } = await db.rpc("create_investigation_for_claim", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_lease_generation: leaseGeneration,
    p_lease_token: leaseToken,
    p_title: title,
    p_raw_query: rawQuery,
    p_normalized_query: normalizedQuery,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (
    !error && row && typeof row === "object" &&
    typeof (row as Record<string, unknown>).investigation_id === "string" &&
    typeof (row as Record<string, unknown>).share_token === "string"
  ) {
    const result = row as Record<string, string>;
    return { id: result.investigation_id, shareToken: result.share_token };
  }
  console.error(JSON.stringify({
    code: "create_idempotency_investigation_failed",
    request_id: requestId,
  }));
  return null;
}

async function completeCreationClaim(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  investigationId: string,
  usageId: number | null,
  requestId: string,
): Promise<"complete" | "rejected" | "unavailable"> {
  const { data, error } = await db.rpc("complete_investigation_creation", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_lease_generation: leaseGeneration,
    p_lease_token: leaseToken,
    p_investigation_id: investigationId,
    p_usage_id: usageId,
  });
  const completed = data === true ||
    (Array.isArray(data) && data[0] === true);
  if (!error && completed) return "complete";
  console.error(JSON.stringify({
    code: "create_idempotency_complete_failed",
    request_id: requestId,
  }));
  return error ? "unavailable" : "rejected";
}

type CreationStep = "parse" | "embedding";
type CreationStepStatus = "started" | "complete" | "uncertain" | "lost";

async function beginCreationStep(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  step: CreationStep,
  requestId: string,
): Promise<CreationStepStatus> {
  const { data, error } = await db.rpc("begin_investigation_creation_step", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_lease_generation: leaseGeneration,
    p_lease_token: leaseToken,
    p_step: step,
  });
  if (
    !error && ["started", "complete", "uncertain", "lost"].includes(
      String(data),
    )
  ) return data as CreationStepStatus;
  console.error(JSON.stringify({
    code: "create_idempotency_step_begin_failed",
    request_id: requestId,
  }));
  return "lost";
}

async function saveParseCheckpoint(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  checkpoint: PersistedParseCheckpoint,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc(
    "save_investigation_creation_parse_checkpoint",
    {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_request_digest: requestDigest,
      p_lease_generation: leaseGeneration,
      p_lease_token: leaseToken,
      p_checkpoint: checkpoint,
    },
  );
  if (!error && data === true) return true;
  console.error(JSON.stringify({
    code: "create_idempotency_parse_checkpoint_failed",
    request_id: requestId,
  }));
  return false;
}

async function saveEmbeddingCheckpoint(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  embedding: number[] | null,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc(
    "save_investigation_creation_embedding_checkpoint",
    {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_request_digest: requestDigest,
      p_lease_generation: leaseGeneration,
      p_lease_token: leaseToken,
      p_embedding: embedding,
    },
  );
  if (!error && data === true) return true;
  console.error(JSON.stringify({
    code: "create_idempotency_embedding_checkpoint_failed",
    request_id: requestId,
  }));
  return false;
}

async function markCreationRetryable(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc(
    "mark_investigation_creation_retryable",
    {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_request_digest: requestDigest,
      p_lease_generation: leaseGeneration,
      p_lease_token: leaseToken,
    },
  );
  if (!error && data === true) return true;
  console.error(JSON.stringify({
    code: "create_idempotency_retryable_failed",
    request_id: requestId,
  }));
  return false;
}

async function failCreationClaim(
  db: CreationDb,
  userId: string,
  idempotencyKey: string,
  requestDigest: string,
  leaseGeneration: number,
  leaseToken: string,
  investigationId: string | null,
  usageId: number | null,
  failureCode:
    | "parse_provider_error"
    | "parse_schema_invalid"
    | "invalid_checkpoint"
    | "finalization_rejected",
  requestId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("fail_investigation_creation", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_lease_generation: leaseGeneration,
    p_lease_token: leaseToken,
    p_investigation_id: investigationId,
    p_usage_id: usageId,
    p_failure_code: failureCode,
  });
  if (!error && data === true) return true;
  console.error(JSON.stringify({
    code: "create_idempotency_terminal_failed",
    request_id: requestId,
  }));
  return false;
}

function logCreateMetric(
  requestId: string,
  stage: string,
  fields: Record<string, string | number | boolean>,
): void {
  console.info(JSON.stringify({
    metric: "investigation_run",
    request_id: requestId,
    stage,
    ...fields,
  }));
}

function createProviderInstrumentation(
  requestId: string,
): ProviderInstrumentation {
  return {
    onMetric(metric) {
      logCreateMetric(requestId, "provider_call", {
        provider: /^[A-Za-z0-9_.:-]{1,64}$/.test(metric.provider)
          ? metric.provider
          : "unknown",
        operation: /^[A-Za-z0-9_.:-]{1,64}$/.test(metric.operation)
          ? metric.operation
          : "unknown",
        provider_call_ms: metric.durationMs,
        semaphore_wait_ms: metric.semaphoreWaitMs ?? 0,
        retry_count: metric.retryCount ?? 0,
        outcome: metric.outcome,
      });
      if (metric.operation === "embedding") {
        logCreateMetric(requestId, "embedding_api", {
          embedding_api_ms: metric.durationMs,
          embedding_queue_ms: metric.semaphoreWaitMs ?? 0,
          embedding_item_count: metric.itemCount ?? 1,
          retry_count: metric.retryCount ?? 0,
          outcome: metric.outcome,
        });
      }
      if (metric.retryCount && metric.retryCount > 0) {
        logCreateMetric(requestId, "retry", {
          retry_layer: "gemini",
          retry_count: metric.retryCount,
        });
      }
    },
  };
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
    "x-request-id": requestId,
  });
}

async function handleCreateRequest(
  req: Request,
  requestId: string,
  requestSignal: AbortSignal,
): Promise<Response> {
  throwIfAborted(requestSignal);
  const options = handleOptions(req);
  if (options) return options;

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.userId) {
    return jsonWithRequestId({ error: "認証が必要です" }, 401, req, requestId);
  }

  const boundedBody = await readRequestBodyLimited(req, MAX_CREATE_BODY_BYTES, {
    signal: requestSignal,
  });
  if (boundedBody.timedOut) {
    return jsonWithRequestId(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
      requestId,
    );
  }
  if (boundedBody.tooLarge) {
    return jsonWithRequestId(
      { error: "リクエストが大きすぎます" },
      413,
      req,
      requestId,
    );
  }
  if (boundedBody.readError) {
    return jsonWithRequestId(
      { error: "リクエストが不正です" },
      400,
      req,
      requestId,
    );
  }
  let parsedBody: unknown = null;
  let malformedJson = false;
  if (boundedBody.text.trim()) {
    try {
      parsedBody = JSON.parse(boundedBody.text) as unknown;
    } catch {
      malformedJson = true;
    }
  }
  if (malformedJson) {
    return jsonWithRequestId(
      { error: "リクエストが不正です" },
      400,
      req,
      requestId,
    );
  }
  const bodyResult = createInvestigationBodySchema.safeParse(parsedBody);
  if (!bodyResult.success) {
    return jsonWithRequestId(
      { error: "リクエストが不正です" },
      400,
      req,
      requestId,
    );
  }
  const { query, displayName } = bodyResult.data;
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonWithRequestId(
      { error: "Idempotency-Key が必要です" },
      400,
      req,
      requestId,
    );
  }
  const requestDigest = await digestCreateRequest(query, displayName);

  // Claim は rate-limit / cost reservation / provider 呼び出しより先に行う。
  // timeout後の再送が同じキーなら、同一 investigation の応答へ収束する。
  const { data: claimData, error: claimError } = await db.rpc(
    "claim_investigation_creation",
    {
      p_user_id: auth.userId,
      p_idempotency_key: idempotencyKey,
      p_request_digest: requestDigest,
    },
  );
  const claim = firstClaimRow(claimData);
  if (claimError || !claim) {
    console.error(JSON.stringify({
      code: "create_idempotency_claim_failed",
      request_id: requestId,
    }));
    return jsonWithRequestId(
      { error: "調査を開始できません" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }
  if (claim.claim_status === "mismatch") {
    return jsonWithRequestId(
      { error: "同じIdempotency-Keyに別の入力は指定できません" },
      409,
      req,
      requestId,
    );
  }
  if (claim.claim_status === "in_flight") {
    return jsonWithRequestId(
      { error: "調査の作成が進行中です" },
      409,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }
  if (
    claim.claim_status === "complete" &&
    claim.investigation_id &&
    claim.share_token
  ) {
    return jsonWithRequestId(
      {
        investigationId: claim.investigation_id,
        shareToken: claim.share_token,
      },
      200,
      req,
      requestId,
    );
  }
  // completed_at があるのに ID/token が欠ける状態は migration の制約違反だが、
  // 防御的に「不完全な行」を200 replayしない。
  if (claim.claim_status === "complete") {
    return jsonWithRequestId(
      { error: "調査の作成状態を確認できません" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }
  if (claim.claim_status === "failed") {
    const parseFailure = claim.failure_code?.startsWith("parse_") ?? false;
    return jsonWithRequestId(
      {
        error: parseFailure
          ? "条件の解析に失敗しました"
          : "調査の作成を確定できませんでした",
      },
      parseFailure ? 422 : 503,
      req,
      requestId,
    );
  }
  if (claim.lease_generation === null || claim.lease_token === null) {
    return jsonWithRequestId(
      { error: "調査の作成leaseを確認できません" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }
  const leaseGeneration = claim.lease_generation;
  const leaseToken = claim.lease_token;
  // reclaimed は hard-kill 後の同じ台帳行を再開する状態。investigation_id が
  // 既にあれば、以降の失敗で台帳を release して別行を作らせてはならない。

  const freshClaim = claim.claim_status === "claimed";
  if (freshClaim) {
    const rateLimit = await checkRateLimit(
      db,
      req,
      "create",
      auth.userId,
      auth.isServiceRole,
    );
    if (!rateLimit.allowed) {
      const limited = rateLimit.kind === "limited";
      await releaseCreationClaim(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        requestId,
      );
      return jsonWithRequestId(
        {
          error: limited
            ? "しばらく待ってからもう一度お試しください"
            : "ただいま調査を開始できません",
        },
        limited ? 429 : 503,
        req,
        requestId,
        { "Retry-After": String(rateLimit.retryAfter) },
      );
    }
  }

  // Re-run the creation-aware guard even when a usage already exists. The DB
  // wrapper reuses the same reservation and rechecks status/provider/action and
  // the live kill switch; it never trusts a stale claim snapshot.
  const costGuard = await checkCostGuard(
    db,
    "create",
    claim.investigation_id,
    auth.isServiceRole,
    undefined,
    undefined,
    undefined,
    {
      userId: auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
    },
  );
  if (!costGuard.allowed) {
    if (freshClaim) {
      await releaseCreationClaim(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        requestId,
      );
    } else {
      await markCreationRetryable(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        requestId,
      );
    }
    return jsonWithRequestId(
      { error: "ただいま調査を開始できません。時間をおいてお試しください" },
      503,
      req,
      requestId,
      { "Retry-After": String(costGuard.retryAfter) },
    );
  }

  const touched = await touchCreationClaim(
    db,
    auth.userId,
    idempotencyKey,
    requestDigest,
    leaseGeneration,
    leaseToken,
    costGuard.usageId,
    requestId,
  );
  if (!touched) {
    return jsonWithRequestId(
      { error: "調査の作成を再開できません" },
      409,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }

  const { error: profileError } = await db.from("profiles").upsert({
    id: auth.userId,
    display_name: displayName,
  });
  if (profileError) {
    if (freshClaim) {
      await releaseCreationClaim(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        requestId,
      );
    } else {
      await markCreationRetryable(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        requestId,
      );
    }
    return jsonWithRequestId(
      { error: "プロフィールを保存できません" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }

  const { ai } = getProviders(createProviderInstrumentation(requestId));
  let checkpoint = claim.parse_completed_at
    ? readParseCheckpoint(claim.parse_checkpoint)
    : null;
  if (claim.parse_completed_at && !checkpoint) {
    await failCreationClaim(
      db,
      auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
      claim.investigation_id,
      costGuard.usageId,
      "invalid_checkpoint",
      requestId,
    );
    return jsonWithRequestId(
      { error: "調査の作成状態を確認できません" },
      503,
      req,
      requestId,
    );
  }

  if (!checkpoint) {
    const step = await beginCreationStep(
      db,
      auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
      "parse",
      requestId,
    );
    if (step !== "started") {
      return jsonWithRequestId(
        { error: "条件の解析状態を確認中です" },
        409,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }

    const parseStarted = Date.now();
    let raw: unknown;
    try {
      raw = await withAbortTimeout(
        (signal) => ai.parseRequirements(query, signal),
        CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS,
        requestSignal,
      );
    } catch {
      throwIfAborted(requestSignal);
      logCreateMetric(requestId, "create_parse", {
        create_parse_ms: Date.now() - parseStarted,
        retry_count: 0,
        outcome: "error",
      });
      await failCreationClaim(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        null,
        costGuard.usageId,
        "parse_provider_error",
        requestId,
      );
      return jsonWithRequestId(
        { error: "条件の解析に失敗しました" },
        422,
        req,
        requestId,
      );
    }
    const checked = validateAndDedupeParsedRequirements(raw);
    logCreateMetric(requestId, "create_parse", {
      create_parse_ms: Date.now() - parseStarted,
      retry_count: 0,
      outcome: checked.success ? "ok" : "error",
    });
    if (!checked.success) {
      await failCreationClaim(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        null,
        costGuard.usageId,
        "parse_schema_invalid",
        requestId,
      );
      return jsonWithRequestId(
        { error: "条件の解析に失敗しました" },
        422,
        req,
        requestId,
      );
    }

    let parsed = checked.data;
    const fallback = resolveLocationScope(query);
    if (
      fallback.status === "resolved" &&
      fallback.source === "query" &&
      (!parsed.locationScope ||
        (fallback.scope.type === "point" &&
          queryHasExplicitLocationMarker(query)))
    ) {
      // UIの `場所:` marker は単一点を意味する。条件連結後の `/` を
      // AIが沿線・駅間scopeへ誤分類しても、明示された一点を優先する。
      parsed = { ...parsed, locationScope: fallback.scope };
    }
    const title = parsed.title.trim() || query.slice(0, 20);
    parsed = { ...parsed, title };
    const budgetRequirement = parsed.requirements.find((requirement) =>
      requirement.kind === "budget"
    );
    const budget = budgetRequirement
      ? attestedBudgetConstraint({
        kind: "budget",
        text: budgetRequirement.text,
        normalizedText: budgetRequirement.normalizedText,
        rawQuery: query,
      })
      : null;
    const persisted: PersistedParseCheckpoint = {
      ...parsed,
      locationScope: parsed.locationScope ?? null,
      budgetMax: budget?.maxYen ?? null,
    };
    if (
      !await saveParseCheckpoint(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        persisted,
        requestId,
      )
    ) {
      return jsonWithRequestId(
        { error: "条件の解析結果を確定できません" },
        409,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
    checkpoint = { parsed, budgetMax: persisted.budgetMax };
  }

  const parsed = checkpoint.parsed;
  const inv = await createInvestigationForClaim(
    db,
    auth.userId,
    idempotencyKey,
    requestDigest,
    leaseGeneration,
    leaseToken,
    parsed.title,
    query,
    parsed.normalizedQuery,
    requestId,
  );
  if (!inv) {
    await markCreationRetryable(
      db,
      auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
      requestId,
    );
    return jsonWithRequestId(
      { error: "調査の作成に失敗しました" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }

  let queryEmbedding = claim.embedding_checkpoint;
  if (!claim.embedding_completed_at) {
    const step = await beginCreationStep(
      db,
      auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
      "embedding",
      requestId,
    );
    if (step !== "started") {
      return jsonWithRequestId(
        { error: "embedding作成状態を確認中です" },
        409,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
    const embeddingStarted = Date.now();
    let embeddingOutcome = "ok";
    queryEmbedding = null;
    try {
      const [embedding] = await withAbortTimeout(
        (signal) => ai.embed([parsed.normalizedQuery], signal),
        CREATE_EMBEDDING_TIMEOUT_MS,
        requestSignal,
      );
      const checked = validateEmbedding(embedding);
      if (checked.ok) queryEmbedding = checked.value;
      else embeddingOutcome = "invalid";
    } catch {
      throwIfAborted(requestSignal);
      embeddingOutcome = "error";
    }
    logCreateMetric(requestId, "create_embedding", {
      create_embedding_ms: Date.now() - embeddingStarted,
      embedding_calls: 1,
      embedding_items: 1,
      outcome: embeddingOutcome,
    });
    if (
      !await saveEmbeddingCheckpoint(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        queryEmbedding,
        requestId,
      )
    ) {
      return jsonWithRequestId(
        { error: "embedding結果を確定できません" },
        409,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
  }

  // Recheck the fenced usage and live control immediately before the atomic
  // seven-responsibility finalization.
  if (
    !await touchCreationClaim(
      db,
      auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
      costGuard.usageId,
      requestId,
    )
  ) {
    await markCreationRetryable(
      db,
      auth.userId,
      idempotencyKey,
      requestDigest,
      leaseGeneration,
      leaseToken,
      requestId,
    );
    return jsonWithRequestId(
      { error: "調査の作成を確定できませんでした" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }
  const completed = await completeCreationClaim(
    db,
    auth.userId,
    idempotencyKey,
    requestDigest,
    leaseGeneration,
    leaseToken,
    inv.id,
    costGuard.usageId,
    requestId,
  );
  if (completed !== "complete") {
    if (completed === "unavailable") {
      await markCreationRetryable(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        requestId,
      );
    } else {
      await failCreationClaim(
        db,
        auth.userId,
        idempotencyKey,
        requestDigest,
        leaseGeneration,
        leaseToken,
        inv.id,
        costGuard.usageId,
        "finalization_rejected",
        requestId,
      );
    }
    return jsonWithRequestId(
      { error: "調査の作成を確定できませんでした" },
      503,
      req,
      requestId,
      { "Retry-After": "1" },
    );
  }

  return jsonWithRequestId(
    { investigationId: inv.id, shareToken: inv.shareToken },
    200,
    req,
    requestId,
  );
}

Deno.serve(async (req) => {
  const requestId = safeRequestId(req.headers.get("x-request-id"));
  try {
    return await withAbortTimeout(
      (signal) => handleCreateRequest(req, requestId, signal),
      EDGE_TIMEOUT_POLICY.synchronousCreate,
      req.signal,
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      return jsonWithRequestId(
        { error: "調査の作成がタイムアウトしました" },
        504,
        req,
        requestId,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }
});
