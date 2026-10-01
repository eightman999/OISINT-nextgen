import { assert, assertEquals, assertFalse } from "@std/assert";
import type { User } from "@supabase/supabase-js";
import {
  isGoogleLinkedPermanentUser,
  parseAccountHandoffBody,
  parseCompletedHandoffResult,
} from "../functions/_shared/account_handoff.ts";

const operationId = "00000000-0000-4000-8000-000000001166";

Deno.test("account handoff: bodyはoperationIdだけを受理する", () => {
  assertEquals(parseAccountHandoffBody({ operationId }), { operationId });
  assertEquals(
    parseAccountHandoffBody({ operationId, userId: operationId }),
    null,
  );
  assertEquals(parseAccountHandoffBody({ operationId: "not-a-uuid" }), null);
  assertEquals(parseAccountHandoffBody(null), null);
});

Deno.test("account handoff: 恒久Google identity以外を本人証明にしない", () => {
  const googleUser = {
    id: operationId,
    is_anonymous: false,
    identities: [{ provider: "google" }],
  } as unknown as User;
  assert(isGoogleLinkedPermanentUser(googleUser));
  assertFalse(
    isGoogleLinkedPermanentUser({ ...googleUser, is_anonymous: true }),
  );
  assertFalse(isGoogleLinkedPermanentUser({ ...googleUser, identities: [] }));
  assertFalse(isGoogleLinkedPermanentUser(null));
});

Deno.test("account handoff: RPC結果は有限の状態と非負event_countだけを通す", () => {
  assertEquals(
    parseCompletedHandoffResult({ status: "completed", event_count: 2 }),
    {
      status: "completed",
      eventCount: 2,
    },
  );
  assertEquals(
    parseCompletedHandoffResult([{
      status: "already_completed",
      event_count: 0,
    }]),
    { status: "already_completed", eventCount: 0 },
  );
  assertEquals(
    parseCompletedHandoffResult({ status: "completed", event_count: -1 }),
    null,
  );
  assertEquals(
    parseCompletedHandoffResult({ status: "unknown", event_count: 0 }),
    null,
  );
  assertEquals(
    parseCompletedHandoffResult({ status: "completed", event_count: 1.5 }),
    null,
  );
});

Deno.test("account handoff: complete Edgeはbody user idを認証材料にしない", async () => {
  const source = await Deno.readTextFile(
    new URL("../functions/complete-account-handoff/index.ts", import.meta.url),
  );
  assert(source.includes("p_user_id: auth.userId"));
  assert(source.includes("isGoogleLinkedPermanentUser(userData.user)"));
  assertFalse(source.includes("p_user_id: parsedBody.userId"));
  assertFalse(source.includes("p_user_id: body.userId"));
});
