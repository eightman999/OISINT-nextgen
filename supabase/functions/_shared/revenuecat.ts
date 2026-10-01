import { z } from "zod";

export const REVENUECAT_ENTITLEMENT_ID = "plus" as const;
export const REVENUECAT_OFFERING_ID = "default" as const;
export const REVENUECAT_PRODUCT_IDS = [
  "oisint_plus_monthly",
  "oisint_plus_annual",
] as const;

export type RevenueCatProductId = typeof REVENUECAT_PRODUCT_IDS[number];

const MAX_REVENUECAT_TIMESTAMP_MS = Date.parse("2100-01-01T00:00:00.000Z");
// Webhook event timestamps describe when RevenueCat emitted the event.  A
// small clock-skew window is enough for legitimate delivery while rejecting
// forged far-future events.  Expiration timestamps use the wider legacy bound
// above because a valid entitlement may span multiple billing periods.
const MAX_EVENT_TIMESTAMP_FUTURE_MS = 5 * 60 * 1000;
const nullableString = z.string().trim().max(256).nullable().optional();
const nullableTimestamp = z.number().int().nonnegative().safe()
  .max(MAX_REVENUECAT_TIMESTAMP_MS).nullable().optional();
const eventTimestamp = z.number().int().nonnegative().safe().refine(
  (value) => value <= Date.now() + MAX_EVENT_TIMESTAMP_FUTURE_MS,
  { message: "event timestamp is too far in the future" },
);

// RevenueCat は将来イベントへフィールドを追加するため passthrough とするが、
// DBへ渡す前に下の selected fields だけへ縮約する。aliases/個人属性は保存しない。
const revenueCatEventSchema = z.object({
  id: z.string().trim().min(1).max(256),
  type: z.string().trim().min(1).max(80),
  event_timestamp_ms: eventTimestamp,
  app_id: nullableString,
  app_user_id: z.string().trim().min(1).max(256).optional(),
  original_app_user_id: nullableString,
  entitlement_id: nullableString,
  entitlement_ids: z.array(z.string().trim().min(1).max(128)).max(20).nullable()
    .optional(),
  product_id: nullableString,
  new_product_id: nullableString,
  offering_id: nullableString,
  presented_offering_id: nullableString,
  store: nullableString,
  environment: nullableString,
  expiration_at_ms: nullableTimestamp,
  grace_period_expiration_at_ms: nullableTimestamp,
  will_renew: z.boolean().optional(),
  // 公式TRANSFERは $RCAnonymousID 等の任意App User IDを含み得る。
  // UUID/恒久userかどうかはDB側で検証し、ここではbounded stringとして受ける。
  transferred_from: z.array(z.string().trim().min(1).max(256)).max(100)
    .optional(),
  transferred_to: z.array(z.string().trim().min(1).max(256)).max(100)
    .optional(),
}).passthrough();

export const revenueCatWebhookSchema = z.object({
  api_version: z.string().trim().min(1).max(80),
  event: revenueCatEventSchema,
}).passthrough();

export type RevenueCatWebhook = z.infer<typeof revenueCatWebhookSchema>;
export type RevenueCatEvent = RevenueCatWebhook["event"];

export function isPlusEvent(event: RevenueCatEvent): boolean {
  return event.entitlement_id === REVENUECAT_ENTITLEMENT_ID ||
    event.entitlement_ids?.includes(REVENUECAT_ENTITLEMENT_ID) === true;
}

/**
 * RevenueCatのApp User IDに使う恒久Supabase subjectを正規化する。
 * UUID v4だけに狭めず、Supabase Authが発行したUUIDのversion集合を受ける。
 * DBのsubject比較とWeb/iOS/AndroidのSDK identityを同じ小文字表記に揃える。
 */
export function parseSupabaseUserId(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const parsed = z.string().uuid().safeParse(value.trim());
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export function isKnownProduct(
  value: string | null | undefined,
): value is RevenueCatProductId {
  return (REVENUECAT_PRODUCT_IDS as readonly string[]).includes(value ?? "");
}

/**
 * Googleの署名通知だけ、確認済みのsubscription:basePlanをDBの正規IDへ変換する。
 * 未知IDは欠落値へ置き換えず残し、後段のallow-listで拒否する。
 * DB/Subscriber API/クライアントの正規商品集合はbare IDのまま維持する。
 */
export function revenueCatEventProductId(
  event: RevenueCatEvent,
): string | null {
  const value = event.type === "PRODUCT_CHANGE"
    ? event.new_product_id ?? event.product_id ?? null
    : event.product_id ?? null;
  if (event.store === "PLAY_STORE") {
    if (value === "oisint_plus_monthly:monthly2") return "oisint_plus_monthly";
    if (value === "oisint_plus_annual:2annual") return "oisint_plus_annual";
  }
  return value;
}

export type EntitlementLifecycle =
  | "free"
  | "active"
  | "canceled"
  | "grace"
  | "billing_issue"
  | "expired";

export interface EntitlementSnapshot {
  is_active: boolean;
  lifecycle_state: EntitlementLifecycle;
  product_id: RevenueCatProductId | null;
  expires_at: string | null;
  grace_period_expires_at: string | null;
  will_renew: boolean;
  last_event_id: string;
  last_event_timestamp_ms: number;
}

export type EntitlementMutation =
  | { kind: "ignore"; reason: string }
  | {
    kind: "upsert";
    is_active: boolean;
    lifecycle_state: EntitlementLifecycle;
    product_id: RevenueCatProductId | null;
    expires_at: string | null;
    grace_period_expires_at: string | null;
    will_renew: boolean;
  };

function timestampToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function existingProduct(
  value: string | null | undefined,
): RevenueCatProductId | null {
  return isKnownProduct(value) ? value : null;
}

const KNOWN_WEBHOOK_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "CANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "PRODUCT_CHANGE",
  "SUBSCRIPTION_PAUSED",
  "UNCANCELLATION",
  "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED",
]);

const EXPIRATION_PROOF_REQUIRED_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED",
]);

function isFutureIsoAt(value: string | null, nowMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

/**
 * Webhook lifecycle の純粋な状態遷移。DB RPCでも同じ規則を防御的に再検証する。
 * 不明な entitlement / product / 時系列は grant せず ignore する。
 */
export function buildEntitlementMutation(
  event: RevenueCatEvent,
  existing?: EntitlementSnapshot,
  nowMs = Date.now(),
): EntitlementMutation {
  if (!isPlusEvent(event)) {
    return { kind: "ignore", reason: "entitlement_not_plus" };
  }
  if (!KNOWN_WEBHOOK_EVENT_TYPES.has(event.type)) {
    return { kind: "ignore", reason: "unknown_event" };
  }
  const eventProductId = revenueCatEventProductId(event);
  // `presented_offering_id` is an official nullable field.  When the key is
  // present with null, do not fall back to a legacy/unknown offering value.
  const presentedOfferingId = event.presented_offering_id !== undefined
    ? event.presented_offering_id
    : event.offering_id;
  if (
    eventProductId !== null && eventProductId !== undefined &&
    !isKnownProduct(eventProductId)
  ) {
    return { kind: "ignore", reason: "unknown_product" };
  }
  if (
    presentedOfferingId !== null && presentedOfferingId !== undefined &&
    presentedOfferingId !== REVENUECAT_OFFERING_ID
  ) {
    return { kind: "ignore", reason: "unknown_offering" };
  }
  if (
    existing && event.event_timestamp_ms <= existing.last_event_timestamp_ms
  ) {
    return { kind: "ignore", reason: "stale_or_duplicate_event" };
  }

  const productId = existingProduct(eventProductId) ?? existing?.product_id ??
    null;
  if (!productId && event.type !== "EXPIRATION") {
    return { kind: "ignore", reason: "missing_product" };
  }

  const eventExpiresAt = timestampToIso(event.expiration_at_ms);
  const eventGraceExpiresAt = timestampToIso(
    event.grace_period_expiration_at_ms,
  );
  const expiresAt = event.expiration_at_ms !== null &&
      event.expiration_at_ms !== undefined
    ? eventExpiresAt
    : existing?.expires_at ?? null;
  const graceExpiresAt = event.grace_period_expiration_at_ms !== null &&
      event.grace_period_expiration_at_ms !== undefined
    ? eventGraceExpiresAt
    : existing?.grace_period_expires_at ?? null;
  const hasFutureSignedAccess = isFutureIsoAt(expiresAt, nowMs) ||
    isFutureIsoAt(graceExpiresAt, nowMs);
  const hasFutureEventProof = isFutureIsoAt(eventExpiresAt, nowMs) ||
    isFutureIsoAt(eventGraceExpiresAt, nowMs);
  if (
    EXPIRATION_PROOF_REQUIRED_EVENT_TYPES.has(event.type) &&
    !hasFutureEventProof
  ) {
    return { kind: "ignore", reason: "missing_expiration" };
  }
  const isActive = event.type === "EXPIRATION" ? false : hasFutureSignedAccess;
  const lifecycleState: EntitlementLifecycle = event.type === "EXPIRATION"
    ? "expired"
    : event.type === "BILLING_ISSUE"
    ? isFutureIsoAt(graceExpiresAt, nowMs) ? "grace" : "billing_issue"
    : event.type === "CANCELLATION" || event.type === "PRODUCT_CHANGE" ||
        event.type === "SUBSCRIPTION_PAUSED"
    ? isActive ? "canceled" : "free"
    : isActive
    ? "active"
    : "free";

  return {
    kind: "upsert",
    is_active: isActive,
    lifecycle_state: lifecycleState,
    product_id: productId,
    expires_at: expiresAt,
    grace_period_expires_at: graceExpiresAt,
    will_renew: event.type === "CANCELLATION" || event.type === "EXPIRATION" ||
        event.type === "SUBSCRIPTION_PAUSED"
      ? false
      : event.type === "UNCANCELLATION"
      ? true
      : event.will_renew ?? existing?.will_renew ?? false,
  };
}

export function isEntitlementActiveAt(
  entitlement: Pick<
    EntitlementSnapshot,
    "is_active" | "lifecycle_state" | "expires_at" | "grace_period_expires_at"
  >,
  nowMs: number,
): boolean {
  if (!entitlement.is_active || !Number.isFinite(nowMs)) return false;
  const expiresAt = entitlement.expires_at === null
    ? null
    : Date.parse(entitlement.expires_at);
  const graceAt = entitlement.grace_period_expires_at === null
    ? null
    : Date.parse(entitlement.grace_period_expires_at);
  if (entitlement.expires_at !== null && !Number.isFinite(expiresAt)) {
    return false;
  }
  if (
    entitlement.grace_period_expires_at !== null && !Number.isFinite(graceAt)
  ) return false;
  if (
    !(["active", "canceled", "grace", "billing_issue"] as string[]).includes(
      entitlement.lifecycle_state,
    )
  ) return false;
  // null is not a lifetime subscription.  Access requires a finite future
  // expiry or an explicitly recorded future grace window.
  return (expiresAt !== null && expiresAt > nowMs) ||
    (graceAt !== null && graceAt > nowMs);
}

/** ログ/監査に残すのは状態遷移に必要な最小集合だけ。個人属性や aliases は除外する。 */
export function redactRevenueCatEvent(
  payload: RevenueCatWebhook,
): Record<string, unknown> {
  const event = payload.event;
  return {
    api_version: payload.api_version,
    event: {
      id: event.id,
      type: event.type,
      event_timestamp_ms: event.event_timestamp_ms,
      app_id: event.app_id,
      app_user_id: event.app_user_id,
      entitlement_id: event.entitlement_id,
      entitlement_ids: event.entitlement_ids,
      product_id: event.product_id,
      offering_id: event.offering_id,
      presented_offering_id: event.presented_offering_id,
      store: event.store,
      environment: event.environment,
      expiration_at_ms: event.expiration_at_ms,
      grace_period_expiration_at_ms: event.grace_period_expiration_at_ms,
      will_renew: event.will_renew,
    },
  };
}

export type WebhookAuthDecision =
  | { ok: true }
  | { ok: false; status: 401 | 500; reason: "missing_config" | "mismatch" };

export const REVENUECAT_SECRET_MIN_LENGTH = 32;
export const REVENUECAT_SECRET_MAX_LENGTH = 256;
const MAX_WEBHOOK_AUTH_HEADER_LENGTH = 512;
const MAX_WEBHOOK_SIGNATURE_AGE_SECONDS = 300;

/**
 * API key/token/HMAC secret はサーバー設定値であり、制御文字・空白・
 * 過度に長い値を受け付けない。値をtrimして別の秘密へ変換しないことも
 * 意図的な仕様である。
 */
export function isValidRevenueCatSecret(
  value: string | undefined,
): value is string {
  return value !== undefined &&
    value.length >= REVENUECAT_SECRET_MIN_LENGTH &&
    value.length <= REVENUECAT_SECRET_MAX_LENGTH &&
    /^[\x21-\x7e]+$/.test(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export function authorizeRevenueCatWebhook(
  authorizationHeader: string | null,
  expectedToken: string | undefined,
): WebhookAuthDecision {
  if (!isValidRevenueCatSecret(expectedToken)) {
    return { ok: false, status: 500, reason: "missing_config" };
  }
  if (
    authorizationHeader === null ||
    authorizationHeader.length > MAX_WEBHOOK_AUTH_HEADER_LENGTH
  ) {
    return { ok: false, status: 401, reason: "mismatch" };
  }
  const presented = authorizationHeader?.match(/^Bearer[\t ]+(.+)$/i)?.[1] ??
    "";
  if (presented.length > REVENUECAT_SECRET_MAX_LENGTH) {
    return { ok: false, status: 401, reason: "mismatch" };
  }
  return constantTimeEqual(presented, expectedToken)
    ? { ok: true }
    : { ok: false, status: 401, reason: "mismatch" };
}

export type WebhookSignatureDecision =
  | { ok: true }
  | {
    ok: false;
    status: 401 | 500;
    reason: "missing_config" | "mismatch";
  };

interface RevenueCatSignatureParts {
  timestampSeconds: number;
  signatureHex: string;
}

function parseRevenueCatSignatureHeader(
  header: string | null,
): RevenueCatSignatureParts | null {
  if (!header || header.length > MAX_WEBHOOK_AUTH_HEADER_LENGTH) return null;
  const fields = header.split(",");
  if (fields.length !== 2) return null;
  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator !== field.lastIndexOf("=")) return null;
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (name === "t" && timestamp === undefined) timestamp = value;
    else if (name === "v1" && signature === undefined) signature = value;
    else return null;
  }
  // Unix seconds currently fit in ten digits.  The explicit bound prevents
  // Number coercion and constant-time comparison from becoming an input DoS.
  if (!timestamp || !/^\d{1,10}$/.test(timestamp)) return null;
  if (!signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return null;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    return null;
  }
  return { timestampSeconds, signatureHex: signature.toLowerCase() };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hmacSha256Hex(
  secret: string,
  value: string | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, payload as unknown as BufferSource),
  );
}

function signaturePayload(
  timestampSeconds: number,
  rawBody: string | Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode(`${timestampSeconds}.`);
  const body = typeof rawBody === "string"
    ? new TextEncoder().encode(rawBody)
    : rawBody;
  const payload = new Uint8Array(prefix.byteLength + body.byteLength);
  payload.set(prefix, 0);
  payload.set(body, prefix.byteLength);
  return payload;
}

/** テストと署名検証が共有する、RevenueCatのraw-body署名生成。 */
export function createRevenueCatWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string | Uint8Array,
): Promise<string> {
  if (
    !isValidRevenueCatSecret(secret) ||
    !Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0
  ) {
    throw new Error("invalid_revenuecat_signature_input");
  }
  return hmacSha256Hex(secret, signaturePayload(timestampSeconds, rawBody));
}

/**
 * RevenueCat公式形式 t=<unix>,v1=<HMAC-SHA256(raw)> を検証する。
 * JSON parse/再serialize後の値ではなく、受信した本文そのものを署名対象にする。
 */
export async function authorizeRevenueCatWebhookSignature(
  signatureHeader: string | null,
  secret: string | undefined,
  rawBody: string | Uint8Array,
  nowMs = Date.now(),
): Promise<WebhookSignatureDecision> {
  if (!isValidRevenueCatSecret(secret)) {
    return { ok: false, status: 500, reason: "missing_config" };
  }
  const parts = parseRevenueCatSignatureHeader(signatureHeader);
  if (!parts || !Number.isFinite(nowMs)) {
    return { ok: false, status: 401, reason: "mismatch" };
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    Math.abs(nowSeconds - parts.timestampSeconds) >
      MAX_WEBHOOK_SIGNATURE_AGE_SECONDS
  ) {
    return { ok: false, status: 401, reason: "mismatch" };
  }
  try {
    const expected = await hmacSha256Hex(
      secret,
      signaturePayload(parts.timestampSeconds, rawBody),
    );
    return constantTimeEqual(expected, parts.signatureHex)
      ? { ok: true }
      : { ok: false, status: 401, reason: "mismatch" };
  } catch {
    return { ok: false, status: 500, reason: "missing_config" };
  }
}

export type RevenueCatEventConfigDecision =
  | { ok: true }
  | {
    ok: false;
    status: 500 | 400;
    reason: "missing_config" | "app_mismatch" | "environment_mismatch";
  };

/** Webhook URLが明示されたアプリ/環境だけを受けるserver-side allow-list。 */
export function authorizeRevenueCatEventConfig(
  event: RevenueCatEvent,
  expectedAppId: string | undefined,
  allowedEnvironments: ReadonlySet<string>,
  allowMissingEnvironment = false,
): RevenueCatEventConfigDecision {
  const appIds = expectedAppId?.split(",").map((id) => id.trim()) ?? [];
  if (
    appIds.length === 0 || appIds.some((id) => id.length === 0) ||
    allowedEnvironments.size === 0
  ) {
    return { ok: false, status: 500, reason: "missing_config" };
  }
  if (!event.app_id || !appIds.includes(event.app_id)) {
    return { ok: false, status: 400, reason: "app_mismatch" };
  }
  if (
    (!event.environment && !allowMissingEnvironment) ||
    (event.environment && !allowedEnvironments.has(event.environment))
  ) {
    return { ok: false, status: 400, reason: "environment_mismatch" };
  }
  return { ok: true };
}
