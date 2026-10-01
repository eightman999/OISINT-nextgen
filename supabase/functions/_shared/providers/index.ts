// Provider 生成 (spec.md §26)
// DATA_PROVIDER_MODE の分岐はここ 1 箇所のみ。呼び出し側や UI に if (mock) を書かない。
// mock: MockPlaceProvider + MockAIProvider — parse / investigate / embed 全てを外部 API 非依存で返す。
//       外部 API 停止時に mock でデモ完走できることが §5.4 Fallback / §41 の要件。
// live: GeoapifyPlaceProvider + SearchFetchResearchProvider (Serper+フェッチャ+Gemini。
//       grounding 経路は 2026-08-15 廃止 §5。legacy provider API は #297 で完全撤去)
import type {
  AIProvider,
  PlaceSearchProvider,
  PreRankProvider,
  ProviderInstrumentation,
} from "./types.ts";
import { MockPlaceProvider } from "./mock_place.ts";
import { MockAIProvider } from "./mock_research.ts";
import { GeoapifyPlaceProvider } from "./geoapify.ts";
import { OvertureIndexPlaceProvider } from "./overture.ts";
import { SearchFetchResearchProvider } from "./search_fetch_research.ts";
import {
  DeterministicPreRankProvider,
  MockPreRankProvider,
} from "./prerank_deterministic.ts";
import { OpenRouterPreRankProvider } from "./openrouter.ts";
import { CerebrasPreRankProvider } from "./cerebras.ts";
import type { ResearchBudgetProfile } from "../research_policy.ts";
import { FINAL_CANDIDATE_LIMIT } from "../research_policy.ts";

export interface Providers {
  place: PlaceSearchProvider;
  ai: AIProvider;
}

// live の discovery provider を選ぶ (#530 Phase 4 / #297)。
// legacy provider への依存は撤去済み。既定は geoapify。
// 新 provider (Overture #559 等) を足すときはここへ case を追加する。
export function livePlaceProvider(): PlaceSearchProvider {
  const id = Deno.env.get("PLACE_PROVIDER") ?? "geoapify";
  switch (id) {
    case "geoapify":
      return new GeoapifyPlaceProvider();
    // Overture は自前 index (public.place_discovery_index) を読む canonical backbone (#559)。
    // 外部 API を呼ばないため、外部 API 障害でも候補 0 件にならない
    case "overture":
      return new OvertureIndexPlaceProvider();
    default:
      throw new Error(`未知の PLACE_PROVIDER: ${id}`);
  }
}

export function getProviders(
  instrumentation?: ProviderInstrumentation,
): Providers {
  const mode = Deno.env.get("DATA_PROVIDER_MODE") ?? "live";
  if (mode === "mock") {
    return { place: new MockPlaceProvider(), ai: new MockAIProvider() };
  }
  return {
    place: livePlaceProvider(),
    ai: new SearchFetchResearchProvider(undefined, instrumentation),
  };
}

// ============================================================
// Pre-Rank provider の選択 (issue #552)
// DATA_PROVIDER_MODE / PRE_RANK_PROVIDER の分岐はここ 1 箇所のみ。
// 呼び出し側 (run-investigation) に provider 名の if を書かない。
//
// 既定は deterministic — 外部 API を増やさず現行挙動を変えないため。
// PRE_RANK_PROVIDER=openrouter|cerebras で AI pre-rank を有効化する。
// ============================================================
export function getPreRankProvider(): PreRankProvider {
  const mode = Deno.env.get("DATA_PROVIDER_MODE") ?? "live";
  // mock モードでは外部 API を一切呼ばない (§5.4 Fallback: mock で全フロー完走)
  if (mode === "mock") return new MockPreRankProvider();

  const id = Deno.env.get("PRE_RANK_PROVIDER") ?? "deterministic";
  switch (id) {
    case "openrouter":
      return new OpenRouterPreRankProvider();
    case "cerebras":
      return new CerebrasPreRankProvider();
    case "deterministic":
      return new DeterministicPreRankProvider();
    case "mock":
      return new MockPreRankProvider();
    default:
      throw new Error(`未知の PRE_RANK_PROVIDER: ${id}`);
  }
}

// ============================================================
// Pre-Rank / Broad Discovery の候補数 (issue #552 / #554)
// FreeはP0の3件を維持し、Plusはserver snapshotのruntime-configured stage
// 上限を実行経路へ渡す。RevenueCat識別子や課金分岐はここへ持ち込まない。
// ============================================================
const P0_RESEARCH_CANDIDATE_LIMIT = 3;

export interface PreRankLimits {
  broadLimit: number; // place provider から取る候補数
  preRankLimit: number; // pre-rank providerへ渡す候補数 (policy上限)
  researchLimit: number; // Web Research + Gemini Judge へ回す候補数 (policy上限)
  explorationSlots: number; // researchLimit のうち探索枠
}

/**
 * Apply the server snapshot's provider-call ceiling at the last fan-out
 * boundary.  Keeping this as a small pure boundary makes the actual call
 * count auditable in tests; client input cannot widen it.
 */
export function limitResearchProviderCalls<T>(
  pending: readonly T[],
  policy?: ResearchBudgetProfile,
): T[] {
  const limit = policy?.providerCallLimit ?? P0_RESEARCH_CANDIDATE_LIMIT;
  return pending.slice(0, limit);
}

export function preRankLimits(policy?: ResearchBudgetProfile): PreRankLimits {
  // policy が指定された実行経路では、環境変数は運用上の縮小だけを許し、
  // client申告で上限を増やすことはできない。最終候補数は常に3件固定。
  const policyBroadLimit = policy?.broadCandidateLimit ?? FINAL_CANDIDATE_LIMIT;
  const configuredBroadLimit = positiveInt(
    "BROAD_CANDIDATE_LIMIT",
    policyBroadLimit,
  );
  const broadLimit = policy
    ? Math.max(
      FINAL_CANDIDATE_LIMIT,
      Math.min(policyBroadLimit, configuredBroadLimit),
    )
    : Math.max(FINAL_CANDIDATE_LIMIT, configuredBroadLimit);
  // Keep policy-less callers backward-compatible: their pre-rank input is the
  // configured broad pool. Accepted #554 runs always provide the snapshot cap.
  const preRankLimit = policy?.preRankCandidateLimit ?? broadLimit;
  const researchLimit = policy?.researchCandidateLimit ??
    P0_RESEARCH_CANDIDATE_LIMIT;
  const explorationSlots = Math.min(
    Math.max(0, intOrDefault("EXPLORATION_SLOTS", 0)),
    researchLimit,
  );
  return { broadLimit, preRankLimit, researchLimit, explorationSlots };
}

function intOrDefault(name: string, fallback: number): number {
  const raw = parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(raw) ? raw : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const v = intOrDefault(name, fallback);
  return v > 0 ? v : fallback;
}
