// rerank-investigation (spec.md §25.3 / contracts/rerank-investigation.md)
// クライアントから明示的に呼ぶ。DB Webhook や trigger は使わない。
// 冪等: 全候補の score/rank を毎回計算し直すため、同時に複数回呼ばれても最終状態は同じ。
import {
  authenticate,
  createServiceClient,
  handleOptions,
  isMember,
  json,
  logEvent,
} from "../_shared/db.ts";
import { rerankInvestigationBodySchema } from "../_shared/validation.ts";
import {
  investigateAndPersist,
  loadCandidates,
  loadRequirements,
  rankInvestigation,
} from "../_shared/pipeline.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";
import { checkCostGuard } from "../_shared/cost_guard.ts";
import { throwIfDatabaseError } from "../_shared/database_error.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";
import { policyForTier } from "../_shared/research_policy.ts";
import { limitResearchProviderCalls } from "../_shared/providers/index.ts";
import {
  type PersistedRerankPolicyRow,
  policyFromAcceptedRun,
} from "../_shared/rerank_policy.ts";
import {
  EDGE_TIMEOUT_POLICY,
  OperationTimeoutError,
  throwIfAborted,
  withAbortTimeout,
} from "../_shared/timeout_policy.ts";

const MAX_RERANK_BODY_BYTES = 16 * 1024;

async function handleRerankRequest(
  req: Request,
  requestSignal: AbortSignal,
): Promise<Response> {
  throwIfAborted(requestSignal);
  const options = handleOptions(req);
  if (options) return options;

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.userId && !auth.isServiceRole) {
    return json({ error: "認証が必要です" }, 401, req);
  }

  const boundedBody = await readRequestBodyLimited(req, MAX_RERANK_BODY_BYTES, {
    signal: requestSignal,
  });
  if (boundedBody.timedOut) {
    return json(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
    );
  }
  if (boundedBody.tooLarge) {
    return json({ error: "リクエストが大きすぎます" }, 413, req);
  }
  if (boundedBody.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
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
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const bodyResult = rerankInvestigationBodySchema.safeParse(parsedBody);
  if (!bodyResult.success) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const { investigationId: invId, trigger } = bodyResult.data;

  const { data: inv, error: investigationError } = await db.from(
    "investigations",
  ).select("id, status").eq(
    "id",
    invId,
  ).maybeSingle();
  if (investigationError) {
    return json(
      { error: "調査情報を確認できませんでした" },
      503,
      req,
      { "Retry-After": "1" },
    );
  }
  if (!inv) return json({ error: "調査が見つかりません" }, 404, req);
  if (auth.userId) {
    let member: boolean;
    try {
      member = await isMember(db, invId, auth.userId);
    } catch (error) {
      if (requestSignal.aborted) throw error;
      return json(
        { error: "参加状態を確認できませんでした" },
        503,
        req,
        { "Retry-After": "1" },
      );
    }
    if (!member) {
      return json({ error: "この調査のメンバーではありません" }, 401, req);
    }
  }
  // run 実行中は rerank しない (contracts/rerank-investigation.md)
  if (inv.status !== "complete" && inv.status !== "failed") {
    return json(
      { error: `調査の実行中は再ランキングできません (status=${inv.status})` },
      409,
      req,
    );
  }

  // Rerank is a second entry point into provider work. Reuse the policy pinned
  // at run acceptance, including failed investigations; do not resolve current
  // entitlement or read client/runtime limits here. Legacy complete rows may
  // predate the durable run snapshot and are constrained to Free, while a
  // failed row without a valid snapshot is rejected fail-closed.
  const { data: persistedPolicyRow, error: policyError } = await db
    .from("investigation_runs")
    .select("budget_profile, entitlement_tier, acceptance_state")
    .eq("investigation_id", invId)
    .eq("acceptance_state", "accepted")
    .in("status", ["complete", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (policyError) {
    return json({ error: "調査ポリシーを確認できません" }, 503, req, {
      "Retry-After": "60",
    });
  }
  const persistedPolicy = policyFromAcceptedRun(
    (persistedPolicyRow as PersistedRerankPolicyRow | null) ?? null,
  );
  if (inv.status === "failed" && !persistedPolicy) {
    return json({ error: "調査ポリシーを確認できません" }, 503, req, {
      "Retry-After": "60",
    });
  }
  const policy = persistedPolicy ?? policyForTier("free");

  const rateLimit = await checkRateLimit(
    db,
    req,
    "rerank",
    auth.userId,
    auth.isServiceRole,
  );
  if (!rateLimit.allowed) {
    const limited = rateLimit.kind === "limited";
    return json(
      {
        error: limited
          ? "しばらく待ってからもう一度お試しください"
          : "ただいま再ランキングできません",
      },
      limited ? 429 : 503,
      req,
      { "Retry-After": String(rateLimit.retryAfter) },
    );
  }

  const costGuard = await checkCostGuard(
    db,
    "rerank",
    invId,
    auth.isServiceRole,
    // vote/requirement_removed only recalculate persisted scores and make no
    // provider call. Reserve budget only for the requirement_added branch.
    trigger === "requirement_added" ? policy.estimatedCostMicros : 0,
  );
  if (!costGuard.allowed) {
    return json(
      { error: "ただいま再ランキングできません。時間をおいてお試しください" },
      503,
      req,
      { "Retry-After": String(costGuard.retryAfter) },
    );
  }

  const timeoutMs = trigger === "requirement_added"
    ? EDGE_TIMEOUT_POLICY.synchronousRerank
    : EDGE_TIMEOUT_POLICY.receipt;
  try {
    await withAbortTimeout(
      async (signal) => {
        // trigger 別処理 (§25.3 の表)
        // - vote:                AI 再実行しない。score 再計算のみ
        // - requirement_added:   評価が存在しない (candidate × requirement) のみ investigateCandidate を再実行
        // - requirement_removed: AI 再実行しない。削除済み requirement の評価は FK cascade で消えており再計算のみ
        if (trigger === "requirement_added") {
          const requirements = await loadRequirements(db, invId);
          throwIfAborted(signal);
          const candidates = await loadCandidates(db, invId);
          throwIfAborted(signal);
          const boundedCandidates = limitResearchProviderCalls(
            candidates,
            policy,
          );
          await Promise.all(boundedCandidates.map(async (c) => {
            throwIfAborted(signal);
            const { data: evaluated, error } = await db
              .from("requirement_evaluations")
              .select("requirement_id")
              .eq("investigation_id", invId)
              .eq("candidate_id", c.id);
            throwIfDatabaseError(
              error,
              "requirement_evaluations.rerank_select",
            );
            throwIfAborted(signal);
            const evaluatedIds = new Set(
              (evaluated ?? []).map((e) => e.requirement_id),
            );
            const missing = requirements.filter((r) => !evaluatedIds.has(r.id));
            if (missing.length === 0) return;
            await investigateAndPersist(db, invId, c, missing, {
              updateSummary: false,
              signal,
            });
          }));
        }

        throwIfAborted(signal);
        await rankInvestigation(db, invId, policy.finalCandidateLimit);
        throwIfAborted(signal);
        await logEvent(db, invId, "reranked", "ランキングを再計算しました", {
          trigger,
        });
      },
      timeoutMs,
      requestSignal,
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      return json(
        { error: "再ランキングがタイムアウトしました" },
        504,
        req,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }

  return json({ reranked: true }, 200, req);
}

Deno.serve(async (req) => {
  try {
    return await withAbortTimeout(
      (signal) => handleRerankRequest(req, signal),
      EDGE_TIMEOUT_POLICY.synchronousRerank,
      req.signal,
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      return json(
        { error: "再ランキングがタイムアウトしました" },
        504,
        req,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }
});
