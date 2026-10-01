// Server-side investigation timing helpers. Inputs are timestamps only; query,
// anchor, provider response, and exception data never cross this boundary.
import type { ResearchBudgetProfile } from "./research_policy.ts";

export function queueWaitMs(
  workerStartedAt: number,
  acceptedAt: number,
): number {
  return Math.max(0, workerStartedAt - acceptedAt);
}

/** Fixed, non-PII tier/depth/cost labels used by both acceptance and worker logs. */
export function policyMetricFields(
  policy: ResearchBudgetProfile,
): Record<string, string | number> {
  return {
    tier: policy.tier,
    policy_version: policy.version,
    final_candidate_limit: policy.finalCandidateLimit,
    broad_candidate_limit: policy.broadCandidateLimit,
    pre_rank_candidate_limit: policy.preRankCandidateLimit,
    research_candidate_limit: policy.researchCandidateLimit,
    provider_call_limit: policy.providerCallLimit,
    estimated_cost_microusd: policy.estimatedCostMicros,
  };
}
