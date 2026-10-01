import { assertEquals, assertMatch } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkRateLimit,
  hmacHex,
  readLimitValues,
} from "../functions/_shared/rate_limit.ts";

const secret = "test-rate-limit-secret-000000000000";
const userId = "11111111-1111-4111-8111-111111111111";

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

Deno.test("rate limit config: live既定値、mock倍率、env上書きを決定論的に読む", () => {
  assertEquals(readLimitValues("create", "live", env()), {
    userHourly: 10,
    userDaily: 30,
    ipHourly: 30,
  });
  assertEquals(readLimitValues("create", "mock", env()), {
    userHourly: 100,
    userDaily: 300,
    ipHourly: 300,
  });
  assertEquals(readLimitValues("join", "live", env()), {
    userHourly: 10,
    userDaily: 30,
    ipHourly: 30,
  });
  assertEquals(
    readLimitValues(
      "create",
      "live",
      env({ RATE_LIMIT_CREATE_USER_HOURLY: "7" }),
    ),
    { userHourly: 7, userDaily: 30, ipHourly: 30 },
  );
});

Deno.test("rate limit: user/IP平文を送らず3窓を1 RPCで消費する", async () => {
  const calls: unknown[] = [];
  const decision = await checkRateLimit(
    fakeDb(
      [{ is_allowed: true, retry_after_seconds: 0, exceeded_scope: null }],
      calls,
    ),
    new Request("https://edge.example"),
    "create",
    userId,
    false,
    env({ RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(decision, { allowed: true });
  assertEquals(calls.length, 1);
  const serialized = JSON.stringify(calls[0]);
  assertEquals(serialized.includes(userId), false);
  assertEquals(serialized.includes("direct-edge"), false);
  const rules =
    (calls[0] as { p_limits: Array<{ subject_hash: string }> }).p_limits;
  assertEquals(rules.length, 3);
  for (const rule of rules) assertMatch(rule.subject_hash, /^[0-9a-f]{64}$/);
});

Deno.test("rate limit: Worker署名済みclient keyだけをIP subjectとして信頼する", async () => {
  const clientKey = await hmacHex(secret, "ip:203.0.113.10");
  const signature = await hmacHex(secret, `proxy:${clientKey}`);
  const request = new Request("https://edge.example", {
    headers: {
      "x-oisint-client-key": clientKey,
      "x-oisint-proxy-signature": signature,
    },
  });
  const calls: unknown[] = [];
  await checkRateLimit(
    fakeDb(
      [{ is_allowed: true, retry_after_seconds: 0, exceeded_scope: null }],
      calls,
    ),
    request,
    "run",
    userId,
    false,
    env({ RATE_LIMIT_SECRET: secret }),
  );
  const rules =
    (calls[0] as { p_limits: Array<{ scope: string; subject_hash: string }> })
      .p_limits;
  assertEquals(
    rules.find((rule) => rule.scope === "run:ip:hour")?.subject_hash,
    clientKey,
  );
});

Deno.test("rate limit: 超過はRetry-After付きdecision、service roleはRPCなし", async () => {
  const limited = await checkRateLimit(
    fakeDb([{
      is_allowed: false,
      retry_after_seconds: 321,
      exceeded_scope: "rerank:user:hour",
    }]),
    new Request("https://edge.example"),
    "rerank",
    userId,
    false,
    env({ RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(limited, { allowed: false, kind: "limited", retryAfter: 321 });

  const calls: unknown[] = [];
  const service = await checkRateLimit(
    fakeDb([], calls),
    new Request("https://edge.example"),
    "run",
    null,
    true,
    env(),
  );
  assertEquals(service, { allowed: true });
  assertEquals(calls.length, 0);
});

Deno.test("rate limit: live設定/DB異常はfail-closed、mock DB異常だけfail-open", async () => {
  const broken = {
    rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
  } as unknown as SupabaseClient;
  assertEquals(
    await checkRateLimit(
      broken,
      new Request("https://edge.example"),
      "create",
      userId,
      false,
      env(),
    ),
    { allowed: false, kind: "unavailable", retryAfter: 30 },
  );
  assertEquals(
    await checkRateLimit(
      broken,
      new Request("https://edge.example"),
      "create",
      userId,
      false,
      env({ DATA_PROVIDER_MODE: "mock" }),
    ),
    { allowed: true },
  );
});
