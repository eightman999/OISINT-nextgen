import { assert, assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isReusableSafeSharedEvidence } from "../functions/_shared/evidence_content.ts";
import {
  type CandidateEvaluationRow,
  formatNeutralSharedClaim,
  insertEvidenceIfStale,
  investigateAndPersist,
  mergeEvidenceClaims,
} from "../functions/_shared/pipeline.ts";
import type {
  AIProvider,
  CandidateInvestigationInput,
} from "../functions/_shared/providers/types.ts";

interface EvidenceRecord {
  id: string;
  place_id: string;
  scope: string;
  investigation_id: string | null;
  source_type: string;
  source_url: string;
  source_title: string | null;
  excerpt: string;
  structured_claims: Array<{ key: string; value: unknown; rawText: string }>;
  source_quality: number;
  freshness_score: number;
  observed_at: string;
  embedding: string | null;
}

interface ProvenanceState {
  evidence: EvidenceRecord[];
  evaluations: Map<string, CandidateEvaluationRow>;
  nextEvidenceId: number;
}

interface EvidenceQueryResult {
  data: EvidenceRecord[];
  error: null;
}

class FakeEvidenceQuery implements PromiseLike<EvidenceQueryResult> {
  private readonly equals = new Map<string, unknown>();
  private readonly nullColumns = new Set<string>();
  private cutoff: { column: string; value: string } | null = null;
  private maximum = Number.POSITIVE_INFINITY;

  constructor(private readonly state: ProvenanceState) {}

  eq(column: string, value: unknown): this {
    this.equals.set(column, value);
    return this;
  }

  is(column: string, value: null): this {
    if (value === null) this.nullColumns.add(column);
    return this;
  }

  gt(column: string, value: string): this {
    this.cutoff = { column, value };
    return this;
  }

  order(): this {
    return this;
  }

  limit(maximum: number): this {
    this.maximum = maximum;
    return this;
  }

  maybeSingle(): Promise<{ data: EvidenceRecord | null; error: null }> {
    return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
  }

  then<TResult1 = EvidenceQueryResult, TResult2 = never>(
    onfulfilled?:
      | ((value: EvidenceQueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows(), error: null }).then(
      onfulfilled,
      onrejected,
    );
  }

  private rows(): EvidenceRecord[] {
    return this.state.evidence
      .filter((row) =>
        [...this.equals].every(([column, value]) =>
          (row as unknown as Record<string, unknown>)[column] === value
        )
      )
      .filter((row) =>
        [...this.nullColumns].every((column) =>
          (row as unknown as Record<string, unknown>)[column] === null
        )
      )
      .filter((row) =>
        !this.cutoff ||
        String(
            (row as unknown as Record<string, unknown>)[this.cutoff.column],
          ) >
          this.cutoff.value
      )
      .sort((a, b) =>
        b.observed_at.localeCompare(a.observed_at) || a.id.localeCompare(b.id)
      )
      .slice(0, this.maximum);
  }
}

function provenanceDatabase(state: ProvenanceState): SupabaseClient {
  return {
    from(table: string) {
      if (table === "evidence") {
        return {
          select() {
            return new FakeEvidenceQuery(state);
          },
          insert(value: Omit<EvidenceRecord, "id">) {
            return {
              select() {
                return {
                  single() {
                    const row: EvidenceRecord = {
                      ...value,
                      investigation_id: value.investigation_id ?? null,
                      id: `evidence-new-${++state.nextEvidenceId}`,
                    };
                    state.evidence.push(row);
                    return Promise.resolve({
                      data: {
                        id: row.id,
                        scope: row.scope,
                        investigation_id: row.investigation_id,
                        place_id: row.place_id,
                        source_url: row.source_url,
                        structured_claims: row.structured_claims,
                        excerpt: row.excerpt,
                        source_quality: row.source_quality,
                      },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "requirement_evaluations") {
        return {
          upsert(rows: CandidateEvaluationRow[]) {
            for (const row of rows) {
              state.evaluations.set(row.requirement_id, row);
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "candidates") {
        return {
          update() {
            return {
              eq() {
                return Promise.resolve({ data: null, error: null });
              },
            };
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

function twoFindingsOneUrlProvider(
  sourceUrl: string,
  embeddedTexts?: string[],
  capturedInputs?: CandidateInvestigationInput[],
): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      capturedInputs?.push(input);
      const claimByKind = {
        payment: {
          key: "card_accepted" as const,
          value: true,
          rawText: "クレジットカード利用可能",
        },
        reservation: {
          key: "reservation" as const,
          value: true,
          rawText: "予約可能",
        },
      };
      return Promise.resolve({
        summary: "同一公式ページでカードと予約を確認",
        searchQueries: ["fixed provenance query"],
        citations: [{ url: sourceUrl, title: "公式店舗ページ" }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "",
          sourceUrls: [sourceUrl],
          claims: [claimByKind[requirement.kind as "payment" | "reservation"]],
        })),
      });
    },
    embed(texts: string[]) {
      embeddedTexts?.push(...texts);
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function emptyPaymentClaimProvider(sourceUrl: string): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "カード条件の根拠claimなし",
        searchQueries: ["fixed missing-claim query"],
        citations: [{ url: sourceUrl, title: "公式店舗ページ" }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "カード利用可能と回答したが構造化根拠はない",
          sourceUrls: [sourceUrl],
          claims: [],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function paymentWithoutClaimAndReservationProvider(
  sourceUrl: string,
): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "同一URLでカード回答と予約claimを返す",
        searchQueries: ["fixed cross-finding query"],
        citations: [{ url: sourceUrl, title: "公式店舗ページ" }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "fixture",
          sourceUrls: [sourceUrl],
          claims: requirement.kind === "reservation"
            ? [{
              key: "reservation" as const,
              value: true,
              rawText: "予約可能",
            }]
            : [],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function neutralCitationProvider(
  sourceUrl: string,
  embeddedTexts: string[],
): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "中立citation fixture",
        searchQueries: ["fixed neutral citation query"],
        citations: [{
          url: sourceUrl,
          title: "私の秘密の結婚記念日の店",
        }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.82,
          explanation:
            `私の秘密の結婚記念日条件「${requirement.normalizedText}」を確認`,
          sourceUrls: [sourceUrl],
          claims: [],
        })),
      });
    },
    embed(texts: string[]) {
      embeddedTexts.push(...texts);
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function uncitedNeutralProvider(sourceUrl: string): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "citation無し fixture",
        searchQueries: ["fixed uncited query"],
        citations: [],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "古いshared行を借りようとするfixture",
          sourceUrls: [sourceUrl],
          claims: [],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function mixedFabricatedUrlProvider(
  citedUrl: string,
  fabricatedUrl: string,
  attempts: { count: number },
): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      attempts.count += 1;
      return Promise.resolve({
        summary: "実在citationへ未検証URLを混ぜるfixture",
        searchQueries: ["fixed fabricated citation query"],
        citations: [{ url: citedUrl, title: "公式店舗ページ" }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "未検証URLを混ぜたため全体を破棄する",
          sourceUrls: [citedUrl, fabricatedUrl],
          claims: [{
            key: "card_accepted" as const,
            value: true,
            rawText: "クレジットカード利用可能",
          }],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function multiUrlProvider(urls: readonly [string, string]): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "複数URL fixture",
        searchQueries: ["fixed multi source query"],
        citations: urls.map((url, index) => ({
          url,
          title: `公開ページ${index + 1}`,
        })),
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "claimごとの出典URLは不明",
          sourceUrls: [...urls],
          claims: requirement.kind === "payment"
            ? [{
              key: "card_accepted" as const,
              value: true,
              rawText: "クレジットカード利用可能",
            }]
            : [],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function invalidConfidenceProvider(sourceUrl: string): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "範囲外confidence fixture",
        searchQueries: ["fixed invalid confidence query"],
        citations: [{ url: sourceUrl, title: "公式店舗ページ" }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 1.5,
          explanation: "破棄されるべきfinding",
          sourceUrls: [sourceUrl],
          claims: [{
            key: "card_accepted" as const,
            value: true,
            rawText: "クレジットカード利用可能",
          }],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function budgetMatchProvider(sourceUrl: string): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "予算claim fixture",
        searchQueries: ["fixed budget conflict query"],
        citations: [{ url: sourceUrl, title: "公式店舗ページ" }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation: "新しいページでは予算内",
          sourceUrls: [sourceUrl],
          claims: [{
            key: "budget_dinner" as const,
            value: { min: 1000, max: 2000 },
            rawText: "夕食予算: 1000〜2000円",
          }],
        })),
      });
    },
    embed(texts: string[]) {
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

function mixedSharedProvider(
  sourceUrl: string,
  embeddedTexts: string[],
): AIProvider {
  return {
    parseRequirements() {
      throw new Error("not used");
    },
    investigateCandidate(input: CandidateInvestigationInput) {
      return Promise.resolve({
        summary: "shared fact + neutral citation fixture",
        searchQueries: ["fixed mixed query"],
        citations: [{
          url: sourceUrl,
          title: "私の秘密の結婚記念日の店",
        }],
        findings: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          state: "match" as const,
          confidence: 0.9,
          explanation:
            `私の秘密の結婚記念日「${requirement.normalizedText}」を確認`,
          sourceUrls: [sourceUrl],
          claims: requirement.kind === "payment"
            ? [{
              key: "card_accepted" as const,
              value: true,
              rawText: "私の秘密の結婚記念日はカード利用可能",
            }]
            : [],
        })),
      });
    },
    embed(texts: string[]) {
      embeddedTexts.push(...texts);
      return Promise.resolve(texts.map(() => Array(768).fill(0)));
    },
  };
}

Deno.test("pipeline provenance: claim mergeはkey+valueでdedupeし入力順に依存しない", () => {
  const a = {
    key: "reservation" as const,
    value: true,
    rawText: "予約できます",
  };
  const b = {
    key: "card_accepted" as const,
    value: true,
    rawText: "カード利用可能",
  };
  const duplicate = {
    ...a,
    rawText: "予約可",
  };
  assertEquals(
    mergeEvidenceClaims([[a, b], [duplicate]]),
    mergeEvidenceClaims([[duplicate], [b, a]]),
  );
  assertEquals(
    mergeEvidenceClaims([[a, b], [duplicate]]),
    [b, a],
  );
});

Deno.test("pipeline provenance: 同一URLの全finding claimを1行へ統合し、fresh既存不足時はappendする", async () => {
  const sourceUrl = "https://official.example/restaurant";
  const oldEvidence: EvidenceRecord = {
    id: "evidence-old-1",
    place_id: "place-1",
    scope: "shared",
    investigation_id: null,
    source_type: "official_site",
    source_url: sourceUrl,
    source_title: "公式店舗ページ",
    excerpt: "既存行",
    structured_claims: [{
      key: "genre",
      value: ["和食"],
      rawText: "和食",
    }],
    source_quality: 1,
    freshness_score: 1,
    observed_at: new Date().toISOString(),
    embedding: null,
  };
  const state: ProvenanceState = {
    evidence: [oldEvidence],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const requirements = [
    {
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    },
    {
      id: "req-reservation",
      originalText: "予約可能",
      normalizedText: "予約可能",
      kind: "reservation",
      priority: "must",
      sourceAttested: true,
    },
  ];

  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "provenance fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    requirements,
    { updateSummary: true, ai: twoFindingsOneUrlProvider(sourceUrl) },
  );

  assertEquals(state.evidence.length, 2);
  assertEquals(oldEvidence.structured_claims.map((claim) => claim.key), [
    "genre",
  ]);
  const appended = state.evidence.find((row) => row.id !== oldEvidence.id);
  assertEquals(appended?.structured_claims.map((claim) => claim.key), [
    "card_accepted",
    "reservation",
  ]);
  assertEquals(appended?.structured_claims.map((claim) => claim.rawText), [
    "クレジットカード利用可",
    "予約可",
  ]);
  assertEquals(appended?.excerpt, "クレジットカード利用可。予約可");
  for (const requirement of requirements) {
    const evaluation = state.evaluations.get(requirement.id);
    assertEquals(evaluation?.state, "match");
    assertEquals(evaluation?.evidence_ids, [appended?.id]);
    const requiredKey = requirement.kind === "payment"
      ? "card_accepted"
      : "reservation";
    assertEquals(
      appended?.structured_claims.some((claim) => claim.key === requiredKey),
      true,
    );
  }

  // 中立なfull claim集合を持つ行は、後続のsubset claim保存でも
  // excerptをrequired subsetと誤比較せず再利用する。
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-2",
    {
      id: "candidate-2",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "provenance fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-payment-ambiguous",
      originalText: "支払い方法を確認",
      normalizedText: "支払い方法を確認",
      kind: "payment",
      priority: "must",
      sourceAttested: false,
    }],
    { updateSummary: true, ai: twoFindingsOneUrlProvider(sourceUrl) },
  );
  assertEquals(state.evidence.length, 2);
  assertEquals(
    state.evaluations.get("req-payment-ambiguous")?.state,
    "unknown",
  );
});

Deno.test("pipeline provenance: match findingのclaimが空なら同一URLの無関係Evidenceを借りない", async () => {
  const sourceUrl = "https://official.example/restaurant";
  const oldEvidence: EvidenceRecord = {
    id: "evidence-old-genre",
    place_id: "place-1",
    scope: "shared",
    investigation_id: null,
    source_type: "official_site",
    source_url: sourceUrl,
    source_title: "公式店舗ページ",
    excerpt: "和食店です",
    structured_claims: [{ key: "genre", value: ["和食"], rawText: "和食" }],
    source_quality: 1,
    freshness_score: 1,
    observed_at: new Date().toISOString(),
    embedding: null,
  };
  const state: ProvenanceState = {
    evidence: [oldEvidence],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };

  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "missing claim fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    }],
    { updateSummary: true, ai: emptyPaymentClaimProvider(sourceUrl) },
  );

  const evaluation = state.evaluations.get("req-payment");
  assertEquals(evaluation?.state, "unknown");
  assertEquals(evaluation?.evidence_ids, []);
  assertEquals(state.evidence.length, 1);

  // deterministic findingのclaimが無ければshared空行も作らない。
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "missing claim fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    }],
    { updateSummary: true, ai: emptyPaymentClaimProvider(sourceUrl) },
  );
  assertEquals(state.evidence.length, 1);
  assertEquals(state.evaluations.get("req-payment")?.state, "unknown");
  assertEquals(state.evaluations.get("req-payment")?.evidence_ids, []);
});

Deno.test("pipeline provenance: 同一URLの別finding claimをmatch根拠として借りない", async () => {
  const sourceUrl = "https://official.example/shared";
  const state: ProvenanceState = {
    evidence: [],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const requirements = [
    {
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    },
    {
      id: "req-reservation",
      originalText: "予約可能",
      normalizedText: "予約可能",
      kind: "reservation",
      priority: "must",
      sourceAttested: true,
    },
  ];

  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "cross finding fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    requirements,
    {
      updateSummary: true,
      ai: paymentWithoutClaimAndReservationProvider(sourceUrl),
    },
  );

  assertEquals(state.evidence.length, 1);
  assertEquals(state.evidence[0].structured_claims.map((claim) => claim.key), [
    "reservation",
  ]);
  assertEquals(state.evaluations.get("req-payment")?.state, "unknown");
  assertEquals(state.evaluations.get("req-payment")?.evidence_ids, []);
  assertEquals(state.evaluations.get("req-reservation")?.state, "match");
  assertEquals(state.evaluations.get("req-reservation")?.evidence_ids, [
    state.evidence[0].id,
  ]);
});

Deno.test("pipeline provenance: fresh同一URLの内部矛盾Evidenceを再利用せずclean rowへ追記する", async () => {
  const sourceUrl = "https://official.example/conflicting-card";
  const conflictingEvidence: EvidenceRecord = {
    id: "evidence-conflicting-card",
    place_id: "place-1",
    scope: "shared",
    investigation_id: null,
    source_type: "official_site",
    source_url: sourceUrl,
    source_title: "公式店舗ページ",
    excerpt: "相反する既存claim",
    structured_claims: [
      { key: "card_accepted", value: true, rawText: "カード利用可能" },
      { key: "card_accepted", value: false, rawText: "カード利用不可" },
    ],
    source_quality: 1,
    freshness_score: 1,
    observed_at: new Date().toISOString(),
    embedding: null,
  };
  const state: ProvenanceState = {
    evidence: [conflictingEvidence],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };

  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "internal conflict fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    }],
    { updateSummary: true, ai: twoFindingsOneUrlProvider(sourceUrl) },
  );

  assertEquals(state.evidence.length, 2);
  assertEquals(
    conflictingEvidence.structured_claims.map((claim) => claim.value),
    [
      true,
      false,
    ],
  );
  const appended = state.evidence.find((row) =>
    row.id !== conflictingEvidence.id
  );
  assertEquals(appended?.structured_claims, [{
    key: "card_accepted",
    value: true,
    rawText: "クレジットカード利用可",
  }]);
  assertEquals(state.evaluations.get("req-payment")?.state, "match");
  assertEquals(state.evaluations.get("req-payment")?.evidence_ids, [
    appended?.id,
  ]);
});

Deno.test("pipeline provenance: fresh legacyの要件echo入りshared行を借りず中立行をappendする", async () => {
  const candidate = {
    id: "candidate-1",
    place_id: "place-1",
    places: {
      id: "place-1",
      name: "legacy privacy fixture",
      address: null,
      provider: "geoapify",
      provider_place_id: "provider-1",
    },
  };
  const now = new Date().toISOString();

  const claimUrl = "https://official.example/legacy-claim";
  const legacyClaim: EvidenceRecord = {
    id: "legacy-personalized-claim",
    place_id: "place-1",
    scope: "shared",
    investigation_id: null,
    source_type: "official_site",
    source_url: claimUrl,
    source_title: "私の秘密の条件",
    excerpt: "私の秘密の条件でカード可",
    structured_claims: [{
      key: "card_accepted",
      value: true,
      rawText: "私の秘密の条件でカード可",
    }],
    source_quality: 1,
    freshness_score: 1,
    observed_at: now,
    embedding: null,
  };
  const claimState: ProvenanceState = {
    evidence: [legacyClaim],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const capturedInputs: CandidateInvestigationInput[] = [];
  await investigateAndPersist(
    provenanceDatabase(claimState),
    "investigation-1",
    candidate,
    [{
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    }],
    {
      updateSummary: true,
      ai: twoFindingsOneUrlProvider(claimUrl, undefined, capturedInputs),
    },
  );
  assertEquals(claimState.evidence.length, 2);
  const neutralClaim = claimState.evidence.find((row) =>
    row.id !== legacyClaim.id
  );
  assertEquals(
    neutralClaim?.structured_claims[0].rawText,
    "クレジットカード利用可",
  );
  assertEquals(neutralClaim?.excerpt, "クレジットカード利用可");
  assertEquals(claimState.evaluations.get("req-payment")?.evidence_ids, [
    neutralClaim?.id,
  ]);
  assertEquals(capturedInputs.length, 1);
  assertEquals(
    JSON.stringify(capturedInputs[0]).includes("私の秘密の条件"),
    false,
  );

  const citationUrl = "https://official.example/legacy-citation";
  const legacyCitation: EvidenceRecord = {
    ...legacyClaim,
    id: "legacy-personalized-citation",
    source_url: citationUrl,
    structured_claims: [],
  };
  const citationState: ProvenanceState = {
    evidence: [legacyCitation],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const embeddedTexts: string[] = [];
  await investigateAndPersist(
    provenanceDatabase(citationState),
    "investigation-1",
    candidate,
    [{
      id: "req-location",
      originalText: "駅から近い",
      normalizedText: "駅から近い",
      kind: "location",
      priority: "should",
      sourceAttested: true,
    }],
    {
      updateSummary: true,
      ai: neutralCitationProvider(citationUrl, embeddedTexts),
    },
  );
  assertEquals(citationState.evidence.length, 2);
  const neutralCitation = citationState.evidence.find((row) =>
    row.id !== legacyCitation.id
  );
  assertEquals(neutralCitation?.structured_claims, []);
  assertEquals(
    neutralCitation?.excerpt,
    "公開ページ (official.example)",
  );
  assertEquals(citationState.evaluations.get("req-location")?.evidence_ids, [
    neutralCitation?.id,
  ]);
});

Deno.test("pipeline provenance: 同一URLのshared factと中立citationを分離し、利用者文脈をsharedへ保存しない", async () => {
  const sourceUrl = "https://official.example/mixed";
  const embeddedTexts: string[] = [];
  const state: ProvenanceState = {
    evidence: [],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const requirements = [
    {
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    },
    {
      id: "req-location",
      originalText: "結婚記念日に駅から近い",
      normalizedText: "結婚記念日に駅から近い",
      kind: "location",
      priority: "should",
      sourceAttested: true,
    },
    {
      id: "req-dietary",
      originalText: "家族のアレルギー対応",
      normalizedText: "家族のアレルギー対応",
      kind: "dietary",
      priority: "must",
      sourceAttested: true,
    },
  ];
  const candidate = {
    id: "candidate-1",
    place_id: "place-1",
    places: {
      id: "place-1",
      name: "mixed fixture",
      address: null,
      provider: "geoapify",
      provider_place_id: "provider-1",
    },
  };

  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    candidate,
    requirements,
    { updateSummary: true, ai: mixedSharedProvider(sourceUrl, embeddedTexts) },
  );

  assertEquals(state.evidence.length, 2);
  const fact = state.evidence.find((row) => row.structured_claims.length > 0);
  const neutral = state.evidence.find((row) =>
    row.structured_claims.length === 0
  );
  assertEquals(fact?.scope, "shared");
  assertEquals(fact?.investigation_id, null);
  assertEquals(fact?.structured_claims, [{
    key: "card_accepted",
    value: true,
    rawText: "クレジットカード利用可",
  }]);
  assertEquals(fact?.excerpt, "クレジットカード利用可");
  assertEquals(neutral?.scope, "shared");
  assertEquals(neutral?.investigation_id, null);
  assertEquals(neutral?.excerpt, "公開ページ (official.example)");
  assertEquals(neutral?.embedding, null);

  const persistedText = state.evidence.flatMap((row) => [
    row.source_title ?? "",
    row.excerpt,
    ...row.structured_claims.map((claim) => claim.rawText),
  ]).join("\n");
  for (
    const secret of [
      "私の秘密の結婚記念日",
      "結婚記念日に駅から近い",
      "家族のアレルギー対応",
    ]
  ) {
    assertEquals(persistedText.includes(secret), false, secret);
    assertEquals(embeddedTexts.some((text) => text.includes(secret)), false);
  }
  assertEquals(embeddedTexts, [
    "クレジットカード利用可",
  ]);

  assertEquals(state.evaluations.get("req-payment")?.state, "match");
  assertEquals(state.evaluations.get("req-payment")?.evidence_ids, [fact?.id]);
  for (const requirementId of ["req-location", "req-dietary"]) {
    assertEquals(state.evaluations.get(requirementId)?.state, "match");
    assertEquals(state.evaluations.get(requirementId)?.evidence_ids, [
      neutral?.id,
    ]);
  }

  // 同じ調査と別調査のどちらも、今回のproviderがcitationを
  // 返した場合のみ中立shared行を再利用し、行を増やさない。
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    candidate,
    requirements,
    { updateSummary: true, ai: mixedSharedProvider(sourceUrl, embeddedTexts) },
  );
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-2",
    { ...candidate, id: "candidate-2" },
    requirements,
    { updateSummary: true, ai: mixedSharedProvider(sourceUrl, embeddedTexts) },
  );
  assertEquals(state.evidence.length, 2);

  // 古いshared行が存在しても、今回のcitationに無ければmatchに借りない。
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-3",
    { ...candidate, id: "candidate-3" },
    [requirements[1]],
    { updateSummary: true, ai: uncitedNeutralProvider(sourceUrl) },
  );
  assertEquals(state.evaluations.get("req-location")?.state, "unknown");
  assertEquals(state.evaluations.get("req-location")?.evidence_ids, []);
});

Deno.test("pipeline provenance: claimとURLの対応が無い複数URL findingは複製せずunknown", async () => {
  const urls = [
    "https://one.example/page",
    "https://two.example/page",
  ] as const;
  const state: ProvenanceState = {
    evidence: [],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const requirements = [
    {
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    },
    {
      id: "req-location",
      originalText: "駅から近い",
      normalizedText: "駅から近い",
      kind: "location",
      priority: "should",
      sourceAttested: true,
    },
  ];
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "multi source fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    requirements,
    { updateSummary: true, ai: multiUrlProvider(urls) },
  );

  assertEquals(state.evidence, []);
  for (const requirement of requirements) {
    assertEquals(state.evaluations.get(requirement.id)?.state, "unknown");
    assertEquals(state.evaluations.get(requirement.id)?.evidence_ids, []);
  }
});

Deno.test("pipeline provenance: citation外URLが1件でも混ざれば結果全体を破棄しEvidenceを残さない", async () => {
  const attempts = { count: 0 };
  const state: ProvenanceState = {
    evidence: [],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };

  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "fabricated reference fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    }],
    {
      updateSummary: true,
      ai: mixedFabricatedUrlProvider(
        "https://official.example/restaurant",
        "https://fabricated.example/not-cited",
        attempts,
      ),
    },
  );

  assertEquals(attempts.count, 2);
  assertEquals(state.evidence, []);
  assertEquals(state.evaluations.get("req-payment"), {
    investigation_id: "investigation-1",
    candidate_id: "candidate-1",
    requirement_id: "req-payment",
    state: "unknown",
    confidence: null,
    explanation: "外部調査に失敗したため不明です",
    evidence_ids: [],
  });
});

Deno.test("pipeline provenance: 範囲外confidenceのfindingを保存・strict再昇格しない", async () => {
  const sourceUrl = "https://official.example/invalid-confidence";
  const state: ProvenanceState = {
    evidence: [],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "invalid confidence fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-payment",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      sourceAttested: true,
    }],
    { updateSummary: true, ai: invalidConfidenceProvider(sourceUrl) },
  );

  assertEquals(state.evidence, []);
  assertEquals(state.evaluations.get("req-payment"), {
    investigation_id: "investigation-1",
    candidate_id: "candidate-1",
    requirement_id: "req-payment",
    state: "unknown",
    confidence: null,
    explanation: "confidenceが許容範囲外のため判定を破棄しました",
    evidence_ids: [],
  });
});

Deno.test("pipeline provenance: 既知の矛盾予算をresearch片側claimでcategoricalへ戻さない", async () => {
  const now = new Date().toISOString();
  const budgetRow = (
    id: string,
    sourceUrl: string,
    min: number,
    max: number,
  ): EvidenceRecord => ({
    id,
    place_id: "place-1",
    scope: "shared",
    investigation_id: null,
    source_type: "other_public_page",
    source_url: sourceUrl,
    source_title: `公開ページ (${new URL(sourceUrl).hostname})`,
    excerpt: `夕食予算: ${min}〜${max}円`,
    structured_claims: [{
      key: "budget_dinner",
      value: { min, max },
      rawText: `夕食予算: ${min}〜${max}円`,
    }],
    source_quality: 0.8,
    freshness_score: 1,
    observed_at: now,
    embedding: null,
  });
  const state: ProvenanceState = {
    evidence: [
      budgetRow(
        "evidence-known-low",
        "https://low.example/budget",
        1000,
        2000,
      ),
      budgetRow(
        "evidence-known-high",
        "https://high.example/budget",
        4000,
        5000,
      ),
    ],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  await investigateAndPersist(
    provenanceDatabase(state),
    "investigation-1",
    {
      id: "candidate-1",
      place_id: "place-1",
      places: {
        id: "place-1",
        name: "budget conflict fixture",
        address: null,
        provider: "geoapify",
        provider_place_id: "provider-1",
      },
    },
    [{
      id: "req-budget",
      originalText: "予算3000円以下",
      normalizedText: "予算3000円以下",
      kind: "budget",
      priority: "must",
      sourceAttested: true,
    }],
    {
      updateSummary: true,
      ai: budgetMatchProvider("https://current.example/budget"),
    },
  );

  assertEquals(state.evaluations.get("req-budget")?.state, "partial");
  assertEquals(state.evaluations.get("req-budget")?.confidence, 0.6);
  assertEquals(state.evaluations.get("req-budget")?.evidence_ids, [
    "evidence-known-high",
    "evidence-known-low",
    "evidence-new-1",
  ]);
});

Deno.test("pipeline provenance: trusted providerの人間可読excerpt/rawTextを保ち、その文をembedding入力に使う", async () => {
  const embeddedTexts: string[] = [];
  const rawText = "クレジットカードを利用できます";
  const excerpt = "カード対応の店舗情報";
  const url = "https://www.openstreetmap.org/node/5140000001";
  const legacyModelRow: EvidenceRecord = {
    id: "legacy-model-row",
    place_id: "place-1",
    scope: "shared",
    investigation_id: null,
    source_type: "major_place_provider",
    source_url: url,
    source_title: "私の秘密の条件",
    excerpt: "私の秘密の条件",
    structured_claims: [{ key: "card_accepted", value: true, rawText }],
    source_quality: 0.85,
    freshness_score: 1,
    observed_at: new Date().toISOString(),
    embedding: null,
  };
  const state: ProvenanceState = {
    evidence: [legacyModelRow],
    evaluations: new Map(),
    nextEvidenceId: 0,
  };
  const id = await insertEvidenceIfStale(
    provenanceDatabase(state),
    "place-1",
    url,
    // 本番の insertPlaceEvidenceRow と同じ `<店名> - 店舗情報` 形式 (#514)
    "Geoapify 店 - 店舗情報",
    "major_place_provider",
    [{ key: "card_accepted", value: true, rawText }],
    excerpt,
    new Date().toISOString(),
    {
      embed(texts: string[]) {
        embeddedTexts.push(...texts);
        return Promise.resolve(texts.map(() => Array(768).fill(0)));
      },
    },
  );

  assertEquals(id, "evidence-new-1");
  assertEquals(state.evidence.length, 2);
  assertEquals(state.evidence[1].structured_claims[0].rawText, rawText);
  // excerpt は保存する claim の rawText から作る (#514)。呼び出し側の任意文を
  // そのまま保存すると、自分で書いた行を knownClaims として再利用できなくなる
  assertEquals(state.evidence[1].excerpt, rawText);
  assert(isReusableSafeSharedEvidence(state.evidence[1]));
  assertEquals(embeddedTexts, [rawText]);
  assertEquals(
    formatNeutralSharedClaim({
      key: "budget_dinner",
      value: { min: 3000, max: 5000 },
      rawText: "model text",
    }),
    "夕食予算: 3000〜5000円",
  );
});
