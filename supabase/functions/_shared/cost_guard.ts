import type { SupabaseClient } from "@supabase/supabase-js";

export type CostAction = "create" | "run" | "rerank";

export type CostGuardDecision =
  | { allowed: true; usageId: number | null }
  | {
    allowed: false;
    kind: "budget" | "kill_switch" | "unavailable";
    retryAfter: number;
  };

export type CreationCostClaim = {
  userId: string;
  idempotencyKey: string;
  requestDigest: string;
  leaseGeneration: number;
  leaseToken: string;
};

/**
 * Re-check only the live kill switch for an already accepted run.
 *
 * The acceptance RPC has already pinned the cost decision and, when needed,
 * created the idempotent provider_usage reservation. Re-running the normal
 * budget reservation here would let a mode/config change create a second
 * reservation or contradict a mock/disabled snapshot. This boundary is
 * deliberately read-only with respect to provider_usage.
 */
export async function checkAcceptedRunControl(
  db: SupabaseClient,
  env: EnvReader = defaultEnv,
): Promise<CostGuardDecision> {
  if (env("LIVE_KILL_SWITCH")?.toLowerCase() === "true") {
    console.error("[cost-guard] denied action=run reason=env-kill-switch");
    return { allowed: false, kind: "kill_switch", retryAfter: 300 };
  }
  if (
    env("DATA_PROVIDER_MODE") === "mock" ||
    env("LIVE_COST_GUARD_ENABLED")?.toLowerCase() === "false"
  ) {
    return { allowed: true, usageId: null };
  }
  try {
    const { data, error } = await db
      .from("runtime_controls")
      .select("enabled")
      .eq("key", "provider_live")
      .maybeSingle();
    if (error || !data || typeof data.enabled !== "boolean") {
      throw new Error("provider live control is unavailable");
    }
    if (!data.enabled) {
      console.error("[cost-guard] denied action=run reason=db-kill-switch");
      return { allowed: false, kind: "kill_switch", retryAfter: 300 };
    }
    return { allowed: true, usageId: null };
  } catch {
    return unavailableDecision("run");
  }
}

type EnvReader = (name: string) => string | undefined;

const DEFAULT_ESTIMATED_USD: Record<CostAction, string> = {
  create: "0.01",
  run: "0.05",
  rerank: "0.03",
};

function defaultEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

export function usdToMicros(
  value: string | undefined,
  fallback: string,
): number {
  const normalized = value && /^\d+(?:\.\d{1,6})?$/.test(value)
    ? value
    : fallback;
  const [whole, fraction = ""] = normalized.split(".");
  const micros = Number.parseInt(whole, 10) * 1_000_000 +
    Number.parseInt(fraction.padEnd(6, "0") || "0", 10);
  return Number.isSafeInteger(micros) && micros >= 0
    ? micros
    : usdToMicros(undefined, fallback);
}

export function readBudgetValues(action: CostAction, env: EnvReader) {
  return {
    estimatedMicros: usdToMicros(
      env(`LIVE_ESTIMATED_${action.toUpperCase()}_COST_USD`),
      DEFAULT_ESTIMATED_USD[action],
    ),
    dailyLimitMicros: usdToMicros(env("LIVE_DAILY_BUDGET_USD"), "5.00"),
    monthlyLimitMicros: usdToMicros(env("LIVE_MONTHLY_BUDGET_USD"), "50.00"),
  };
}

function providerFor(action: CostAction): string {
  if (action === "create") return "gemini";
  if (action === "run") return "gemini+serper+geoapify";
  return "gemini+serper";
}

function unavailableDecision(action: CostAction): CostGuardDecision {
  console.error(`[cost-guard] unavailable action=${action}`);
  return { allowed: false, kind: "unavailable", retryAfter: 60 };
}

export async function checkCostGuard(
  db: SupabaseClient,
  action: CostAction,
  investigationId: string | null,
  isServiceRole: boolean,
  estimatedMicrosOverride?: number,
  env: EnvReader = defaultEnv,
  investigationRunId?: string,
  creationClaim?: CreationCostClaim,
): Promise<CostGuardDecision> {
  const mode = env("DATA_PROVIDER_MODE") === "mock" ? "mock" : "live";
  const guardDisabled =
    env("LIVE_COST_GUARD_ENABLED")?.toLowerCase() === "false";
  if (mode === "live" && env("LIVE_KILL_SWITCH")?.toLowerCase() === "true") {
    console.error(
      `[cost-guard] denied action=${action} reason=env-kill-switch`,
    );
    return { allowed: false, kind: "kill_switch", retryAfter: 300 };
  }
  if (guardDisabled && !creationClaim) {
    console.warn(`[cost-guard] disabled action=${action}`);
    return { allowed: true, usageId: null };
  }

  // 自己再実行は同じ調査の予算を二重予約しない。ただし service role は
  // live provider の緊急停止を迂回できてはならないため、DB control だけは
  // provider 呼び出し前に毎回 fail-closed で確認する。
  if (isServiceRole && !creationClaim) {
    if (mode === "mock") return { allowed: true, usageId: null };
    try {
      const { data, error } = await db
        .from("runtime_controls")
        .select("enabled")
        .eq("key", "provider_live")
        .maybeSingle();
      if (error || !data || typeof data.enabled !== "boolean") {
        throw new Error("provider live control is unavailable");
      }
      if (!data.enabled) {
        console.error(
          `[cost-guard] denied action=${action} reason=db-kill-switch`,
        );
        return { allowed: false, kind: "kill_switch", retryAfter: 300 };
      }
      return { allowed: true, usageId: null };
    } catch {
      return unavailableDecision(action);
    }
  }

  const values = readBudgetValues(action, env);
  try {
    const reservationArgs = {
      p_action: action,
      p_investigation_id: investigationId,
      p_provider: providerFor(action),
      p_model: env("AI_MODEL") ?? "gemini-3.6-flash",
      p_mode: mode,
      p_estimated_cost_microusd: mode === "mock"
        ? 0
        : estimatedMicrosOverride ?? values.estimatedMicros,
      p_daily_limit_microusd: values.dailyLimitMicros,
      p_monthly_limit_microusd: values.monthlyLimitMicros,
      // A creation claim always records a durable zero/non-zero reservation.
      // Disabling budget enforcement must not disable its attempt ledger.
      p_enforce: mode === "live" && !guardDisabled,
      ...(investigationRunId ? { p_run_id: investigationRunId } : {}),
    };
    // run は受付の重複要求が同じ durable run へ収束するため、run_id を
    // idempotency key とする専用RPCを使う。create は claim と同一transactionで
    // 予約する専用RPC、rerank は従来RPCを使う。
    const reservationRpc = investigationRunId
      ? "reserve_provider_budget_for_run"
      : creationClaim
      ? "reserve_provider_budget_for_creation"
      : "reserve_provider_budget";
    const reservationRpcArgs = investigationRunId
      ? reservationArgs
      : creationClaim
      ? {
        ...reservationArgs,
        p_user_id: creationClaim.userId,
        p_idempotency_key: creationClaim.idempotencyKey,
        p_request_digest: creationClaim.requestDigest,
        p_lease_generation: creationClaim.leaseGeneration,
        p_lease_token: creationClaim.leaseToken,
      }
      : {
        p_action: action,
        p_investigation_id: investigationId,
        p_provider: providerFor(action),
        p_model: env("AI_MODEL") ?? "gemini-3.6-flash",
        p_mode: mode,
        p_estimated_cost_microusd: mode === "mock"
          ? 0
          : estimatedMicrosOverride ?? values.estimatedMicros,
        p_daily_limit_microusd: values.dailyLimitMicros,
        p_monthly_limit_microusd: values.monthlyLimitMicros,
        p_enforce: mode === "live",
      };
    const { data, error } = await db.rpc(reservationRpc, reservationRpcArgs);
    if (error) throw new Error("provider budget RPC failed");
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.is_allowed !== "boolean") {
      throw new Error("provider budget RPC returned an invalid shape");
    }

    const alerts = Array.isArray(row.new_alerts) ? row.new_alerts : [];
    for (const alert of alerts) {
      const numeric = Number(alert);
      const period = numeric < 0 ? "monthly" : "daily";
      console.warn(
        `[budget-alert] period=${period} threshold=${Math.abs(numeric)}`,
      );
    }
    if (row.is_allowed) {
      const usageId = Number(row.usage_id);
      if (
        creationClaim &&
        (!Number.isSafeInteger(usageId) || usageId <= 0)
      ) {
        throw new Error("creation budget RPC returned no durable usage");
      }
      return {
        allowed: true,
        usageId: Number.isSafeInteger(usageId) && usageId > 0 ? usageId : null,
      };
    }

    const reason = row.stop_reason === "kill_switch" ? "kill_switch" : "budget";
    console.error(
      `[cost-guard] denied action=${action} reason=${
        row.stop_reason ?? "unknown"
      }`,
    );
    return {
      allowed: false,
      kind: reason,
      retryAfter: reason === "budget" ? 3600 : 300,
    };
  } catch {
    if (mode === "mock" && !creationClaim) {
      console.warn(`[cost-guard] mock fail-open action=${action}`);
      return { allowed: true, usageId: null };
    }
    return unavailableDecision(action);
  }
}

export async function linkUsageToInvestigation(
  db: SupabaseClient,
  usageId: number | null,
  investigationId: string,
): Promise<void> {
  if (usageId === null) return;
  const { error } = await db
    .from("provider_usage")
    .update({ investigation_id: investigationId })
    .eq("id", usageId)
    .is("investigation_id", null);
  if (error) console.warn("[cost-guard] usage link failed");
}
