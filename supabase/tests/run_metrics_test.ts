import { assertEquals } from "@std/assert";
import {
  policyMetricFields,
  queueWaitMs,
} from "../functions/_shared/run_metrics.ts";
import { policyForTier } from "../functions/_shared/research_policy.ts";

Deno.test("queue wait は受付後のworker開始時刻を非ゼロで測る", () => {
  assertEquals(queueWaitMs(1_250, 1_000), 250);
  assertEquals(queueWaitMs(1_000, 1_250), 0);
});

Deno.test("policy metric はtier/depth/costを固定しPIIを含めない", () => {
  const fields = policyMetricFields(policyForTier("plus", 70_000, {
    broadCandidateLimit: 12,
    preRankCandidateLimit: 8,
    researchCandidateLimit: 6,
    providerCallLimit: 6,
  }));
  if (fields.tier !== "plus") throw new Error("tier label missing");
  if (fields.final_candidate_limit !== 3) {
    throw new Error("final candidate limit changed");
  }
  if (fields.research_candidate_limit !== 6) {
    throw new Error("Plus research limit missing");
  }
  if (
    fields.broad_candidate_limit !== 12 ||
    fields.pre_rank_candidate_limit !== 8 ||
    fields.provider_call_limit !== 6 ||
    fields.estimated_cost_microusd !== 70_000
  ) {
    throw new Error("Plus budget labels missing");
  }
  const serialized = JSON.stringify(fields);
  if (serialized.includes("app_user_id") || serialized.includes("product_id")) {
    throw new Error("RevenueCat identity leaked into metrics");
  }
});
