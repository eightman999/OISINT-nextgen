// 匿名アカウント引き継ぎの入力・認証結果を閉じた契約で扱う (#166)。
// 引き継ぎIDは復旧秘密ではなく、匿名セッションが予約した短命な一回性操作ID。
// 実際の本人確認は常に Edge の検証済みJWTとAuth identitiesで行う。
import type { User } from "@supabase/supabase-js";
import { z } from "zod";

export const ACCOUNT_HANDOFF_METHOD = "google_identity_link" as const;
export const ACCOUNT_HANDOFF_EVENT_TYPE = "account_handoff_completed" as const;
export const ACCOUNT_HANDOFF_MAX_BODY_BYTES = 4 * 1024;

const accountHandoffBodySchema = z.object({
  operationId: z.string().uuid(),
}).strict();
const prepareAccountHandoffBodySchema = z.object({}).strict();

export interface AccountHandoffBody {
  operationId: string;
}

/** 外部入力は operationId 以外を受理しない。失敗時は null で収束する。 */
export function parseAccountHandoffBody(
  value: unknown,
): AccountHandoffBody | null {
  const parsed = accountHandoffBodySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 予約は引数を持たない。将来のclient指定user/providerを受理しない。 */
export function isPrepareAccountHandoffBody(value: unknown): boolean {
  return prepareAccountHandoffBodySchema.safeParse(value).success;
}

/** Edge が管理APIから取得したユーザーだけを、Google連携済み恒久ユーザーと認める。 */
export function isGoogleLinkedPermanentUser(
  user: User | null | undefined,
): boolean {
  if (!user || user.is_anonymous === true) return false;
  return (user.identities ?? []).some((identity) =>
    identity.provider === "google"
  );
}

export interface CompletedHandoffResult {
  status: "completed" | "already_completed";
  eventCount: number;
}

/** RPC応答をそのままUIへ渡さず、期待する有限の形へ検証する。 */
export function parseCompletedHandoffResult(
  value: unknown,
): CompletedHandoffResult | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const candidate = row as { status?: unknown; event_count?: unknown };
  if (
    (candidate.status !== "completed" &&
      candidate.status !== "already_completed") ||
    typeof candidate.event_count !== "number" ||
    !Number.isSafeInteger(candidate.event_count) ||
    candidate.event_count < 0
  ) {
    return null;
  }
  return {
    status: candidate.status,
    eventCount: candidate.event_count,
  };
}
