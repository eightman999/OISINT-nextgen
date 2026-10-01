import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkRateLimit,
  readLimitValues,
} from "../functions/_shared/rate_limit.ts";

const joinSource = await Deno.readTextFile(
  new URL("../functions/join-investigation/index.ts", import.meta.url),
);
const secret = "join-rate-limit-test-secret-000000000000";
const userId = "22222222-2222-4222-8222-222222222222";

// Edge moduleはimport時にDeno.serveを登録し、handler依存を注入する境界を
// 公開していない。そのため、共有rate limitの実行fixtureと、joinの順序・HTTP
// 契約を結合したsource contractで、実装を変更せずに非到達条件を固定する。

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

Deno.test("join専用rate limitはlive/mockともuser/IPの3窓を持つ", async () => {
  assertEquals(readLimitValues("join", "live", env()), {
    userHourly: 10,
    userDaily: 30,
    ipHourly: 30,
  });
  assertEquals(readLimitValues("join", "mock", env()), {
    userHourly: 100,
    userDaily: 300,
    ipHourly: 300,
  });

  const calls: unknown[] = [];
  const decision = await checkRateLimit(
    fakeDb([{ is_allowed: true, retry_after_seconds: 0 }], calls),
    new Request("https://edge.example"),
    "join",
    userId,
    false,
    env({ RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(decision, { allowed: true });
  assertEquals(calls.length, 1);
  const rules = (calls[0] as {
    p_limits: Array<{
      scope: string;
      window_seconds: number;
      limit: number;
    }>;
  }).p_limits;
  assertEquals(rules.map((rule) => rule.scope), [
    "join:user:hour",
    "join:user:day",
    "join:ip:hour",
  ]);
  assertEquals(rules.map((rule) => rule.window_seconds), [3600, 86400, 3600]);
  assertEquals(rules.map((rule) => rule.limit), [10, 30, 30]);

  const mockCalls: unknown[] = [];
  const mockDecision = await checkRateLimit(
    fakeDb([{ is_allowed: true, retry_after_seconds: 0 }], mockCalls),
    new Request("https://edge.example"),
    "join",
    userId,
    false,
    env({ DATA_PROVIDER_MODE: "mock", RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(mockDecision, { allowed: true });
  const mockRules = (mockCalls[0] as {
    p_limits: Array<{ limit: number }>;
  }).p_limits;
  assertEquals(mockRules.map((rule) => rule.limit), [100, 300, 300]);
});

Deno.test("join専用rate limitのlimitedは429契約値、live障害は503契約値になる", async () => {
  const request = new Request("https://edge.example");
  const limited = await checkRateLimit(
    fakeDb([{
      is_allowed: false,
      retry_after_seconds: 17,
      exceeded_scope: "join:user:hour",
    }]),
    request,
    "join",
    userId,
    false,
    env({ RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(limited, {
    allowed: false,
    kind: "limited",
    retryAfter: 17,
  });

  const broken = {
    rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
  } as unknown as SupabaseClient;
  const unavailable = await checkRateLimit(
    broken,
    request,
    "join",
    userId,
    false,
    env({ RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(unavailable, {
    allowed: false,
    kind: "unavailable",
    retryAfter: 30,
  });

  const mockFailure = await checkRateLimit(
    broken,
    request,
    "join",
    userId,
    false,
    env({ DATA_PROVIDER_MODE: "mock", RATE_LIMIT_SECRET: secret }),
  );
  assertEquals(mockFailure, { allowed: true });
});

Deno.test("joinのrate limit超過はbody parse・share token RPCより先に返す", () => {
  const rateLimitCall = joinSource.indexOf(
    "const rateLimit = await checkRateLimit(",
  );
  const deniedGuard = joinSource.indexOf("if (!rateLimit.allowed)");
  const bodyReader = joinSource.indexOf(
    "const boundedBody = await readRequestBodyLimited(",
  );
  const joinRpc = joinSource.indexOf('db.rpc("join_investigation"');

  assert(rateLimitCall >= 0, "joinのcheckRateLimit呼出しがない");
  assert(deniedGuard > rateLimitCall, "rate limit拒否guardが呼出し後にない");
  assert(bodyReader > deniedGuard, "body readerが拒否guard後にない");
  assert(joinRpc > bodyReader, "join RPCがbody reader後にない");

  const rateLimitBlock = joinSource.slice(rateLimitCall, bodyReader);
  assertStringIncludes(rateLimitBlock, '"join"');
  assertStringIncludes(rateLimitBlock, "limited ? 429 : 503");
  assertStringIncludes(
    rateLimitBlock,
    '"Retry-After": String(rateLimit.retryAfter)',
  );
  assertStringIncludes(
    rateLimitBlock,
    "しばらく待ってからもう一度お試しください",
  );
});

Deno.test("joinのservice role bypassは共有契約どおりrate limit RPCを呼ばない", async () => {
  const calls: unknown[] = [];
  const decision = await checkRateLimit(
    fakeDb([], calls),
    new Request("https://edge.example"),
    "join",
    null,
    true,
    env(),
  );
  assertEquals(decision, { allowed: true });
  assertEquals(calls.length, 0);
});
