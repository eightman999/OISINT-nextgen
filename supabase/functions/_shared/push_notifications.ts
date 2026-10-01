import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ONESIGNAL_ENDPOINT = "https://api.onesignal.com/notifications?c=push";
const ONESIGNAL_USERS_ENDPOINT = "https://api.onesignal.com/apps";
const RESPONSE_BODY_LIMIT = 64 * 1024;

export const pushOutboxRowSchema = z.object({
  id: z.string().uuid(),
  recipient_user_id: z.string().uuid(),
  investigation_id: z.string().uuid(),
  event_type: z.enum([
    "investigation_completed",
    "group_update",
    "ranking_changed",
    "invite_activity",
  ]),
  idempotency_key: z.string().uuid(),
  attempts: z.number().int().min(1).max(5),
}).strict();

export type PushOutboxRow = z.infer<typeof pushOutboxRowSchema>;

const responseSchema = z.object({
  id: z.string().uuid().optional(),
  recipients: z.number().int().nonnegative().optional(),
}).passthrough();

type EnvReader = (name: string) => string | undefined;

export interface OneSignalCredentials {
  appId: string;
  apiKey: string;
}

export function isPushDeliveryEnabled(
  env: EnvReader = defaultEnv,
): boolean {
  return env("PUSH_NOTIFICATIONS_ENABLED")?.trim().toLowerCase() === "true";
}

export type PushSendResult =
  | { result: "sent"; providerMessageId: string }
  | { result: "no_subscription" }
  | {
    result: "retry";
    errorCode: "http_5xx" | "network" | "invalid_response" | "rate_limited";
    retryAfterSeconds?: number;
  }
  | { result: "dead"; errorCode: "http_4xx" | "invalid_response" };

export type PushUserDeletionResult =
  | { ok: true }
  | {
    ok: false;
    reason: "credentials" | "network" | "rate_limited" | "provider";
  };

const FIXED_COPY: Record<
  PushOutboxRow["event_type"],
  { heading: string; body: string }
> = {
  investigation_completed: {
    heading: "調査が完了しました",
    body: "結果のTop3を確認できます。",
  },
  group_update: {
    heading: "参加中の調査が更新されました",
    body: "投票または条件の更新を確認できます。",
  },
  ranking_changed: {
    heading: "候補の順位が変わりました",
    body: "更新された結果を確認できます。",
  },
  invite_activity: {
    heading: "グループに新しい参加がありました",
    body: "共同で店選びを続けられます。",
  },
};

function defaultEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

export function readOneSignalCredentials(
  env: EnvReader = defaultEnv,
): OneSignalCredentials | null {
  const appId = env("ONESIGNAL_APP_ID")?.trim() ?? "";
  const apiKey = env("ONESIGNAL_REST_API_KEY")?.trim() ?? "";
  if (!UUID_RE.test(appId)) return null;
  if (
    apiKey.length < 32 || apiKey.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(apiKey)
  ) return null;
  return { appId, apiKey };
}

/**
 * Account deletion時にexternal_idへ結び付くOneSignal Userを削除する。
 * 404は再実行時のalready-deletedとして成功扱いにし、応答本文は保持・返却しない。
 */
export async function deleteOneSignalUser(
  userId: string,
  credentials: OneSignalCredentials | null,
  fetcher: typeof fetch = fetch,
): Promise<PushUserDeletionResult> {
  if (!UUID_RE.test(userId) || !credentials) {
    return { ok: false, reason: "credentials" };
  }

  let response: Response;
  try {
    response = await fetcher(
      `${ONESIGNAL_USERS_ENDPOINT}/${credentials.appId}/users/by/external_id/${
        encodeURIComponent(userId)
      }`,
      {
        method: "DELETE",
        headers: { Authorization: `Key ${credentials.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    return { ok: false, reason: "network" };
  }

  if (response.ok || response.status === 404) return { ok: true };
  if (response.status === 429) return { ok: false, reason: "rate_limited" };
  return { ok: false, reason: "provider" };
}

export function buildOneSignalPushBody(
  row: PushOutboxRow,
  appId: string,
): Record<string, unknown> {
  const copy = FIXED_COPY[row.event_type];
  return {
    app_id: appId,
    include_aliases: { external_id: [row.recipient_user_id] },
    target_channel: "push",
    headings: { en: copy.heading, ja: copy.heading },
    contents: { en: copy.body, ja: copy.body },
    data: {
      schema: "oisint.push.v1",
      eventType: row.event_type,
      investigationId: row.investigation_id,
      notificationId: row.id,
      route: `/investigations/${row.investigation_id}`,
    },
    collapse_id: `${row.investigation_id}:${row.event_type}`,
    idempotency_key: row.idempotency_key,
  };
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^\d{1,4}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 3600
    ? value
    : undefined;
}

export async function sendOneSignalPush(
  row: PushOutboxRow,
  credentials: OneSignalCredentials,
  fetcher: typeof fetch = fetch,
): Promise<PushSendResult> {
  let response: Response;
  try {
    response = await fetcher(ONESIGNAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Key ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildOneSignalPushBody(row, credentials.appId)),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { result: "retry", errorCode: "network" };
  }

  if (response.status === 429) {
    return {
      result: "retry",
      errorCode: "rate_limited",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }
  if (response.status >= 500) {
    return { result: "retry", errorCode: "http_5xx" };
  }
  if (!response.ok) {
    return { result: "dead", errorCode: "http_4xx" };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { result: "retry", errorCode: "invalid_response" };
  }
  if (text.length > RESPONSE_BODY_LIMIT) {
    return { result: "retry", errorCode: "invalid_response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { result: "retry", errorCode: "invalid_response" };
  }
  const validated = responseSchema.safeParse(parsed);
  if (!validated.success) {
    return { result: "retry", errorCode: "invalid_response" };
  }
  if (validated.data.id) {
    return { result: "sent", providerMessageId: validated.data.id };
  }
  if (
    validated.data.recipients === undefined || validated.data.recipients === 0
  ) {
    return { result: "no_subscription" };
  }
  return { result: "retry", errorCode: "invalid_response" };
}
