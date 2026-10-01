import { isValidRevenueCatSecret, parseSupabaseUserId } from "./revenuecat.ts";
import { readResponseBodyLimited } from "./request_body.ts";

/**
 * RevenueCat customer erasure boundary for account deletion.
 * The App User ID is already the authenticated permanent UUID; no aliases are
 * accepted here. Store subscriptions are not cancelled by this operation.
 */
export type RevenueCatCustomerDeletionResult =
  | { ok: true; status: 200 | 404 }
  | {
    ok: false;
    status: 0 | 400 | 401 | 403 | 408 | 429 | 500 | 502 | 503;
    reason: string;
  };

export type RevenueCatDeletionAction = "skip" | "delete";

export const DEFAULT_REVENUECAT_CUSTOMER_TIMEOUT_MS = 5_000;
const MAX_CUSTOMER_RESPONSE_BYTES = 16 * 1024;

/**
 * 匿名Authには恒久的なRevenueCat customer UUIDがないため、外部customer
 * 消去を呼ばずに従来のローカル掃除へ進める。未知のRPC結果はfail-closed。
 */
export function planRevenueCatCustomerDeletion(
  enqueueResult: unknown,
): RevenueCatDeletionAction {
  if (enqueueResult === "ignored_unknown_user") return "skip";
  if (enqueueResult === "succeeded") return "skip";
  if (enqueueResult === "pending") return "delete";
  throw new Error("unexpected_revenuecat_deletion_status");
}

/** RPC応答/エラーを同時に検証し、DB更新失敗を成功扱いにしない。 */
export function isRecordedRevenueCatDeletion(
  data: unknown,
  error: unknown,
): boolean {
  return error == null && data === "recorded";
}

export async function deleteRevenueCatCustomer(
  appUserId: string,
  options: {
    secret?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<RevenueCatCustomerDeletionResult> {
  const secret = options.secret ?? Deno.env.get("REVENUECAT_SECRET_API_KEY") ??
    "";
  if (!isValidRevenueCatSecret(secret)) {
    return { ok: false, status: 503, reason: "missing_config" };
  }
  const canonicalAppUserId = parseSupabaseUserId(appUserId);
  if (!canonicalAppUserId) {
    return { ok: false, status: 400, reason: "invalid_subject" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(
    Math.max(
      1,
      Math.floor(options.timeoutMs ?? DEFAULT_REVENUECAT_CUSTOMER_TIMEOUT_MS),
    ),
    30_000,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.revenuecat.com/v1/subscribers/${
        encodeURIComponent(canonicalAppUserId)
      }`,
      {
        method: "DELETE",
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
      MAX_CUSTOMER_RESPONSE_BYTES,
    );
    if (bounded.tooLarge || bounded.readError) {
      return {
        ok: false,
        status: controller.signal.aborted ? 408 : 502,
        reason: controller.signal.aborted ? "timeout" : "invalid_response",
      };
    }
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, status: 408, reason: "timeout" };
    }
    return { ok: false, status: 0, reason: "network" };
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 200 || response.status === 404) {
    return { ok: true, status: response.status };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, reason: "authorization" };
  }
  if (response.status === 408 || response.status === 429) {
    return { ok: false, status: response.status, reason: "retryable" };
  }
  return {
    ok: false,
    // Domain result deliberately does not expose arbitrary provider status codes.
    status: response.status >= 500 && response.status < 600 ? 500 : 502,
    reason: "provider",
  };
}
