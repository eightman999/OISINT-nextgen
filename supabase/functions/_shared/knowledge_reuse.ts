// 既存 Knowledge を Broad Discovery へ戻すための純粋な統合器 (#124 / #509)。
//
// 類似調査・current place vector・place_facts は候補生成の根拠にしか使わず、
// Evidence の無い「match」や最終 score をここで作らない。provider の検索結果と
// 同じ CanonicalPlaceHit に揃え、canonical ID で重複を除いてから既存の pre-rank
// へ渡す。入力には自由文の調査本文を受けないため、他ユーザーの private query が
// この経路を通って漏れることもない。
import {
  type CanonicalPlaceHit,
  canonicalResultKey,
  type KnowledgeFreshness,
} from "./canonical_place_lookup.ts";
import { cosineSimilarity } from "./ranking.ts";
import { parseEmbeddingVector } from "./embedding_validation.ts";

export type KnowledgeCandidateSource =
  | "similar_investigation"
  | "place_vector"
  | "place_facts"
  | "canonical_place";

export interface KnowledgeCandidateMetadata {
  sources: KnowledgeCandidateSource[];
  factFreshness: KnowledgeFreshness;
  vectorSimilarity: number | null;
  freshFactKeys: string[];
  staleFactKeys: string[];
  freshClaimKeys: string[];
  staleClaimKeys: string[];
}

export interface KnowledgeReuseStats {
  inputHitCount: number;
  candidateCount: number;
  duplicateCount: number;
  similarCandidateCount: number;
  vectorCandidateCount: number;
  freshFactCandidateCount: number;
  staleFactCandidateCount: number;
  missingFactCandidateCount: number;
  refreshCandidateCount: number;
}

export interface KnowledgeReuseResult {
  hits: CanonicalPlaceHit[];
  metadataByResultKey: Map<string, KnowledgeCandidateMetadata>;
  stats: KnowledgeReuseStats;
}

export interface KnowledgeReuseInput {
  hits: readonly CanonicalPlaceHit[];
  similarPlaceIds?: ReadonlySet<string>;
  queryVector?: readonly number[] | null;
  broadLimit: number;
}

const SOURCE_ORDER: Record<KnowledgeCandidateSource, number> = {
  similar_investigation: 0,
  place_vector: 1,
  place_facts: 2,
  canonical_place: 3,
};

const FRESHNESS_ORDER: Record<KnowledgeFreshness, number> = {
  fresh: 0,
  stale: 1,
  missing: 2,
};

function validVector(
  value: readonly number[] | null | undefined,
): number[] | null {
  if (!value) return null;
  const parsed = parseEmbeddingVector(JSON.stringify([...value]));
  return parsed;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbersDescending(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function sourceList(
  hit: CanonicalPlaceHit,
  similarPlaceIds: ReadonlySet<string>,
  vectorSimilarity: number | null,
): KnowledgeCandidateSource[] {
  const sources: KnowledgeCandidateSource[] = [];
  if (similarPlaceIds.has(hit.canonicalPlaceId)) {
    sources.push("similar_investigation");
  }
  if (vectorSimilarity !== null) sources.push("place_vector");
  if (hit.factFreshness !== "missing") sources.push("place_facts");
  // 既存 canonical read が返した候補もprovider結果とのmerge対象である。
  // これを別sourceとして残すことで、sourceが無い候補を黙って捨てず、
  // pre-rankでは fresh claim の無い限り unknown のまま扱える。
  sources.push("canonical_place");
  return sources.sort((left, right) =>
    SOURCE_ORDER[left] - SOURCE_ORDER[right]
  );
}

function metadataForHit(
  hit: CanonicalPlaceHit,
  similarPlaceIds: ReadonlySet<string>,
  queryVector: number[] | null,
): KnowledgeCandidateMetadata {
  const embedding = parseEmbeddingVector(hit.embedding);
  const vectorSimilarity = queryVector && embedding
    ? (() => {
      const value = cosineSimilarity(queryVector, embedding);
      return Number.isFinite(value) ? value : null;
    })()
    : null;
  return {
    sources: sourceList(hit, similarPlaceIds, vectorSimilarity),
    factFreshness: hit.factFreshness,
    vectorSimilarity,
    freshFactKeys: [...hit.freshFactKeys],
    staleFactKeys: [...hit.staleFactKeys],
    freshClaimKeys: [...hit.freshClaimKeys],
    staleClaimKeys: [...hit.staleClaimKeys],
  };
}

/**
 * 複数の既知候補を canonical ID でmergeし、決定論的なBroad候補列を返す。
 * 同じ店が類似調査・vector・factsの複数経路に現れても1件として扱う。
 */
export function mergeReusableKnowledgeHits(
  input: KnowledgeReuseInput,
): KnowledgeReuseResult {
  const similarPlaceIds = input.similarPlaceIds ?? new Set<string>();
  const queryVector = validVector(input.queryVector);
  const byCanonicalId = new Map<string, {
    hit: CanonicalPlaceHit;
    metadata: KnowledgeCandidateMetadata;
  }>();
  let duplicateCount = 0;

  for (const hit of input.hits) {
    const metadata = metadataForHit(hit, similarPlaceIds, queryVector);
    const current = byCanonicalId.get(hit.canonicalPlaceId);
    if (!current) {
      byCanonicalId.set(hit.canonicalPlaceId, { hit, metadata });
      continue;
    }
    duplicateCount += 1;
    const mergedSources = [
      ...new Set([
        ...current.metadata.sources,
        ...metadata.sources,
      ]),
    ].sort((left, right) => SOURCE_ORDER[left] - SOURCE_ORDER[right]);
    const preferred = FRESHNESS_ORDER[metadata.factFreshness] <
        FRESHNESS_ORDER[current.metadata.factFreshness]
      ? metadata
      : current.metadata;
    current.metadata = {
      ...preferred,
      sources: mergedSources,
      vectorSimilarity: current.metadata.vectorSimilarity === null
        ? metadata.vectorSimilarity
        : metadata.vectorSimilarity === null
        ? current.metadata.vectorSimilarity
        : Math.max(
          current.metadata.vectorSimilarity,
          metadata.vectorSimilarity,
        ),
      freshFactKeys: [
        ...new Set([
          ...current.metadata.freshFactKeys,
          ...metadata.freshFactKeys,
        ]),
      ].sort(compareStrings),
      staleFactKeys: [
        ...new Set([
          ...current.metadata.staleFactKeys,
          ...metadata.staleFactKeys,
        ]),
      ].sort(compareStrings),
      freshClaimKeys: [
        ...new Set([
          ...current.metadata.freshClaimKeys,
          ...metadata.freshClaimKeys,
        ]),
      ].sort(compareStrings),
      staleClaimKeys: [
        ...new Set([
          ...current.metadata.staleClaimKeys,
          ...metadata.staleClaimKeys,
        ]),
      ].sort(compareStrings),
    };
  }

  const entries = [...byCanonicalId.values()].sort((left, right) => {
    const leftSource = SOURCE_ORDER[left.metadata.sources[0]];
    const rightSource = SOURCE_ORDER[right.metadata.sources[0]];
    if (leftSource !== rightSource) return leftSource - rightSource;
    const vectorOrder = compareNumbersDescending(
      left.metadata.vectorSimilarity,
      right.metadata.vectorSimilarity,
    );
    if (vectorOrder !== 0) return vectorOrder;
    const freshness = FRESHNESS_ORDER[left.metadata.factFreshness] -
      FRESHNESS_ORDER[right.metadata.factFreshness];
    if (freshness !== 0) return freshness;
    return compareStrings(
      left.hit.canonicalPlaceId,
      right.hit.canonicalPlaceId,
    );
  });
  const limited = entries.slice(0, Math.max(0, Math.floor(input.broadLimit)));
  const metadataByResultKey = new Map<string, KnowledgeCandidateMetadata>();
  for (const entry of limited) {
    metadataByResultKey.set(
      canonicalResultKey(entry.hit.result),
      entry.metadata,
    );
  }

  let similarCandidateCount = 0;
  let vectorCandidateCount = 0;
  let freshFactCandidateCount = 0;
  let staleFactCandidateCount = 0;
  let missingFactCandidateCount = 0;
  for (const entry of limited) {
    const { metadata } = entry;
    if (metadata.sources.includes("similar_investigation")) {
      similarCandidateCount += 1;
    }
    if (metadata.sources.includes("place_vector")) vectorCandidateCount += 1;
    if (metadata.factFreshness === "fresh") freshFactCandidateCount += 1;
    else if (metadata.factFreshness === "stale") staleFactCandidateCount += 1;
    else missingFactCandidateCount += 1;
  }
  return {
    hits: limited.map((entry) => entry.hit),
    metadataByResultKey,
    stats: {
      inputHitCount: input.hits.length,
      candidateCount: limited.length,
      duplicateCount,
      similarCandidateCount,
      vectorCandidateCount,
      freshFactCandidateCount,
      staleFactCandidateCount,
      missingFactCandidateCount,
      refreshCandidateCount: staleFactCandidateCount +
        missingFactCandidateCount,
    },
  };
}
