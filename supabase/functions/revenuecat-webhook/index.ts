import { createServiceClient, handleOptions, json } from "../_shared/db.ts";
import {
  authorizeRevenueCatEventConfig,
  authorizeRevenueCatWebhook,
  authorizeRevenueCatWebhookSignature,
  isKnownProduct,
  isPlusEvent,
  parseSupabaseUserId,
  revenueCatEventProductId,
  revenueCatWebhookSchema,
} from "../_shared/revenuecat.ts";
import {
  fetchSubscriberPlusState,
  type SubscriberPlusState,
} from "../_shared/revenuecat_subscriber.ts";
import { readRequestBytesLimited } from "../_shared/request_body.ts";

const ALLOWED_RESULTS = new Set([
  "applied",
  "ignored_duplicate",
  "ignored_stale",
  "ignored_non_plus",
  "ignored_unknown_user",
  "ignored_unknown_product",
  "ignored_unknown_offering",
  "ignored_unknown_event",
  "ignored_missing_product",
  "ignored_missing_expiration",
  "ignored_invalid_event",
  "ignored_test_event",
  "applied_transfer",
  "transfer_revoked_old_requires_reconciliation",
  "ignored_invalid_transfer",
  "ignored_unknown_transfer_user",
]);
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function safeErrorResponse(): Response {
  return json({ error: "entitlement webhook を処理できませんでした" }, 500);
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") {
    return json({ error: "POST のみ受け付けます" }, 405, req);
  }

  const auth = authorizeRevenueCatWebhook(
    req.headers.get("Authorization"),
    Deno.env.get("REVENUECAT_WEBHOOK_TOKEN"),
  );
  if (!auth.ok) {
    return json(
      {
        error: auth.reason === "missing_config"
          ? "webhook 未設定"
          : "認証に失敗しました",
      },
      auth.status,
      req,
    );
  }

  const contentLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES
  ) {
    return json({ error: "webhook本文が大きすぎます" }, 413, req);
  }
  let body: unknown;
  let rawBody = "";
  try {
    const bounded = await readRequestBytesLimited(
      req,
      MAX_WEBHOOK_BODY_BYTES,
      { signal: req.signal },
    );
    if (bounded.tooLarge) {
      return json({ error: "webhook本文が大きすぎます" }, 413, req);
    }
    if (bounded.timedOut) {
      return json(
        { error: "webhook本文の受信がタイムアウトしました" },
        408,
        req,
      );
    }
    if (bounded.readError) {
      return json({ error: "webhook本文を読み取れませんでした" }, 400, req);
    }
    // Signature検証はUTF-8 decode後の文字列ではなく、RevenueCatから受信した
    // bytesそのものを対象にする。decodeはJSON parseの直前にfatalで行う。
    const signature = await authorizeRevenueCatWebhookSignature(
      req.headers.get("X-RevenueCat-Webhook-Signature"),
      Deno.env.get("REVENUECAT_WEBHOOK_HMAC_SECRET"),
      bounded.bytes,
    );
    if (!signature.ok) {
      return json(
        {
          error: signature.reason === "missing_config"
            ? "webhook 未設定"
            : "署名検証に失敗しました",
        },
        signature.status,
        req,
      );
    }
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "JSON形式が不正です" }, 400, req);
  }
  const parsed = revenueCatWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "webhook形式が不正です" }, 400, req);
  }

  const payload = parsed.data;
  const event = payload.event;
  const eventConfig = authorizeRevenueCatEventConfig(
    event,
    Deno.env.get("REVENUECAT_APP_ID"),
    new Set(
      (Deno.env.get("REVENUECAT_ALLOWED_ENVIRONMENTS") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    event.type === "TRANSFER" && !event.environment,
  );
  if (!eventConfig.ok) {
    return json(
      {
        error: eventConfig.reason === "missing_config"
          ? "webhook 未設定"
          : "webhook対象外です",
      },
      eventConfig.status,
      req,
    );
  }
  if (event.type === "TRANSFER") {
    try {
      const db = createServiceClient();
      const destinations: string[] = [];
      const states: SubscriberPlusState[] = [];
      for (const rawDestination of event.transferred_to ?? []) {
        const destination = parseSupabaseUserId(rawDestination);
        if (!destination) continue;
        // Subscriber APIを先に照合する。失敗時はRPCを呼ばず、ledgerも作らないため
        // RevenueCatの再送で同じ照合を再試行できる。
        const lookup = await fetchSubscriberPlusState(destination);
        if (!lookup.ok) return safeErrorResponse();
        if (!lookup.state) continue;
        destinations.push(destination);
        states.push(lookup.state);
      }

      if (!destinations.length) {
        // Subscriber APIがPlusなしを成功応答した場合もgrantを作らず、旧subjectだけ
        // 安全にrevokeする。匿名/未知のApp User IDだけの通知も同じ経路で処理する。
        const { data, error } = await db.rpc("revoke_revenuecat_transfer", {
          p_event_id: event.id,
          p_event_timestamp_ms: event.event_timestamp_ms,
          p_transferred_from: event.transferred_from ?? [],
          p_transferred_to: event.transferred_to ?? [],
        });
        if (error || typeof data !== "string" || !ALLOWED_RESULTS.has(data)) {
          return safeErrorResponse();
        }
        return json({ ok: true, result: data }, 200, req);
      }

      const transferEnvironment = event.environment ?? states[0]?.environment;
      if (
        !transferEnvironment ||
        states.some((state) =>
          state?.environment && state.environment !== transferEnvironment
        ) ||
        !(Deno.env.get("REVENUECAT_ALLOWED_ENVIRONMENTS") ?? "")
          .split(",")
          .map((value) => value.trim())
          .includes(transferEnvironment)
      ) {
        // TRANSFERはenvironmentが省略され得る。Subscriber APIがsandbox/prodを
        // 証明できない場合は旧/新どちらも変更せず、次回再送へ委ねる。
        return safeErrorResponse();
      }

      const { data, error } = await db.rpc("apply_revenuecat_transfer", {
        p_event_id: event.id,
        p_event_timestamp_ms: event.event_timestamp_ms,
        p_app_id: event.app_id,
        p_environment: transferEnvironment,
        p_transferred_from: event.transferred_from ?? [],
        p_transferred_to: destinations,
        p_product_ids: states.map((state) => state.productId),
        p_expiration_at_ms: states.map((state) => state.expiresAtMs),
        p_grace_period_expiration_at_ms: states.map((state) =>
          state.gracePeriodExpiresAtMs
        ),
        p_will_renew: states.map((state) => state.willRenew ?? false),
      });
      if (error || typeof data !== "string" || !ALLOWED_RESULTS.has(data)) {
        return safeErrorResponse();
      }
      return json({ ok: true, result: data }, 200, req);
    } catch {
      return safeErrorResponse();
    }
  }

  // aliases / unknown entitlement は恒久Supabase subjectを証明しないためgrantしない。
  // 未知 entitlementもDBへ書かず、再送を不要にするため2xxで受領する。
  if (!isPlusEvent(event)) {
    return json({ ok: true, result: "ignored_non_plus" }, 200, req);
  }

  try {
    const eventProductId = revenueCatEventProductId(event);
    const lifecycleEvent = [
      "CANCELLATION",
      "BILLING_ISSUE",
      "PRODUCT_CHANGE",
      "SUBSCRIPTION_PAUSED",
    ].includes(event.type);
    let reconciledState: SubscriberPlusState | null = null;
    const canonicalSubject = parseSupabaseUserId(event.app_user_id);
    if (
      lifecycleEvent && canonicalSubject &&
      (eventProductId === null || isKnownProduct(eventProductId))
    ) {
      // DBに既存行が無い cancellation/billing/paused が先着した場合は、
      // 署名イベントだけで状態を推測せずSubscriber APIを先に照合する。
      const lookup = await fetchSubscriberPlusState(canonicalSubject);
      if (!lookup.ok) return safeErrorResponse();
      // CANCELLATION/BILLING_ISSUE/PRODUCT_CHANGEのcurrent stateを正本にする。
      // PRODUCT_CHANGEは期末変更ならnew_product_idがまだ有効ではないため、
      // eventのnew productとSubscriber current productの不一致を拒否しない。
      reconciledState = lookup.state;
      if (
        event.environment && reconciledState?.environment &&
        event.environment !== reconciledState.environment
      ) return safeErrorResponse();
    }

    const db = createServiceClient();
    const confirmedNoPlus = lifecycleEvent && reconciledState === null;
    const { data, error } = await db.rpc("apply_revenuecat_webhook_event", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_event_timestamp_ms: event.event_timestamp_ms,
      // 正規UUIDは小文字へ統一し、未知/aliasはそのまま渡してDBで拒否する。
      p_app_user_id: canonicalSubject ?? event.app_user_id ?? null,
      p_entitlement_id: event.entitlement_id ?? null,
      p_entitlement_ids: event.entitlement_ids ?? null,
      p_product_id: reconciledState?.productId ?? eventProductId ?? null,
      // Explicit null is valid for the official nullable field; only an
      // absent field may use the legacy offering_id compatibility field.
      p_offering_id: event.presented_offering_id !== undefined
        ? event.presented_offering_id
        : event.offering_id ?? null,
      p_store: event.store ?? null,
      p_environment: event.environment ?? null,
      // API成功でPlusが無い場合はFreeへ落とす。署名payloadの将来期限だけで
      // refund/cancel/graceなしをgrantしない。
      // A successful Subscriber lookup with no Plus is an authoritative Free
      // reconciliation.  Use an explicit past timestamp so the SQL RPC cannot
      // fall back to an older verified future expiry.  Missing/failed lookup
      // never reaches this point and is retried with 5xx.
      p_expiration_at_ms: confirmedNoPlus
        ? 0
        : lifecycleEvent
        ? reconciledState?.expiresAtMs ?? null
        : event.expiration_at_ms ?? null,
      p_grace_period_expiration_at_ms: confirmedNoPlus
        ? 0
        : lifecycleEvent
        ? reconciledState?.gracePeriodExpiresAtMs ?? null
        : event.grace_period_expiration_at_ms ?? null,
      p_will_renew: lifecycleEvent
        ? reconciledState?.willRenew ?? event.will_renew ?? null
        : event.will_renew ?? null,
      p_app_id: event.app_id ?? null,
    });
    if (error || typeof data !== "string" || !ALLOWED_RESULTS.has(data)) {
      return safeErrorResponse();
    }
    return json({ ok: true, result: data }, 200, req);
  } catch {
    // secret / payload / provider customer information をログに出さず、RevenueCatには再送を促す。
    return safeErrorResponse();
  }
});
