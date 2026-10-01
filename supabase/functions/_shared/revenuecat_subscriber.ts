import { z } from "zod";
import {
  isKnownProduct,
  isValidRevenueCatSecret,
  type RevenueCatProductId,
} from "./revenuecat.ts";
import { readResponseBodyLimited } from "./request_body.ts";

const subscriberEntitlementSchema = z.object({
  product_identifier: z.string().min(1),
  expires_date: z.string().nullable().optional(),
  grace_period_expires_date: z.string().nullable().optional(),
  is_sandbox: z.boolean().optional(),
}).passthrough();

const subscriberSubscriptionSchema = z.object({
  store: z.string().min(1).optional(),
  auto_renewing: z.boolean().optional(),
  expires_date: z.string().nullable().optional(),
  grace_period_expires_date: z.string().nullable().optional(),
  is_sandbox: z.boolean().optional(),
}).passthrough();

const subscriberResponseSchema = z.object({
  subscriber: z.object({
    entitlements: z.record(z.string(), subscriberEntitlementSchema).default({}),
    subscriptions: z.record(z.string(), subscriberSubscriptionSchema).default(
      {},
    ),
  }).passthrough(),
}).passthrough();

const DEFAULT_SUBSCRIBER_TIMEOUT_MS = 5_000;
const MAX_SUBSCRIBER_RESPONSE_BYTES = 256 * 1024;

export interface SubscriberPlusState {
  productId: RevenueCatProductId;
  expiresAtMs: number | null;
  gracePeriodExpiresAtMs: number | null;
  willRenew: boolean | null;
  lifecycleState: "active" | "canceled" | "grace";
  environment: "PRODUCTION" | "SANDBOX" | null;
}

export type SubscriberPlusLookup =
  | { ok: true; state: SubscriberPlusState | null }
  | {
    ok: false;
    reason:
      | "missing_config"
      | "network"
      | "timeout"
      | "provider"
      | "invalid_response";
  };

/**
 * TRANSFER payloadには購入状態がないため、server-only secretでSubscriber APIを照合する。
 * API成功でplusが存在しない/期限切れの場合は {ok:true,state:null} とし、
 * 通信・secret・shape失敗だけを {ok:false} として再送へ回す。
 */
export async function fetchSubscriberPlusState(
  appUserId: string,
  options: {
    secret?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<SubscriberPlusLookup> {
  const secret = options.secret ?? Deno.env.get("REVENUECAT_SECRET_API_KEY") ??
    "";
  if (!isValidRevenueCatSecret(secret)) {
    return { ok: false, reason: "missing_config" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(options.timeoutMs ?? DEFAULT_SUBSCRIBER_TIMEOUT_MS, 30_000)
      : DEFAULT_SUBSCRIBER_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.revenuecat.com/v1/subscribers/${
        encodeURIComponent(appUserId)
      }`,
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      },
    );
    const bounded = await readResponseBodyLimited(
      response,
      MAX_SUBSCRIBER_RESPONSE_BYTES,
    );
    if (bounded.tooLarge || bounded.readError) {
      return { ok: false, reason: "invalid_response" };
    }
    if (response.status === 404) return { ok: true, state: null };
    if (!response.ok) return { ok: false, reason: "provider" };
    // 外部応答は置換文字を許さない。invalid UTF-8をJSONへ通さず、provider障害として再送する。
    let decodedBody: string;
    try {
      decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(
        bounded.bytes,
      );
    } catch {
      return { ok: false, reason: "invalid_response" };
    }
    let body: unknown;
    try {
      body = JSON.parse(decodedBody) as unknown;
    } catch {
      return { ok: false, reason: "invalid_response" };
    }
    const parsed = subscriberResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_response" };
    const plus = parsed.data.subscriber.entitlements.plus;
    if (!plus) return { ok: true, state: null };
    // subscription metadata is keyed by the original RevenueCat identifier.
    const subscription =
      parsed.data.subscriber.subscriptions[plus.product_identifier];
    let productId = plus.product_identifier;
    if (subscription?.store === "play_store") {
      if (productId === "oisint_plus_monthly:monthly2") {
        productId = "oisint_plus_monthly";
      } else if (productId === "oisint_plus_annual:2annual") {
        productId = "oisint_plus_annual";
      }
    }
    if (!isKnownProduct(productId)) return { ok: true, state: null };
    const parsedExpiresAtMs = plus.expires_date
      ? Date.parse(plus.expires_date)
      : Number.NaN;
    const expiresAtMs = Number.isFinite(parsedExpiresAtMs)
      ? parsedExpiresAtMs
      : null;
    const gracePeriodExpiresAtMs = plus.grace_period_expires_date
      ? Date.parse(plus.grace_period_expires_date)
      : null;
    const hasFutureExpiry = expiresAtMs !== null && expiresAtMs > Date.now();
    const hasFutureGrace = gracePeriodExpiresAtMs !== null &&
      Number.isFinite(gracePeriodExpiresAtMs) &&
      gracePeriodExpiresAtMs > Date.now();
    // RevenueCat access can continue during grace after expiration.
    if (!hasFutureExpiry && !hasFutureGrace) return { ok: true, state: null };
    const willRenew = subscription?.auto_renewing ?? null;
    const isSandbox = subscription?.is_sandbox ?? plus.is_sandbox;
    return {
      ok: true,
      state: {
        productId,
        expiresAtMs,
        gracePeriodExpiresAtMs: gracePeriodExpiresAtMs !== null &&
            Number.isFinite(gracePeriodExpiresAtMs)
          ? gracePeriodExpiresAtMs
          : null,
        willRenew,
        lifecycleState: hasFutureGrace && !hasFutureExpiry
          ? "grace"
          : willRenew === false
          ? "canceled"
          : "active",
        environment: isSandbox === undefined
          ? null
          : isSandbox
          ? "SANDBOX"
          : "PRODUCTION",
      },
    };
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timeout);
  }
}
