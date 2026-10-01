import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_REVENUECAT_CUSTOMER_TIMEOUT_MS,
  deleteRevenueCatCustomer,
  isRecordedRevenueCatDeletion,
  planRevenueCatCustomerDeletion,
} from "../functions/_shared/revenuecat_customer.ts";

const userId = "00000000-0000-4000-8000-000000000571";
const serverSecret = "s".repeat(32);

Deno.test("customer deletion uses DELETE, permanent UUID, and server secret only", async () => {
  const result = await deleteRevenueCatCustomer(userId, {
    secret: serverSecret,
    fetchImpl: (_input, init) => {
      assertEquals(init?.method, "DELETE");
      assertEquals(
        (init?.headers as Record<string, string>).Authorization,
        `Bearer ${serverSecret}`,
      );
      assertEquals(init?.redirect, "error");
      return Promise.resolve(
        new Response(JSON.stringify({ deleted: true }), { status: 200 }),
      );
    },
  });
  assertEquals(result, { ok: true, status: 200 });
});

Deno.test("missing secret, provider failure, and already deleted are explicit", async () => {
  assertEquals(
    await deleteRevenueCatCustomer(userId, { secret: "" }),
    { ok: false, status: 503, reason: "missing_config" },
  );
  assertEquals(
    await deleteRevenueCatCustomer(userId, {
      secret: serverSecret,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 429 })),
    }),
    { ok: false, status: 429, reason: "retryable" },
  );
  assertEquals(
    await deleteRevenueCatCustomer(userId, {
      secret: serverSecret,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
    }),
    { ok: true, status: 404 },
  );
  const invalid = await deleteRevenueCatCustomer("$RCAnonymousID:123", {
    secret: serverSecret,
  });
  assert(invalid.ok === false && invalid.reason === "invalid_subject");
});

Deno.test("customer deletion aborts a hung provider request", async () => {
  let aborted = false;
  const result = await deleteRevenueCatCustomer(userId, {
    secret: serverSecret,
    timeoutMs: 5,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  assertEquals(result, { ok: false, status: 408, reason: "timeout" });
  assert(aborted);
  assert(DEFAULT_REVENUECAT_CUSTOMER_TIMEOUT_MS > 0);
});

Deno.test("customer deletion canonicalizes any valid UUID version to lowercase", async () => {
  let requestedPath = "";
  const result = await deleteRevenueCatCustomer(
    "00000000-0000-1000-8000-000000000571".toUpperCase(),
    {
      secret: serverSecret,
      fetchImpl: (input) => {
        requestedPath = String(input);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    },
  );
  assertEquals(result, { ok: true, status: 404 });
  assert(requestedPath.endsWith("/00000000-0000-1000-8000-000000000571"));
});

Deno.test("anonymous deletion skips RevenueCat while permanent users require an outbox status", () => {
  assertEquals(planRevenueCatCustomerDeletion("ignored_unknown_user"), "skip");
  assertEquals(planRevenueCatCustomerDeletion("pending"), "delete");
  assertEquals(planRevenueCatCustomerDeletion("succeeded"), "skip");
  let threw = false;
  try {
    planRevenueCatCustomerDeletion("failed");
  } catch {
    threw = true;
  }
  assert(threw);
  let networkCalled = false;
  const action = planRevenueCatCustomerDeletion("ignored_unknown_user");
  if (action === "delete") networkCalled = true;
  assert(!networkCalled);
  assert(!isRecordedRevenueCatDeletion("recorded", { code: "db_error" }));
  assert(!isRecordedRevenueCatDeletion("ignored_unknown_user", null));
  assert(isRecordedRevenueCatDeletion("recorded", null));
});
