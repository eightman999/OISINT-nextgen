import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  AccountDeletionOrchestrationDeps,
  AccountDeletionStepResult,
} from "../functions/delete-account/orchestration.ts";
import {
  orchestrateAccountDeletion,
  safeRevenueCatReason,
} from "../functions/delete-account/orchestration.ts";
import type {
  RevenueCatCustomerDeletionResult,
} from "../functions/_shared/revenuecat_customer.ts";

type Plan = {
  externalResult?: RevenueCatCustomerDeletionResult;
  recordResult?: boolean;
  purgeResult?: AccountDeletionStepResult;
  finalizeResult?: boolean;
  authResult?: AccountDeletionStepResult;
  deleteExternalCustomer?: boolean;
  hasExternalOutbox?: boolean;
};

function makeDeps(plan: Plan = {}): {
  deps: AccountDeletionOrchestrationDeps;
  events: string[];
  outbox: { count: number };
} {
  const events: string[] = [];
  const outbox = { count: plan.hasExternalOutbox === false ? 0 : 1 };
  const externalResult = plan.externalResult ?? { ok: true, status: 200 };
  const recordResult = plan.recordResult ?? true;
  const purgeResult = plan.purgeResult ?? { ok: true };
  const finalizeResult = plan.finalizeResult ?? true;
  const authResult = plan.authResult ?? { ok: true };

  return {
    events,
    outbox,
    deps: {
      deleteExternalCustomer: plan.deleteExternalCustomer ?? true,
      hasExternalOutbox: plan.hasExternalOutbox ?? true,
      deleteRevenueCatCustomer: () => {
        events.push("external");
        return Promise.resolve(externalResult);
      },
      recordRevenueCatDeletion: (status, errorCode) => {
        events.push(`record:${status}:${errorCode ?? "none"}`);
        return Promise.resolve(recordResult);
      },
      purgeLocalData: () => {
        events.push("purge");
        return Promise.resolve(purgeResult);
      },
      finalizeRevenueCatDeletion: () => {
        events.push("finalize");
        if (finalizeResult) outbox.count = 0;
        return Promise.resolve(finalizeResult);
      },
      deleteAuthUser: () => {
        events.push("auth");
        return Promise.resolve(authResult);
      },
    },
  };
}

Deno.test("成功時は外部削除→purge→finalize→Authの順でoutboxが空になる", async () => {
  const fixture = makeDeps();
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: true });
  assertEquals(fixture.events, [
    "external",
    "record:succeeded:none",
    "purge",
    "finalize",
    "auth",
  ]);
  assertEquals(fixture.outbox.count, 0);
  assert(
    fixture.events.indexOf("external") < fixture.events.indexOf("purge"),
  );
  assert(fixture.events.indexOf("purge") < fixture.events.indexOf("finalize"));
  assert(fixture.events.indexOf("finalize") < fixture.events.indexOf("auth"));
});

Deno.test("匿名相当のskipでは外部削除/finalizeを呼ばずlocal purge後にAuthを削除する", async () => {
  const fixture = makeDeps({
    deleteExternalCustomer: false,
    hasExternalOutbox: false,
  });
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: true });
  assertEquals(fixture.events, ["purge", "auth"]);
  assertEquals(fixture.outbox.count, 0);
});

Deno.test("finalize失敗時はAuthを呼ばず500相当の再試行可能な結果にする", async () => {
  const fixture = makeDeps({ finalizeResult: false });
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: false, stage: "finalize" });
  assertEquals(fixture.events, [
    "external",
    "record:succeeded:none",
    "purge",
    "finalize",
  ]);
  assertEquals(fixture.outbox.count, 1);
  assert(!fixture.events.includes("auth"));
});

Deno.test("purge失敗時はfinalize/Authを呼ばず外部outboxを失敗記録する", async () => {
  const fixture = makeDeps({ purgeResult: { ok: false, code: "purge_rpc" } });
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: false, stage: "purge", code: "purge_rpc" });
  assertEquals(fixture.events, [
    "external",
    "record:succeeded:none",
    "purge",
    "record:local_cleanup_failed:purge_rpc",
  ]);
  assert(!fixture.events.includes("finalize"));
  assert(!fixture.events.includes("auth"));
});

for (
  const [name, reason] of [
    ["secret欠落", "missing_config"],
    ["timeout", "timeout"],
    ["429", "retryable"],
  ] as const
) {
  Deno.test(`外部${name}ではpurge/Authを実行しない`, async () => {
    const fixture = makeDeps({
      externalResult: { ok: false, status: 503, reason },
    });
    const result = await orchestrateAccountDeletion(fixture.deps);

    assertEquals(result, { ok: false, stage: "external", reason });
    assertEquals(fixture.events, [
      "external",
      `record:failed:provider_${reason}`,
    ]);
    assert(!fixture.events.includes("purge"));
    assert(!fixture.events.includes("finalize"));
    assert(!fixture.events.includes("auth"));
  });
}

Deno.test("RevenueCat 404 already-deletedは成功として最終Auth削除へ進む", async () => {
  const fixture = makeDeps({
    externalResult: { ok: true, status: 404 },
  });
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: true });
  assertEquals(fixture.events, [
    "external",
    "record:succeeded:none",
    "purge",
    "finalize",
    "auth",
  ]);
  assertEquals(fixture.outbox.count, 0);
});

Deno.test("Auth削除失敗後は同じJWTの再試行で404を受理して最終成功へ収束する", async () => {
  const events: string[] = [];
  const outbox = { count: 1 };
  let externalAttempt = 0;
  let authAttempt = 0;

  const run = () =>
    orchestrateAccountDeletion({
      deleteExternalCustomer: true,
      hasExternalOutbox: true,
      deleteRevenueCatCustomer: () => {
        events.push(`external:${++externalAttempt}`);
        return Promise.resolve(
          externalAttempt === 1
            ? { ok: true, status: 200 }
            : { ok: true, status: 404 },
        );
      },
      recordRevenueCatDeletion: (status) => {
        events.push(`record:${status}`);
        // finalize already removed the row on the first Auth failure, so the
        // best-effort local_cleanup_failed record is ignored by the database.
        return Promise.resolve(status !== "local_cleanup_failed");
      },
      purgeLocalData: () => {
        events.push("purge");
        return Promise.resolve({ ok: true });
      },
      finalizeRevenueCatDeletion: () => {
        events.push("finalize");
        outbox.count = 0;
        return Promise.resolve(true);
      },
      deleteAuthUser: () => {
        events.push(`auth:${++authAttempt}`);
        return Promise.resolve(
          authAttempt === 1 ? { ok: false, code: "temporary" } : { ok: true },
        );
      },
    });

  const first = await run();
  assertEquals(first, { ok: false, stage: "auth", code: "temporary" });
  assertEquals(outbox.count, 0);
  assertEquals(
    events,
    [
      "external:1",
      "record:succeeded",
      "purge",
      "finalize",
      "auth:1",
      "record:local_cleanup_failed",
    ],
  );

  // The handler's enqueue RPC creates a fresh pending row for the same JWT
  // after Auth failure.  Model that durable retry boundary explicitly.
  outbox.count = 1;
  const second = await run();
  assertEquals(second, { ok: true });
  assertEquals(outbox.count, 0);
  assertEquals(events.slice(6), [
    "external:2",
    "record:succeeded",
    "purge",
    "finalize",
    "auth:2",
  ]);
});

Deno.test("未知の外部reasonは固定カテゴリへ落としsecret/payloadを結果へ出さない", async () => {
  const secret = "super-secret-token";
  const payload = `provider payload ${secret}`;
  const fixture = makeDeps({
    externalResult: { ok: false, status: 500, reason: payload },
  });
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: false, stage: "external", reason: "provider" });
  assertEquals(fixture.events, ["external", "record:failed:provider_provider"]);
  assert(!JSON.stringify(result).includes(secret));
  assert(!JSON.stringify(result).includes(payload));
  assertEquals(safeRevenueCatReason(payload), "provider");
  assertStringIncludes(fixture.events[1], "provider_provider");
});

Deno.test("purge/Authの外部エラーコードはログ対象にせず、未検証payloadを記録値へ通さない", async () => {
  const secret = "super-secret-token";
  const payload = `raw provider payload ${secret}`;
  const fixture = makeDeps({
    purgeResult: { ok: false, code: payload },
  });
  const result = await orchestrateAccountDeletion(fixture.deps);

  assertEquals(result, { ok: false, stage: "purge", code: "purge_failed" });
  assertEquals(fixture.events, [
    "external",
    "record:succeeded:none",
    "purge",
    "record:local_cleanup_failed:purge_failed",
  ]);
  assert(!JSON.stringify(result).includes(secret));
  assert(!fixture.events.join(" ").includes(payload));
});
