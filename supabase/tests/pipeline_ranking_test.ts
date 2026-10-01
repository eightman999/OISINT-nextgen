import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseOperationError } from "../functions/_shared/database_error.ts";
import {
  RANKING_BULK_QUERY_COUNT,
  rankInvestigation,
} from "../functions/_shared/pipeline.ts";
import { AI_OUTPUT_LIMITS } from "../functions/_shared/validation.ts";

interface RankFixture {
  evidenceError?: unknown;
  recallError?: unknown;
  candidateScoreError?: unknown;
  candidateRankError?: unknown;
  evaluationUpdateError?: unknown;
  commitError?: unknown;
  commitData?: Record<string, unknown>;
  rawQuery?: string;
  requirements?: Record<string, unknown>[];
  evidence?: Record<string, unknown>[];
  evaluations?: Record<string, unknown>[];
  votes?: Record<string, unknown>[];
  candidates?: Record<string, unknown>[];
}

interface RankState {
  evaluationUpdates: Record<string, unknown>[];
  candidateUpdates: Record<string, unknown>[];
  queryCount: number;
  rpcCalls: number;
  rpcPayloads: Record<string, unknown>[];
}

function rankDatabase(fixture: RankFixture = {}): {
  db: SupabaseClient;
  state: RankState;
} {
  const state: RankState = {
    evaluationUpdates: [],
    candidateUpdates: [],
    queryCount: 0,
    rpcCalls: 0,
    rpcPayloads: [],
  };
  const requirements = fixture.requirements ?? [];
  const evidence = (fixture.evidence ?? []).map((row) => ({
    place_id: "place-1",
    ...row,
  }));
  const evaluations = (fixture.evaluations ?? []).map((row) => ({
    candidate_id: "candidate-1",
    investigation_id: "investigation-1",
    ...row,
  }));
  const votes = (fixture.votes ?? []).map((row) => ({
    candidate_id: "candidate-1",
    investigation_id: "investigation-1",
    ...row,
  }));
  const candidates = fixture.candidates ?? [{
    id: "candidate-1",
    place_id: "place-1",
    created_at: "2026-08-16T00:00:00.000Z",
    places: { embedding: null },
  }];

  const response = (
    table: string,
    operation: "select" | "update" | "insert",
    values?: Record<string, unknown>,
  ) => {
    if (operation === "select") state.queryCount += 1;
    if (operation === "insert") return { data: null, error: null };
    if (operation === "update") {
      if (table === "requirement_evaluations") {
        state.evaluationUpdates.push(values ?? {});
        return { data: null, error: fixture.evaluationUpdateError ?? null };
      }
      if (table === "candidates") {
        state.candidateUpdates.push(values ?? {});
        const error = "rank" in (values ?? {})
          ? fixture.candidateRankError
          : fixture.candidateScoreError;
        return { data: null, error: error ?? null };
      }
      return { data: null, error: null };
    }
    if (table === "investigations") {
      return {
        data: { embedding: null, raw_query: fixture.rawQuery ?? "寿司" },
        error: null,
      };
    }
    if (table === "requirements") return { data: requirements, error: null };
    if (table === "investigation_events") {
      return { data: null, error: fixture.recallError ?? null };
    }
    if (table === "investigation_members") {
      return { data: null, count: 1, error: null };
    }
    if (table === "candidates") {
      return { data: candidates, error: null };
    }
    if (table === "evidence") {
      return { data: evidence, error: fixture.evidenceError ?? null };
    }
    if (table === "requirement_evaluations") {
      return { data: evaluations, error: null };
    }
    if (table === "votes") return { data: votes, error: null };
    throw new Error(`unexpected table: ${table}`);
  };

  const db = {
    from(table: string) {
      let operation: "select" | "update" | "insert" = "select";
      let values: Record<string, unknown> | undefined;
      const query = {
        select() {
          operation = "select";
          return query;
        },
        update(next: Record<string, unknown>) {
          operation = "update";
          values = next;
          return query;
        },
        insert(next: Record<string, unknown>) {
          operation = "insert";
          values = next;
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        or() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        single() {
          return Promise.resolve(response(table, operation, values));
        },
        maybeSingle() {
          return Promise.resolve(response(table, operation, values));
        },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?:
            | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
        ) {
          return Promise.resolve(response(table, operation, values)).then(
            onfulfilled,
            onrejected,
          );
        },
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      state.rpcCalls += 1;
      state.rpcPayloads.push({ name, ...args });
      const evaluationPayload = Array.isArray(args.p_evaluations)
        ? args.p_evaluations as Record<string, unknown>[]
        : [];
      state.evaluationUpdates.push(
        ...evaluationPayload.map((evaluation) => ({
          state: evaluation.state,
          confidence: evaluation.confidence,
          explanation: evaluation.explanation,
          evidence_ids: evaluation.evidence_ids,
        })),
      );
      const candidatePayload = Array.isArray(args.p_candidates)
        ? args.p_candidates as Record<string, unknown>[]
        : [];
      state.candidateUpdates.push(...candidatePayload);
      return Promise.resolve({
        data: fixture.commitData ?? {
          queryCount: candidates.length > 0 ? 9 : 6,
          updatedRows: candidatePayload.length,
          evaluationRows: evaluationPayload.length,
          candidateRows: candidatePayload.length,
          deletedRows: 0,
          latencyMs: 1,
        },
        error: fixture.commitError ?? null,
      });
    },
  } as unknown as SupabaseClient;
  return { db, state };
}

function safeCardEvidence(id: string, value: boolean): Record<string, unknown> {
  const rawText = `クレジットカード利用${value ? "可" : "不可"}`;
  return {
    id,
    scope: "shared",
    investigation_id: null,
    source_url: `https://official.example/${id}`,
    source_type: "other_public_page",
    source_title: "公開ページ (official.example)",
    excerpt: rawText,
    source_quality: 0.8,
    observed_at: "2026-08-16T00:00:00.000Z",
    structured_claims: [{ key: "card_accepted", value, rawText }],
    embedding: null,
  };
}

function safeBooleanEvidence(
  id: string,
  key: "private_room" | "reservation",
  value: boolean,
): Record<string, unknown> {
  const rawText = key === "private_room"
    ? `個室${value ? "あり" : "なし"}`
    : `予約${value ? "可" : "不可"}`;
  return {
    ...safeCardEvidence(id, value),
    excerpt: rawText,
    structured_claims: [{ key, value, rawText }],
  };
}

function safeCapacityEvidence(
  id: string,
  value: number,
): Record<string, unknown> {
  const rawText = `総席数: ${value}席`;
  return {
    ...safeCardEvidence(id, true),
    excerpt: rawText,
    structured_claims: [{ key: "capacity", value, rawText }],
  };
}

function safeBudgetEvidence(
  id: string,
  min: number,
  max: number,
): Record<string, unknown> {
  const rawText = `夕食予算: ${min}〜${max}円`;
  return {
    ...safeCardEvidence(id, true),
    excerpt: rawText,
    structured_claims: [{
      key: "budget_dinner",
      value: { min, max },
      rawText,
    }],
  };
}

Deno.test("ranking: required DB read/write failures are typed and fail closed", async () => {
  for (
    const testCase of [
      {
        fixture: { evidenceError: { message: "forced evidence read" } },
        operation: "evidence.ranking_select",
      },
      {
        fixture: { recallError: { message: "forced recall read" } },
        operation: "investigation_events.recall_select",
      },
      {
        fixture: { commitError: { message: "forced ranking commit" } },
        operation: "ranking.commit",
      },
    ]
  ) {
    const { db } = rankDatabase(testCase.fixture);
    const error = await assertRejects(
      () => rankInvestigation(db, "investigation-1"),
      DatabaseOperationError,
      testCase.operation,
    );
    assertEquals(error.operation, testCase.operation);
  }
});

Deno.test("ranking: source-unverified/foreign Evidence evaluation is demoted to unknown", async () => {
  const { db, state } = rankDatabase({
    rawQuery: "カードは使いたくない",
    requirements: [{
      id: "requirement-1",
      kind: "other",
      priority: "must",
      weight: 1,
      embedding: JSON.stringify(Array(768).fill(0)),
      text: "クレジットカード利用可能",
      normalized_text: "クレジットカード利用可能",
    }],
    evaluations: [{
      id: "evaluation-1",
      requirement_id: "requirement-1",
      state: "mismatch",
      confidence: 0.9,
      explanation: "legacy mismatch",
      evidence_ids: ["foreign"],
    }],
  });
  await rankInvestigation(db, "investigation-1");
  assertEquals(state.evaluationUpdates[0], {
    state: "unknown",
    confidence: 0,
    explanation:
      "ユーザー原文に一意な条件記述を確認できないため判定を保留しました",
    evidence_ids: [],
  });
});

Deno.test("ranking: source-unverified unknown is not promoted by candidate-wide contradictions", async () => {
  const { db, state } = rankDatabase({
    rawQuery: "カードは使いたくない",
    requirements: [{
      id: "requirement-1",
      kind: "payment",
      priority: "must",
      weight: 1,
      embedding: JSON.stringify(Array(768).fill(0)),
      text: "カード利用可",
      normalized_text: "クレジットカード利用可能",
    }],
    evidence: [safeCardEvidence("e-a", true), safeCardEvidence("e-b", false)],
    evaluations: [{
      id: "evaluation-1",
      requirement_id: "requirement-1",
      state: "unknown",
      confidence: 0,
      explanation: "根拠未確認",
      evidence_ids: [],
    }],
  });
  await rankInvestigation(db, "investigation-1");
  assertEquals(state.evaluationUpdates[0], {
    state: "unknown",
    confidence: 0,
    explanation:
      "ユーザー原文に一意な条件記述を確認できないため判定を保留しました",
    evidence_ids: [],
  });
});

Deno.test("ranking: contradiction demotion converges match/mismatch/partial to both actual Evidence IDs", async () => {
  for (
    const stateName of ["match", "mismatch", "partial", "unknown"] as const
  ) {
    const evidence = [
      safeCardEvidence("e-a", true),
      safeCardEvidence("e-b", false),
    ];
    const { db, state } = rankDatabase({
      rawQuery: "カード利用可",
      requirements: [{
        id: "requirement-1",
        kind: "payment",
        priority: "must",
        weight: 1,
        embedding: JSON.stringify(Array(768).fill(0)),
        text: "カード利用可",
        normalized_text: "クレジットカード利用可能",
      }],
      evidence,
      evaluations: [{
        id: "evaluation-1",
        requirement_id: "requirement-1",
        state: stateName,
        confidence: stateName === "partial" ? 0.5 : 0.9,
        explanation: "legacy categorical assertion",
        evidence_ids: ["e-a"],
      }],
    });
    await rankInvestigation(db, "investigation-1");
    assertEquals(state.evaluationUpdates[0], {
      state: "partial",
      confidence: 0.5,
      explanation: "情報源が矛盾するため部分適合として扱います",
      evidence_ids: ["e-a", "e-b"],
    }, stateName);

    const { db: convergedDb, state: convergedState } = rankDatabase({
      rawQuery: "カード利用可",
      requirements: [{
        id: "requirement-1",
        kind: "payment",
        priority: "must",
        weight: 1,
        embedding: JSON.stringify(Array(768).fill(0)),
        text: "カード利用可",
        normalized_text: "クレジットカード利用可能",
      }],
      evidence,
      evaluations: [{
        id: "evaluation-1",
        requirement_id: "requirement-1",
        ...state.evaluationUpdates[0],
      }],
    });
    await rankInvestigation(convergedDb, "investigation-1");
    assertEquals(
      convergedState.evaluationUpdates,
      [],
      `${stateName}: second pass`,
    );
  }
});

Deno.test("ranking: contradiction relevance separates seat reservation, private room, and party size", async () => {
  const privateRoomEvidence = [
    safeBooleanEvidence("e-private-yes", "private_room", true),
    safeBooleanEvidence("e-private-no", "private_room", false),
  ];

  const reservationCase = rankDatabase({
    rawQuery: "予約可",
    requirements: [{
      id: "requirement-reservation",
      kind: "reservation",
      priority: "must",
      weight: 1,
      embedding: null,
      text: "予約可",
      normalized_text: "予約可能",
    }],
    evidence: privateRoomEvidence,
    evaluations: [{
      id: "evaluation-reservation",
      requirement_id: "requirement-reservation",
      state: "match",
      confidence: 0.9,
      explanation: "legacy assertion",
      evidence_ids: ["e-private-yes"],
    }],
  });
  await rankInvestigation(reservationCase.db, "investigation-1");
  assertEquals(reservationCase.state.evaluationUpdates[0], {
    state: "unknown",
    confidence: 0,
    explanation: "Evidenceの内容が条件判定に対応しないため判定を保留しました",
    evidence_ids: [],
  });

  const partyCase = rankDatabase({
    rawQuery: "4人",
    requirements: [{
      id: "requirement-party",
      kind: "party_size",
      priority: "must",
      weight: 1,
      embedding: null,
      text: "4人",
      normalized_text: "4人で利用可能",
    }],
    evidence: [...privateRoomEvidence, safeCapacityEvidence("e-capacity", 20)],
    evaluations: [{
      id: "evaluation-party",
      requirement_id: "requirement-party",
      state: "match",
      confidence: 0.9,
      explanation: "legacy assertion",
      evidence_ids: ["e-capacity"],
    }],
  });
  await rankInvestigation(partyCase.db, "investigation-1");
  assertEquals(partyCase.state.evaluationUpdates[0], {
    state: "partial",
    confidence: 0.8,
    explanation:
      "蓄積済みの総席数は 20席で 4人以上ですが、同時利用や同一テーブルの可否までは確認できません",
    evidence_ids: ["e-capacity"],
  });

  const privateRoomCase = rankDatabase({
    rawQuery: "個室あり",
    requirements: [{
      id: "requirement-private",
      kind: "reservation",
      priority: "must",
      weight: 1,
      embedding: null,
      text: "個室あり",
      normalized_text: "個室あり",
    }],
    evidence: privateRoomEvidence,
    evaluations: [{
      id: "evaluation-private",
      requirement_id: "requirement-private",
      state: "match",
      confidence: 0.9,
      explanation: "legacy assertion",
      evidence_ids: ["e-private-yes"],
    }],
  });
  await rankInvestigation(privateRoomCase.db, "investigation-1");
  assertEquals(privateRoomCase.state.evaluationUpdates[0], {
    state: "partial",
    confidence: 0.5,
    explanation: "情報源が矛盾するため部分適合として扱います",
    evidence_ids: ["e-private-no", "e-private-yes"],
  });
});

Deno.test("ranking: deterministic state must be backed by a relevant claim in the referenced Evidence", async () => {
  const irrelevant = {
    ...safeCardEvidence("e-hours", true),
    structured_claims: [{
      key: "opening_hours",
      value: "17:00-23:00",
      rawText: "営業時間: 17:00-23:00",
    }],
    excerpt: "営業時間: 17:00-23:00",
  };
  const { db, state } = rankDatabase({
    rawQuery: "カード利用可",
    requirements: [{
      id: "requirement-1",
      kind: "payment",
      priority: "must",
      weight: 1,
      embedding: JSON.stringify(Array(768).fill(0)),
      text: "カード利用可",
      normalized_text: "クレジットカード利用可能",
    }],
    evidence: [irrelevant],
    evaluations: [{
      id: "evaluation-1",
      requirement_id: "requirement-1",
      state: "match",
      confidence: 0.9,
      explanation: "legacy match",
      evidence_ids: ["e-hours"],
    }],
  });
  await rankInvestigation(db, "investigation-1");
  assertEquals(state.evaluationUpdates[0], {
    state: "unknown",
    confidence: 0,
    explanation: "Evidenceの内容が条件判定に対応しないため判定を保留しました",
    evidence_ids: [],
  });
});

Deno.test("ranking: vague budget uses the shared tolerance semantics for match/partial/mismatch", async () => {
  for (
    const testCase of [
      { min: 2000, max: 3000, expected: "match" },
      { min: 3100, max: 3500, expected: "partial" },
      { min: 3601, max: 4000, expected: "mismatch" },
    ] as const
  ) {
    const evidence = safeBudgetEvidence(
      `e-budget-${testCase.expected}`,
      testCase.min,
      testCase.max,
    );
    const { db, state } = rankDatabase({
      rawQuery: "お手頃",
      requirements: [{
        id: "requirement-budget",
        kind: "budget",
        priority: "must",
        weight: 1,
        embedding: null,
        text: "お手頃",
        normalized_text: "お手頃",
      }],
      evidence: [evidence],
      evaluations: [{
        id: "evaluation-budget",
        requirement_id: "requirement-budget",
        state: "match",
        confidence: 0.9,
        explanation: "legacy assertion",
        evidence_ids: [evidence.id],
      }],
    });
    await rankInvestigation(db, "investigation-1");
    assertEquals(state.evaluationUpdates[0]?.state, testCase.expected);
    assertEquals(state.evaluationUpdates[0]?.evidence_ids, [evidence.id]);
  }
});

Deno.test("ranking: legacy budget ID subset converges against every relevant safe Evidence row", async () => {
  const match = safeBudgetEvidence("e-budget-match", 1000, 3000);
  const partial = safeBudgetEvidence("e-budget-partial", 2500, 3500);
  const { db, state } = rankDatabase({
    rawQuery: "予算3000円以下",
    requirements: [{
      id: "requirement-budget",
      kind: "budget",
      priority: "must",
      weight: 1,
      embedding: null,
      text: "予算3000円以下",
      normalized_text: "予算3000円以下",
    }],
    evidence: [partial, match],
    evaluations: [{
      id: "evaluation-budget",
      requirement_id: "requirement-budget",
      state: "match",
      confidence: 0.9,
      explanation: "legacy winner assertion",
      evidence_ids: ["e-budget-match"],
    }],
  });
  await rankInvestigation(db, "investigation-1");
  assertEquals(state.evaluationUpdates[0]?.state, "partial");
  assertEquals(state.evaluationUpdates[0]?.evidence_ids, [
    "e-budget-match",
    "e-budget-partial",
  ]);
});

Deno.test("ranking: 100 candidates x the configured 500 requirements stays bulk-only", async () => {
  const embedding = JSON.stringify(Array(768).fill(0));
  const requirements = Array.from(
    { length: AI_OUTPUT_LIMITS.requirements },
    (_, index) => ({
      id: `requirement-${index}`,
      kind: "other",
      priority: "should",
      weight: 0.5,
      embedding,
      text: `静かな店の条件${index}`,
      normalized_text: `静かな店の条件${index}`,
    }),
  );
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    id: `candidate-${index}`,
    place_id: `place-${index}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    places: { embedding: null },
  }));
  const evaluations = candidates.flatMap((candidate) =>
    requirements.map((requirement) => ({
      id: `evaluation-${candidate.id}-${requirement.id}`,
      candidate_id: candidate.id,
      requirement_id: requirement.id,
      state: "unknown",
      confidence: 0,
      explanation: null,
      evidence_ids: [],
    }))
  );
  const { db, state } = rankDatabase({
    rawQuery: "静かな店を探す",
    requirements,
    candidates,
    evaluations,
  });

  await rankInvestigation(db, "investigation-1", 3);

  // investigations / requirements / recall / members / candidates / 3 bulk reads
  // とcommit RPCだけで、候補数・要件数に応じて増えるqueryを持たない。
  assertEquals(state.queryCount, 8);
  assertEquals(state.queryCount + state.rpcCalls, RANKING_BULK_QUERY_COUNT);
  assertEquals(state.rpcCalls, 1);
  const commit = state.rpcPayloads[0];
  assertEquals(commit.name, "persist_investigation_ranking");
  assertEquals((commit.p_candidates as unknown[]).length, 100);
  assertEquals((commit.p_evaluations as unknown[]).length, 0);
  assertEquals((commit.p_discarded_candidate_ids as unknown[]).length, 97);
  assertEquals(commit.p_final_count, 3);
  assertEquals(commit.p_research_pool_count, 100);
  assertEquals(commit.p_db_query_count, RANKING_BULK_QUERY_COUNT);
  assertEquals((commit.p_candidates as Record<string, unknown>[])[0]?.rank, 1);
});

Deno.test("ranking: commit failure is a typed non-success and never reports ranking completion", async () => {
  const { db, state } = rankDatabase({
    commitError: { message: "statement timeout", code: "57014" },
  });
  const error = await assertRejects(
    () => rankInvestigation(db, "investigation-1"),
    DatabaseOperationError,
    "ranking.commit",
  );
  assertEquals(error.operation, "ranking.commit");
  assertEquals(state.rpcCalls, 1);
  assertEquals(state.rpcPayloads[0]?.name, "persist_investigation_ranking");
});

Deno.test("ranking: Free 3候補のscore/rank goldenは既存の§17式を維持する", async () => {
  const { db, state } = rankDatabase({
    candidates: [
      {
        id: "candidate-late",
        place_id: "place-late",
        created_at: "2026-08-16T00:00:02.000Z",
        places: { embedding: null },
      },
      {
        id: "candidate-first",
        place_id: "place-first",
        created_at: "2026-08-16T00:00:00.000Z",
        places: { embedding: null },
      },
      {
        id: "candidate-middle",
        place_id: "place-middle",
        created_at: "2026-08-16T00:00:01.000Z",
        places: { embedding: null },
      },
    ],
  });

  await rankInvestigation(db, "investigation-1", 3);

  const candidates = state.rpcPayloads[0]?.p_candidates as Record<
    string,
    unknown
  >[];
  assertEquals(
    candidates.map((candidate) => ({
      id: candidate.id,
      score: candidate.score,
      rank: candidate.rank,
    })),
    [
      { id: "candidate-late", score: 0.05, rank: 3 },
      { id: "candidate-first", score: 0.05, rank: 1 },
      { id: "candidate-middle", score: 0.05, rank: 2 },
    ],
  );
  assertEquals(state.rpcPayloads[0]?.p_discarded_candidate_ids, []);
});
