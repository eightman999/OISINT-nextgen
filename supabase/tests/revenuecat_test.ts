import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  authorizeRevenueCatEventConfig,
  authorizeRevenueCatWebhook,
  authorizeRevenueCatWebhookSignature,
  buildEntitlementMutation,
  createRevenueCatWebhookSignature,
  isEntitlementActiveAt,
  isKnownProduct,
  isPlusEvent,
  redactRevenueCatEvent,
  revenueCatEventProductId,
  revenueCatWebhookSchema,
} from "../functions/_shared/revenuecat.ts";
import { fetchSubscriberPlusState } from "../functions/_shared/revenuecat_subscriber.ts";

const baseEvent = {
  id: "evt-1",
  type: "INITIAL_PURCHASE",
  event_timestamp_ms: 1_000,
  app_user_id: "00000000-0000-4000-8000-000000000571",
  app_id: "app-oisint",
  original_app_user_id: null,
  entitlement_id: "plus",
  entitlement_ids: ["plus"],
  product_id: "oisint_plus_monthly",
  new_product_id: null,
  offering_id: "default",
  presented_offering_id: "default",
  store: "TEST_STORE",
  environment: "SANDBOX",
  expiration_at_ms: 10_000,
  grace_period_expiration_at_ms: null,
  will_renew: true,
};
const serverSecret = "s".repeat(32);
const webhookToken = "t".repeat(32);

Deno.test("Google通知の確認済みbase planだけを正規IDへ変換してgrantする", () => {
  for (
    const [wireId, canonicalId] of [
      ["oisint_plus_monthly:monthly2", "oisint_plus_monthly"],
      ["oisint_plus_annual:2annual", "oisint_plus_annual"],
    ]
  ) {
    // DB/Subscriber用のallow-list自体は広げない。
    assertFalse(isKnownProduct(wireId));
    assert(isKnownProduct(canonicalId));
    for (const type of ["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION"]) {
      const event = {
        ...baseEvent,
        type,
        store: "PLAY_STORE",
        product_id: wireId,
      };
      assertEquals(revenueCatEventProductId(event), canonicalId);
      const mutation = buildEntitlementMutation(event, undefined, 0);
      assertEquals(mutation.kind, "upsert");
      if (mutation.kind === "upsert") {
        assertEquals(mutation.product_id, canonicalId);
        assert(mutation.is_active);
      }
    }
  }
});

Deno.test("Google通知でも未知plan・入替・suffix・別storeを既存Plusへfallbackしない", () => {
  const existing = {
    is_active: true,
    lifecycle_state: "active" as const,
    product_id: "oisint_plus_monthly" as const,
    expires_at: new Date(10_000).toISOString(),
    grace_period_expires_at: null,
    will_renew: true,
    last_event_id: "old",
    last_event_timestamp_ms: 0,
  };
  for (
    const [store, product_id] of [
      ["PLAY_STORE", "oisint_plus_monthly:unknown"],
      ["PLAY_STORE", "oisint_plus_monthly:2annual"],
      ["PLAY_STORE", "oisint_plus_annual:monthly2"],
      ["PLAY_STORE", "oisint_plus_monthly:monthly2:offer"],
      ["APP_STORE", "oisint_plus_monthly:monthly2"],
      ["TEST_STORE", "oisint_plus_annual:2annual"],
      [undefined, "oisint_plus_monthly:monthly2"],
    ]
  ) {
    const event = { ...baseEvent, store, product_id };
    assertEquals(buildEntitlementMutation(event, existing, 0), {
      kind: "ignore",
      reason: "unknown_product",
    });
  }
});

Deno.test("Googleのプラン変更・失効も正規化し、期限証明の要件を維持する", () => {
  const change = {
    ...baseEvent,
    store: "PLAY_STORE",
    type: "PRODUCT_CHANGE",
    product_id: "oisint_plus_monthly:monthly2",
    new_product_id: "oisint_plus_annual:2annual",
  };
  assertEquals(revenueCatEventProductId(change), "oisint_plus_annual");
  assertEquals(
    buildEntitlementMutation(
      { ...change, expiration_at_ms: null },
      undefined,
      0,
    ),
    {
      kind: "ignore",
      reason: "missing_expiration",
    },
  );
  const expired = buildEntitlementMutation(
    { ...change, type: "EXPIRATION", expiration_at_ms: 0 },
    undefined,
    0,
  );
  assertEquals(expired.kind, "upsert");
  if (expired.kind === "upsert") {
    assertEquals(expired.product_id, "oisint_plus_monthly");
    assertFalse(expired.is_active);
  }
  assertEquals(
    revenueCatEventProductId({ ...baseEvent, store: "APP_STORE" }),
    "oisint_plus_monthly",
  );
});

Deno.test("RevenueCat webhook schema accepts the frozen plus contract and extra future fields", () => {
  const parsed = revenueCatWebhookSchema.safeParse({
    api_version: "1.0",
    event: { ...baseEvent, future_field: { version: 2 } },
  });
  assert(parsed.success);
  assert(isPlusEvent(parsed.data.event));
});

Deno.test("TRANSFER accepts arbitrary App User IDs and leaves ownership filtering to DB", () => {
  const parsed = revenueCatWebhookSchema.safeParse({
    api_version: "1.0",
    event: {
      ...baseEvent,
      type: "TRANSFER",
      entitlement_id: null,
      entitlement_ids: null,
      app_user_id: undefined,
      transferred_from: ["00000000-0000-4000-8000-000000000571"],
      transferred_to: ["00000000-0000-4000-8000-000000000572"],
      aliases: ["email@example.com"],
    },
  });
  assert(parsed.success);
  if (parsed.success) assertFalse(isPlusEvent(parsed.data.event));
  assert(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: {
        ...baseEvent,
        type: "TRANSFER",
        transferred_from: ["$RCAnonymousID:123", "email@example.com"],
      },
    }).success,
  );
});

Deno.test("RevenueCat webhook schema rejects missing event identity and malformed timestamp", () => {
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: { ...baseEvent, id: "" },
    }).success,
  );
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: { ...baseEvent, event_timestamp_ms: -1 },
    }).success,
  );
});

Deno.test("RevenueCat webhook schema bounds strings, arrays, and timestamps", () => {
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: { ...baseEvent, app_id: "x".repeat(257) },
    }).success,
  );
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: {
        ...baseEvent,
        entitlement_ids: Array.from({ length: 21 }, () => "plus"),
      },
    }).success,
  );
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: { ...baseEvent, event_timestamp_ms: Number.MAX_SAFE_INTEGER },
    }).success,
  );
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: {
        ...baseEvent,
        expiration_at_ms: Date.parse("2100-01-01T00:00:00.001Z"),
      },
    }).success,
  );
  assertFalse(
    revenueCatWebhookSchema.safeParse({
      api_version: "1.0",
      event: {
        ...baseEvent,
        type: "TRANSFER",
        transferred_from: Array.from(
          { length: 101 },
          () => "email@example.com",
        ),
      },
    }).success,
  );
});

Deno.test("buildEntitlementMutation fail-closes unknown product, non-plus, and stale events", () => {
  assertEquals(
    buildEntitlementMutation({ ...baseEvent, product_id: "pro" } as never).kind,
    "ignore",
  );
  const nonPlus = buildEntitlementMutation({
    ...baseEvent,
    entitlement_id: "pro",
    entitlement_ids: ["pro"],
  });
  assertEquals(nonPlus.kind, "ignore");
  if (nonPlus.kind === "ignore") {
    assertEquals(nonPlus.reason, "entitlement_not_plus");
  }
  const stale = buildEntitlementMutation(baseEvent, {
    is_active: true,
    lifecycle_state: "active",
    product_id: "oisint_plus_monthly",
    expires_at: null,
    grace_period_expires_at: null,
    will_renew: true,
    last_event_id: "evt-0",
    last_event_timestamp_ms: 1_000,
  });
  assertEquals(stale.kind, "ignore");
  if (stale.kind === "ignore") {
    assertEquals(stale.reason, "stale_or_duplicate_event");
  }
});

Deno.test("official null presented_offering_id is accepted when product is known", () => {
  const mutation = buildEntitlementMutation(
    {
      ...baseEvent,
      offering_id: null,
      presented_offering_id: null,
    },
    undefined,
    0,
  );
  assertEquals(mutation.kind, "upsert");
});

Deno.test("explicit null presented_offering_id does not inherit an unknown legacy offering", () => {
  const mutation = buildEntitlementMutation(
    {
      ...baseEvent,
      offering_id: "legacy-offering",
      presented_offering_id: null,
    },
    undefined,
    0,
  );
  assertEquals(mutation.kind, "upsert");
});

Deno.test("expiration and billing issue never create a new Plus grant", () => {
  const expiration = buildEntitlementMutation({
    ...baseEvent,
    id: "evt-2",
    type: "EXPIRATION",
    event_timestamp_ms: 2_000,
    product_id: null,
    expiration_at_ms: 2_000,
  });
  assertEquals(expiration.kind, "upsert");
  if (expiration.kind === "upsert") {
    assertFalse(expiration.is_active);
    assertEquals(expiration.lifecycle_state, "expired");
  }

  const billing = buildEntitlementMutation({
    ...baseEvent,
    id: "evt-3",
    type: "BILLING_ISSUE",
    event_timestamp_ms: 3_000,
    grace_period_expiration_at_ms: null,
  });
  assertEquals(billing.kind, "upsert");
  if (billing.kind === "upsert") {
    assertFalse(billing.is_active);
    assertEquals(billing.lifecycle_state, "billing_issue");
  }
});

Deno.test("missing will_renew is preserved as unknown/false instead of fabricated renewal", () => {
  const mutation = buildEntitlementMutation(
    {
      ...baseEvent,
      type: "INITIAL_PURCHASE",
      will_renew: undefined,
    },
    undefined,
    0,
  );
  if (mutation.kind === "upsert") {
    assertEquals(mutation.will_renew, false);
  } else {
    throw new Error("missing will_renew unexpectedly prevented the grant");
  }
});

Deno.test("purchase-like events require their own finite future expiry or grace proof", () => {
  const now = Date.parse("2026-08-24T00:00:00.000Z");
  const existing = {
    is_active: true,
    lifecycle_state: "active" as const,
    product_id: "oisint_plus_monthly" as const,
    expires_at: "2026-08-25T00:00:00.000Z",
    grace_period_expires_at: null,
    will_renew: true,
    last_event_id: "evt-existing",
    last_event_timestamp_ms: 1,
  };
  for (
    const type of [
      "INITIAL_PURCHASE",
      "RENEWAL",
      "UNCANCELLATION",
      "PRODUCT_CHANGE",
    ]
  ) {
    const mutation = buildEntitlementMutation(
      {
        ...baseEvent,
        type,
        expiration_at_ms: null,
        grace_period_expiration_at_ms: null,
        event_timestamp_ms: 2_000,
      },
      existing,
      now,
    );
    assertEquals(mutation, { kind: "ignore", reason: "missing_expiration" });
  }
  const withFutureGrace = buildEntitlementMutation(
    {
      ...baseEvent,
      type: "RENEWAL",
      expiration_at_ms: null,
      grace_period_expiration_at_ms: Date.parse("2026-08-25T00:00:00.000Z"),
      event_timestamp_ms: 2_001,
    },
    undefined,
    now,
  );
  assertEquals(withFutureGrace.kind, "upsert");
  if (withFutureGrace.kind === "upsert") {
    assert(withFutureGrace.is_active);
    assertEquals(
      withFutureGrace.grace_period_expires_at,
      "2026-08-25T00:00:00.000Z",
    );
  }
});

Deno.test("lifecycle events preserve verified future access even when purchase arrived late", () => {
  const future = Date.now() + 24 * 60 * 60 * 1000;
  const cancellation = buildEntitlementMutation({
    ...baseEvent,
    type: "CANCELLATION",
    event_timestamp_ms: 4_000,
    expiration_at_ms: future,
    will_renew: false,
  });
  assertEquals(cancellation.kind, "upsert");
  if (cancellation.kind === "upsert") {
    assert(cancellation.is_active);
    assertEquals(cancellation.lifecycle_state, "canceled");
  }

  const grace = buildEntitlementMutation({
    ...baseEvent,
    type: "BILLING_ISSUE",
    event_timestamp_ms: 4_001,
    expiration_at_ms: future - 60_000,
    grace_period_expiration_at_ms: future,
    will_renew: false,
  });
  assertEquals(grace.kind, "upsert");
  if (grace.kind === "upsert") {
    assert(grace.is_active);
    assertEquals(grace.lifecycle_state, "grace");
  }

  const paused = buildEntitlementMutation({
    ...baseEvent,
    type: "SUBSCRIPTION_PAUSED",
    event_timestamp_ms: 4_002,
    expiration_at_ms: future,
  });
  assertEquals(paused.kind, "upsert");
  if (paused.kind === "upsert") assert(paused.is_active);

  const olderPurchase = buildEntitlementMutation({
    ...baseEvent,
    event_timestamp_ms: 3_999,
  }, {
    is_active: true,
    lifecycle_state: "canceled",
    product_id: "oisint_plus_monthly",
    expires_at: new Date(future).toISOString(),
    grace_period_expires_at: null,
    will_renew: false,
    last_event_id: "cancel-first",
    last_event_timestamp_ms: 4_000,
  });
  assertEquals(olderPurchase, {
    kind: "ignore",
    reason: "stale_or_duplicate_event",
  });
});

Deno.test("activity requires known active state and a future expiry/grace timestamp", () => {
  const now = Date.parse("2026-08-24T00:00:00.000Z");
  assert(isEntitlementActiveAt({
    is_active: true,
    lifecycle_state: "active",
    expires_at: "2026-08-25T00:00:00.000Z",
    grace_period_expires_at: null,
  }, now));
  assert(isEntitlementActiveAt({
    is_active: true,
    lifecycle_state: "billing_issue",
    expires_at: "2026-08-25T00:00:00.000Z",
    grace_period_expires_at: null,
  }, now));
  assertFalse(isEntitlementActiveAt({
    is_active: true,
    lifecycle_state: "billing_issue",
    expires_at: "2026-08-23T00:00:00.000Z",
    grace_period_expires_at: null,
  }, now));
  assertFalse(isEntitlementActiveAt({
    is_active: true,
    lifecycle_state: "active",
    expires_at: "2026-08-23T00:00:00.000Z",
    grace_period_expires_at: null,
  }, now));
  assert(isEntitlementActiveAt({
    is_active: true,
    lifecycle_state: "grace",
    expires_at: null,
    grace_period_expires_at: "2026-08-25T00:00:00.000Z",
  }, now));
  assertFalse(isEntitlementActiveAt({
    is_active: true,
    lifecycle_state: "active",
    expires_at: null,
    grace_period_expires_at: null,
  }, now));
});

Deno.test("webhook authorization compares the configured secret without exposing it", () => {
  assert(authorizeRevenueCatWebhook(`Bearer ${webhookToken}`, webhookToken).ok);
  assertFalse(
    authorizeRevenueCatWebhook("Bearer wrong-token", webhookToken).ok,
  );
  assertFalse(
    authorizeRevenueCatWebhook(`Basic ${webhookToken}`, webhookToken).ok,
  );
  assertEquals(authorizeRevenueCatWebhook(null, undefined), {
    ok: false,
    status: 500,
    reason: "missing_config",
  });
});

Deno.test("RevenueCat raw-body HMAC signature is strict and time bounded", async () => {
  const rawBody = '{"event":{"id":"evt-1"}}';
  const timestamp = 1_700_000_000;
  const signature = await createRevenueCatWebhookSignature(
    webhookToken,
    timestamp,
    rawBody,
  );
  const validHeader = `t=${timestamp},v1=${signature}`;
  assertEquals(
    await authorizeRevenueCatWebhookSignature(
      validHeader,
      webhookToken,
      rawBody,
      timestamp * 1000,
    ),
    { ok: true },
  );
  assertFalse(
    (await authorizeRevenueCatWebhookSignature(
      validHeader,
      webhookToken,
      '{ "event": {"id":"evt-1"} }',
      timestamp * 1000,
    )).ok,
  );
  assertFalse(
    (await authorizeRevenueCatWebhookSignature(
      `t=${timestamp},v1=${signature}`,
      webhookToken,
      `${rawBody} `,
      timestamp * 1000,
    )).ok,
  );
  for (
    const header of [
      null,
      `t=${timestamp},v1=${signature},v1=${signature}`,
      `t=${timestamp},x=${signature}`,
      `t=not-a-number,v1=${signature}`,
      `t=${timestamp},v1=00`,
      `t=${timestamp},v1=${"f".repeat(64)} `,
    ]
  ) {
    assertFalse(
      (await authorizeRevenueCatWebhookSignature(
        header,
        webhookToken,
        rawBody,
        timestamp * 1000,
      )).ok,
    );
  }
  assertFalse(
    (await authorizeRevenueCatWebhookSignature(
      `t=${timestamp - 301},v1=${signature}`,
      webhookToken,
      rawBody,
      timestamp * 1000,
    )).ok,
  );
  assertFalse(
    (await authorizeRevenueCatWebhookSignature(
      `t=${timestamp + 301},v1=${signature}`,
      webhookToken,
      rawBody,
      timestamp * 1000,
    )).ok,
  );
  assertEquals(
    await authorizeRevenueCatWebhookSignature(
      validHeader,
      "short",
      rawBody,
      timestamp * 1000,
    ),
    { ok: false, status: 500, reason: "missing_config" },
  );

  // multibyte/BOM/invalid-byte boundaries are signed as received, not after
  // TextDecoder replacement or JSON re-serialization.
  const rawBytes = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    0x7b,
    0x22,
    0xe3,
    0x81,
    0x82,
    0x22,
    0x3a,
    0x31,
    0x7d,
  ]);
  const byteSignature = await createRevenueCatWebhookSignature(
    webhookToken,
    timestamp,
    rawBytes,
  );
  assertEquals(
    await authorizeRevenueCatWebhookSignature(
      `t=${timestamp},v1=${byteSignature}`,
      webhookToken,
      rawBytes,
      timestamp * 1000,
    ),
    { ok: true },
  );
  const tampered = rawBytes.slice();
  tampered[tampered.length - 2] ^= 1;
  assertFalse(
    (await authorizeRevenueCatWebhookSignature(
      `t=${timestamp},v1=${byteSignature}`,
      webhookToken,
      tampered,
      timestamp * 1000,
    )).ok,
  );
  const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
  const invalidSignature = await createRevenueCatWebhookSignature(
    webhookToken,
    timestamp,
    invalidUtf8,
  );
  assertEquals(
    await authorizeRevenueCatWebhookSignature(
      `t=${timestamp},v1=${invalidSignature}`,
      webhookToken,
      invalidUtf8,
      timestamp * 1000,
    ),
    { ok: true },
  );
});

Deno.test("webhook app/environment allow-list is exact and fail-closed", () => {
  assert(
    authorizeRevenueCatEventConfig(
      baseEvent,
      "app-oisint",
      new Set(["SANDBOX"]),
    ).ok,
  );
  assertFalse(
    authorizeRevenueCatEventConfig(baseEvent, "other-app", new Set(["SANDBOX"]))
      .ok,
  );
  assertFalse(
    authorizeRevenueCatEventConfig(
      baseEvent,
      "app-oisint",
      new Set(["PRODUCTION"]),
    ).ok,
  );
  assertFalse(
    authorizeRevenueCatEventConfig(baseEvent, undefined, new Set(["SANDBOX"]))
      .ok,
  );
});

Deno.test("redaction excludes aliases and subscriber attributes", () => {
  const payload = revenueCatWebhookSchema.parse({
    api_version: "1.0",
    event: {
      ...baseEvent,
      aliases: ["email@example.com"],
      subscriber_attributes: { "$email": "email@example.com" },
    },
  });
  const redacted = JSON.stringify(redactRevenueCatEvent(payload));
  assertFalse(redacted.includes("aliases"));
  assertFalse(redacted.includes("subscriber_attributes"));
  assertFalse(redacted.includes("email@example.com"));
});

Deno.test("subscriber reconciliation grants only a verified active plus product", async () => {
  const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => {
    assertEquals(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${serverSecret}`,
    );
    assertEquals(init?.redirect, "error");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          subscriber: {
            entitlements: {
              plus: {
                product_identifier: "oisint_plus_monthly",
                expires_date: "2099-01-01T00:00:00Z",
                is_sandbox: false,
              },
            },
            subscriptions: {
              oisint_plus_monthly: { auto_renewing: false },
            },
          },
        }),
        { status: 200 },
      ),
    );
  };
  const state = await fetchSubscriberPlusState(
    "00000000-0000-4000-8000-000000000572",
    { secret: serverSecret, fetchImpl },
  );
  assert(state.ok && state.state !== null);
  assertEquals(state.state?.productId, "oisint_plus_monthly");
  assertEquals(state.state?.willRenew, false);
  assertEquals(state.state?.lifecycleState, "canceled");
  assertEquals(state.state?.environment, "PRODUCTION");

  const grace = await fetchSubscriberPlusState(
    "00000000-0000-4000-8000-000000000572",
    {
      secret: serverSecret,
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              subscriber: {
                entitlements: {
                  plus: {
                    product_identifier: "oisint_plus_monthly",
                    expires_date: "2020-01-01T00:00:00Z",
                    grace_period_expires_date: "2099-01-01T00:00:00Z",
                  },
                },
              },
            }),
            { status: 200 },
          ),
        ),
    },
  );
  assert(grace.ok && grace.state !== null);
  assertEquals(grace.state?.lifecycleState, "grace");

  const graceWithoutExpiry = await fetchSubscriberPlusState(
    "00000000-0000-4000-8000-000000000572",
    {
      secret: serverSecret,
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              subscriber: {
                entitlements: {
                  plus: {
                    product_identifier: "oisint_plus_monthly",
                    expires_date: null,
                    grace_period_expires_date: "2099-01-01T00:00:00Z",
                  },
                },
              },
            }),
            { status: 200 },
          ),
        ),
    },
  );
  assert(graceWithoutExpiry.ok && graceWithoutExpiry.state !== null);
  assertEquals(graceWithoutExpiry.state?.expiresAtMs, null);
  assertEquals(graceWithoutExpiry.state?.lifecycleState, "grace");

  const unknown = await fetchSubscriberPlusState(
    "00000000-0000-4000-8000-000000000572",
    {
      secret: serverSecret,
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              subscriber: {
                entitlements: {
                  plus: {
                    product_identifier: "pro",
                    expires_date: "2099-01-01T00:00:00Z",
                  },
                },
              },
            }),
            { status: 200 },
          ),
        ),
    },
  );
  assertEquals(unknown, { ok: true, state: null });
});

Deno.test("subscriber lookup failure is fail-closed for reconciliation", async () => {
  assertEquals(
    await fetchSubscriberPlusState("00000000-0000-4000-8000-000000000572", {
      secret: serverSecret,
      fetchImpl: () => Promise.reject(new Error("provider unavailable")),
    }),
    { ok: false, reason: "network" },
  );
  assertEquals(
    await fetchSubscriberPlusState("00000000-0000-4000-8000-000000000572", {
      secret: serverSecret,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 429 })),
    }),
    { ok: false, reason: "provider" },
  );
});

Deno.test("subscriber invalid UTF-8 is rejected before JSON validation", async () => {
  assertEquals(
    await fetchSubscriberPlusState("00000000-0000-4000-8000-000000000572", {
      secret: serverSecret,
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }),
        ),
    }),
    { ok: false, reason: "invalid_response" },
  );
});

Deno.test("subscriber lookup aborts on timeout and remains non-granting", async () => {
  let aborted = false;
  const state = await fetchSubscriberPlusState(
    "00000000-0000-4000-8000-000000000572",
    {
      secret: serverSecret,
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    },
  );
  assertEquals(state, { ok: false, reason: "timeout" });
  assert(aborted);
});

Deno.test("webhook accepts only explicitly listed apps and rejects empty CSV entries", () => {
  const config = " app-ios, app-android ";
  for (const appId of ["app-ios", "app-android"]) {
    assertEquals(
      authorizeRevenueCatEventConfig(
        { ...baseEvent, app_id: appId, environment: "PRODUCTION" },
        config,
        new Set(["PRODUCTION"]),
      ),
      { ok: true },
    );
  }
  for (const appId of ["app", "app-ios-extra", "unknown", "", null]) {
    assertEquals(
      authorizeRevenueCatEventConfig(
        { ...baseEvent, app_id: appId },
        config,
        new Set(["SANDBOX"]),
      ),
      { ok: false, status: 400, reason: "app_mismatch" },
    );
  }
  for (
    const invalid of [
      "",
      " ",
      ",",
      "app-ios,",
      ",app-ios",
      "app-ios, ,app-android",
    ]
  ) {
    assertEquals(
      authorizeRevenueCatEventConfig(baseEvent, invalid, new Set(["SANDBOX"])),
      { ok: false, status: 500, reason: "missing_config" },
    );
  }
  assertEquals(
    authorizeRevenueCatEventConfig(
      { ...baseEvent, app_id: "app-android", environment: "SANDBOX" },
      config,
      new Set(["PRODUCTION"]),
    ),
    { ok: false, status: 400, reason: "environment_mismatch" },
  );
});

Deno.test("subscriber reconciliation normalizes only confirmed Play base plans using original lookup key", async () => {
  const cases = [
    ["oisint_plus_monthly:monthly2", "play_store", "oisint_plus_monthly"],
    ["oisint_plus_annual:2annual", "play_store", "oisint_plus_annual"],
    ["oisint_plus_monthly:unknown", "play_store", null],
    ["oisint_plus_monthly:2annual", "play_store", null],
    ["oisint_plus_annual:monthly2", "play_store", null],
    ["oisint_plus_monthly:monthly2", "app_store", null],
    ["oisint_plus_monthly:monthly2", "PLAY_STORE", null],
    ["oisint_plus_monthly:monthly2", undefined, null],
    ["rc_promo_plus_monthly", "promotional", null],
    ["oisint_plus_monthly", "app_store", "oisint_plus_monthly"],
  ] as const;
  for (const [identifier, store, expected] of cases) {
    const result = await fetchSubscriberPlusState("fixture-user", {
      secret: serverSecret,
      fetchImpl: () =>
        Promise.resolve(Response.json({
          subscriber: {
            entitlements: {
              plus: {
                product_identifier: identifier,
                expires_date: "2099-01-01T00:00:00Z",
                is_sandbox: false,
              },
            },
            subscriptions: {
              [identifier]: { store, is_sandbox: true, auto_renewing: false },
            },
          },
        })),
    });
    assert(result.ok);
    if (expected === null) {
      assertEquals(result.state, null, `${identifier} / ${store}`);
    } else {
      assert(result.state !== null);
      assertEquals(result.state.productId, expected);
      // Metadata must come from the original composite key, not the bare ID.
      assertEquals(result.state.environment, "SANDBOX");
      assertEquals(result.state.willRenew, false);
      assertEquals(result.state.lifecycleState, "canceled");
    }
  }
});
