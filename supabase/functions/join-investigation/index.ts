// join-investigation (spec.md §25.4 / contracts/join-investigation.md)
// RLS により未参加ユーザーは share_token から investigation を引けないため、
// 参加処理は service role で動くこの Function が担う。これがないと共有機能が成立しない。
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { joinInvestigationBodySchema } from "../_shared/validation.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";

const MAX_JOIN_BODY_BYTES = 16 * 1024;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const db = createServiceClient();

  // 1. auth 確認 (匿名サインイン済みであること)
  const auth = await authenticate(req, db);
  if (!auth.userId) return json({ error: "認証が必要です" }, 401, req);

  const rateLimit = await checkRateLimit(
    db,
    req,
    "join",
    auth.userId,
    auth.isServiceRole,
  );
  if (!rateLimit.allowed) {
    const limited = rateLimit.kind === "limited";
    return json(
      {
        error: limited
          ? "しばらく待ってからもう一度お試しください"
          : "ただいま参加処理を実行できません",
      },
      limited ? 429 : 503,
      req,
      { "Retry-After": String(rateLimit.retryAfter) },
    );
  }

  const boundedBody = await readRequestBodyLimited(req, MAX_JOIN_BODY_BYTES, {
    signal: req.signal,
  });
  if (boundedBody.timedOut) {
    return json(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
    );
  }
  if (boundedBody.tooLarge) {
    return json({ error: "リクエストが大きすぎます" }, 413, req);
  }
  if (boundedBody.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  let parsedBody: unknown = null;
  let malformedJson = false;
  if (boundedBody.text.trim()) {
    try {
      parsedBody = JSON.parse(boundedBody.text) as unknown;
    } catch {
      malformedJson = true;
    }
  }
  if (malformedJson) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const bodyResult = joinInvestigationBodySchema.safeParse(parsedBody);
  if (!bodyResult.success) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const { shareToken, displayName } = bodyResult.data;

  // share token解決、20人上限、profiles/member/eventを単一RPCで処理する。
  // investigation行ロックにより、並行joinが上限判定をすり抜けない。
  const { data, error } = await db.rpc("join_investigation", {
    p_share_token: shareToken,
    p_user_id: auth.userId,
    p_display_name: displayName,
  });
  if (error) {
    console.error(
      `[join-investigation] join RPC failed code=${error.code ?? "unknown"}`,
    );
    return json({ error: "参加処理を実行できませんでした" }, 500, req);
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    investigation_id?: unknown;
    title?: unknown;
    status?: unknown;
  } | null;
  if (!row) return json({ error: "調査が見つかりません" }, 404, req);
  if (row.status === "full") {
    return json({ error: "参加人数が上限に達しています" }, 409, req);
  }
  if (
    (row.status !== "joined" && row.status !== "already_member") ||
    typeof row.investigation_id !== "string" ||
    typeof row.title !== "string"
  ) {
    console.error("[join-investigation] join RPC returned an invalid shape");
    return json({ error: "参加結果を確認できませんでした" }, 500, req);
  }

  return json(
    { investigationId: row.investigation_id, title: row.title },
    200,
    req,
  );
});
