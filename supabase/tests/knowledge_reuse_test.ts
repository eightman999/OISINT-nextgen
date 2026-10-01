// Issue #124: 既存 Knowledge の候補統合と鮮度境界。
import { assertEquals } from "@std/assert";
import {
  type CanonicalPlaceHit,
  type CanonicalPlaceRow,
  selectCanonicalPlaceHits,
} from "../functions/_shared/canonical_place_lookup.ts";
import {
  mergeReusableKnowledgeHits,
} from "../functions/_shared/knowledge_reuse.ts";
import { sanitizeInvestigationEventMetadata } from "../functions/_shared/db.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function id(number: number): string {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

function hit(
  number: number,
  options: Partial<CanonicalPlaceHit> = {},
): CanonicalPlaceHit {
  return {
    result: {
      provider: "geoapify",
      providerPlaceId: `geo-${number}`,
      name: `店舗${number}`,
      address: "東京都豊島区池袋1-1-1",
      lat: 35.7,
      lng: 139.7,
      url: `https://example.test/${number}`,
      structuredClaims: [],
      metadata: {},
    },
    canonicalPlaceId: id(number),
    embedding: null,
    linkId: id(1000 + number),
    aliases: [`geoapify\u0000geo-${number}`],
    providerLinkCount: 1,
    provenanceCount: 1,
    factFreshness: "missing",
    freshFactKeys: [],
    staleFactKeys: [],
    freshClaimKeys: [],
    staleClaimKeys: [],
    ...options,
  };
}

function vector(value: number): string {
  return JSON.stringify([value, ...Array(767).fill(0)]);
}

Deno.test("#124: 類似調査・place vector・factsをcanonical IDでdedupeする", () => {
  const result = mergeReusableKnowledgeHits({
    hits: [
      hit(1, {
        embedding: vector(1),
        factFreshness: "fresh",
        freshFactKeys: ["card_accepted"],
        freshClaimKeys: ["card_accepted"],
      }),
      hit(1, { embedding: vector(1) }),
      hit(2, {
        embedding: vector(0.8),
        factFreshness: "stale",
        staleFactKeys: ["budget_dinner"],
      }),
      hit(3),
    ],
    similarPlaceIds: new Set([id(1)]),
    queryVector: [1, ...Array(767).fill(0)],
    broadLimit: 3,
  });

  assertEquals(result.hits.map((item) => item.canonicalPlaceId), [
    id(1),
    id(2),
    id(3),
  ]);
  assertEquals(result.stats, {
    inputHitCount: 4,
    candidateCount: 3,
    duplicateCount: 1,
    similarCandidateCount: 1,
    vectorCandidateCount: 2,
    freshFactCandidateCount: 1,
    staleFactCandidateCount: 1,
    missingFactCandidateCount: 1,
    refreshCandidateCount: 2,
  });
  assertEquals(
    result.metadataByResultKey.get("geoapify\u0000geo-1")?.sources,
    ["similar_investigation", "place_vector", "place_facts", "canonical_place"],
  );
  assertEquals(
    result.metadataByResultKey.get("geoapify\u0000geo-2")?.factFreshness,
    "stale",
  );
});

Deno.test("#124: 不正なvectorは候補生成・類似度へ使わず、facts freshnessは別管理する", () => {
  const result = mergeReusableKnowledgeHits({
    hits: [hit(4, { embedding: "not-json", factFreshness: "stale" })],
    queryVector: [1, 2],
    broadLimit: 10,
  });
  assertEquals(result.stats.vectorCandidateCount, 0);
  assertEquals(result.stats.staleFactCandidateCount, 1);
  assertEquals(
    result.metadataByResultKey.get("geoapify\u0000geo-4")?.vectorSimilarity,
    null,
  );
});

function canonicalRow(
  number: number,
  fact: Record<string, unknown>,
  observedAt: string,
): CanonicalPlaceRow {
  return {
    id: id(number),
    provider: "geoapify",
    provider_place_id: `geo-${number}`,
    name: `店舗${number}`,
    address: "東京都豊島区池袋1-1-1",
    lat: 35.7,
    lng: 139.7,
    metadata: { area: "池袋", keywords: ["焼肉"] },
    embedding: null,
    place_provider_links: [{
      id: id(1000 + number),
      provider: "geoapify",
      provider_place_id: `geo-${number}`,
      source_url: `https://example.test/${number}`,
      storage_policy: "persistent",
      expires_at: null,
      attribution_policy: "osm_odbl_attribution",
      last_seen_at: observedAt,
    }],
    evidence: [{
      id: id(2000 + number),
      source_url: `https://example.test/${number}`,
      source_type: "major_place_provider",
      structured_claims: [{
        key: "card_accepted",
        value: fact.value,
        rawText: `カード利用${fact.value ? "可" : "不可"}`,
      }],
      observed_at: observedAt,
      provider_link_id: id(1000 + number),
    }],
    place_facts: [fact],
  };
}

Deno.test("#124: fresh factだけをknown claimへ戻し、stale/conflictingは再利用しない", () => {
  const fresh = selectCanonicalPlaceHits([
    canonicalRow(10, {
      key: "card_accepted",
      value: true,
      conflicting: false,
      last_verified_at: NOW.toISOString(),
    }, NOW.toISOString()),
  ], {
    area: "池袋",
    keyword: "焼肉",
    requiredCount: 1,
    broadLimit: 10,
    now: NOW,
  });
  assertEquals(fresh.hits[0].factFreshness, "fresh");
  assertEquals(fresh.hits[0].freshFactKeys, ["card_accepted"]);
  assertEquals(
    fresh.hits[0].result.structuredClaims.map((claim) => claim.key),
    [
      "card_accepted",
    ],
  );

  const stale = selectCanonicalPlaceHits([
    canonicalRow(11, {
      key: "card_accepted",
      value: true,
      conflicting: false,
      last_verified_at: "2026-08-20T00:00:00.000Z",
    }, "2026-08-20T00:00:00.000Z"),
  ], {
    area: "池袋",
    keyword: "焼肉",
    requiredCount: 1,
    broadLimit: 10,
    now: NOW,
  });
  assertEquals(stale.hits[0].factFreshness, "stale");
  assertEquals(stale.hits[0].freshFactKeys, []);
  assertEquals(stale.hits[0].result.structuredClaims, [
    {
      key: "card_accepted",
      value: true,
      rawText: "カード利用可",
    },
  ]);

  const conflicting = selectCanonicalPlaceHits([
    canonicalRow(12, {
      key: "card_accepted",
      value: true,
      conflicting: true,
      last_verified_at: NOW.toISOString(),
    }, NOW.toISOString()),
  ], {
    area: "池袋",
    keyword: "焼肉",
    requiredCount: 1,
    broadLimit: 10,
    now: NOW,
  });
  assertEquals(conflicting.hits[0].factFreshness, "stale");
  assertEquals(conflicting.hits[0].result.structuredClaims.length, 1);
});

Deno.test("#124: recall eventはplace IDと集計値だけを保存し、query本文/nameを落とす", () => {
  const sanitized = sanitizeInvestigationEventMetadata({
    places: [{
      placeId: id(20),
      avgVote: 1,
      similarity: 0.9,
      name: "公開店舗名",
      rawQuery: "個人の秘密条件",
    }],
    kinds: [{ kind: "cuisine", priority: "must", count: 2, text: "秘密" }],
  }, "recall_preference");
  assertEquals(sanitized, {
    places: [{ placeId: id(20), avgVote: 1, similarity: 0.9 }],
    kinds: [{ kind: "cuisine", priority: "must", count: 2 }],
  });
});
