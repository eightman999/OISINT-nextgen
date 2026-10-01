// delete-account: 本人JWTを確認した上で、個人データ掃除とAuth削除を行う (#167 / #544)
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { deleteAccountBodySchema } from "../_shared/validation.ts";
import {
  deleteRevenueCatCustomer,
  isRecordedRevenueCatDeletion,
  planRevenueCatCustomerDeletion,
} from "../_shared/revenuecat_customer.ts";
import {
  deleteOneSignalUser,
  readOneSignalCredentials,
} from "../_shared/push_notifications.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";
import { orchestrateAccountDeletion } from "./orchestration.ts";

async function recordRevenueCatDeletion(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
  status: "succeeded" | "failed" | "local_cleanup_failed",
  errorCode: string | null,
): Promise<boolean> {
  const { data, error } = await db.rpc(
    "record_revenuecat_customer_deletion",
    {
      p_user_id: userId,
      p_status: status,
      p_error_code: errorCode,
    },
  );
  return isRecordedRevenueCatDeletion(data, error);
}

async function finalizeRevenueCatDeletion(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc(
    "finalize_revenuecat_customer_deletion",
    { p_user_id: userId },
  );
  return error == null && data === "finalized";
}

const MAX_DELETE_ACCOUNT_BODY_BYTES = 16 * 1024;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, req);
  }

  let body: unknown = {};
  try {
    const bounded = await readRequestBodyLimited(
      req,
      MAX_DELETE_ACCOUNT_BODY_BYTES,
      { signal: req.signal },
    );
    if (bounded.tooLarge) {
      return json({ error: "リクエスト本文が大きすぎます" }, 413, req);
    }
    if (bounded.timedOut) {
      return json(
        { error: "リクエスト本文の受信がタイムアウトしました" },
        408,
        req,
      );
    }
    if (bounded.readError) {
      return json({ error: "リクエスト本文を読み取れませんでした" }, 400, req);
    }
    const rawBody = bounded.text;
    if (rawBody.trim()) body = JSON.parse(rawBody);
  } catch {
    // 壊れた非空JSONは削除を起動しない。空body/空白bodyだけを空オブジェクトとして許可する。
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  if (!deleteAccountBodySchema.safeParse(body).success) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.userId || auth.isServiceRole) {
    return json({ error: "認証が必要です" }, 401, req);
  }
  const userId = auth.userId;

  // Pushを一度でも設定した利用者は、local/Auth削除より先にOneSignal Userを削除する。
  // 成功後の再試行はprovider 404を成功扱いにするため、後段失敗でも冪等に再実行できる。
  const { data: pushPreferences, error: pushPreferencesError } = await db
    .from("push_notification_preferences")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (pushPreferencesError) {
    console.error("[delete-account] push deletion eligibility check failed");
    return json({ error: "アカウントを削除できませんでした" }, 500, req);
  }
  if (pushPreferences) {
    const pushDeletion = await deleteOneSignalUser(
      userId,
      readOneSignalCredentials(),
    );
    if (!pushDeletion.ok) {
      console.error(
        `[delete-account] push user deletion failed reason=${pushDeletion.reason}`,
      );
      return json(
        {
          error:
            "Push通知データの削除を確認できないため、アカウント削除を完了できませんでした",
        },
        503,
        req,
      );
    }
  }

  // RevenueCat customer消去を先に完了させる。secret欠落/429/timeout時は
  // 外部保持を見失わないよう、個人DB/Authの削除を開始せず再送可能な失敗にする。
  const { data: enqueueData, error: enqueueError } = await db.rpc(
    "enqueue_revenuecat_customer_deletion",
    {
      p_user_id: userId,
    },
  );
  if (enqueueError) {
    console.error("[delete-account] revenuecat deletion enqueue failed");
    return json({ error: "アカウントを削除できませんでした" }, 500, req);
  }
  let revenueCatDeletionAction: "skip" | "delete";
  try {
    revenueCatDeletionAction = planRevenueCatCustomerDeletion(enqueueData);
  } catch {
    console.error("[delete-account] unexpected revenuecat deletion status");
    return json({ error: "アカウントを削除できませんでした" }, 500, req);
  }
  const hasRevenueCatOutbox = enqueueData !== "ignored_unknown_user";

  const result = await orchestrateAccountDeletion({
    deleteExternalCustomer: revenueCatDeletionAction === "delete",
    hasExternalOutbox: hasRevenueCatOutbox,
    deleteRevenueCatCustomer: () => deleteRevenueCatCustomer(userId),
    recordRevenueCatDeletion: (status, errorCode) =>
      recordRevenueCatDeletion(db, userId, status, errorCode),
    // purge RPC は service_role だけが実行できる。ここで個人ベクトル、
    // プロフィール、本人所有/投稿の個人行を先に処理する。
    purgeLocalData: async () => {
      const { error } = await db.rpc("delete_user_account_data", {
        p_user_id: userId,
      });
      return error == null ? { ok: true } : { ok: false, code: error.code };
    },
    finalizeRevenueCatDeletion: () => finalizeRevenueCatDeletion(db, userId),
    deleteAuthUser: async () => {
      const { error } = await db.auth.admin.deleteUser(userId);
      return error == null ? { ok: true } : { ok: false, code: error.code };
    },
  });

  if (result.ok) return json({ deleted: true }, 200, req);

  switch (result.stage) {
    case "external":
      console.error(
        `[delete-account] revenuecat deletion failed reason=${
          result.reason ?? "provider"
        }`,
      );
      return json(
        {
          error:
            "外部課金データの削除を確認できないため、アカウント削除を完了できませんでした",
        },
        503,
        req,
      );
    case "external_record":
      console.error("[delete-account] revenuecat deletion record failed");
      return json({ error: "アカウントを削除できませんでした" }, 500, req);
    case "purge":
      console.error("[delete-account] purge failed");
      return json({ error: "アカウントを削除できませんでした" }, 500, req);
    case "finalize":
      console.error("[delete-account] revenuecat deletion finalize failed");
      return json({ error: "アカウントを削除できませんでした" }, 500, req);
    case "auth":
      console.error("[delete-account] auth deletion failed");
      return json({ error: "アカウントを削除できませんでした" }, 500, req);
  }
});
