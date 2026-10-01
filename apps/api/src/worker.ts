import app, { type Env } from "./index";

export { EgressReplayGuard } from "./replay_guard";

type QueueDrainEnv = Pick<
  Env,
  "SUPABASE_URL" | "SUPABASE_ANON_KEY" | "RUN_QUEUE_DRAIN_KEY"
>;

const QUEUE_DRAIN_KEY_MIN_LENGTH = 32;
const QUEUE_DRAIN_KEY_MAX_LENGTH = 256;
const SUPABASE_ANON_JWT_MAX_LENGTH = 4096;
const SUPABASE_JWT_PART_MAX_LENGTH = 2048;
const QUEUE_DRAIN_TIMEOUT_MS = 15_000;
const QUEUE_LOG_SCHEMA = "oisint.api.queue.v1";

function logQueueFailure(
  code: "config_unavailable" | "rejected" | "unavailable",
  httpStatus?: number,
): void {
  const event: {
    schema: string;
    stage: string;
    code: string;
    http_status?: number;
  } = {
    schema: QUEUE_LOG_SCHEMA,
    stage: "queue_drain",
    code,
  };
  if (httpStatus !== undefined) event.http_status = httpStatus;
  // URL、Authorization、anon key、drain secret、response bodyは記録しない。
  console.error(JSON.stringify(event));
}

function isJwtLike(value: string, maxLength: number): boolean {
  if (value.length < 32 || value.length > maxLength) return false;
  const parts = value.split(".");
  return (
    parts.length === 3 &&
    parts.every(
      (part) =>
        part.length <= SUPABASE_JWT_PART_MAX_LENGTH &&
        /^[A-Za-z0-9_-]+$/.test(part),
    )
  );
}

export function isValidQueueDrainKey(value: string): boolean {
  return (
    value.length >= QUEUE_DRAIN_KEY_MIN_LENGTH &&
    value.length <= QUEUE_DRAIN_KEY_MAX_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function decodeJwtPayload(value: string): Record<string, unknown> | null {
  if (!isJwtLike(value, SUPABASE_ANON_JWT_MAX_LENGTH)) return null;
  try {
    const encoded = value.split(".")[1];
    if (encoded.length % 4 === 1) return null;
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    );
    const payload: unknown = JSON.parse(decoded);
    return payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expectedSupabaseProjectRef(value: string): string | null {
  try {
    const parsed = new URL(value);
    const match = /^([a-z0-9][a-z0-9-]{0,62})\.supabase\.co$/i.exec(
      parsed.hostname,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isValidSupabaseAnonKey(
  value: string,
  expectedSupabaseUrl?: string,
): boolean {
  const payload = decodeJwtPayload(value);
  if (payload?.role !== "anon") return false;
  if (expectedSupabaseUrl !== undefined) {
    const expectedRef = expectedSupabaseProjectRef(expectedSupabaseUrl);
    if (expectedRef === null || payload.ref !== expectedRef) return false;
  }
  return true;
}

export function buildQueueDrainUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash ||
      !/^[a-z0-9][a-z0-9-]{0,62}\.supabase\.co$/i.test(parsed.hostname)
    )
      return null;
    return `${parsed.origin}/functions/v1/run-investigation`;
  } catch {
    return null;
  }
}

/**
 * Supabase Edge Function 内の service-role DB drain 境界を、別 Worker の
 * Cron invocation から呼び出す。Cron は同じ EdgeRuntime の wall-clock を
 * 延長しないため、waitUntil の再投入ではなく新しい service invocation を
 * 必ず作る。秘密値は Worker secret からのみ読み、ログへ出さない。
 */
export async function dispatchInvestigationQueue(
  env: QueueDrainEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = buildQueueDrainUrl(env.SUPABASE_URL) ?? "";
  const key = env.RUN_QUEUE_DRAIN_KEY ?? "";
  const anonKey = env.SUPABASE_ANON_KEY ?? "";
  if (
    !url ||
    !isValidQueueDrainKey(key) ||
    !isValidSupabaseAnonKey(anonKey, env.SUPABASE_URL)
  ) {
    logQueueFailure("config_unavailable");
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), QUEUE_DRAIN_TIMEOUT_MS);
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        // Supabase gateway の verify_jwt を通す公開 anon JWT。drain の実行
        // 権限は Edge Function 内の custom secret で別途判定し、service-role
        // key は Cloudflare Workerへ置かない。
        Authorization: `Bearer ${anonKey}`,
        "x-queue-drain-key": key,
      },
      body: "{}",
    });
    if (!response.ok) {
      logQueueFailure("rejected", response.status);
      return false;
    }
    return true;
  } catch {
    logQueueFailure("unavailable");
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cloudflare Cron must reject the waitUntil promise on a failed dispatch. */
export async function dispatchInvestigationQueueOrThrow(
  env: QueueDrainEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!(await dispatchInvestigationQueue(env, fetchImpl))) {
    throw new Error("queue drain dispatch failed");
  }
}

const worker = {
  fetch: app.fetch,
  scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(dispatchInvestigationQueueOrThrow(env));
  },
};

export default worker;
