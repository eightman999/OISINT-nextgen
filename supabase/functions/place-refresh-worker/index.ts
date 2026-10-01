// place_facts 需要駆動 refresh worker (#123)
//
// この関数は「何をいつ更新するか」の境界だけを担当する。対象の claim/candidate
// 生成、crawler/frontier、embedding の実行、cron 登録は行わない。対象の claim は
// DB の select_refresh_targets RPC が per-place lease 付きで決め、provider 取得は
// 既存 PlaceSearchProvider.fetchByIds だけを通る。
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { refreshPlaceFacts } from "../_shared/facts.ts";
import { EVIDENCE_EXCERPT_LIMIT } from "../_shared/evidence_content.ts";
import { throwIfDatabaseError } from "../_shared/database_error.ts";
import {
  addObservationMetric,
  type DemandRefreshMetrics,
  emptyDemandRefreshMetrics,
  factSourceVersionChanged,
  isValidRefreshResultBatch,
  refreshObservationKey,
  resolveRefreshObservation,
} from "../_shared/demand_refresh.ts";
import {
  filterValidClaims,
  type StructuredClaimInput,
} from "../_shared/validation.ts";
import type {
  PlaceSearchResult,
  ProviderMeta,
} from "../_shared/providers/types.ts";
import { getProviders } from "../_shared/providers/index.ts";
import { freshnessScore, sourceQuality } from "../_shared/source_quality.ts";
import { parsePublicHttpUrl } from "../_shared/public_url.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";

const MAX_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UnknownRecord = Record<string, unknown>;

export const placeRefreshWorkerBodySchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_RE),
}).strict();

interface RefreshRun {
  runId: string;
  status: string;
  provider: string;
  providerDomain: string;
  configVersion: string;
  batchSize: number;
  leaseExpiresAt: string;
}

interface BeginRunResult {
  status: string;
  run: RefreshRun | null;
  retryAfterSeconds: number | null;
}

interface RefreshTarget {
  placeId: string;
  provider: string;
  providerPlaceId: string;
  sourceUrl: string | null;
  leaseToken: string;
  lastUsedAt: string;
  lastVerifiedAt: string;
  refreshedAt: string;
  factImportance: number;
  priorityScore: number;
  vectorSourceVersion: string | null;
}

type RefreshOutcome =
  | "unchanged"
  | "changed"
  | "provider_error"
  | "closure_suspected"
  | "storage_error";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value);
}

function asRun(value: unknown): RefreshRun | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.run_id !== "string" || !UUID_RE.test(value.run_id) ||
    typeof value.status !== "string" || typeof value.provider !== "string" ||
    typeof value.provider_domain !== "string" ||
    typeof value.config_version !== "string" ||
    typeof value.batch_size !== "number" ||
    !Number.isSafeInteger(value.batch_size) || value.batch_size < 1 ||
    typeof value.lease_expires_at !== "string"
  ) return null;
  return {
    runId: value.run_id,
    status: value.status,
    provider: value.provider,
    providerDomain: value.provider_domain,
    configVersion: value.config_version,
    batchSize: value.batch_size,
    leaseExpiresAt: value.lease_expires_at,
  };
}

function asTarget(value: unknown): RefreshTarget | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.place_id !== "string" || !UUID_RE.test(value.place_id) ||
    typeof value.provider !== "string" ||
    typeof value.provider_place_id !== "string" ||
    value.provider_place_id.length === 0 ||
    (typeof value.source_url !== "string" && value.source_url !== null) ||
    typeof value.lease_token !== "string" || !UUID_RE.test(value.lease_token) ||
    typeof value.last_used_at !== "string" ||
    typeof value.last_verified_at !== "string" ||
    typeof value.refreshed_at !== "string" ||
    typeof value.fact_importance !== "number" ||
    !Number.isFinite(value.fact_importance) || value.fact_importance < 0 ||
    value.fact_importance > 1 || typeof value.priority_score !== "number" ||
    !Number.isFinite(value.priority_score) ||
    (typeof value.vector_source_version !== "string" &&
      value.vector_source_version !== null)
  ) return null;
  return {
    placeId: value.place_id,
    provider: value.provider,
    providerPlaceId: value.provider_place_id,
    sourceUrl: value.source_url,
    leaseToken: value.lease_token,
    lastUsedAt: value.last_used_at,
    lastVerifiedAt: value.last_verified_at,
    refreshedAt: value.refreshed_at,
    factImportance: value.fact_importance,
    priorityScore: value.priority_score,
    vectorSourceVersion: value.vector_source_version,
  };
}

async function readWorkerRequest(req: Request): Promise<string | null> {
  const bounded = await readRequestBodyLimited(req, MAX_BODY_BYTES);
  if (bounded.tooLarge || bounded.readError || !bounded.text.trim()) {
    return null;
  }
  try {
    const body = JSON.parse(bounded.text) as unknown;
    const parsed = placeRefreshWorkerBodySchema.safeParse(body);
    return parsed.success ? parsed.data.idempotencyKey : null;
  } catch {
    return null;
  }
}

function safeObservationTime(
  raw: string | undefined,
  fallback: string,
): string {
  if (raw === undefined) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function publicProviderUrl(raw: string): string | null {
  const value = raw.trim();
  return parsePublicHttpUrl(value) ? value : null;
}

function metricLabel(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "unknown";
}

function logRefreshMetric(
  stage: string,
  fields: Record<string, string | number | boolean>,
): void {
  // provider本文、URL、例外本文、idempotency key は出力しない。
  console.info(JSON.stringify({ metric: "place_refresh", stage, ...fields }));
}

function errorCodeFor(error: unknown): string {
  // 外部例外の本文をログ/DBへ流さず、固定分類だけを永続化する。
  return error instanceof Error && error.name === "DemandRefreshConfigError"
    ? "config_unavailable"
    : "storage_error";
}

async function beginRun(
  db: SupabaseClient,
  idempotencyKey: string,
): Promise<BeginRunResult> {
  const { data, error } = await db.rpc("begin_place_refresh_run", {
    p_idempotency_key: idempotencyKey,
  });
  throwIfDatabaseError(error, "begin_place_refresh_run");
  const row = Array.isArray(data) ? data[0] : data;
  if (isRecord(row) && row.status === "rate_limited") {
    const retryAfterSeconds = row.retry_after_seconds;
    if (
      retryAfterSeconds !== null &&
      (typeof retryAfterSeconds !== "number" ||
        !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0)
    ) throw new Error("invalid refresh rate response");
    return {
      status: "rate_limited",
      run: null,
      retryAfterSeconds,
    };
  }
  const run = asRun(row);
  if (!run) throw new Error("invalid refresh run response");
  const retryAfterSeconds = row && isRecord(row)
    ? row.retry_after_seconds
    : null;
  if (
    retryAfterSeconds !== null &&
    (typeof retryAfterSeconds !== "number" ||
      !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0)
  ) throw new Error("invalid refresh rate response");
  return { status: run.status, run, retryAfterSeconds };
}

async function selectTargets(
  db: SupabaseClient,
  run: RefreshRun,
): Promise<RefreshTarget[]> {
  const { data, error } = await db.rpc("select_refresh_targets", {
    p_limit: run.batchSize,
    p_run_id: run.runId,
  });
  throwIfDatabaseError(error, "select_refresh_targets");
  if (!Array.isArray(data)) throw new Error("invalid refresh target response");
  const targets = data.map(asTarget);
  if (targets.some((target) => target === null)) {
    throw new Error("invalid refresh target row");
  }
  return targets as RefreshTarget[];
}

async function recordProviderCall(
  db: SupabaseClient,
  runId: string,
  itemCount: number,
  durationMs: number,
  outcome: "ok" | "error",
): Promise<void> {
  const { data, error } = await db.rpc("record_place_refresh_provider_call", {
    p_run_id: runId,
    p_item_count: itemCount,
    p_duration_ms: Math.max(0, Math.round(durationMs)),
    p_outcome: outcome,
  });
  throwIfDatabaseError(error, "record_place_refresh_provider_call");
  if (data !== true) throw new Error("refresh provider metric lease lost");
}

async function finishRun(
  db: SupabaseClient,
  runId: string,
  status: "complete" | "partial" | "failed",
  selectedCount: number,
  errorCode: string | null = null,
): Promise<void> {
  const { data, error } = await db.rpc("finish_place_refresh_run", {
    p_run_id: runId,
    p_status: status,
    p_selected_count: selectedCount,
    p_skipped_count: 0,
    p_error_code: errorCode,
  });
  throwIfDatabaseError(error, "finish_place_refresh_run");
  if (data !== true) throw new Error("refresh run is no longer running");
}

async function recordTargetOutcome(
  db: SupabaseClient,
  runId: string,
  target: RefreshTarget,
  outcome: RefreshOutcome,
  observedAt: string,
  factChanged: boolean,
  evidenceAppended: boolean,
  errorCode: string | null,
): Promise<void> {
  const { data, error } = await db.rpc("record_place_refresh_target", {
    p_run_id: runId,
    p_place_id: target.placeId,
    p_lease_token: target.leaseToken,
    p_outcome: outcome,
    p_fact_changed: factChanged,
    p_observed_at: observedAt,
    p_error_code: errorCode,
    p_evidence_appended: evidenceAppended,
  });
  throwIfDatabaseError(error, "record_place_refresh_target");
  if (data !== true) throw new Error("refresh target lease lost");
}

async function upsertPlace(
  db: SupabaseClient,
  target: RefreshTarget,
  result: PlaceSearchResult,
  observedAt: string,
): Promise<void> {
  const { data, error } = await db
    .from("places")
    .update({
      name: result.name,
      address: result.address,
      lat: result.lat,
      lng: result.lng,
      metadata: result.metadata,
      refreshed_at: observedAt,
    })
    .eq("id", target.placeId)
    .eq("provider", target.provider)
    .eq("provider_place_id", target.providerPlaceId)
    .select("id")
    .maybeSingle();
  throwIfDatabaseError(error, "places.refresh_update");
  if (data?.id !== target.placeId) {
    throw new Error("refresh place identity mismatch");
  }
}

async function upsertProviderLink(
  db: SupabaseClient,
  target: RefreshTarget,
  result: PlaceSearchResult,
  meta: ProviderMeta,
  observedAt: string,
): Promise<string | null> {
  const { data: current, error: currentError } = await db
    .from("place_provider_links")
    .select("id, place_id, source_url")
    .eq("provider", target.provider)
    .eq("provider_place_id", target.providerPlaceId)
    .maybeSingle();
  throwIfDatabaseError(currentError, "place_provider_links.current");
  if (current && current.place_id !== target.placeId) {
    // provider identity の衝突時に既存 link を別 Place へ付け替えない。
    throw new Error("refresh provider identity conflict");
  }

  const resultUrl = publicProviderUrl(result.url);
  const sourceUrl = resultUrl ??
    (typeof current?.source_url === "string" ? current.source_url : null);
  const fetchedAtMs = Date.parse(observedAt);
  const expiresAt = meta.ttlHours !== null &&
      Number.isFinite(meta.ttlHours) && meta.ttlHours > 0
    ? new Date(fetchedAtMs + meta.ttlHours * 3_600_000).toISOString()
    : null;
  const mutableFields = {
    source_url: sourceUrl,
    storage_policy: meta.storagePolicy,
    expires_at: expiresAt,
    attribution_policy: meta.attributionPolicy,
    last_seen_at: observedAt,
  };
  if (current) {
    const { data, error } = await db
      .from("place_provider_links")
      .update(mutableFields)
      .eq("id", current.id)
      .eq("place_id", target.placeId)
      .select("id")
      .single();
    throwIfDatabaseError(error, "place_provider_links.refresh_update");
    return typeof data?.id === "string" ? data.id : null;
  }

  const { data, error } = await db
    .from("place_provider_links")
    .insert({
      place_id: target.placeId,
      provider: target.provider,
      provider_place_id: target.providerPlaceId,
      ...mutableFields,
    })
    .select("id")
    .single();
  throwIfDatabaseError(error, "place_provider_links.refresh_insert");
  return typeof data?.id === "string" ? data.id : null;
}

async function appendProviderEvidence(
  db: SupabaseClient,
  runId: string,
  target: RefreshTarget,
  result: PlaceSearchResult,
  providerLinkId: string | null,
  observedAt: string,
  claims: StructuredClaimInput[],
): Promise<boolean> {
  const sourceUrl = publicProviderUrl(result.url);
  if (!sourceUrl) return false;
  const excerpt =
    (claims.length > 0
      ? claims.map((claim) => claim.rawText).join("。")
      : `${result.name} の provider 観測`).slice(0, EVIDENCE_EXCERPT_LIMIT);
  const { data, error } = await db
    .from("evidence")
    .insert({
      place_id: target.placeId,
      scope: "shared",
      investigation_id: null,
      source_type: "major_place_provider",
      source_url: sourceUrl,
      source_title: `${result.name} - 店舗情報`,
      excerpt,
      structured_claims: claims,
      source_quality: sourceQuality("major_place_provider"),
      freshness_score: freshnessScore(new Date(observedAt)),
      observed_at: observedAt,
      embedding: null,
      provider_link_id: providerLinkId,
      refresh_observation_key: refreshObservationKey(
        runId,
        target.placeId,
        "provider",
      ),
    })
    .select("id")
    .maybeSingle();
  if (
    error && typeof error === "object" && error !== null &&
    "code" in error && error.code === "23505"
  ) {
    // 同じ run/place の再入は既存 observation を再利用し、二重 Evidence を作らない。
    return false;
  }
  throwIfDatabaseError(error, "evidence.refresh_insert");
  return typeof data?.id === "string";
}

async function appendClosureEvidence(
  db: SupabaseClient,
  runId: string,
  target: RefreshTarget,
  observedAt: string,
): Promise<boolean> {
  const sourceUrl = target.sourceUrl
    ? publicProviderUrl(target.sourceUrl)
    : null;
  if (!sourceUrl) return false;
  const { data, error } = await db
    .from("evidence")
    .insert({
      place_id: target.placeId,
      scope: "shared",
      investigation_id: null,
      // closure suspicion は canonical claim source と別型にし、facts/reuse の
      // trusted-provider boundary へ入れない。確定閉店とは記録しない。
      source_type: "provider_closure_observation",
      source_url: sourceUrl,
      source_title: "店舗掲載の継続確認",
      excerpt:
        "今回の provider 個別取得で店舗情報が返らなかったため、閉店または掲載終了の可能性を記録。確定情報ではない。",
      structured_claims: [],
      source_quality: null,
      freshness_score: null,
      observed_at: observedAt,
      embedding: null,
      refresh_observation_key: refreshObservationKey(
        runId,
        target.placeId,
        "closure",
      ),
    })
    .select("id")
    .maybeSingle();
  if (
    error && typeof error === "object" && error !== null &&
    "code" in error && error.code === "23505"
  ) return false;
  throwIfDatabaseError(error, "evidence.closure_insert");
  return typeof data?.id === "string";
}

async function readVectorSourceVersion(
  db: SupabaseClient,
  placeId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("places")
    .select("vector_source_version")
    .eq("id", placeId)
    .single();
  throwIfDatabaseError(error, "places.vector_version_select");
  if (data === null || data === undefined) {
    throw new Error("place vector version is missing");
  }
  return typeof data.vector_source_version === "string"
    ? data.vector_source_version
    : null;
}

async function processFoundTarget(
  db: SupabaseClient,
  runId: string,
  target: RefreshTarget,
  result: PlaceSearchResult,
  meta: ProviderMeta,
): Promise<{
  observedAt: string;
  factChanged: boolean;
  evidenceAppended: boolean;
  outcome: "unchanged" | "changed";
}> {
  const fallbackObservedAt = new Date().toISOString();
  const observedAt = safeObservationTime(result.fetchedAt, fallbackObservedAt);
  const claims = filterValidClaims([
    ...result.structuredClaims,
  ] as StructuredClaimInput[]);
  const beforeVersion = await readVectorSourceVersion(db, target.placeId);
  const providerLinkId = await upsertProviderLink(
    db,
    target,
    result,
    meta,
    observedAt,
  );
  const evidenceAppended = await appendProviderEvidence(
    db,
    runId,
    target,
    result,
    providerLinkId,
    observedAt,
    claims,
  );
  // Evidence が trusted provider 契約を満たしたときだけ既存の決定論集約を再利用。
  // embedding はここで実行せず、place_facts trigger の async job 契約へ委ねる。
  if (publicProviderUrl(result.url) && claims.length > 0) {
    await refreshPlaceFacts(db, target.placeId, {
      throwOnError: true,
      lastVerifiedAt: observedAt,
    });
  }
  // provider link / Evidence / facts の保存が成功してから鮮度を進める。
  // 途中の storage failure で places.refreshed_at だけが進み、再試行対象から
  // 消える状態を作らない。
  await upsertPlace(db, target, result, observedAt);
  const afterVersion = await readVectorSourceVersion(db, target.placeId);
  const factChanged = factSourceVersionChanged(beforeVersion, afterVersion);
  return {
    observedAt,
    factChanged,
    evidenceAppended,
    outcome: factChanged ? "changed" : "unchanged",
  };
}

async function processRun(
  db: SupabaseClient,
  run: RefreshRun,
): Promise<{ status: "complete" | "partial"; metrics: DemandRefreshMetrics }> {
  const { place } = getProviders();
  if (place.meta.id !== run.provider || !place.fetchByIds) {
    await finishRun(db, run.runId, "failed", 0, "provider_unavailable");
    throw new Error("configured provider adapter cannot fetch by id");
  }

  const targets = await selectTargets(db, run);
  let metrics = { ...emptyDemandRefreshMetrics(), selected: targets.length };
  logRefreshMetric("selected", {
    provider: metricLabel(run.provider),
    selected: targets.length,
    batch_size: run.batchSize,
  });
  if (targets.length === 0) {
    await finishRun(db, run.runId, "complete", 0);
    return { status: "complete", metrics };
  }

  const startedAt = performance.now();
  let results: unknown = [];
  let providerError: unknown = null;
  try {
    results = await place.fetchByIds(
      targets.map((target) => target.providerPlaceId),
    );
  } catch (error) {
    providerError = error;
  }
  const durationMs = Math.max(0, performance.now() - startedAt);
  metrics = {
    ...metrics,
    providerCalls: metrics.providerCalls + 1,
    providerItems: metrics.providerItems + targets.length,
    providerDurationMs: metrics.providerDurationMs + Math.round(durationMs),
  };
  await recordProviderCall(
    db,
    run.runId,
    targets.length,
    durationMs,
    providerError === null && isValidRefreshResultBatch(results)
      ? "ok"
      : "error",
  );
  logRefreshMetric("provider_fetch", {
    provider: metricLabel(run.provider),
    item_count: targets.length,
    duration_ms: Math.round(durationMs),
    outcome: providerError === null && isValidRefreshResultBatch(results)
      ? "ok"
      : "error",
  });

  if (providerError !== null) {
    for (const target of targets) {
      await recordTargetOutcome(
        db,
        run.runId,
        target,
        "provider_error",
        new Date().toISOString(),
        false,
        false,
        "provider_error",
      );
      metrics = addObservationMetric(metrics, "provider_error");
    }
  } else {
    for (const target of targets) {
      const resolution = resolveRefreshObservation(target, results, null);
      if (resolution.kind === "found" && resolution.result) {
        try {
          const processed = await processFoundTarget(
            db,
            run.runId,
            target,
            resolution.result,
            place.meta,
          );
          await recordTargetOutcome(
            db,
            run.runId,
            target,
            processed.outcome,
            processed.observedAt,
            processed.factChanged,
            processed.evidenceAppended,
            null,
          );
          metrics = addObservationMetric(
            metrics,
            processed.outcome,
            processed.evidenceAppended,
          );
        } catch (error) {
          await recordTargetOutcome(
            db,
            run.runId,
            target,
            "storage_error",
            new Date().toISOString(),
            false,
            false,
            errorCodeFor(error),
          );
          metrics = addObservationMetric(metrics, "storage_error");
        }
        continue;
      }

      if (resolution.kind === "closure_suspected") {
        try {
          const observedAt = new Date().toISOString();
          const evidenceAppended = await appendClosureEvidence(
            db,
            run.runId,
            target,
            observedAt,
          );
          await recordTargetOutcome(
            db,
            run.runId,
            target,
            "closure_suspected",
            observedAt,
            false,
            evidenceAppended,
            resolution.errorCode,
          );
          metrics = addObservationMetric(
            metrics,
            "closure_suspected",
            evidenceAppended,
          );
        } catch (error) {
          await recordTargetOutcome(
            db,
            run.runId,
            target,
            "storage_error",
            new Date().toISOString(),
            false,
            false,
            errorCodeFor(error),
          );
          metrics = addObservationMetric(metrics, "storage_error");
        }
        continue;
      }

      try {
        await recordTargetOutcome(
          db,
          run.runId,
          target,
          "provider_error",
          new Date().toISOString(),
          false,
          false,
          resolution.errorCode,
        );
        metrics = addObservationMetric(metrics, "provider_error");
      } catch (error) {
        await recordTargetOutcome(
          db,
          run.runId,
          target,
          "storage_error",
          new Date().toISOString(),
          false,
          false,
          errorCodeFor(error),
        );
        metrics = addObservationMetric(metrics, "storage_error");
      }
    }
  }

  const partial = metrics.providerErrors > 0 || metrics.closureSuspected > 0 ||
    metrics.storageErrors > 0;
  await finishRun(
    db,
    run.runId,
    partial ? "partial" : "complete",
    targets.length,
    partial ? "partial_outcome" : null,
  );
  logRefreshMetric("finished", {
    provider: metricLabel(run.provider),
    selected: metrics.selected,
    processed: metrics.processed,
    unchanged: metrics.unchanged,
    changed: metrics.changed,
    provider_errors: metrics.providerErrors,
    closure_suspected: metrics.closureSuspected,
    storage_errors: metrics.storageErrors,
    evidence_appended: metrics.evidenceAppended,
  });
  return { status: partial ? "partial" : "complete", metrics };
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "POST のみ受け付けます" }, 405, req);
  }

  let db: SupabaseClient | null = null;
  let activeRun: RefreshRun | null = null;
  try {
    db = createServiceClient();
    const auth = await authenticate(req, db);
    if (!auth.isServiceRole) {
      // この worker は owner 承認済み service-role 経路だけを受ける。
      return json({ error: "Not found" }, 404, req);
    }
    const idempotencyKey = await readWorkerRequest(req);
    if (!idempotencyKey) {
      return json({ error: "refresh job が不正です" }, 400, req);
    }

    const begun = await beginRun(db, idempotencyKey);
    if (begun.status === "rate_limited") {
      const headers: Record<string, string> = {};
      if (begun.retryAfterSeconds !== null) {
        headers["Retry-After"] = String(begun.retryAfterSeconds);
      }
      return json({ status: "rate_limited" }, 429, req, headers);
    }
    if (begun.status === "lease_expired") {
      return json({ status: "lease_expired" }, 409, req);
    }
    if (begun.status !== "running") {
      return json({ status: begun.status }, 200, req);
    }
    if (!begun.run) throw new Error("running refresh has no run");
    activeRun = begun.run;

    const result = await processRun(db, activeRun);
    return json(
      {
        status: result.status,
        selected: result.metrics.selected,
        processed: result.metrics.processed,
        unchanged: result.metrics.unchanged,
        changed: result.metrics.changed,
        providerErrors: result.metrics.providerErrors,
        closureSuspected: result.metrics.closureSuspected,
        storageErrors: result.metrics.storageErrors,
        evidenceAppended: result.metrics.evidenceAppended,
        providerCalls: result.metrics.providerCalls,
        providerItems: result.metrics.providerItems,
        providerDurationMs: result.metrics.providerDurationMs,
      },
      200,
      req,
    );
  } catch {
    if (db && activeRun) {
      try {
        await finishRun(db, activeRun.runId, "failed", 0, "worker_error");
      } catch {
        // run lease の失効/DB障害時は次の owner 操作へ委ねる。
      }
    }
    // provider/DB の本文や secret を返さず、次回の idempotent 実行に任せる。
    console.error("[place-refresh] worker_failed");
    return json({ error: "refresh worker を完了できませんでした" }, 503, req);
  }
});
