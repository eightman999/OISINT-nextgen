import { assertEquals } from "@std/assert";
import {
  authorizeInternalInvocation,
  createInternalInvocationHeaders,
  INTERNAL_INVOKE_MAX_CLOCK_SKEW_SECONDS,
} from "../functions/_shared/internal_invocation.ts";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const nonce = "223e4567-e89b-42d3-a456-426614174000";
const body = JSON.stringify({
  investigationId: "323e4567-e89b-42d3-a456-426614174000",
});
const nowMs = 1_788_000_000_000;

function env(values: Record<string, string>) {
  return (name: string) => values[name];
}

function secrets(current = "i".repeat(32), previous?: string) {
  return env({
    INTERNAL_INVOKE_SECRET: current,
    ...(previous ? { INTERNAL_INVOKE_SECRET_PREVIOUS: previous } : {}),
    RATE_LIMIT_SECRET: "r".repeat(32),
    EGRESS_GATEWAY_SECRET: "e".repeat(32),
    RUN_QUEUE_DRAIN_KEY: "q".repeat(32),
    REVENUECAT_WEBHOOK_HMAC_SECRET: "w".repeat(32),
  });
}

Deno.test("internal invocation: body/request/timestamp/nonceを結んだ署名を検証する", async () => {
  const headers = await createInternalInvocationHeaders(body, requestId, {
    env: secrets(),
    nowMs,
    nonce,
  });
  if (!headers) throw new Error("署名headerを生成できませんでした");
  const requestHeaders = new Headers(headers);

  assertEquals(
    await authorizeInternalInvocation(requestHeaders, body, requestId, {
      env: secrets(),
      nowMs,
    }),
    true,
  );
  assertEquals(
    await authorizeInternalInvocation(requestHeaders, `${body} `, requestId, {
      env: secrets(),
      nowMs,
    }),
    false,
  );
  assertEquals(
    await authorizeInternalInvocation(
      requestHeaders,
      body,
      "423e4567-e89b-42d3-a456-426614174000",
      { env: secrets(), nowMs },
    ),
    false,
  );
});

Deno.test("internal invocation: 15秒を超えた署名と不正headerを拒否する", async () => {
  const headers = await createInternalInvocationHeaders(body, requestId, {
    env: secrets(),
    nowMs,
    nonce,
  });
  if (!headers) throw new Error("署名headerを生成できませんでした");

  assertEquals(
    await authorizeInternalInvocation(new Headers(headers), body, requestId, {
      env: secrets(),
      nowMs: nowMs + INTERNAL_INVOKE_MAX_CLOCK_SKEW_SECONDS * 1_000,
    }),
    true,
  );
  assertEquals(
    await authorizeInternalInvocation(new Headers(headers), body, requestId, {
      env: secrets(),
      nowMs: nowMs + (INTERNAL_INVOKE_MAX_CLOCK_SKEW_SECONDS + 1) * 1_000,
    }),
    false,
  );

  const invalid = new Headers(headers);
  invalid.set("x-oisint-invoke-nonce", "not-a-uuid");
  assertEquals(
    await authorizeInternalInvocation(invalid, body, requestId, {
      env: secrets(),
      nowMs,
    }),
    false,
  );
});

Deno.test("internal invocation: rotation中はpreviousを検証専用で受理する", async () => {
  const oldSecret = "o".repeat(32);
  const newSecret = "n".repeat(32);
  const oldHeaders = await createInternalInvocationHeaders(body, requestId, {
    env: secrets(oldSecret),
    nowMs,
    nonce,
  });
  if (!oldHeaders) {
    throw new Error("旧secretの署名headerを生成できませんでした");
  }

  assertEquals(
    await authorizeInternalInvocation(
      new Headers(oldHeaders),
      body,
      requestId,
      { env: secrets(newSecret, oldSecret), nowMs },
    ),
    true,
  );
  assertEquals(
    await authorizeInternalInvocation(
      new Headers(oldHeaders),
      body,
      requestId,
      { env: secrets(newSecret), nowMs },
    ),
    false,
  );
});

Deno.test("internal invocation: 短いsecret・用途間使い回し・同一previousはfail-closed", async () => {
  assertEquals(
    await createInternalInvocationHeaders(body, requestId, {
      env: secrets("short"),
      nowMs,
      nonce,
    }),
    null,
  );
  const reused = "x".repeat(32);
  assertEquals(
    await createInternalInvocationHeaders(body, requestId, {
      env: env({
        INTERNAL_INVOKE_SECRET: reused,
        RATE_LIMIT_SECRET: reused,
      }),
      nowMs,
      nonce,
    }),
    null,
  );
  assertEquals(
    await createInternalInvocationHeaders(body, requestId, {
      env: secrets(reused, reused),
      nowMs,
      nonce,
    }),
    null,
  );
});
