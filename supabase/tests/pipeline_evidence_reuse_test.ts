import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type CandidateEvaluationRow,
  investigateAndPersist,
} from "../functions/_shared/pipeline.ts";
import type {
  AIProvider,
  CandidateInvestigationInput,
} from "../functions/_shared/providers/types.ts";
import { DatabaseOperationError } from "../functions/_shared/database_error.ts";

interface ResolverFixture {
  requirements: Array<{
    id: string;
    originalText: string;
    normalizedText: string;
    kind: string;
    priority: string;
    sourceAttested: boolean;
  }>;
  evidence: Array<{
    id: string;
    sourceUrl: string;
    sourceType: string;
    sourceQuality: number;
    structuredClaims: unknown[];
  }>;
  expected: {
    resolvedRequirementIds: string[];
    unresolvedRequirementIds: string[];
  };
}

interface FakeDatabaseState {
  evaluationBatches: CandidateEvaluationRow[][];
  evaluations: Map<string, CandidateEvaluationRow>;
  summary: string | null;
  failEvaluationUpsert?: boolean;
}

interface EvidenceQuery {
  select: () => EvidenceQuery;
  eq: () => EvidenceQuery;
  is: () => EvidenceQuery;
  order: () => EvidenceQuery;
  limit: () => Promise<{ data: Record<string, unknown>[]; error: null }>;
}

function fakePipelineDatabase(
  evidence: Record<string, unknown>[],
  state: FakeDatabaseState,
): SupabaseClient {
  return {
    from(table: string) {
      if (table === "evidence") {
        const query: EvidenceQuery = {
          select: () => query,
          eq: () => query,
          is: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: evidence, error: null }),
        };
        return query;
      }
      if (table === "candidates") {
        return {
          update(values: { summary?: string }) {
            return {
              eq() {
                state.summary = values.summary ?? null;
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }
      if (table === "requirement_evaluations") {
        return {
          upsert(rows: CandidateEvaluationRow[]) {
            if (state.failEvaluationUpsert) {
              return Promise.resolve({
                data: null,
                error: { message: "forced candidate upsert failure" },
              });
            }
            const batch = rows.map((row) => ({
              ...row,
              evidence_ids: [...row.evidence_ids],
            }));
            state.evaluationBatches.push(batch);
            for (const row of batch) {
              state.evaluations.set(row.requirement_id, row);
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "investigation_events") {
        return {
          insert() {
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "place_facts") {
        return {
          upsert() {
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function unresolvedProvider(
  calls: string[][],
  knownClaimsSeen?: CandidateInvestigationInput["knownClaims"][],
): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      calls.push(input.requirements.map((requirement) => requirement.id));
      knownClaimsSeen?.push(input.knownClaims);
      return Promise.resolve({
        summary: "fake provider: 未解決条件は公開情報から確認できませんでした",
        searchQueries: ["fixed-query"],
        citations: [],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "unknown" as const,
          confidence: 0,
          explanation: "fake providerでは確認できませんでした",
          sourceUrls: [],
          claims: [],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function omittedFindingsProvider(calls: string[][]): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      calls.push(input.requirements.map((requirement) => requirement.id));
      return Promise.resolve({
        summary: "fixture provider omitted findings",
        searchQueries: ["fixed-query"],
        citations: [],
        findings: [],
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

Deno.test("pipeline: AI finding欠落時もprovider Evidenceからissue #514の3候補を評価する", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/evidence_unknown_issue_514.json", import.meta.url),
    ),
  ) as {
    requirements: ResolverFixture["requirements"];
    candidates: Array<{
      id: string;
      address: string;
      budget: { min: number; max: number };
      expectedBudgetState: "match" | "mismatch";
    }>;
  };

  for (const item of fixture.candidates) {
    const evidenceId = `evidence-${item.id}`;
    const structuredClaims = [
      {
        key: "genre",
        value: ["焼肉・ホルモン"],
        rawText: "ジャンル: 焼肉・ホルモン",
      },
      {
        key: "budget_dinner",
        value: item.budget,
        rawText: `予算 ${item.budget.min}〜${item.budget.max}円`,
      },
    ];
    const evidenceRows = [{
      id: evidenceId,
      source_url: `https://example.test/${item.id}`,
      source_type: "major_place_provider",
      source_title: `${item.id} - 店舗情報`,
      excerpt: structuredClaims.map((claim) => claim.rawText).join("。"),
      source_quality: 0.85,
      observed_at: new Date().toISOString(),
      structured_claims: structuredClaims,
      scope: "shared",
      investigation_id: null,
    }];
    const state: FakeDatabaseState = {
      evaluationBatches: [],
      evaluations: new Map(),
      summary: null,
    };
    const calls: string[][] = [];
    await investigateAndPersist(
      fakePipelineDatabase(evidenceRows, state),
      "investigation-514",
      {
        id: item.id,
        place_id: `place-${item.id}`,
        places: {
          id: `place-${item.id}`,
          name: item.id,
          address: item.address,
          provider: "geoapify",
          provider_place_id: `provider-${item.id}`,
        },
      },
      fixture.requirements.map((requirement) => ({
        ...requirement,
        priority: "must",
        sourceAttested: true,
      })),
      { updateSummary: true, ai: omittedFindingsProvider(calls) },
    );

    assertEquals(
      state.evaluations.get("req-budget")?.state,
      item.expectedBudgetState,
    );
    // 英語 requirement の cuisine は翻訳同値 lexicon で match (#514)。
    // location はローマ字 → 住所の同値を決定論的に取れないため unknown のまま
    assertEquals(state.evaluations.get("req-cuisine")?.state, "match");
    assertEquals(state.evaluations.get("req-location")?.state, "unknown");
    assertEquals(
      state.evaluations.get("req-budget")?.evidence_ids,
      [evidenceId],
    );
    assertEquals(state.evaluations.get("req-cuisine")?.evidence_ids, [
      evidenceId,
    ]);
    assertEquals(state.evaluations.get("req-location")?.evidence_ids, []);
    // 決定論評価は AI 呼び出し後の override なので、未解決集合そのものは変わらない
    assertEquals(calls, [["req-cuisine", "req-location"]]);
  }
});

Deno.test("pipeline: pre-research reuse 3件と未解決2件を統合し、strict時間判定後も再実行同値", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/evidence_unknown_reduction.json", import.meta.url),
    ),
  ) as ResolverFixture;
  // integration test内の2実行で同一observed_atを使い、TTLだけを現在時刻へ固定する。
  const observedAt = new Date().toISOString();
  const evidenceRows = fixture.evidence.map((item) => ({
    id: item.id,
    source_url: item.sourceUrl,
    source_type: item.sourceType,
    source_title: "fixture restaurant - 店舗情報",
    excerpt: (item.structuredClaims as Array<{ rawText: string }>).map((
      claim,
    ) => claim.rawText).join("。"),
    source_quality: item.sourceQuality,
    observed_at: observedAt,
    structured_claims: item.structuredClaims,
    scope: "shared",
    investigation_id: null,
  }));
  const state: FakeDatabaseState = {
    evaluationBatches: [],
    evaluations: new Map(),
    summary: null,
  };
  const calls: string[][] = [];
  const knownClaimsSeen: CandidateInvestigationInput["knownClaims"][] = [];
  const db = fakePipelineDatabase(evidenceRows, state);
  const ai = unresolvedProvider(calls, knownClaimsSeen);
  const candidate = {
    id: "candidate-fixture-1",
    place_id: "place-fixture-1",
    places: {
      id: "place-fixture-1",
      name: "fixture restaurant",
      address: "fixture address",
      provider: "geoapify",
      provider_place_id: "fixture-provider-1",
    },
  };

  await investigateAndPersist(
    db,
    "investigation-fixture-1",
    candidate,
    fixture.requirements,
    {
      updateSummary: true,
      ai,
    },
  );

  assertEquals(state.evaluationBatches.length, 1);
  assertEquals(state.evaluationBatches[0].length, 5);
  assertEquals(calls, [fixture.expected.unresolvedRequirementIds]);
  assertEquals(
    knownClaimsSeen[0].map((claim) => claim.rawText),
    [
      "夕食予算: 2500〜3500円",
      "総席数: 40席",
      "クレジットカード利用可",
      "営業時間: 17:00-23:00",
    ],
  );
  const first = [...state.evaluations.values()].map((row) => ({
    requirementId: row.requirement_id,
    state: row.state,
    evidenceIds: row.evidence_ids,
  }));
  assertEquals(
    first.filter((row) => row.state !== "unknown").map((row) => row.state),
    ["match", "match", "partial", "mismatch"],
  );
  assertEquals(
    first.filter((row) => row.state !== "unknown").every((row) =>
      row.evidenceIds.length === 1 &&
      row.evidenceIds[0] === "evidence-geoapify-0"
    ),
    true,
  );
  assertEquals(
    first.filter((row) => row.state === "unknown").map((row) =>
      row.requirementId
    ),
    ["req-atmosphere"],
  );

  await investigateAndPersist(
    db,
    "investigation-fixture-1",
    candidate,
    fixture.requirements,
    {
      updateSummary: true,
      ai,
    },
  );
  const second = [...state.evaluations.values()].map((row) => ({
    requirementId: row.requirement_id,
    state: row.state,
    evidenceIds: row.evidence_ids,
  }));
  assertEquals(state.evaluationBatches.length, 2);
  assertEquals(state.evaluationBatches[1].length, 5);
  assertEquals(second, first);
  assertEquals(calls, [
    fixture.expected.unresolvedRequirementIds,
    fixture.expected.unresolvedRequirementIds,
  ]);
  assertEquals(knownClaimsSeen.length, 2);
});

Deno.test("pipeline: fresh shared Evidenceだけで全条件を判定できる候補は外部Researchをskipする", async () => {
  const observedAt = new Date().toISOString();
  const evidenceId = "evidence-fresh-all-1";
  const evidenceRows = [{
    id: evidenceId,
    source_url: "https://example.test/fresh-all",
    source_type: "major_place_provider",
    source_title: "fresh fixture - 店舗情報",
    excerpt: "クレジットカード利用可。予算 2001〜3000円",
    source_quality: 0.9,
    observed_at: observedAt,
    structured_claims: [
      {
        key: "card_accepted",
        value: true,
        rawText: "クレジットカード利用可",
      },
      {
        key: "budget_dinner",
        value: { min: 2001, max: 3000 },
        rawText: "予算 2001〜3000円",
      },
    ],
    scope: "shared",
    investigation_id: null,
  }];
  const state: FakeDatabaseState = {
    evaluationBatches: [],
    evaluations: new Map(),
    summary: null,
  };
  const calls: string[][] = [];

  const outcome = await investigateAndPersist(
    fakePipelineDatabase(evidenceRows, state),
    "investigation-fresh-all-1",
    {
      id: "candidate-fresh-all-1",
      place_id: "place-fresh-all-1",
      places: {
        id: "place-fresh-all-1",
        name: "fresh fixture",
        address: "東京都豊島区池袋1-1-1",
        provider: "geoapify",
        provider_place_id: "fresh-provider-1",
      },
    },
    [
      {
        id: "requirement-card-1",
        originalText: "クレジットカード利用可能",
        normalizedText: "クレジットカード利用可能",
        kind: "payment",
        priority: "must",
        sourceAttested: true,
      },
      {
        id: "requirement-budget-1",
        originalText: "予算は4000円以内",
        normalizedText: "予算は4000円以内",
        kind: "budget",
        priority: "must",
        sourceAttested: true,
      },
    ],
    { updateSummary: true, ai: unresolvedProvider(calls) },
  );

  assertEquals(outcome, {
    reusedRequirementCount: 2,
    unresolvedRequirementCount: 0,
    unknownRequirementCount: 0,
    externalResearchAttempted: false,
  });
  assertEquals(calls, []);
  assertEquals(state.evaluationBatches.length, 1);
  assertEquals(
    [...state.evaluations.values()].map((row) => row.state).sort(),
    ["match", "match"],
  );
  assertEquals(
    [...state.evaluations.values()].every((row) =>
      row.evidence_ids.length === 1 && row.evidence_ids[0] === evidenceId
    ),
    true,
  );
  assertEquals(
    state.summary,
    "fresh fixture は蓄積済みEvidenceから全条件を評価しました。",
  );
});

Deno.test("pipeline: final evaluation DB障害はouter catchでもunknown成功に変換せずrejectする", async () => {
  const state: FakeDatabaseState = {
    evaluationBatches: [],
    evaluations: new Map(),
    summary: null,
    failEvaluationUpsert: true,
  };
  const evidenceRows = [{
    id: "evidence-card-1",
    source_url: "https://official.example/card",
    source_type: "major_place_provider",
    source_title: "failure fixture - 店舗情報",
    excerpt: "クレジットカード利用可能",
    source_quality: 1,
    observed_at: new Date().toISOString(),
    structured_claims: [{
      key: "card_accepted",
      value: true,
      rawText: "クレジットカード利用可能",
    }],
    scope: "shared",
    investigation_id: null,
  }];
  const calls: string[][] = [];
  const db = fakePipelineDatabase(evidenceRows, state);

  await assertRejects(
    () =>
      investigateAndPersist(
        db,
        "investigation-failure-1",
        {
          id: "candidate-failure-1",
          place_id: "place-failure-1",
          places: {
            id: "place-failure-1",
            name: "failure fixture",
            address: null,
            provider: "geoapify",
            provider_place_id: "failure-provider-1",
          },
        },
        [{
          id: "requirement-card-1",
          originalText: "クレジットカード利用可能",
          normalizedText: "クレジットカード利用可能",
          kind: "payment",
          priority: "must",
          sourceAttested: true,
        }],
        { updateSummary: true, ai: unresolvedProvider(calls) },
      ),
    DatabaseOperationError,
    "requirement_evaluations.candidate_upsert",
  );
  assertEquals(state.evaluationBatches, []);
  assertEquals(state.evaluations.size, 0);
  assertEquals(calls, []);
});
