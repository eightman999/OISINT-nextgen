import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { handleEgressHop } from "./egress";
import { isRealNonFutureJstDate } from "./calendarDate";

// `wrangler types` が wrangler.toml の vars / Durable Object binding から生成し、
// secret型は worker-secrets.d.ts の型専用augmentationで補う。secret値はworkflowの
// preflight/storeからのみ投入し、ここへ手書きの値やruntime判定を追加しない。
export type Env = CloudflareEnv;

type Ctx = Context<{ Bindings: Env; Variables: { requestId: string } }>;

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
const textEncoder = new TextEncoder();
const PUBLIC_REQUEST_MAX_BYTES = 4_096;
export const PUBLIC_REQUEST_BODY_TIMEOUT_MS = 2_000;
const EGRESS_REQUEST_MAX_BYTES = 4_096;
export const EGRESS_REQUEST_BODY_TIMEOUT_MS = 2_000;
const UPSTREAM_RESPONSE_MAX_BYTES = 1_048_576;
const UPSTREAM_REQUEST_MAX_BYTES = 16 * 1_024;
const UPSTREAM_HEADER_MAX_BYTES = 8 * 1_024;
/**
 * Upstream budgets are selected by endpoint.  Research is a short receipt
 * (the heavy work continues in the Edge Function), create has the documented
 * synchronous parse/embedding chain (the Edge function has a ten-second hard
 * deadline), and requirement-added rerank awaits up
 * to two provider attempts per candidate at the 60-second candidate budget
 * (candidates run concurrently). Worker budgets include DB/ranking margin and
 * are strictly above Edge hard deadlines; client budgets are larger again so
 * an outer layer never abandons a still-valid inner operation first.
 */
export const EDGE_TIMEOUT_CONTRACT = {
  receipt: 5_000,
  synchronousCreate: 10_000,
  synchronousRerank: 155_000,
} as const;
export const UPSTREAM_TIMEOUT_POLICY = {
  receipt: 10_000,
  synchronousCreate: 14_000,
  synchronousRerank: 180_000,
} as const;
type UpstreamTimeoutPolicy = keyof typeof UPSTREAM_TIMEOUT_POLICY;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
type BufferedUpstreamResponse = {
  response: Response;
  body: BoundedTextResult;
};

/**
 * Build an endpoint only from the configured Supabase origin.  The API Worker
 * forwards browser credentials, so an arbitrary URL, redirect, userinfo, port,
 * or pre-existing path would be an egress/credential disclosure boundary.
 */
export function buildTrustedSupabaseEndpoint(
  rawOrigin: string,
  path: string,
  allowLoopbackOrigin = false,
): string | null {
  try {
    const origin = new URL(rawOrigin);
    const isProductionOrigin =
      origin.protocol === "https:" &&
      !origin.port &&
      /^[a-z0-9][a-z0-9-]{0,62}\.supabase\.co$/i.test(origin.hostname);
    const isExplicitLocalOrigin =
      allowLoopbackOrigin &&
      origin.protocol === "http:" &&
      origin.hostname === "127.0.0.1" &&
      /^\d{1,5}$/.test(origin.port) &&
      Number(origin.port) >= 1024 &&
      Number(origin.port) <= 65_535;
    if (
      origin.username ||
      origin.password ||
      (origin.pathname !== "" && origin.pathname !== "/") ||
      origin.search ||
      origin.hash ||
      (!isProductionOrigin && !isExplicitLocalOrigin) ||
      !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(path)
    ) {
      return null;
    }
    return new URL(path, origin.origin + "/").toString();
  } catch {
    return null;
  }
}

function boundedHeader(value: string | undefined): string | undefined {
  if (
    !value ||
    value.length > UPSTREAM_HEADER_MAX_BYTES ||
    /[\r\n]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

async function fetchUpstream(
  url: string,
  init: RequestInit,
  timeoutPolicy: UpstreamTimeoutPolicy = "receipt",
): Promise<BufferedUpstreamResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_POLICY[timeoutPolicy],
  );
  try {
    const response = await fetch(url, {
      ...init,
      // Workers runtimeは"error"を実装しないためmanualで受け、3xxを明示拒否する。
      // Locationを追わず、認証ヘッダーを別originへ転送しない境界は維持する。
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    // fetch() resolves when headers arrive. Keep the same deadline alive until
    // the bounded body stream finishes so a stalled upstream cannot hold the
    // Worker request indefinitely after sending headers.
    const body = await readBoundedText(response, UPSTREAM_RESPONSE_MAX_BYTES);
    return { response, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function serializeUpstreamBody(value: unknown): string | null {
  try {
    const body = JSON.stringify(value);
    if (body.length > UPSTREAM_REQUEST_MAX_BYTES) return null;
    return body;
  } catch {
    return null;
  }
}

type BoundedTextResult =
  | { ok: true; text: string }
  | {
    ok: false;
    kind: "too_large" | "invalid_encoding" | "timeout";
  };

async function readBoundedText(
  message: Request | Response,
  maxBytes: number,
  timeoutMs?: number,
): Promise<BoundedTextResult> {
  const declared = message.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    // 宣言値だけで上限超過を判定できる場合も、受信側のstreamを保持しない。
    // cancelはawaitせず、相手側の実装が停止しなくてもfail-closed応答を遅延させない。
    void message.body?.cancel().catch(() => {});
    return { ok: false, kind: "too_large" };
  }

  const reader = message.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timeoutMarker = Symbol("body-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutMs === undefined
    ? null
    : new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
    });
  try {
    while (true) {
      const next = timeout
        ? await Promise.race([reader.read(), timeout])
        : await reader.read();
      if (next === timeoutMarker) {
        void reader.cancel().catch(() => {});
        return { ok: false, kind: "timeout" };
      }
      const { done, value } = next;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, kind: "too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes,
      ),
    };
  } catch {
    return { ok: false, kind: "invalid_encoding" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: "too_large" | "invalid" | "timeout" };

async function readPublicJson(
  request: Request,
  allowEmpty = false,
): Promise<JsonReadResult> {
  const body = await readBoundedText(
    request,
    PUBLIC_REQUEST_MAX_BYTES,
    PUBLIC_REQUEST_BODY_TIMEOUT_MS,
  );
  if (!body.ok) {
    return {
      ok: false,
      kind: body.kind === "too_large"
        ? "too_large"
        : body.kind === "timeout"
        ? "timeout"
        : "invalid",
    };
  }
  if (!body.text.trim()) {
    return allowEmpty
      ? { ok: true, value: {} }
      : { ok: false, kind: "invalid" };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, kind: "invalid" };
  }
}

function publicBodyError(
  c: Ctx,
  result: { kind: "too_large" | "invalid" | "timeout" },
): Response {
  if (result.kind === "too_large") {
    return c.json({ error: "リクエストが大きすぎます" }, 413);
  }
  if (result.kind === "timeout") {
    return c.json({ error: "リクエスト本文の受信がタイムアウトしました" }, 408);
  }
  return c.json({ error: "リクエストが不正です" }, 400);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// 全リクエストに request id を付与
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
});

// CORS: 本番 + ローカル開発オリジンのみ
app.use("*", (c, next) => {
  const allowed = c.env.CORS_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return cors({
    origin: allowed,
    allowHeaders: [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "idempotency-key",
    ],
    allowMethods: ["POST", "GET", "PATCH", "OPTIONS"],
    exposeHeaders: ["Retry-After", "x-request-id"],
    credentials: false,
  })(c, next);
});

app.get("/v1/health", (c) => c.json({ status: "ok" }));

const egressBodySchema = z.object({
  url: z.string().max(2_048),
  nonce: z.string().uuid(),
  validatedAddresses: z.array(z.string().min(3).max(45)).min(1).max(16),
});

export type EgressBodyFailureKind =
  | "timeout"
  | "too_large"
  | "invalid_encoding"
  | "malformed_json";
export type EgressJsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: EgressBodyFailureKind };

export async function readEgressJson(
  request: Request,
): Promise<EgressJsonReadResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, kind: "malformed_json" };
  }
  const body = await readBoundedText(
    request,
    EGRESS_REQUEST_MAX_BYTES,
    EGRESS_REQUEST_BODY_TIMEOUT_MS,
  );
  if (!body.ok) {
    return { ok: false, kind: body.kind };
  }
  if (!body.text.trim()) {
    return { ok: false, kind: "malformed_json" };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, kind: "malformed_json" };
  }
}

function recordEgressBodyFailure(c: Ctx, kind: EgressBodyFailureKind): void {
  // body・URL・署名は記録せず、固定語彙の分類と生成済みrequest idだけを内部計測へ送る。
  console.warn(JSON.stringify({
    metric: "egress_request_body_rejected",
    kind,
    request_id: c.get("requestId"),
  }));
}

// Supabase Edge Functions専用の1-hop egress gateway (#193)。browserからの
// Authorizationは使わず、用途分離したEGRESS_GATEWAY_SECRETの短寿命HMACだけを受理する。
app.post("/v1/internal/egress-fetch", async (c) => {
  const timestamp = c.req.header("x-oisint-egress-timestamp");
  const signature = c.req.header("x-oisint-egress-signature");
  if (
    !/^\d{10}$/.test(timestamp ?? "") ||
    !/^[0-9a-f]{64}$/.test(signature ?? "")
  ) {
    return c.json({ error: "egress request rejected" }, 403);
  }
  const raw = await readEgressJson(c.req.raw);
  if (!raw.ok) {
    // 内部分類は観測に利用できる型として保持し、外部には詳細を返さない。
    // timeoutだけはクライアントが再送判断できる標準4xxへ写像する。
    recordEgressBodyFailure(c, raw.kind);
    return c.json(
      { error: "egress request rejected" },
      raw.kind === "timeout" ? 408 : 400,
    );
  }
  const parsed = egressBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "egress request rejected" }, 400);
  return handleEgressHop(
    c.env.EGRESS_GATEWAY_SECRET ?? "",
    parsed.data,
    {
      timestamp,
      signature,
    },
    {
      consumeNonce: async (nonce, expiresAtMs) => {
        const namespace = c.env.EGRESS_REPLAY_GUARD;
        if (!namespace)
          throw new Error("egress replay guard binding is unavailable");
        const response = await namespace
          .getByName(nonce)
          .fetch("https://egress-replay-guard/consume", {
            method: "POST",
            headers: { "x-oisint-replay-expires-at": String(expiresAtMs) },
          });
        if (response.status === 201) return true;
        if (response.status === 409) return false;
        throw new Error("egress replay guard rejected the request");
      },
    },
  );
});

// Supabase Edge Function へプロキシ
async function callFunction(
  c: Ctx,
  name: string,
  body: unknown,
  timeoutPolicy: UpstreamTimeoutPolicy = "receipt",
): Promise<Response> {
  const url = buildTrustedSupabaseEndpoint(
    c.env.SUPABASE_URL,
    `/functions/v1/${name}`,
    c.env.LOCAL_SUPABASE_DEV === "1",
  );
  if (!url) return c.json({ error: "上流サービスを利用できません" }, 503);
  const serializedBody = serializeUpstreamBody(body);
  if (serializedBody === null)
    return c.json({ error: "リクエストが大きすぎます" }, 413);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-request-id": c.get("requestId"),
  };
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey !== undefined) {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return c.json({ error: "リクエストが不正です" }, 400);
    }
    headers["Idempotency-Key"] = idempotencyKey;
  }
  const auth = boundedHeader(c.req.header("Authorization"));
  const suppliedAuth = c.req.header("Authorization");
  if (suppliedAuth && !auth) return c.json({ error: "認証が必要です" }, 401);
  if (auth) headers["Authorization"] = auth;
  const apikey = boundedHeader(c.req.header("apikey"));
  const suppliedApikey = c.req.header("apikey");
  if (suppliedApikey && !apikey)
    return c.json({ error: "リクエストが不正です" }, 400);
  if (apikey) headers["apikey"] = apikey;
  const clientIp = c.req.header("cf-connecting-ip");
  if (clientIp && c.env.RATE_LIMIT_SECRET?.length >= 32) {
    const clientKey = await hmacHex(c.env.RATE_LIMIT_SECRET, `ip:${clientIp}`);
    headers["X-OISINT-Client-Key"] = clientKey;
    headers["X-OISINT-Proxy-Signature"] = await hmacHex(
      c.env.RATE_LIMIT_SECRET,
      `proxy:${clientKey}`,
    );
  }

  const upstream = await fetchUpstream(
    url,
    {
      method: "POST",
      headers,
      body: serializedBody,
    },
    timeoutPolicy,
  );
  if (!upstream) return c.json({ error: "上流サービスに接続できません" }, 502);

  const { response: res, body: upstreamBody } = upstream;
  if (!upstreamBody.ok) {
    return c.json({ error: "上流サービスの応答を処理できません" }, 502);
  }
  const text = upstreamBody.text;
  const contentType = res.headers.get("Content-Type") ?? "application/json";
  const responseHeaders: Record<string, string> = {
    "Content-Type": contentType,
  };
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) responseHeaders["Retry-After"] = retryAfter;

  // JSON ならパースして返す。壊れていても原因を隠蔽せず中継する。
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      responseHeaders["Content-Type"] = "application/json";
      return c.newResponse(
        JSON.stringify(parsed),
        res.status as StatusCode,
        responseHeaders,
      );
    } catch {
      // JSONを名乗る壊れた上流本文は加工せず、診断に必要な元Content-Typeも保つ。
      return c.newResponse(text, res.status as StatusCode, responseHeaders);
    }
  }
  return c.newResponse(text, res.status as StatusCode, responseHeaders);
}

// Supabase PostgREST RPC へプロキシ (P1 書き込み系 #106)。
// ユーザー JWT (Authorization) をそのまま転送し、RPC 側の権限チェック
// (auth.uid() ベース) に委ねる。service role は Worker に置かない (§34)。
// apikey はクライアントから来ていればそちらを優先し、無ければ anon key
// (公開可 §34) を補う。callFunction と同じ方針。
type RpcResult =
  { ok: true; data: unknown } | { ok: false; status: number; message: string };

async function callRpc(
  c: Ctx,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const url = buildTrustedSupabaseEndpoint(
    c.env.SUPABASE_URL,
    `/rest/v1/rpc/${fn}`,
    c.env.LOCAL_SUPABASE_DEV === "1",
  );
  if (!url) {
    return { ok: false, status: 503, message: "上流サービスを利用できません" };
  }
  const serializedBody = serializeUpstreamBody(args);
  if (serializedBody === null) {
    return { ok: false, status: 413, message: "リクエストが大きすぎます" };
  }
  const suppliedApikey = c.req.header("apikey");
  const apikey =
    boundedHeader(suppliedApikey) ?? boundedHeader(c.env.SUPABASE_ANON_KEY);
  if (!apikey) {
    return { ok: false, status: 503, message: "上流サービスを利用できません" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey,
  };
  if (suppliedApikey && !boundedHeader(suppliedApikey)) {
    return { ok: false, status: 400, message: "リクエストが不正です" };
  }
  const suppliedAuth = c.req.header("Authorization");
  const auth = boundedHeader(suppliedAuth);
  if (suppliedAuth && !auth) {
    return { ok: false, status: 401, message: "認証が必要です" };
  }
  if (auth) headers["Authorization"] = auth;

  const upstream = await fetchUpstream(url, {
    method: "POST",
    headers,
    body: serializedBody,
  });
  if (!upstream) {
    return { ok: false, status: 502, message: "上流サービスに接続できません" };
  }

  const { response: res, body: upstreamBody } = upstream;
  if (!upstreamBody.ok) {
    return {
      ok: false,
      status: 502,
      message: "上流サービスの応答を処理できません",
    };
  }
  const text = upstreamBody.text;
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok) return { ok: true, data };

  // PostgREST のstatusだけを保持し、message/details/hintや非JSON本文は公開しない。
  // RPC固有の内部情報はWorker logにも複製せず、request idとupstream側logで追跡する。
  return {
    ok: false,
    status: res.status,
    message: publicRpcErrorMessage(res.status),
  };
}

function publicRpcErrorMessage(status: number): string {
  if (status === 400 || status === 422) return "リクエストが不正です";
  if (status === 401) return "認証が必要です";
  if (status === 403) return "この操作を行う権限がありません";
  if (status === 404) return "対象が見つかりません";
  if (status === 409) return "操作が競合しました";
  if (status === 429) return "しばらく待ってからもう一度お試しください";
  return "上流サービスの応答を処理できません";
}

function rpcError(
  c: Ctx,
  result: { status: number; message: string },
): Response {
  return c.newResponse(
    JSON.stringify({ error: result.message }),
    result.status as StatusCode,
    {
      "Content-Type": "application/json",
    },
  );
}

const uuidSchema = z.string().uuid();

const createBodySchema = z.object({
  query: z.string().min(1).max(500),
  displayName: z.string().min(1).max(40),
});

// GPS は run request の一時 search anchor にだけ許可する。Worker では
// 座標の補正・保存・ログ出力をせず、Edge Function へ検証済み値を中継する。
const locationAnchorSchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  })
  .strict();

const runResearchBodySchema = z
  .object({
    searchAnchor: locationAnchorSchema.optional(),
  })
  .strict();

const locationScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("current_location") }).strict(),
  z
    .object({ type: z.literal("point"), place: z.string().min(1).max(120) })
    .strict(),
  z
    .object({
      type: z.literal("line"),
      line: z.string().min(1).max(120),
      operator: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("between"),
      from: z.string().min(1).max(120),
      to: z.string().min(1).max(120),
      line: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("corridor"),
      from: z.string().min(1).max(120),
      to: z.string().min(1).max(120),
      line: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("station_hops"),
      origin: z.string().min(1).max(120),
      maxStops: z.number().int().min(0).max(100),
      line: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("travel_time"),
      origin: z.string().min(1).max(120),
      maxMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60),
    })
    .strict(),
]);

const locationResolveBodySchema = z.object({ scope: locationScopeSchema });

app.post("/v1/investigations", async (c) => {
  const raw = await readPublicJson(c.req.raw);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = createBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return c.json({ error: "Idempotency-Key が必要です" }, 400);
  }
  return callFunction(
    c,
    "create-investigation",
    parsed.data,
    "synchronousCreate",
  );
});

// Deterministic N02 rail Location Resolver. The Worker only validates and
// proxies; station/line expansion remains a server-side DB responsibility.
app.post("/v1/location/resolve", async (c) => {
  const raw = await readPublicJson(c.req.raw);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = locationResolveBodySchema.safeParse(raw.value);
  if (!parsed.success)
    return c.json({ error: "location scope が不正です" }, 400);
  return callFunction(c, "resolve-location", parsed.data);
});

app.post("/v1/investigations/:id/research", async (c) => {
  const id = c.req.param("id");
  if (!uuidSchema.safeParse(id).success) {
    return c.json({ error: "investigation id が不正です" }, 400);
  }
  const raw = await readPublicJson(c.req.raw, true);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = runResearchBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);
  return callFunction(c, "run-investigation", {
    investigationId: id,
    ...(parsed.data.searchAnchor
      ? { searchAnchor: parsed.data.searchAnchor }
      : {}),
  });
});

const rerankTriggerSchema = z.enum([
  "vote",
  "requirement_added",
  "requirement_removed",
]);
const rerankBodySchema = z
  .object({
    trigger: rerankTriggerSchema.optional(),
  })
  .passthrough();

app.post("/v1/investigations/:id/rerank", async (c) => {
  const id = c.req.param("id");
  if (!uuidSchema.safeParse(id).success) {
    return c.json({ error: "investigation id が不正です" }, 400);
  }
  const raw = await readPublicJson(c.req.raw, true);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = rerankBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);
  const trigger = parsed.data.trigger ?? "vote";
  return callFunction(
    c,
    "rerank-investigation",
    { investigationId: id, trigger },
    trigger === "requirement_added" ? "synchronousRerank" : "receipt",
  );
});

const joinBodySchema = z.object({
  shareToken: z.string().min(1),
  displayName: z.string().min(1).max(40),
});

app.post("/v1/investigations/join", async (c) => {
  const raw = await readPublicJson(c.req.raw);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = joinBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);
  return callFunction(c, "join-investigation", parsed.data);
});

// Investigation の公開 / 非公開切り替え (§3 P1, #106)。
// RPC set_investigation_visibility (migration 0007) を PostgREST 経由で呼ぶ
const visibilityBodySchema = z.object({
  visibility: z.enum(["private", "public"]),
});

app.patch("/v1/investigations/:id/visibility", async (c) => {
  const id = c.req.param("id");
  if (!uuidSchema.safeParse(id).success) {
    return c.json({ error: "investigation id が不正です" }, 400);
  }
  const raw = await readPublicJson(c.req.raw);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = visibilityBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  const result = await callRpc(c, "set_investigation_visibility", {
    p_investigation: id,
    p_visibility: parsed.data.visibility,
  });
  if (!result.ok) return rpcError(c, result);
  return c.json({ visibility: parsed.data.visibility });
});

const feedbackBodySchema = z
  .object({
    visitedAt: z.string().trim().refine(isRealNonFutureJstDate).optional(),
    rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
    aspect: z.enum(["noise", "space", "value", "service"]).optional(),
    aspectValue: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (
      b.visitedAt === undefined &&
      b.rating === undefined &&
      b.aspect === undefined &&
      b.aspectValue === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "at least one feedback field is required",
      });
    }
    if (b.aspectValue !== undefined && b.aspect === undefined) {
      ctx.addIssue({ code: "custom", message: "aspectValue requires aspect" });
    }
    if (b.aspectValue !== undefined && b.aspect !== undefined) {
      const allowedValues: Record<typeof b.aspect, readonly string[]> = {
        noise: ["quiet", "loud"],
        space: ["comfortable", "cramped"],
        value: ["good", "bad"],
        service: ["good", "bad"],
      };
      if (!allowedValues[b.aspect].includes(b.aspectValue)) {
        ctx.addIssue({
          code: "custom",
          message: "aspectValue is not canonical",
        });
      }
    }
  });

function buildFeedbackRpcArgs(
  placeId: string,
  body: z.infer<typeof feedbackBodySchema>,
  feedbackId?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { p_place: placeId };
  if (feedbackId !== undefined) args.p_feedback = feedbackId;
  if (body.visitedAt !== undefined) args.p_visited_at = body.visitedAt;
  if (body.rating !== undefined) args.p_rating = body.rating;
  if (body.aspect !== undefined) args.p_aspect = body.aspect;
  if (body.aspectValue !== undefined) args.p_aspect_value = body.aspectValue;
  return args;
}

app.post("/v1/places/:id/feedback", async (c) => {
  const id = c.req.param("id");
  if (!uuidSchema.safeParse(id).success) {
    return c.json({ error: "place id が不正です" }, 400);
  }
  const raw = await readPublicJson(c.req.raw);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = feedbackBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  // 未指定の項目は送らず、RPC 側の default null に委ねる
  const args = buildFeedbackRpcArgs(id, parsed.data);

  const result = await callRpc(c, "submit_place_feedback", args);
  if (!result.ok) return rpcError(c, result);
  // submit_place_feedback は作成した feedback 行の uuid を返す
  return c.json({ feedbackId: result.data });
});

// 来店フィードバックの編集 (#110)。
// RPC 側で place・feedback・auth.uid() を同時に検証し、place_facts の旧値と新値を
// 同一トランザクションで再計算する。未指定項目は RPC の default null で置換する。
app.patch("/v1/places/:id/feedback/:feedbackId", async (c) => {
  const placeId = c.req.param("id");
  const feedbackId = c.req.param("feedbackId");
  if (!uuidSchema.safeParse(placeId).success) {
    return c.json({ error: "place id が不正です" }, 400);
  }
  if (!uuidSchema.safeParse(feedbackId).success) {
    return c.json({ error: "feedback id が不正です" }, 400);
  }
  const raw = await readPublicJson(c.req.raw);
  if (!raw.ok) return publicBodyError(c, raw);
  const parsed = feedbackBodySchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  const args = buildFeedbackRpcArgs(placeId, parsed.data, feedbackId);

  const result = await callRpc(c, "update_place_feedback", args);
  if (!result.ok) return rpcError(c, result);
  return c.json({ feedbackId: result.data });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
