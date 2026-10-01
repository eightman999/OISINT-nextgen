// delete-investigation: JWT本人が所有する調査単位だけを削除する (#167)
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { deleteInvestigationBodySchema } from "../_shared/validation.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";

const MAX_DELETE_INVESTIGATION_BODY_BYTES = 16 * 1024;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, req);
  }

  const boundedBody = await readRequestBodyLimited(
    req,
    MAX_DELETE_INVESTIGATION_BODY_BYTES,
    { signal: req.signal },
  );
  let parsedBody: unknown = null;
  if (
    !boundedBody.tooLarge && !boundedBody.readError && !boundedBody.timedOut &&
    boundedBody.text.trim()
  ) {
    try {
      parsedBody = JSON.parse(boundedBody.text) as unknown;
    } catch {
      parsedBody = null;
    }
  }
  if (boundedBody.tooLarge) {
    return json({ error: "リクエストが大きすぎます" }, 413, req);
  }
  if (boundedBody.timedOut) {
    return json(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
    );
  }
  if (boundedBody.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const bodyResult = deleteInvestigationBodySchema.safeParse(parsedBody);
  if (!bodyResult.success) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  // service-role key はJWT subjectを持たないため、クライアントとしての利用を拒否する。
  if (!auth.userId || auth.isServiceRole) {
    return json({ error: "認証が必要です" }, 401, req);
  }

  const { data, error } = await db.rpc("delete_investigation", {
    p_investigation_id: bodyResult.data.investigationId,
    p_user_id: auth.userId,
  });
  if (error) {
    // 調査本文・表示名・user idはログへ出さず、運用に必要なコードだけを残す。
    console.error(
      `[delete-investigation] purge failed code=${error.code ?? "unknown"}`,
    );
    return json({ error: "調査を削除できませんでした" }, 500, req);
  }

  const result = data as { deleted?: unknown } | null;
  if (result?.deleted !== true) {
    // 未所有・不存在を同じ応答にして、調査IDの列挙を防ぐ。
    return json({ error: "調査が見つかりません" }, 404, req);
  }

  return json({ deleted: true }, 200, req);
});
