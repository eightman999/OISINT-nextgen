// Google連携完了後の匿名アカウント引き継ぎを監査へ確定する (#166)。
// bodyのoperationIdは認証材料ではない。匿名時に予約された行、現在JWTのsubject、
// Google identityの存在をすべてサーバー側で照合してから、RPCが原子的に記録する。
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import {
  ACCOUNT_HANDOFF_MAX_BODY_BYTES,
  isGoogleLinkedPermanentUser,
  parseAccountHandoffBody,
  parseCompletedHandoffResult,
} from "../_shared/account_handoff.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, req);
  }

  const boundedBody = await readRequestBodyLimited(
    req,
    ACCOUNT_HANDOFF_MAX_BODY_BYTES,
    { signal: req.signal },
  );
  if (boundedBody.timedOut) {
    return json(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
    );
  }
  if (boundedBody.tooLarge || boundedBody.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  let body: unknown = null;
  try {
    body = boundedBody.text.trim() ? JSON.parse(boundedBody.text) : null;
  } catch {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const parsedBody = parseAccountHandoffBody(body);
  if (!parsedBody) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.userId || auth.isServiceRole) {
    return json({ error: "認証が必要です" }, 401, req);
  }

  // JWT subjectから取得したAuth userだけを信頼する。client bodyのuser idや
  // provider情報は受け取らないため、他人の匿名データを指定できない。
  const { data: userData, error: userError } = await db.auth.admin.getUserById(
    auth.userId,
  );
  if (userError || !isGoogleLinkedPermanentUser(userData.user)) {
    return json({ error: "引き継ぎを完了できませんでした" }, 403, req);
  }

  const { data, error } = await db.rpc("complete_account_handoff", {
    p_operation_id: parsedBody.operationId,
    // authenticate()が検証したJWT subjectをEdgeが渡す。body値は存在しない。
    p_user_id: auth.userId,
  });
  if (error) {
    console.error(
      `[complete-account-handoff] RPC failed code=${error.code ?? "unknown"}`,
    );
    return json({ error: "引き継ぎを完了できませんでした" }, 403, req);
  }
  const result = parseCompletedHandoffResult(data);
  if (!result) {
    console.error("[complete-account-handoff] RPC returned invalid shape");
    return json({ error: "引き継ぎを完了できませんでした" }, 500, req);
  }

  return json({ status: result.status }, 200, req);
});
