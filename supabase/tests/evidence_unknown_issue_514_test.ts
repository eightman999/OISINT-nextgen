import { assertEquals } from "@std/assert";
import {
  type ClaimWithEvidence,
  deterministicEvaluations,
} from "../functions/_shared/requirement_matching.ts";

interface FixtureRequirement {
  id: string;
  kind: string;
  originalText: string;
  normalizedText: string;
}

interface FixtureCandidate {
  id: string;
  address: string;
  budget: { min: number; max: number };
  expectedBudgetState: "match" | "mismatch";
}

interface Fixture {
  requirements: FixtureRequirement[];
  candidates: FixtureCandidate[];
}

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/evidence_unknown_issue_514.json", import.meta.url),
  ),
) as Fixture;

Deno.test("issue #514: 英語fixtureは予算と翻訳同値の料理ジャンルを決定論評価する", () => {
  for (const candidate of fixture.candidates) {
    const evidenceId = `evidence-${candidate.id}`;
    const claims: ClaimWithEvidence[] = [
      {
        key: "genre",
        value: ["焼肉・ホルモン"],
        rawText: "ジャンル: 焼肉・ホルモン",
        evidenceIds: [evidenceId],
      },
      {
        key: "budget_dinner",
        value: candidate.budget,
        rawText: `予算 ${candidate.budget.min}〜${candidate.budget.max}円`,
        evidenceIds: [evidenceId],
      },
      {
        key: "place_address",
        value: candidate.address,
        rawText: candidate.address,
        evidenceIds: [evidenceId],
      },
    ];

    const evaluations = deterministicEvaluations(fixture.requirements, claims);
    assertEquals(
      evaluations.get("req-budget")?.state,
      candidate.expectedBudgetState,
      candidate.id,
    );
    // 「Yakiniku」⇔「焼肉」は lexicon の翻訳同値クラスで判定できる (#514)。
    // 「Ikebukuro」⇔「池袋」は同値台帳が無いため unknown を維持する
    assertEquals(evaluations.get("req-cuisine")?.state, "match", candidate.id);
    assertEquals(
      evaluations.get("req-cuisine")?.evidenceIds,
      [evidenceId],
      candidate.id,
    );
    assertEquals(evaluations.get("req-location"), undefined, candidate.id);
    assertEquals(evaluations.get("req-budget")?.evidenceIds, [evidenceId]);
  }
});

Deno.test("issue #514: 同等の日本語料理・場所requirementは決定論評価する", () => {
  const evidenceId = "evidence-japanese";
  const evaluations = deterministicEvaluations([
    {
      id: "req-cuisine-ja",
      kind: "cuisine",
      originalText: "焼肉",
      normalizedText: "焼肉",
    },
    {
      id: "req-location-ja",
      kind: "location",
      originalText: "池袋",
      normalizedText: "池袋",
    },
  ], [
    {
      key: "genre",
      value: ["焼肉・ホルモン"],
      rawText: "ジャンル: 焼肉・ホルモン",
      evidenceIds: [evidenceId],
    },
    {
      key: "place_address",
      value: "東京都豊島区西池袋1丁目",
      rawText: "東京都豊島区西池袋1丁目",
      evidenceIds: [evidenceId],
    },
  ]);

  assertEquals(evaluations.get("req-cuisine-ja")?.state, "match");
  assertEquals(evaluations.get("req-location-ja")?.state, "match");
  assertEquals(evaluations.get("req-cuisine-ja")?.evidenceIds, [evidenceId]);
  assertEquals(evaluations.get("req-location-ja")?.evidenceIds, [evidenceId]);
});
