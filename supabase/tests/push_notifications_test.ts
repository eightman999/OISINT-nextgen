import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  buildOneSignalPushBody,
  deleteOneSignalUser,
  isPushDeliveryEnabled,
  type PushOutboxRow,
  readOneSignalCredentials,
  sendOneSignalPush,
} from "../functions/_shared/push_notifications.ts";

const row: PushOutboxRow = {
  id: "00000000-0000-4000-8000-000000000540",
  recipient_user_id: "00000000-0000-4000-8000-000000000541",
  investigation_id: "00000000-0000-4000-8000-000000000542",
  event_type: "investigation_completed",
  idempotency_key: "00000000-0000-4000-8000-000000000543",
  attempts: 1,
};

const credentials = {
  appId: "00000000-0000-4000-8000-000000000544",
  apiKey: "test_api_key_000000000000000000000000",
};

Deno.test("OneSignal body uses fixed copy and the safe UUID-only payload", () => {
  const body = buildOneSignalPushBody(row, credentials.appId);
  const serialized = JSON.stringify(body);
  assertEquals(body.include_aliases, { external_id: [row.recipient_user_id] });
  assertEquals(body.target_channel, "push");
  assertEquals(body.data, {
    schema: "oisint.push.v1",
    eventType: "investigation_completed",
    investigationId: row.investigation_id,
    notificationId: row.id,
    route: `/investigations/${row.investigation_id}`,
  });
  for (
    const forbidden of [
      "raw_query",
      "auth_token",
      "tasteProfile",
      "restaurantName",
      "display_name",
    ]
  ) {
    assertEquals(serialized.includes(forbidden), false);
  }
});

Deno.test("OneSignal credentials fail closed", () => {
  assertEquals(isPushDeliveryEnabled(() => undefined), false);
  assertEquals(
    isPushDeliveryEnabled((name) =>
      name === "PUSH_NOTIFICATIONS_ENABLED" ? "true" : undefined
    ),
    true,
  );
  assertEquals(
    isPushDeliveryEnabled((name) =>
      name === "PUSH_NOTIFICATIONS_ENABLED" ? "1" : undefined
    ),
    false,
  );
  assertEquals(readOneSignalCredentials(() => undefined), null);
  assertEquals(
    readOneSignalCredentials((name) =>
      name === "ONESIGNAL_APP_ID" ? credentials.appId : "short"
    ),
    null,
  );
  assertEquals(
    readOneSignalCredentials((name) =>
      name === "ONESIGNAL_APP_ID" ? credentials.appId : credentials.apiKey
    ),
    credentials,
  );
});

Deno.test("OneSignal success validates provider response", async () => {
  const fetcher: typeof fetch = (_input, init) => {
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      `Key ${credentials.apiKey}`,
    );
    assertMatch(String(init?.body), /oisint\.push\.v1/);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000545",
          recipients: 1,
        }),
        { status: 200 },
      ),
    );
  };
  assertEquals(await sendOneSignalPush(row, credentials, fetcher), {
    result: "sent",
    providerMessageId: "00000000-0000-4000-8000-000000000545",
  });
});

Deno.test("zero recipients is explicit and retryable failures stay classified", async () => {
  assertEquals(
    await sendOneSignalPush(
      row,
      credentials,
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ recipients: 0 }), { status: 200 }),
        ),
    ),
    { result: "no_subscription" },
  );
  assertEquals(
    await sendOneSignalPush(
      row,
      credentials,
      () =>
        Promise.resolve(
          new Response("busy", {
            status: 429,
            headers: { "Retry-After": "17" },
          }),
        ),
    ),
    { result: "retry", errorCode: "rate_limited", retryAfterSeconds: 17 },
  );
  const networkResult = await sendOneSignalPush(
    row,
    credentials,
    () => Promise.reject(new Error("secret provider error")),
  );
  assertEquals(networkResult, { result: "retry", errorCode: "network" });
  assert(!JSON.stringify(networkResult).includes("secret provider error"));
});

Deno.test("account deletion removes the external_id user without exposing provider body", async () => {
  const seen: { url?: string; authorization?: string } = {};
  const result = await deleteOneSignalUser(
    row.recipient_user_id,
    credentials,
    (input, init) => {
      seen.url = String(input);
      seen.authorization = new Headers(init?.headers).get("authorization") ??
        undefined;
      return Promise.resolve(
        new Response("provider-private-body", { status: 202 }),
      );
    },
  );
  assertEquals(result, { ok: true });
  assertEquals(
    seen.url,
    `https://api.onesignal.com/apps/${credentials.appId}/users/by/external_id/${row.recipient_user_id}`,
  );
  assertEquals(seen.authorization, `Key ${credentials.apiKey}`);
  assertEquals(JSON.stringify(result).includes("provider-private-body"), false);
});

Deno.test("OneSignal user deletion is idempotent and fails closed", async () => {
  assertEquals(
    await deleteOneSignalUser(
      row.recipient_user_id,
      credentials,
      () => Promise.resolve(new Response(null, { status: 404 })),
    ),
    { ok: true },
  );
  assertEquals(await deleteOneSignalUser(row.recipient_user_id, null), {
    ok: false,
    reason: "credentials",
  });
  assertEquals(
    await deleteOneSignalUser(
      row.recipient_user_id,
      credentials,
      () => Promise.resolve(new Response("retry", { status: 429 })),
    ),
    { ok: false, reason: "rate_limited" },
  );
});
