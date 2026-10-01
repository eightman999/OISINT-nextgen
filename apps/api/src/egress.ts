import { isPublicIpAddress } from "./ip";

const textEncoder = new TextEncoder();

export const EGRESS_POLICY = "deny-private-public-egress-v1";
// 実送出される唯一の UA。supabase/functions/_shared/providers/fetcher.ts の
// USER_AGENT (robots.txt の product token 照合に使う) と同一値であること。
// 一致は supabase/tests/robots_test.ts が検証する。
export const EGRESS_USER_AGENT = "OISINT-Fetcher/0.2 (+https://oisint.com; research bot)";
export const EGRESS_MAX_BYTES = 500_000;
export const EGRESS_MAX_CLOCK_SKEW_SECONDS = 15;
const DOH_MAX_BYTES = 65_536;
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const RESPONSE_ABORTED = "response-aborted" as const;

export interface EgressRequestBody {
  url: string;
  nonce: string;
  validatedAddresses: string[];
}

export interface EgressAuthHeaders {
  timestamp: string | undefined;
  signature: string | undefined;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalAddresses(addresses: readonly string[]): string {
  return [...new Set(addresses)].sort().join(",");
}

export function egressSignaturePayload(
  timestamp: string,
  nonce: string,
  url: string,
  addresses: readonly string[],
): string {
  return `egress:v2:${timestamp}:${nonce}:${url}:${canonicalAddresses(addresses)}`;
}

export function createEgressSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  url: string,
  addresses: readonly string[],
): Promise<string> {
  return hmacHex(secret, egressSignaturePayload(timestamp, nonce, url, addresses));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname);
}

export function normalizeEgressUrl(rawUrl: string): URL | null {
  if (!rawUrl || rawUrl !== rawUrl.trim() || !/^https:\/\//i.test(rawUrl)) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname || url.port) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    isIpLiteral(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    hostname === "oisint.com" ||
    hostname.endsWith(".oisint.com")
  ) {
    return null;
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
}

/**
 * Redirect の Location を caller (Deno fetcher) へ返す前に gateway 側でも検証する。
 * fetcher は次 hop を normalizeFetchUrl + same-origin + DNS で再検証するが、
 * 両層が独立に拒否できるよう (src/ip.ts 冒頭の方針)、ここでも base (検証済み
 * target) で相対 Location を解決し、normalizeEgressUrl を通らない URL・
 * cross-origin の URL は破棄する。破棄時は Location header を返さないため、
 * caller 側は redirect を辿れず fail-closed になる。
 */
export function sanitizeRedirectLocation(location: string, base: URL): string | null {
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch {
    return null;
  }
  const normalized = normalizeEgressUrl(resolved.href);
  if (!normalized || normalized.origin !== base.origin) return null;
  return normalized.href;
}

function validAddressEvidence(addresses: readonly string[]): boolean {
  if (addresses.length < 1 || addresses.length > 16) return false;
  return addresses.every((address) => address.length <= 45 && isPublicIpAddress(address));
}

function validNonce(nonce: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    nonce,
  );
}

interface DnsJsonAnswer {
  type?: unknown;
  data?: unknown;
}

interface DnsJsonResponse {
  Status?: unknown;
  TC?: unknown;
  Answer?: unknown;
}

async function queryDns(
  hostname: string,
  type: "A" | "AAAA",
  signal: AbortSignal,
): Promise<string[] | null> {
  const endpoint = new URL(DOH_ENDPOINT);
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", type);
  const response = await fetch(endpoint, {
    headers: { Accept: "application/dns-json" },
    redirect: "error",
    cache: "no-store",
    signal,
  });
  if (!response.ok) return null;
  if (!(response.headers.get("content-type") ?? "").includes("application/dns-json")) {
    return null;
  }
  const limited = await readAtMost(response, DOH_MAX_BYTES, signal);
  if (limited.aborted || limited.exceeded) return null;
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    limited.bytes,
  );
  const parsed = JSON.parse(text) as DnsJsonResponse;
  if (parsed.Status !== 0 || parsed.TC === true) return null;
  const expectedType = type === "A" ? 1 : 28;
  const answers = Array.isArray(parsed.Answer) ? parsed.Answer as DnsJsonAnswer[] : [];
  return answers
    .filter((answer) => answer.type === expectedType && typeof answer.data === "string")
    .map((answer) => String(answer.data));
}

async function resolvePublicDns(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  const records = await Promise.all([
    queryDns(hostname, "A", signal),
    queryDns(hostname, "AAAA", signal),
  ]);
  if (records.some((record) => record === null)) return null;
  const addresses = [...new Set(records.flatMap((record) => record ?? []))];
  if (addresses.length < 1 || addresses.length > 16) return null;
  return addresses.every(isPublicIpAddress) ? addresses : null;
}

async function authorized(
  secret: string,
  body: EgressRequestBody,
  headers: EgressAuthHeaders,
  nowMs: number,
): Promise<boolean> {
  if (secret.length < 32 || !headers.timestamp || !headers.signature) return false;
  if (!/^\d{10}$/.test(headers.timestamp) || !/^[0-9a-f]{64}$/.test(headers.signature)) {
    return false;
  }
  const requestSeconds = Number(headers.timestamp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - requestSeconds) > EGRESS_MAX_CLOCK_SKEW_SECONDS) return false;
  if (!validNonce(body.nonce)) return false;
  if (!validAddressEvidence(body.validatedAddresses)) return false;

  const expected = await createEgressSignature(
    secret,
    headers.timestamp,
    body.nonce,
    body.url,
    body.validatedAddresses,
  );
  return constantTimeEqual(expected, headers.signature);
}

type BoundedResponse = {
  bytes: Uint8Array;
  truncated: boolean;
  exceeded: boolean;
  aborted: boolean;
};

async function readAtMost(
  response: Response,
  maxBytes = EGRESS_MAX_BYTES,
  signal?: AbortSignal,
): Promise<BoundedResponse> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared)) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      void response.body?.cancel().catch(() => {});
      return {
        bytes: new Uint8Array(),
        truncated: true,
        exceeded: true,
        aborted: false,
      };
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return {
      bytes: new Uint8Array(),
      truncated: false,
      exceeded: false,
      aborted: signal?.aborted ?? false,
    };
  }

  type ReadResult =
    | { kind: "read"; result: ReadableStreamReadResult<Uint8Array> }
    | { kind: typeof RESPONSE_ABORTED };
  let removeAbortListener: (() => void) | undefined;
  const aborted = signal
    ? new Promise<ReadResult>((resolve) => {
      const onAbort = () => {
        void reader.cancel().catch(() => {});
        resolve({ kind: RESPONSE_ABORTED });
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
    })
    : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    // 上限ちょうどの本文は次のreadでdoneを確認し、上限+1を受け取った時点で
    // 追加の本文を保持せず直ちにcancelする。
    while (true) {
      const next: ReadResult = aborted
        ? await Promise.race([
          reader.read().then((result) => ({ kind: "read" as const, result })),
          aborted,
        ])
        : { kind: "read", result: await reader.read() };
      if (next.kind === RESPONSE_ABORTED) {
        return { bytes: joinChunks(chunks, total), truncated: false, exceeded: false, aborted: true };
      }
      const { done, value } = next.result;
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        exceeded = true;
        // cancelのPromise自体は待たない。応答側のcancelが停止しても、上限超過の
        // fail-closed応答をこのWorker内で遅延させないためである。
        void reader.cancel().catch(() => {});
        break;
      }
      if (value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      return { bytes: joinChunks(chunks, total), truncated: false, exceeded: false, aborted: true };
    }
    throw error;
  } finally {
    removeAbortListener?.();
  }

  return {
    bytes: joinChunks(chunks, total),
    truncated: exceeded || total === maxBytes,
    exceeded,
    aborted: false,
  };
}

function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function gatewayError(status: 400 | 403 | 502): Response {
  return Response.json({ error: "egress request rejected" }, { status });
}

export async function handleEgressHop(
  secret: string,
  body: EgressRequestBody,
  headers: EgressAuthHeaders,
  options: {
    nowMs?: number;
    fetchImpl?: FetchLike;
    consumeNonce?: (nonce: string, expiresAtMs: number) => Promise<boolean>;
  } = {},
): Promise<Response> {
  const nowMs = options.nowMs ?? Date.now();
  if (!(await authorized(secret, body, headers, nowMs))) return gatewayError(403);

  const target = normalizeEgressUrl(body.url);
  if (!target || target.href !== body.url) return gatewayError(400);

  // HMAC verification happens before the durable lookup so unauthenticated
  // traffic cannot allocate replay-guard objects. Every valid nonce maps to its
  // own object, avoiding a global serialization bottleneck.
  if (!options.consumeNonce) return gatewayError(502);
  try {
    const requestSeconds = Number(headers.timestamp);
    const expiresAtMs = (requestSeconds + EGRESS_MAX_CLOCK_SKEW_SECONDS + 5) * 1_000;
    if (!(await options.consumeNonce(body.nonce, expiresAtMs))) return gatewayError(403);
  } catch {
    console.error("[egress] replay_guard_failed");
    return gatewayError(502);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const gatewayAddresses = await resolvePublicDns(target.hostname, controller.signal);
    if (!gatewayAddresses) {
      console.error("[egress] dns_rejected");
      return gatewayError(403);
    }
    const upstream = await (options.fetchImpl ?? fetch)(target.href, {
      headers: {
        "Accept-Language": "ja",
        "Accept-Encoding": "identity",
        "Range": `bytes=0-${EGRESS_MAX_BYTES - 1}`,
        "User-Agent": EGRESS_USER_AGENT,
      },
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const location = upstream.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});
      const safeLocation = location ? sanitizeRedirectLocation(location, target) : null;
      if (safeLocation) responseHeaders.set("Location", safeLocation);
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    if (upstream.status === 101) {
      await upstream.body?.cancel().catch(() => {});
      return gatewayError(502);
    }

    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("Content-Type", contentType);
    const contentLength = Number(upstream.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > EGRESS_MAX_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      console.error("[egress] response_too_large");
      return gatewayError(502);
    }
    if ([204, 205, 304].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    const limited = await readAtMost(upstream, EGRESS_MAX_BYTES, controller.signal);
    if (limited.aborted) {
      console.error("[egress] response_timeout");
      return gatewayError(502);
    }
    if (limited.truncated) responseHeaders.set("X-OISINT-Truncated", "1");
    return new Response(limited.bytes, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    // 外部例外はURL/queryや接続情報を含み得るため、固定分類だけを記録する。
    console.error("[egress] upstream_failed");
    return gatewayError(502);
  } finally {
    clearTimeout(timeout);
  }
}
