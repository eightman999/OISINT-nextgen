// Issue #509: Broad Discovery → Pre-Rank → Research selection → Top 3 の決定論的な契約。
// 外部 provider / DB は呼ばず、mock fixture / AI と純関数だけで段階間の上限を検証する。
import { assert, assertEquals } from "@std/assert";
import { computeScore } from "../functions/_shared/ranking.ts";
import {
  deterministicPreRank,
  hardFilter,
  type PreRankCandidate,
  type PreRankRequirement,
  selectResearchCandidates,
} from "../functions/_shared/prerank.ts";
import { assignRanks } from "../functions/_shared/ranking.ts";
import {
  limitResearchProviderCalls,
  preRankLimits,
} from "../functions/_shared/providers/index.ts";
import {
  MOCK_BROAD_CANDIDATE_COUNT,
  MockPlaceProvider,
} from "../functions/_shared/providers/mock_place.ts";
import { MockAIProvider } from "../functions/_shared/providers/mock_research.ts";
import { policyForTier } from "../functions/_shared/research_policy.ts";
import type { PlaceSearchResult } from "../functions/_shared/providers/types.ts";
import {
  filterValidClaims,
  groundedCandidateInvestigationSchema,
  type StructuredClaimInput,
} from "../functions/_shared/validation.ts";

function toPreRankCandidate(result: PlaceSearchResult): PreRankCandidate {
  const genre = result.structuredClaims.find((claim) => claim.key === "genre");
  const categories = Array.isArray(genre?.value)
    ? genre.value.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: `${result.provider}:${result.providerPlaceId}`,
    name: result.name,
    provider: result.provider,
    distanceM: null,
    categories,
    knownClaims: result.structuredClaims.map((claim) => ({
      key: claim.key,
      value: claim.value,
      rawText: claim.rawText,
    })),
  };
}

const requirements: PreRankRequirement[] = [
  {
    id: "budget",
    kind: "budget",
    priority: "must",
    weight: 1,
    normalizedText: "予算は4000円以内",
    originalText: "予算は4000円以内",
  },
  {
    id: "cuisine",
    kind: "cuisine",
    priority: "should",
    weight: 1,
    normalizedText: "肉料理が主体の店",
    originalText: "肉料理が主体の店",
  },
];

Deno.test("#509 mock Broad Discovery: 20件超をPre-Rankし、Researchを独立上限で選抜してTop3にする", async () => {
  const policy = policyForTier("plus", 50_000, {
    broadCandidateLimit: 24,
    preRankCandidateLimit: 12,
    researchCandidateLimit: 6,
    providerCallLimit: 6,
  });
  const limits = preRankLimits(policy);
  const provider = new MockPlaceProvider();
  const broad = await provider.search({
    area: "池袋",
    keyword: "焼肉",
    limit: limits.broadLimit,
  });

  assert(MOCK_BROAD_CANDIDATE_COUNT >= 20);
  assertEquals(broad.length, 24);
  assertEquals(
    new Set(broad.map((candidate) => candidate.providerPlaceId)).size,
    broad.length,
  );
  for (const candidate of broad) {
    assertEquals(
      filterValidClaims(candidate.structuredClaims as StructuredClaimInput[])
        .length,
      candidate.structuredClaims.length,
      `${candidate.providerPlaceId} のstructured claimが不正です`,
    );
  }
  assertEquals(
    broad.map((candidate) => candidate.providerPlaceId),
    (await provider.search({
      area: "池袋",
      keyword: "焼肉",
      limit: limits.broadLimit,
    }))
      .map((candidate) => candidate.providerPlaceId),
  );

  // Broad は24件のまま、Pre-Rankだけserver snapshotの12件へ渡す。
  const preRankInput = broad.slice(0, limits.preRankLimit).map(
    toPreRankCandidate,
  );
  const preRanked = deterministicPreRank(preRankInput, requirements);
  const filtered = hardFilter(preRankInput, requirements, preRanked);
  const selection = selectResearchCandidates(filtered.kept, preRanked, {
    researchLimit: limits.researchLimit,
    explorationSlots: 2,
  });

  assertEquals(preRankInput.length, 12);
  assertEquals(selection.selected.length, 6);
  assert(selection.exploration.length > 0);
  assert(
    selection.exploration.some((id) =>
      (preRanked.find((result) => result.id === id)?.unknown.length ?? 0) > 0
    ),
  );

  // 同じ候補集合でも入力順に依存しない。乱数や時刻を selection に持ち込まない。
  const reversed = [...preRankInput].reverse();
  const reversedResults = deterministicPreRank(reversed, requirements);
  const reversedSelection = selectResearchCandidates(
    reversed,
    reversedResults,
    { researchLimit: limits.researchLimit, explorationSlots: 2 },
  );
  assertEquals(reversedSelection, selection);

  // 高価な provider/AI 呼び出しは Broad 件数とは独立した6件上限で止める。
  assertEquals(limitResearchProviderCalls(broad, policy).length, 6);
  assertEquals(
    limitResearchProviderCalls(selection.selected, policy).length,
    6,
  );

  // 選抜された候補だけを mock AI で調査し、既存の final score 式へ渡す。
  // Broad 24件をそのまま AI 評価していないことを呼び出し数で固定する。
  const ai = new MockAIProvider();
  const researchResults = await Promise.all(
    selection.selected.map(async (id) => {
      const candidate = broad.find((item) =>
        `${item.provider}:${item.providerPlaceId}` === id
      );
      assert(candidate, id);
      const result = await ai.investigateCandidate({
        place: {
          name: candidate.name,
          address: candidate.address,
          providerPlaceId: candidate.providerPlaceId,
        },
        requirements: requirements.map((requirement) => ({
          id: requirement.id,
          normalizedText: requirement.normalizedText,
          kind: requirement.kind,
          priority: requirement.priority,
        })),
        knownClaims: candidate.structuredClaims,
      });
      assert(groundedCandidateInvestigationSchema.safeParse(result).success);
      return { id, result };
    }),
  );
  assertEquals(researchResults.length, limits.researchLimit);
  const finalRanks = assignRanks(
    researchResults.map(({ id, result }, index) => ({
      id,
      score: computeScore({
        requirements: requirements.map(({ id, priority, weight }) => ({
          id,
          priority,
          weight,
        })),
        evaluations: result.findings.map((finding) => ({
          requirementId: finding.requirementId,
          state: finding.state,
          confidence: finding.confidence,
        })),
        evidenceQualities: [0.8],
        evidenceFreshness: [1],
        voteValues: [],
        memberCount: 0,
        semanticMatch: 0.5,
      }),
      createdAt: `2026-08-30T00:00:0${index}Z`,
    })),
  );
  const top3 = [...finalRanks.entries()]
    .filter(([, rank]) => rank <= 3)
    .map(([id]) => id);
  assertEquals(top3.length, 3);
  assertEquals(new Set(top3).size, 3);
});

Deno.test("#509 mock Broad Discovery: limitは候補fixtureを越えず、無効値は空でfail-closed", async () => {
  const provider = new MockPlaceProvider();
  assertEquals(
    (await provider.search({ area: "池袋", limit: 100 })).length,
    MOCK_BROAD_CANDIDATE_COUNT,
  );
  assertEquals((await provider.search({ area: "池袋", limit: 0 })).length, 0);
  assertEquals((await provider.search({ area: "池袋", limit: -1 })).length, 0);
  assertEquals(
    (await provider.search({ area: "池袋", limit: Number.NaN })).length,
    0,
  );
});
