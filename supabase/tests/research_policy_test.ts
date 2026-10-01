import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEntitlementForUser } from "../functions/_shared/entitlement.ts";
import {
  DEFAULT_RESEARCH_COST_MICROS,
  FINAL_CANDIDATE_LIMIT,
  MAX_PLUS_STAGE_LIMIT,
  P0_CANDIDATE_LIMIT,
  parseResearchPolicy,
  PLUS_BROAD_LIMIT_ENV,
  PLUS_PRE_RANK_LIMIT_ENV,
  PLUS_PROVIDER_CALL_LIMIT_ENV,
  PLUS_RESEARCH_COST_ENV,
  PLUS_RESEARCH_LIMIT_ENV,
  policyForEntitlement,
  policyForTier,
  policySnapshot,
} from "../functions/_shared/research_policy.ts";
import { policyFromAcceptedRun } from "../functions/_shared/rerank_policy.ts";

Deno.test("research policy: unknown/error/expired entitlement is Free", () => {
  const free = policyForEntitlement(null, () => undefined);
  if (!free) throw new Error("Free policy unexpectedly unavailable");
  assertEquals(free.tier, "free");
  assertEquals(free.finalCandidateLimit, FINAL_CANDIDATE_LIMIT);
  assertEquals(free.researchCandidateLimit, P0_CANDIDATE_LIMIT);
  assertEquals(free.estimatedCostMicros, DEFAULT_RESEARCH_COST_MICROS);
  assertEquals(policyForTier("expired").tier, "free");
  assertEquals(
    policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
      broadCandidateLimit: 12,
      preRankCandidateLimit: 8,
      researchCandidateLimit: 6,
      providerCallLimit: 6,
    }).tier,
    "plus",
  );
});

Deno.test("research policy: Free=3、Plusはstage別runtime設定だけ探索幅を増やす", () => {
  const plus = policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
    broadCandidateLimit: 12,
    preRankCandidateLimit: 8,
    researchCandidateLimit: 6,
    providerCallLimit: 6,
  });
  assertEquals(plus.finalCandidateLimit, 3);
  assertEquals(plus.broadCandidateLimit, 12);
  assertEquals(plus.preRankCandidateLimit, 8);
  assertEquals(plus.researchCandidateLimit, 6);
  assertEquals(plus.providerCallLimit, 6);
  assertEquals(
    policyForTier("free").researchCandidateLimit,
    P0_CANDIDATE_LIMIT,
  );
  assertEquals(plus.estimatedCostMicros, DEFAULT_RESEARCH_COST_MICROS);
});

Deno.test("research policy: Plus cost/幅は明示server設定だけから解決する", () => {
  const plus = policyForEntitlement(
    { tier: "plus" },
    (name) => ({
      [PLUS_RESEARCH_COST_ENV]: "0.07",
      [PLUS_BROAD_LIMIT_ENV]: "12",
      [PLUS_PRE_RANK_LIMIT_ENV]: "8",
      [PLUS_RESEARCH_LIMIT_ENV]: "6",
      [PLUS_PROVIDER_CALL_LIMIT_ENV]: "6",
    }[name]),
  );
  if (!plus) throw new Error("configured Plus policy missing");
  assertEquals(plus.tier, "plus");
  assertEquals(plus.estimatedCostMicros, 70_000);
  assertEquals(plus.broadCandidateLimit, 12);
  assertEquals(plus.preRankCandidateLimit, 8);
  assertEquals(plus.researchCandidateLimit, 6);
  assertEquals(
    policyForEntitlement({ tier: "plus" }, () => undefined),
    null,
  );
  assertEquals(
    policyForEntitlement(
      { tier: "plus" },
      (name) => name === PLUS_RESEARCH_COST_ENV ? "0.07" : undefined,
    ),
    null,
  );
  assertEquals(
    policyForEntitlement(
      { tier: "plus" },
      (name) => name === PLUS_RESEARCH_LIMIT_ENV ? "6" : undefined,
    ),
    null,
  );
  assertEquals(
    policyForEntitlement(
      { tier: "plus" },
      (name) => ({
        [PLUS_RESEARCH_COST_ENV]: "0.07",
        [PLUS_BROAD_LIMIT_ENV]: "12",
        [PLUS_PRE_RANK_LIMIT_ENV]: "8",
        [PLUS_RESEARCH_LIMIT_ENV]: "3",
        [PLUS_PROVIDER_CALL_LIMIT_ENV]: "6",
      }[name]),
    ),
    null,
  );
  assertEquals(
    policyForEntitlement(
      { tier: "plus" },
      (name) => ({
        [PLUS_RESEARCH_COST_ENV]: "0.07",
        [PLUS_BROAD_LIMIT_ENV]: "8",
        [PLUS_PRE_RANK_LIMIT_ENV]: "12",
        [PLUS_RESEARCH_LIMIT_ENV]: "6",
        [PLUS_PROVIDER_CALL_LIMIT_ENV]: "6",
      }[name]),
    ),
    null,
  );
  const freeWithPlusEnv = policyForEntitlement(
    { tier: "free" },
    (name) => ({
      [PLUS_RESEARCH_COST_ENV]: "0.07",
      [PLUS_BROAD_LIMIT_ENV]: "12",
      [PLUS_PRE_RANK_LIMIT_ENV]: "8",
      [PLUS_RESEARCH_LIMIT_ENV]: "6",
      [PLUS_PROVIDER_CALL_LIMIT_ENV]: "6",
    }[name]),
  );
  if (!freeWithPlusEnv) throw new Error("Free policy unexpectedly unavailable");
  assertEquals(freeWithPlusEnv.tier, "free");
  assertEquals(freeWithPlusEnv.researchCandidateLimit, P0_CANDIDATE_LIMIT);
  assertThrows(() => policyForTier("plus"));
});

Deno.test("research policy: persisted snapshot is bounded and round-trips", () => {
  const plus = policyForEntitlement(
    { tier: "plus" },
    (name) => ({
      [PLUS_RESEARCH_COST_ENV]: "0.07",
      [PLUS_BROAD_LIMIT_ENV]: "12",
      [PLUS_PRE_RANK_LIMIT_ENV]: "8",
      [PLUS_RESEARCH_LIMIT_ENV]: "6",
      [PLUS_PROVIDER_CALL_LIMIT_ENV]: "6",
    }[name]),
  );
  if (!plus) throw new Error("configured Plus policy missing");
  const snapshot = policySnapshot(plus);
  assertEquals(parseResearchPolicy(snapshot), plus);
  assertEquals(parseResearchPolicy({ ...snapshot, tier: "enterprise" }), null);
  assertEquals(
    parseResearchPolicy({
      ...snapshot,
      broadCandidateLimit: 3,
      preRankCandidateLimit: 3,
      researchCandidateLimit: 3,
      providerCallLimit: 3,
    })?.tier,
    "plus",
  );
  assertEquals(
    parseResearchPolicy({ ...snapshot, finalCandidateLimit: 10 }),
    null,
  );
  assertEquals(
    parseResearchPolicy({ ...snapshot, researchCandidateLimit: 9 }),
    null,
  );
  assertEquals(
    parseResearchPolicy({ ...snapshot, providerCallLimit: 4 }),
    null,
  );
  assertEquals(
    parseResearchPolicy({
      ...snapshot,
      broadCandidateLimit: MAX_PLUS_STAGE_LIMIT + 1,
      preRankCandidateLimit: MAX_PLUS_STAGE_LIMIT + 1,
      researchCandidateLimit: MAX_PLUS_STAGE_LIMIT + 1,
      providerCallLimit: MAX_PLUS_STAGE_LIMIT + 1,
    }),
    null,
  );
  assertEquals(
    parseResearchPolicy({ ...snapshot, estimatedCostMicros: 1_000_000_001 }),
    null,
  );
  assertEquals(
    parseResearchPolicy({ ...snapshot, estimatedCostMicros: -1 }),
    null,
  );
});

Deno.test("research policy: snapshot has no RevenueCat identity or purchase payload", () => {
  const snapshot = JSON.stringify(
    policySnapshot(policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
      broadCandidateLimit: 12,
      preRankCandidateLimit: 8,
      researchCandidateLimit: 6,
      providerCallLimit: 6,
    })),
  );
  assertFalse(snapshot.includes("app_user_id"));
  assertFalse(snapshot.includes("product_id"));
  assertFalse(snapshot.includes("alias"));
  assertNotEquals(snapshot, "");
});

Deno.test("rerank policy: accepted run snapshot is required, validated, and tier-bound", () => {
  const free = policyForTier("free");
  const plus = policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
    broadCandidateLimit: 12,
    preRankCandidateLimit: 8,
    researchCandidateLimit: 6,
    providerCallLimit: 6,
  });

  assertEquals(
    policyFromAcceptedRun({
      budget_profile: policySnapshot(free),
      entitlement_tier: "free",
      acceptance_state: "accepted",
    }),
    free,
  );
  assertEquals(
    policyFromAcceptedRun({
      budget_profile: policySnapshot(plus),
      entitlement_tier: "plus",
      acceptance_state: "accepted",
    }),
    plus,
  );
  assertEquals(
    policyFromAcceptedRun({
      budget_profile: policySnapshot(plus),
      entitlement_tier: "free",
      acceptance_state: "accepted",
    }),
    null,
  );
  assertEquals(
    policyFromAcceptedRun({
      budget_profile: { ...policySnapshot(free), providerCallLimit: 99 },
      entitlement_tier: "free",
      acceptance_state: "accepted",
    }),
    null,
  );
  assertEquals(
    policyFromAcceptedRun({
      budget_profile: policySnapshot(free),
      entitlement_tier: "free",
      acceptance_state: "pending",
    }),
    null,
  );
  assertEquals(policyFromAcceptedRun(null), null);
});

Deno.test("rerank handler: failed run is fail-closed and rerank uses the persisted policy", async () => {
  const source = await Deno.readTextFile(
    new URL("../functions/rerank-investigation/index.ts", import.meta.url),
  );
  assert(source.includes('acceptance_state", "accepted"'));
  assert(source.includes('inv.status === "failed" && !persistedPolicy'));
  assert(
    /limitResearchProviderCalls\(\s*candidates,\s*policy,?\s*\)/.test(source),
  );
  assert(
    source.includes(
      'trigger === "requirement_added" ? policy.estimatedCostMicros : 0',
    ),
  );
  assert(
    source.includes("rankInvestigation(db, invId, policy.finalCandidateLimit)"),
  );
  assert(!source.includes("policyForEntitlement"));
});

Deno.test("research policy: resolver error/invalid shape fails closed to null", async () => {
  const failingDb = {
    rpc: () =>
      Promise.resolve({ data: null, error: { message: "unavailable" } }),
  } as unknown as SupabaseClient;
  assertEquals(
    await resolveEntitlementForUser(
      failingDb,
      "00000000-0000-0000-0000-000000000554",
    ),
    null,
  );

  const invalidDb = {
    rpc: () => Promise.resolve({ data: { tier: "plus" }, error: null }),
  } as unknown as SupabaseClient;
  assertEquals(
    await resolveEntitlementForUser(
      invalidDb,
      "00000000-0000-0000-0000-000000000554",
    ),
    null,
  );

  const throwingDb = {
    rpc: () => Promise.reject(new Error("transport failure")),
  } as unknown as SupabaseClient;
  assertEquals(
    await resolveEntitlementForUser(
      throwingDb,
      "00000000-0000-0000-0000-000000000554",
    ),
    null,
  );
});

Deno.test("research policy: client cannot spoof tier into the run boundary", async () => {
  const source = await Deno.readTextFile(
    new URL("../functions/run-investigation/index.ts", import.meta.url),
  );
  assert(source.includes("resolveEntitlementForUser"));
  assert(source.includes("setRunPolicy"));
  assertFalse(/bodyResult\.data\.(tier|plan|entitlement)/.test(source));
  assertFalse(source.includes("app_user_id"));
  assertFalse(source.includes("purchase_payload"));
});
