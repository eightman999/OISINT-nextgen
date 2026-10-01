import type { SupabaseClient } from "@supabase/supabase-js";

export type RateLimitAction = "create" | "run" | "rerank" | "join";

export type RateLimitDecision =
  | { allowed: true }
  | {
    allowed: false;
    kind: "limited" | "unavailable";
    retryAfter: number;
  };

type EnvReader = (name: string) => string | undefined;

interface LimitValues {
  userHourly: number;
  userDaily: number;
  ipHourly: number;
}

interface RateLimitRule {
  scope: string;
  subject_hash: string;
  window_seconds: number;
  limit: number;
}

const CREATE_DEFAULTS: LimitValues = {
  userHourly: 10,
  userDaily: 30,
  ipHourly: 30,
};

const LIVE_DEFAULTS: Record<RateLimitAction, LimitValues> = {
  create: CREATE_DEFAULTS,
  run: { userHourly: 20, userDaily: 60, ipHourly: 60 },
  rerank: { userHourly: 60, userDaily: 200, ipHourly: 180 },
  // join は外部APIを呼ばないが、profiles/member/eventへの書き込みと
  // 直Edge経路のDB/Edge実行コストを保護する。createと同じ既定値を使う。
  join: CREATE_DEFAULTS,
};

const MOCK_MULTIPLIER = 10;
const textEncoder = new TextEncoder();

function defaultEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 100000 ? parsed : fallback;
}

export function readLimitValues(
  action: RateLimitAction,
  mode: "live" | "mock",
  env: EnvReader,
): LimitValues {
  const defaults = LIVE_DEFAULTS[action];
  const multiplier = mode === "mock" ? MOCK_MULTIPLIER : 1;
  const prefix = `RATE_LIMIT_${action.toUpperCase()}`;
  return {
    userHourly: positiveInteger(
      env(`${prefix}_USER_HOURLY`),
      defaults.userHourly * multiplier,
    ),
    userDaily: positiveInteger(
      env(`${prefix}_USER_DAILY`),
      defaults.userDaily * multiplier,
    ),
    ipHourly: positiveInteger(
      env(`${prefix}_IP_HOURLY`),
      defaults.ipHourly * multiplier,
    ),
  };
}

export async function hmacHex(secret: string, value: string): Promise<string> {
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

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function ipSubjectHash(req: Request, secret: string): Promise<string> {
  const clientKey = req.headers.get("x-oisint-client-key") ?? "";
  const signature = req.headers.get("x-oisint-proxy-signature") ?? "";
  if (/^[0-9a-f]{64}$/.test(clientKey) && /^[0-9a-f]{64}$/.test(signature)) {
    const expected = await hmacHex(secret, `proxy:${clientKey}`);
    if (constantTimeEqual(signature, expected)) return clientKey;
  }

  // Edge Function直叩きは送信元IPを信頼できる形で取得できないため、偽装可能な
  // x-forwarded-for等は使わず共有bucketへ倒す。通常の本番経路はWorker署名を使う。
  return await hmacHex(secret, "ip:direct-edge-shared-bucket");
}

function unavailable(): RateLimitDecision {
  return { allowed: false, kind: "unavailable", retryAfter: 30 };
}

export async function checkRateLimit(
  db: SupabaseClient,
  req: Request,
  action: RateLimitAction,
  userId: string | null,
  isServiceRole: boolean,
  env: EnvReader = defaultEnv,
): Promise<RateLimitDecision> {
  if (isServiceRole) return { allowed: true };
  if (!userId) return unavailable();
  if (env("RATE_LIMIT_ENABLED")?.toLowerCase() === "false") {
    console.warn(`[rate-limit] disabled action=${action}`);
    return { allowed: true };
  }

  const mode = env("DATA_PROVIDER_MODE") === "mock" ? "mock" : "live";
  const configuredSecret = env("RATE_LIMIT_SECRET") ?? "";
  const secret = mode === "mock" && configuredSecret.length < 32
    ? "mock-only-rate-limit-secret-000000"
    : configuredSecret;
  if (secret.length < 32) {
    console.error(`[rate-limit] unavailable action=${action} reason=secret`);
    return unavailable();
  }

  try {
    const values = readLimitValues(action, mode, env);
    const [userHash, ipHash] = await Promise.all([
      hmacHex(secret, `user:${userId}`),
      ipSubjectHash(req, secret),
    ]);
    const rules: RateLimitRule[] = [
      {
        scope: `${action}:user:hour`,
        subject_hash: userHash,
        window_seconds: 3600,
        limit: values.userHourly,
      },
      {
        scope: `${action}:user:day`,
        subject_hash: userHash,
        window_seconds: 86400,
        limit: values.userDaily,
      },
      {
        scope: `${action}:ip:hour`,
        subject_hash: ipHash,
        window_seconds: 3600,
        limit: values.ipHourly,
      },
    ];

    const { data, error } = await db.rpc("consume_request_rate_limits", {
      p_limits: rules,
    });
    if (error) throw new Error("rate limit RPC failed");
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.is_allowed !== "boolean") {
      throw new Error("rate limit RPC returned an invalid shape");
    }
    if (row.is_allowed) return { allowed: true };

    const retryAfter = positiveInteger(
      String(row.retry_after_seconds ?? ""),
      60,
    );
    const scope = typeof row.exceeded_scope === "string"
      ? row.exceeded_scope
      : "unknown";
    console.warn(`[rate-limit] denied action=${action} scope=${scope}`);
    return { allowed: false, kind: "limited", retryAfter };
  } catch {
    if (mode === "mock") {
      console.warn(`[rate-limit] mock fail-open action=${action}`);
      return { allowed: true };
    }
    console.error(`[rate-limit] unavailable action=${action} reason=storage`);
    return unavailable();
  }
}
