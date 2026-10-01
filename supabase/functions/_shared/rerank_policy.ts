import {
  parseResearchPolicy,
  type ResearchBudgetProfile,
} from "./research_policy.ts";

/**
 * Columns read from the accepted durable run snapshot before rerank work.
 * Keep this shape free of entitlement/provider identifiers: rerank only needs
 * the immutable, validated budget policy that was accepted for the run.
 */
export interface PersistedRerankPolicyRow {
  budget_profile: unknown;
  entitlement_tier: unknown;
  acceptance_state: unknown;
}

/**
 * Resolve a persisted policy for rerank and fail closed on any mismatch.
 * A failed investigation has no safe runtime fallback; a complete legacy run
 * may be handled by the caller's constrained Free fallback.
 */
export function policyFromAcceptedRun(
  row: PersistedRerankPolicyRow | null,
): ResearchBudgetProfile | null {
  if (!row || row.acceptance_state !== "accepted") return null;
  const policy = parseResearchPolicy(row.budget_profile);
  return policy && row.entitlement_tier === policy.tier ? policy : null;
}
