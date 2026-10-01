// OneSignal push outbox worker (#540)
//
// service-role専用。DB leaseで重複実行を防ぎ、OneSignalへは固定文言と
// event/investigation/outbox UUIDだけを送る。
import { z } from "zod";
import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { throwIfDatabaseError } from "../_shared/database_error.ts";
import {
  isPushDeliveryEnabled,
  pushOutboxRowSchema,
  type PushSendResult,
  readOneSignalCredentials,
  sendOneSignalPush,
} from "../_shared/push_notifications.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";

const MAX_BODY_BYTES = 4 * 1024;
export const pushWorkerBodySchema = z.object({
  batchSize: z.number().int().min(1).max(25).default(10),
}).strict();

function resultArguments(result: PushSendResult) {
  switch (result.result) {
    case "sent":
      return {
        p_result: "sent",
        p_provider_message_id: result.providerMessageId,
        p_error_code: null,
        p_retry_after_seconds: null,
      };
    case "no_subscription":
      return {
        p_result: "no_subscription",
        p_provider_message_id: null,
        p_error_code: "no_subscription",
        p_retry_after_seconds: null,
      };
    case "retry":
      return {
        p_result: "retry",
        p_provider_message_id: null,
        p_error_code: result.errorCode,
        p_retry_after_seconds: result.retryAfterSeconds ?? null,
      };
    case "dead":
      return {
        p_result: "dead",
        p_provider_message_id: null,
        p_error_code: result.errorCode,
        p_retry_after_seconds: null,
      };
  }
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, req);
  }

  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.isServiceRole) {
    return json({ error: "service role が必要です" }, 401, req);
  }

  if (!isPushDeliveryEnabled()) {
    // 明示的に有効化されるまでleaseせず、通知もattemptも消費しない。
    return json({ error: "push delivery は停止中です" }, 503, req);
  }

  const credentials = readOneSignalCredentials();
  if (!credentials) {
    // credentialが無い状態ではleaseせず、attemptを消費しない。
    return json({ error: "push provider が設定されていません" }, 503, req);
  }

  const bounded = await readRequestBodyLimited(req, MAX_BODY_BYTES);
  if (bounded.tooLarge) {
    return json({ error: "リクエストが大きすぎます" }, 413, req);
  }
  if (bounded.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  let input: unknown = {};
  if (bounded.text.trim()) {
    try {
      input = JSON.parse(bounded.text) as unknown;
    } catch {
      return json({ error: "リクエストが不正です" }, 400, req);
    }
  }
  const parsedBody = pushWorkerBodySchema.safeParse(input);
  if (!parsedBody.success) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }

  const workerId = crypto.randomUUID();
  const { data, error } = await db.rpc("lease_push_notification_outbox", {
    p_worker_id: workerId,
    p_limit: parsedBody.data.batchSize,
    p_lease_seconds: 30,
  });
  throwIfDatabaseError(error, "lease_push_notification_outbox");
  const leased = z.array(pushOutboxRowSchema).safeParse(data ?? []);
  if (!leased.success) {
    return json({ error: "push outbox の応答形式が不正です" }, 500, req);
  }

  const counts = {
    sent: 0,
    noSubscription: 0,
    retry: 0,
    dead: 0,
    leaseLost: 0,
  };
  await Promise.all(leased.data.map(async (row) => {
    const result = await sendOneSignalPush(row, credentials);
    if (result.result === "sent") counts.sent += 1;
    else if (result.result === "no_subscription") counts.noSubscription += 1;
    else if (result.result === "retry") counts.retry += 1;
    else counts.dead += 1;

    const completion = resultArguments(result);
    const { data: finished, error: finishError } = await db.rpc(
      "finish_push_notification_outbox",
      {
        p_notification_id: row.id,
        p_worker_id: workerId,
        ...completion,
      },
    );
    if (finishError || finished !== true) counts.leaseLost += 1;
  }));

  console.info(JSON.stringify({
    metric: "push_outbox",
    leased: leased.data.length,
    ...counts,
  }));
  const summary = { leased: leased.data.length, ...counts };
  if (counts.leaseLost > 0) {
    return json(summary, 503, req, { "Cache-Control": "no-store" });
  }
  return json(summary, 200, req, { "Cache-Control": "no-store" });
});
