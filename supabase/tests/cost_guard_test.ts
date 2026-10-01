import { assertEquals, assertNotEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkAcceptedRunControl,
  checkCostGuard,
  readBudgetValues,
  usdToMicros,
} from "../functions/_shared/cost_guard.ts";
import {
  PLUS_BROAD_LIMIT_ENV,
  PLUS_PRE_RANK_LIMIT_ENV,
  PLUS_PROVIDER_CALL_LIMIT_ENV,
  PLUS_RESEARCH_COST_ENV,
  PLUS_RESEARCH_LIMIT_ENV,
  policyForEntitlement,
} from "../functions/_shared/research_policy.ts";

function env(values: Record<string, string> = {}) {
  return (name: string) => values[name];
}

function fakeDb(result: unknown, calls: unknown[] = []): SupabaseClient {
  return {
    rpc: (_name: string, args: unknown) => {
      calls.push(args);
      return Promise.resolve({ data: result, error: null });
    },
  } as unknown as SupabaseClient;
}

function fakeServiceDb(
  result: { data: { enabled: boolean } | null; error: unknown },
  calls: string[] = [],
): SupabaseClient {
  return {
    from: (table: string) => {
      calls.push(`from:${table}`);
      return {
        select: (columns: string) => {
          calls.push(`select:${columns}`);
          return {
            eq: (column: string, value: string) => {
              calls.push(`eq:${column}:${value}`);
              return { maybeSingle: () => Promise.resolve(result) };
            },
          };
        },
      };
    },
    rpc: () => {
      calls.push("rpc");
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

Deno.test("cost config: USDを浮動小数誤差なしでmicroUSDへ変換する", () => {
  assertEquals(usdToMicros("0.01", "1"), 10_000);
  assertEquals(usdToMicros("5.123456", "1"), 5_123_456);
  assertEquals(readBudgetValues("run", env()), {
    estimatedMicros: 50_000,
    dailyLimitMicros: 5_000_000,
    monthlyLimitMicros: 50_000_000,
  });
});

Deno.test("cost guard: live予約は台帳RPCへ調査IDと概算値だけを渡す", async () => {
  const calls: unknown[] = [];
  const decision = await checkCostGuard(
    fakeDb([{
      is_allowed: true,
      stop_reason: null,
      usage_id: 42,
      new_alerts: [50, -50],
    }], calls),
    "run",
    "11111111-1111-4111-8111-111111111111",
    false,
    undefined,
    env(),
  );
  assertEquals(decision, { allowed: true, usageId: 42 });
  assertEquals(calls.length, 1);
  assertEquals(calls[0], {
    p_action: "run",
    p_investigation_id: "11111111-1111-4111-8111-111111111111",
    p_provider: "gemini+serper+geoapify",
    p_model: "gemini-3.6-flash",
    p_mode: "live",
    p_estimated_cost_microusd: 50_000,
    p_daily_limit_microusd: 5_000_000,
    p_monthly_limit_microusd: 50_000_000,
    p_enforce: true,
  });
});

Deno.test("research tierの明示server budgetが同じrun予約へ実際に渡る", async () => {
  const free = policyForEntitlement(
    null,
    (name) => name === "LIVE_ESTIMATED_RUN_COST_USD" ? "0.05" : undefined,
  );
  const plus = policyForEntitlement(
    { tier: "plus" },
    (name) => ({
      [PLUS_RESEARCH_COST_ENV]: "0.07",
      [PLUS_BROAD_LIMIT_ENV]: "12",
      [PLUS_PRE_RANK_LIMIT_ENV]: "8",
      [PLUS_RESEARCH_LIMIT_ENV]: "6",
      [PLUS_PROVIDER_CALL_LIMIT_ENV]: "6",
    }[name]),
  );
  if (!free || !plus) throw new Error("research policy fixture unavailable");

  const freeCalls: unknown[] = [];
  await checkCostGuard(
    fakeDb([{ is_allowed: true, usage_id: 11, new_alerts: [] }], freeCalls),
    "run",
    "11111111-1111-4111-8111-111111111111",
    false,
    free.estimatedCostMicros,
    env(),
    "33333333-3333-4333-8333-333333333333",
  );
  const plusCalls: unknown[] = [];
  await checkCostGuard(
    fakeDb([{ is_allowed: true, usage_id: 12, new_alerts: [] }], plusCalls),
    "run",
    "11111111-1111-4111-8111-111111111111",
    false,
    plus.estimatedCostMicros,
    env(),
    "44444444-4444-4444-8444-444444444444",
  );

  assertEquals(
    (freeCalls[0] as { p_estimated_cost_microusd: number })
      .p_estimated_cost_microusd,
    50_000,
  );
  assertEquals(
    (plusCalls[0] as { p_estimated_cost_microusd: number })
      .p_estimated_cost_microusd,
    70_000,
  );
  assertNotEquals(free.estimatedCostMicros, plus.estimatedCostMicros);
});

Deno.test("cost guard: DB予算超過とenv kill switchを外部呼び出し前に拒否する", async () => {
  const budget = await checkCostGuard(
    fakeDb([{
      is_allowed: false,
      stop_reason: "daily_budget",
      usage_id: 9,
      new_alerts: [],
    }]),
    "create",
    null,
    false,
    undefined,
    env(),
  );
  assertEquals(budget, { allowed: false, kind: "budget", retryAfter: 3600 });

  const calls: unknown[] = [];
  const killed = await checkCostGuard(
    fakeDb([], calls),
    "create",
    null,
    false,
    undefined,
    env({ LIVE_KILL_SWITCH: "true" }),
  );
  assertEquals(killed, {
    allowed: false,
    kind: "kill_switch",
    retryAfter: 300,
  });
  assertEquals(calls.length, 0);
});

Deno.test("cost guard: service再実行はDB停止を確認するが再予約しない", async () => {
  const serviceCalls: unknown[] = [];
  assertEquals(
    await checkCostGuard(
      fakeServiceDb(
        { data: { enabled: true }, error: null },
        serviceCalls as string[],
      ),
      "run",
      null,
      true,
      undefined,
      env(),
    ),
    { allowed: true, usageId: null },
  );
  assertEquals(serviceCalls, [
    "from:runtime_controls",
    "select:enabled",
    "eq:key:provider_live",
  ]);

  const dbKilledCalls: string[] = [];
  assertEquals(
    await checkCostGuard(
      fakeServiceDb(
        { data: { enabled: false }, error: null },
        dbKilledCalls,
      ),
      "run",
      null,
      true,
      undefined,
      env(),
    ),
    { allowed: false, kind: "kill_switch", retryAfter: 300 },
  );
  assertEquals(dbKilledCalls.includes("rpc"), false);

  assertEquals(
    await checkCostGuard(
      fakeServiceDb({ data: null, error: { message: "down" } }),
      "run",
      null,
      true,
      undefined,
      env(),
    ),
    { allowed: false, kind: "unavailable", retryAfter: 60 },
  );

  const envKilledCalls: string[] = [];
  assertEquals(
    await checkCostGuard(
      fakeServiceDb(
        { data: { enabled: true }, error: null },
        envKilledCalls,
      ),
      "run",
      null,
      true,
      undefined,
      env({ LIVE_KILL_SWITCH: "true" }),
    ),
    { allowed: false, kind: "kill_switch", retryAfter: 300 },
  );
  assertEquals(envKilledCalls, []);
});

Deno.test("cost guard: mockは0 costで記録する", async () => {
  const mockCalls: unknown[] = [];
  assertEquals(
    await checkCostGuard(
      fakeDb([{ is_allowed: true, usage_id: 1, new_alerts: [] }], mockCalls),
      "create",
      null,
      false,
      undefined,
      env({ DATA_PROVIDER_MODE: "mock" }),
    ),
    { allowed: true, usageId: 1 },
  );
  assertEquals(
    (mockCalls[0] as { p_estimated_cost_microusd: number })
      .p_estimated_cost_microusd,
    0,
  );

  const freeRerankCalls: unknown[] = [];
  await checkCostGuard(
    fakeDb([{
      is_allowed: true,
      usage_id: 2,
      new_alerts: [],
    }], freeRerankCalls),
    "rerank",
    "11111111-1111-4111-8111-111111111111",
    false,
    0,
    env(),
  );
  assertEquals(
    (freeRerankCalls[0] as { p_estimated_cost_microusd: number })
      .p_estimated_cost_microusd,
    0,
  );
});

Deno.test("cost guard: 台帳障害はlive fail-closed / mock fail-open", async () => {
  const broken = {
    rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
  } as unknown as SupabaseClient;
  assertEquals(
    await checkCostGuard(broken, "run", null, false, undefined, env()),
    { allowed: false, kind: "unavailable", retryAfter: 60 },
  );
  assertEquals(
    await checkCostGuard(
      broken,
      "run",
      null,
      false,
      undefined,
      env({ DATA_PROVIDER_MODE: "mock" }),
    ),
    { allowed: true, usageId: null },
  );
});

Deno.test("create claimはguard無効時もdurable usageを予約し、台帳障害をfail-closedにする", async () => {
  const claim = {
    userId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "create-claim",
    requestDigest: "a".repeat(64),
    leaseGeneration: 1,
    leaseToken: "22222222-2222-4222-8222-222222222222",
  };
  const calls: unknown[] = [];
  assertEquals(
    await checkCostGuard(
      fakeDb([{ is_allowed: true, usage_id: 77, new_alerts: [] }], calls),
      "create",
      null,
      false,
      undefined,
      env({ LIVE_COST_GUARD_ENABLED: "false" }),
      undefined,
      claim,
    ),
    { allowed: true, usageId: 77 },
  );
  assertEquals(
    (calls[0] as { p_enforce: boolean; p_idempotency_key: string }).p_enforce,
    false,
  );
  assertEquals(
    (calls[0] as { p_idempotency_key: string }).p_idempotency_key,
    "create-claim",
  );

  const broken = {
    rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
  } as unknown as SupabaseClient;
  assertEquals(
    await checkCostGuard(
      broken,
      "create",
      null,
      false,
      undefined,
      env({ DATA_PROVIDER_MODE: "mock" }),
      undefined,
      claim,
    ),
    { allowed: false, kind: "unavailable", retryAfter: 60 },
  );
});

Deno.test("accepted run control: 既存予約を再作成せずkill switchだけ再確認する", async () => {
  const calls: string[] = [];
  assertEquals(
    await checkAcceptedRunControl(
      fakeServiceDb({ data: { enabled: true }, error: null }, calls),
      env({ DATA_PROVIDER_MODE: "live" }),
    ),
    { allowed: true, usageId: null },
  );
  assertEquals(calls.includes("rpc"), false);

  assertEquals(
    await checkAcceptedRunControl(
      fakeServiceDb({ data: { enabled: false }, error: null }),
      env({ DATA_PROVIDER_MODE: "live" }),
    ),
    { allowed: false, kind: "kill_switch", retryAfter: 300 },
  );
  assertEquals(
    await checkAcceptedRunControl(
      fakeServiceDb({ data: null, error: { message: "down" } }),
      env({ DATA_PROVIDER_MODE: "live" }),
    ),
    { allowed: false, kind: "unavailable", retryAfter: 60 },
  );
  assertEquals(
    await checkAcceptedRunControl(
      fakeServiceDb({ data: { enabled: true }, error: null }),
      env({ LIVE_KILL_SWITCH: "true" }),
    ),
    { allowed: false, kind: "kill_switch", retryAfter: 300 },
  );
});
