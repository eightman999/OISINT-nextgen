// run-investigation の自己再呼出し専用HMAC境界（Issue #171）。
//
// SUPABASE_SERVICE_ROLE_KEY をHTTPへ載せず、公開可能なanon keyはSupabase gateway
// のJWT検証だけに使う。関数内の権限昇格は、body hash・request id・短命timestamp・
// nonceを結んだ専用HMACを検証した場合だけ許可する。

type EnvReader = (name: string) => string | undefined;

export const INTERNAL_INVOKE_MAX_CLOCK_SKEW_SECONDS = 15;
export const INTERNAL_INVOKE_TIMESTAMP_HEADER = "x-oisint-invoke-timestamp";
export const INTERNAL_INVOKE_NONCE_HEADER = "x-oisint-invoke-nonce";
export const INTERNAL_INVOKE_SIGNATURE_HEADER = "x-oisint-invoke-signature";

const SECRET_MIN_LENGTH = 32;
const SECRET_MAX_LENGTH = 256;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function defaultEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

function validSecret(value: string): boolean {
  return value.length >= SECRET_MIN_LENGTH &&
    value.length <= SECRET_MAX_LENGTH &&
    /^[\x21-\x7e]+$/.test(value);
}

function secretCollidesWithAnotherPurpose(
  secret: string,
  env: EnvReader,
): boolean {
  return [
    "RATE_LIMIT_SECRET",
    "EGRESS_GATEWAY_SECRET",
    "RUN_QUEUE_DRAIN_KEY",
    "REVENUECAT_WEBHOOK_HMAC_SECRET",
  ].some((name) => {
    const other = env(name);
    return Boolean(other && other === secret);
  });
}

function internalSecrets(env: EnvReader): readonly string[] | null {
  const current = env("INTERNAL_INVOKE_SECRET") ?? "";
  if (!validSecret(current) || secretCollidesWithAnotherPurpose(current, env)) {
    return null;
  }
  const previous = env("INTERNAL_INVOKE_SECRET_PREVIOUS") ?? "";
  if (!previous) return [current];
  if (
    !validSecret(previous) || previous === current ||
    secretCollidesWithAnotherPurpose(previous, env)
  ) {
    return null;
  }
  return [current, previous];
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function signaturePayload(
  timestamp: string,
  nonce: string,
  requestId: string,
  body: string,
): Promise<string> {
  return `run-investigation:v1:${timestamp}:${nonce}:${requestId}:${await sha256Hex(
    body,
  )}`;
}

export interface InternalInvocationHeaders {
  readonly [header: string]: string;
  readonly [INTERNAL_INVOKE_TIMESTAMP_HEADER]: string;
  readonly [INTERNAL_INVOKE_NONCE_HEADER]: string;
  readonly [INTERNAL_INVOKE_SIGNATURE_HEADER]: string;
}

/** 送信側。現在secretだけで署名し、rotation中のpreviousは検証専用とする。 */
export async function createInternalInvocationHeaders(
  body: string,
  requestId: string,
  options: {
    env?: EnvReader;
    nowMs?: number;
    nonce?: string;
  } = {},
): Promise<InternalInvocationHeaders | null> {
  const env = options.env ?? defaultEnv;
  const secrets = internalSecrets(env);
  const nowMs = options.nowMs ?? Date.now();
  const nonce = options.nonce ?? crypto.randomUUID();
  if (
    !secrets || !Number.isFinite(nowMs) ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    !NONCE_PATTERN.test(nonce)
  ) return null;
  const timestamp = String(Math.floor(nowMs / 1_000));
  if (!/^\d{10}$/.test(timestamp)) return null;
  const payload = await signaturePayload(timestamp, nonce, requestId, body);
  return {
    [INTERNAL_INVOKE_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_INVOKE_NONCE_HEADER]: nonce,
    [INTERNAL_INVOKE_SIGNATURE_HEADER]: await hmacHex(secrets[0], payload),
  };
}

/** 受信側。current/previousの両方を計算し、短命かつbody-boundな署名だけを許可する。 */
export async function authorizeInternalInvocation(
  headers: Headers,
  body: string,
  requestId: string,
  options: { env?: EnvReader; nowMs?: number } = {},
): Promise<boolean> {
  const env = options.env ?? defaultEnv;
  const secrets = internalSecrets(env);
  const nowMs = options.nowMs ?? Date.now();
  const timestamp = headers.get(INTERNAL_INVOKE_TIMESTAMP_HEADER) ?? "";
  const nonce = headers.get(INTERNAL_INVOKE_NONCE_HEADER) ?? "";
  const signature = headers.get(INTERNAL_INVOKE_SIGNATURE_HEADER) ?? "";
  if (
    !secrets || !Number.isFinite(nowMs) ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    !/^\d{10}$/.test(timestamp) || !NONCE_PATTERN.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) return false;
  const requestSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    !Number.isSafeInteger(requestSeconds) ||
    Math.abs(nowSeconds - requestSeconds) >
      INTERNAL_INVOKE_MAX_CLOCK_SKEW_SECONDS
  ) return false;

  const payload = await signaturePayload(timestamp, nonce, requestId, body);
  const expected = await Promise.all(
    secrets.map((secret) => hmacHex(secret, payload)),
  );
  // rotation有無で早期returnせず、設定された候補をすべて比較する。
  return expected.reduce(
    (matched, candidate) => constantTimeEqual(signature, candidate) || matched,
    false,
  );
}
