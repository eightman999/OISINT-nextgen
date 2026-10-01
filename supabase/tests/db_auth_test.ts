import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticate, isMember } from "../functions/_shared/db.ts";
import { DatabaseOperationError } from "../functions/_shared/database_error.ts";

function authDb(
  result: { userId?: string; error?: boolean },
  onCall: () => void,
): SupabaseClient {
  return {
    auth: {
      getUser: () => {
        onCall();
        return Promise.resolve({
          data: { user: result.userId ? { id: result.userId } : null },
          error: result.error ? { message: "invalid" } : null,
        });
      },
    },
  } as unknown as SupabaseClient;
}

Deno.test("authenticate: service-role互換比較は一致時だけ権限昇格する", async () => {
  const original = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const serviceKey = `eyJ${"a".repeat(80)}.${"b".repeat(80)}.${"c".repeat(80)}`;
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceKey);
  try {
    let calls = 0;
    const db = authDb({ error: true }, () => calls += 1);
    const accepted = await authenticate(
      new Request("https://example.test", {
        headers: { Authorization: `Bearer ${serviceKey}` },
      }),
      db,
    );
    assertEquals(accepted, { userId: null, isServiceRole: true });
    assertEquals(calls, 0);

    const rejected = await authenticate(
      new Request("https://example.test", {
        headers: { Authorization: `Bearer ${serviceKey.slice(0, -1)}x` },
      }),
      db,
    );
    assertEquals(rejected, { userId: null, isServiceRole: false });
    assertEquals(calls, 1);
  } finally {
    if (original === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", original);
  }
});

Deno.test("authenticate: 過大Authorizationはauth providerへ転送しない", async () => {
  const original = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "s".repeat(32));
  try {
    let calls = 0;
    const result = await authenticate(
      new Request("https://example.test", {
        headers: { Authorization: `Bearer ${"x".repeat(8193)}` },
      }),
      authDb({ userId: "should-not-be-used" }, () => calls += 1),
    );
    assertEquals(result, { userId: null, isServiceRole: false });
    assertEquals(calls, 0);
  } finally {
    if (original === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", original);
  }
});

function membershipDb(
  result: { data: unknown; error: unknown },
): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(result),
  };
  return {
    from: () => chain,
  } as unknown as SupabaseClient;
}

Deno.test("isMember: 実際の不在だけをfalseへ写像する", async () => {
  assertEquals(
    await isMember(
      membershipDb({ data: null, error: null }),
      "123e4567-e89b-42d3-a456-426614174000",
      "223e4567-e89b-42d3-a456-426614174000",
    ),
    false,
  );
});

Deno.test("isMember: DB read障害をmembership不在へ誤変換しない", async () => {
  await assertRejects(
    () =>
      isMember(
        membershipDb({
          data: null,
          error: { message: "transport unavailable" },
        }),
        "123e4567-e89b-42d3-a456-426614174000",
        "223e4567-e89b-42d3-a456-426614174000",
      ),
    DatabaseOperationError,
    "investigation_members.membership_select",
  );
});
