import type { ServerEntitlement } from "./entitlement.ts";
import { readBudgetValues, usdToMicros } from "./cost_guard.ts";

/**
 * Research policy is deliberately independent from RevenueCat identifiers.
 * Only the server-resolved tier is allowed to cross into the pipeline.
 */
export const RESEARCH_POLICY_VERSION = "v1" as const;
export const FINAL_CANDIDATE_LIMIT = 3 as const;
/** P0 scope keeps the existing three-candidate search contract unchanged. */
export const P0_CANDIDATE_LIMIT = 3 as const;
/**
 * Persisted-policy guardrail; product limits remain runtime-configurable.
 * These are safety ceilings, not the product's promised Plus values.
 */
export const MIN_PLUS_STAGE_LIMIT = 4 as const;
// #554's early discussion used 100 as a whole-pipeline safety ceiling.  It is
// retained only as a fail-closed bound; it is not a default or a product
// promise, and every deployed stage value must still be supplied explicitly.
export const MAX_PLUS_STAGE_LIMIT = 100 as const;
/** Backward-compatible name for callers that only need the safety ceiling. */
export const MAX_PLUS_RESEARCH_CANDIDATE_LIMIT = MAX_PLUS_STAGE_LIMIT;
/** Existing cost-guard baseline; Plus must not invent a multiplier. */
export const DEFAULT_RESEARCH_COST_MICROS = 50_000 as const;
export const PLUS_RESEARCH_COST_ENV =
  "LIVE_PLUS_ESTIMATED_RUN_COST_USD" as const;
export const PLUS_BROAD_LIMIT_ENV = "LIVE_PLUS_BROAD_CANDIDATE_LIMIT" as const;
export const PLUS_PRE_RANK_LIMIT_ENV =
  "LIVE_PLUS_PRE_RANK_CANDIDATE_LIMIT" as const;
export const PLUS_RESEARCH_LIMIT_ENV =
  "LIVE_PLUS_RESEARCH_CANDIDATE_LIMIT" as const;
export const PLUS_PROVIDER_CALL_LIMIT_ENV =
  "LIVE_PLUS_PROVIDER_CALL_LIMIT" as const;

export type ResearchTier = "free" | "plus";

export interface ResearchBudgetProfile {
  version: typeof RESEARCH_POLICY_VERSION;
  tier: ResearchTier;
  finalCandidateLimit: typeof FINAL_CANDIDATE_LIMIT;
  broadCandidateLimit: number;
  preRankCandidateLimit: number;
  researchCandidateLimit: number;
  providerCallLimit: number;
  estimatedCostMicros: number;
}

export interface PlusResearchLimits {
  broadCandidateLimit: number;
  preRankCandidateLimit: number;
  researchCandidateLimit: number;
  providerCallLimit: number;
}

const FREE_POLICY: ResearchBudgetProfile = Object.freeze({
  version: RESEARCH_POLICY_VERSION,
  tier: "free",
  finalCandidateLimit: FINAL_CANDIDATE_LIMIT,
  broadCandidateLimit: P0_CANDIDATE_LIMIT,
  preRankCandidateLimit: P0_CANDIDATE_LIMIT,
  researchCandidateLimit: P0_CANDIDATE_LIMIT,
  providerCallLimit: P0_CANDIDATE_LIMIT,
  estimatedCostMicros: DEFAULT_RESEARCH_COST_MICROS,
});

export function policyForTier(
  tier: unknown,
  estimatedCostMicros?: number,
  plusResearchLimits?: PlusResearchLimits,
): ResearchBudgetProfile {
  if (tier === "plus") {
    if (
      estimatedCostMicros === undefined ||
      !isValidPlusResearchLimits(plusResearchLimits)
    ) {
      throw new Error(
        "Plus research cost and stage limits must be explicit",
      );
    }
    return {
      version: RESEARCH_POLICY_VERSION,
      tier: "plus",
      finalCandidateLimit: FINAL_CANDIDATE_LIMIT,
      ...plusResearchLimits,
      estimatedCostMicros,
    };
  }
  return {
    ...FREE_POLICY,
    estimatedCostMicros: estimatedCostMicros ?? DEFAULT_RESEARCH_COST_MICROS,
  };
}

export type ResearchEnvReader = (name: string) => string | undefined;

function defaultResearchEnvReader(name: string): string | undefined {
  return Deno.env.get(name);
}

/** Resolve cost from the existing server cost configuration, never client input. */
export function researchCostMicros(
  env: ResearchEnvReader = defaultResearchEnvReader,
): number {
  return readBudgetValues("run", env).estimatedMicros;
}

function explicitPositiveCostMicros(raw: string | undefined): number | null {
  if (!raw || !/^\d+(?:\.\d{1,6})?$/.test(raw)) return null;
  const micros = usdToMicros(raw, "0");
  return micros > 0 && micros <= 1_000_000_000 ? micros : null;
}

function explicitPlusResearchLimits(
  env: ResearchEnvReader,
): PlusResearchLimits | null {
  const broadCandidateLimit = explicitPlusStageLimit(
    env(PLUS_BROAD_LIMIT_ENV),
  );
  const preRankCandidateLimit = explicitPlusStageLimit(
    env(PLUS_PRE_RANK_LIMIT_ENV),
  );
  const researchCandidateLimit = explicitPlusStageLimit(
    env(PLUS_RESEARCH_LIMIT_ENV),
  );
  const providerCallLimit = explicitPlusStageLimit(
    env(PLUS_PROVIDER_CALL_LIMIT_ENV),
  );
  const limits = {
    broadCandidateLimit,
    preRankCandidateLimit,
    researchCandidateLimit,
    providerCallLimit,
  };
  return [
      broadCandidateLimit,
      preRankCandidateLimit,
      researchCandidateLimit,
      providerCallLimit,
    ].some((value) => value === null)
    ? null
    : isValidPlusResearchLimits(limits as PlusResearchLimits)
    ? limits as PlusResearchLimits
    : null;
}

function explicitPlusStageLimit(
  raw: string | undefined,
): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return isBoundedPositiveInt(limit, MAX_PLUS_STAGE_LIMIT) &&
      limit >= MIN_PLUS_STAGE_LIMIT
    ? limit
    : null;
}

export function policyForEntitlement(
  entitlement: Pick<ServerEntitlement, "tier"> | null | undefined,
  env: ResearchEnvReader = defaultResearchEnvReader,
): ResearchBudgetProfile | null {
  if (entitlement?.tier === "plus") {
    // Both Plus cost and every stage width must be explicit server-side
    // configuration. Do not infer any value from Free or accept client input.
    const plusCost = explicitPositiveCostMicros(env(PLUS_RESEARCH_COST_ENV));
    const plusLimits = explicitPlusResearchLimits(env);
    return plusCost === null || plusLimits === null
      ? null
      : policyForTier("plus", plusCost, plusLimits);
  }
  return policyForTier("free", researchCostMicros(env));
}

function isBoundedPositiveInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 &&
    value <= max;
}

function isValidPlusResearchLimits(
  limits: PlusResearchLimits | null | undefined,
): limits is PlusResearchLimits {
  if (!limits) return false;
  const values = [
    limits.broadCandidateLimit,
    limits.preRankCandidateLimit,
    limits.researchCandidateLimit,
    limits.providerCallLimit,
  ];
  if (
    !values.every((value) =>
      isBoundedPositiveInt(value, MAX_PLUS_STAGE_LIMIT) &&
      value >= MIN_PLUS_STAGE_LIMIT
    )
  ) return false;
  return limits.broadCandidateLimit >= limits.preRankCandidateLimit &&
    limits.preRankCandidateLimit >= limits.researchCandidateLimit &&
    limits.providerCallLimit >= limits.researchCandidateLimit;
}

/** Validate a DB snapshot before allowing a durable worker to call providers. */
export function parseResearchPolicy(
  value: unknown,
): ResearchBudgetProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const tier = row.tier === "free" || row.tier === "plus" ? row.tier : null;
  if (row.version !== RESEARCH_POLICY_VERSION || tier === null) return null;
  if (row.finalCandidateLimit !== FINAL_CANDIDATE_LIMIT) return null;
  const maxCandidateLimit = tier === "plus"
    ? MAX_PLUS_STAGE_LIMIT
    : P0_CANDIDATE_LIMIT;
  const candidateValues = [
    row.broadCandidateLimit,
    row.preRankCandidateLimit,
    row.researchCandidateLimit,
    row.providerCallLimit,
  ];
  if (
    !candidateValues.every((value): value is number =>
      isBoundedPositiveInt(value, maxCandidateLimit)
    )
  ) return null;
  const [
    broadCandidateLimit,
    preRankCandidateLimit,
    researchCandidateLimit,
    providerCallLimit,
  ] = candidateValues;
  if (tier === "free") {
    if (
      broadCandidateLimit !== P0_CANDIDATE_LIMIT ||
      preRankCandidateLimit !== P0_CANDIDATE_LIMIT ||
      researchCandidateLimit !== P0_CANDIDATE_LIMIT ||
      providerCallLimit !== P0_CANDIDATE_LIMIT
    ) return null;
  } else {
    const plusLimits = {
      broadCandidateLimit,
      preRankCandidateLimit,
      researchCandidateLimit,
      providerCallLimit,
    };
    const legacyP0Snapshot = candidateValues.every((value) =>
      value === P0_CANDIDATE_LIMIT
    );
    // Runs accepted before stage-specific Plus configuration was introduced
    // are immutable and may finish on the old P0 snapshot. New Plus runs can
    // never be created with this shape: policyForEntitlement and the DB RPC
    // both require explicit stage widths >= 4.
    if (!isValidPlusResearchLimits(plusLimits) && !legacyP0Snapshot) {
      return null;
    }
  }
  if (
    typeof row.estimatedCostMicros !== "number" ||
    !Number.isSafeInteger(row.estimatedCostMicros) ||
    row.estimatedCostMicros < 0 ||
    row.estimatedCostMicros > 1_000_000_000
  ) return null;
  return {
    version: RESEARCH_POLICY_VERSION,
    tier,
    finalCandidateLimit: FINAL_CANDIDATE_LIMIT,
    broadCandidateLimit,
    preRankCandidateLimit,
    researchCandidateLimit,
    providerCallLimit,
    estimatedCostMicros: row.estimatedCostMicros as number,
  };
}

export function policySnapshot(
  policy: ResearchBudgetProfile,
): Record<string, unknown> {
  return { ...policy };
}
