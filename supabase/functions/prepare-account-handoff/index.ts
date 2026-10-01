// 匿名セッションがGoogle連携を開始する前の、短命・一回性操作IDを予約する (#166)。
// user_idはbodyから受け取らず、RPC側でauth.uid()とJWTの匿名claimを検証する。
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import {
  ACCOUNT_HANDOFF_MAX_BODY_BYTES,
  isPrepareAccountHandoffBody,
} from "../_shared/account_handoff.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";
import { z } from "zod";

const operationIdSchema = z.string().uuid();

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

  let body: unknown = {};
  if (boundedBody.text.trim()) {
    try {
      body = JSON.parse(boundedBody.text) as unknown;
    } catch {
      return json({ error: "リクエストが不正です" }, 400, req);
    }
  }
  if (!isPrepareAccountHandoffBody(body)) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.userId || auth.isServiceRole) {
    return json({ error: "認証が必要です" }, 401, req);
  }

  const { data, error } = await db.rpc("prepare_account_handoff");
  if (error) {
    // DB側の匿名claim/有効期限/ACLエラーをクライアントへ出さない。
    console.error(
      `[prepare-account-handoff] RPC failed code=${error.code ?? "unknown"}`,
    );
    return json({ error: "引き継ぎを開始できませんでした" }, 403, req);
  }
  const operationId = operationIdSchema.safeParse(data);
  if (!operationId.success) {
    console.error("[prepare-account-handoff] RPC returned invalid shape");
    return json({ error: "引き継ぎを開始できませんでした" }, 500, req);
  }

  return json({ operationId: operationId.data }, 200, req);
});
