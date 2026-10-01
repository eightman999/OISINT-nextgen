import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DatabaseOperationError,
  throwIfDatabaseError,
} from "../functions/_shared/database_error.ts";
import {
  insertEvidenceIfStale,
  insertUnknownEvaluations,
  loadRequirements,
  persistCandidateEvaluations,
} from "../functions/_shared/pipeline.ts";
import { planKnownEvidenceForCandidate } from "../functions/_shared/facts.ts";

Deno.test("database error: PostgREST errorをtyped errorへ変換する", () => {
  const error = assertThrows(
    () =>
      throwIfDatabaseError({ message: "database unavailable" }, "test.select"),
    DatabaseOperationError,
  );
  assertEquals(error.operation, "test.select");
});

function requirementLoadDb(
  normalizedText: string,
  rawQuery = "カード利用不可",
  rawQueryError: unknown = null,
  requirement: { text?: string; kind?: string | null } = {},
): SupabaseClient {
  const requirementsQuery = {
    select() {
      return requirementsQuery;
    },
    eq() {
      return Promise.resolve({
        data: [{
          id: "r1",
          text: requirement.text ?? "カード利用不可",
          normalized_text: normalizedText,
          kind: requirement.kind === undefined ? "payment" : requirement.kind,
          priority: "must",
        }],
        error: null,
      });
    },
  };
  const investigationQuery = {
    select() {
      return investigationQuery;
    },
    eq() {
      return investigationQuery;
    },
    maybeSingle() {
      return Promise.resolve({
        data: rawQueryError ? null : { raw_query: rawQuery },
        error: rawQueryError,
      });
    },
  };
  const db = {
    from(table: string) {
      if (table === "requirements") return requirementsQuery;
      if (table === "investigations") return investigationQuery;
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return db as unknown as SupabaseClient;
}

Deno.test("requirements load: raw_queryと同一intentのDB textだけstrict原文として保持する", async () => {
  assertEquals(
    await loadRequirements(
      requirementLoadDb("カード利用不可"),
      "inv-1",
    ),
    [{
      id: "r1",
      originalText: "カード利用不可",
      normalizedText: "カード利用不可",
      kind: "payment",
      priority: "must",
      weight: 0.5,
      sourceAttested: true,
    }],
  );
  assertEquals(
    await loadRequirements(
      requirementLoadDb("クレジットカード利用可能"),
      "inv-1",
    ),
    [{
      id: "r1",
      originalText: "",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      weight: 0.5,
      sourceAttested: false,
    }],
  );
});

Deno.test("requirements load: parserのkind誤分類は隔離し、user-added NULLはsemanticに維持する", async () => {
  assertEquals(
    await loadRequirements(
      requirementLoadDb(
        "クレジットカード利用可能",
        "カードは使いたくない",
        null,
        { text: "クレジットカード利用可能", kind: "other" },
      ),
      "inv-1",
    ),
    [{
      id: "r1",
      originalText: "",
      normalizedText: "クレジットカード利用可能",
      kind: "other",
      priority: "must",
      weight: 0.5,
      sourceAttested: false,
    }],
  );
  assertEquals(
    await loadRequirements(
      requirementLoadDb(
        "クレジットカード利用可能",
        "元の相談文",
        null,
        { text: "クレジットカード利用可能", kind: null },
      ),
      "inv-1",
    ),
    [{
      id: "r1",
      originalText: "クレジットカード利用可能",
      normalizedText: "クレジットカード利用可能",
      kind: "payment",
      priority: "must",
      weight: 0.5,
      sourceAttested: true,
    }],
  );
});

Deno.test("requirements load: raw_query取得障害をsemantic unknownへ変換せずrejectする", async () => {
  await assertRejects(
    () =>
      loadRequirements(
        requirementLoadDb(
          "カード利用不可",
          "",
          { message: "forced raw query failure" },
        ),
        "inv-1",
      ),
    DatabaseOperationError,
    "investigations.raw_query_select",
  );
});

function failingEvaluationDb(): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "requirement_evaluations") {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        upsert() {
          return Promise.resolve({
            error: { message: "forced evaluation write failure" },
          });
        },
      };
    },
  } as unknown as SupabaseClient;
}

Deno.test("database error: unknown評価の保存失敗を成功扱いせずrejectする", async () => {
  await assertRejects(
    () =>
      insertUnknownEvaluations(
        failingEvaluationDb(),
        "inv-1",
        "candidate-1",
        ["r1"],
      ),
    DatabaseOperationError,
    "requirement_evaluations.unknown_upsert",
  );
});

Deno.test("database error: 候補単位evaluation upsert失敗をsemantic unknownへ変換しない", async () => {
  await assertRejects(
    () =>
      persistCandidateEvaluations(failingEvaluationDb(), [{
        investigation_id: "inv-1",
        candidate_id: "candidate-1",
        requirement_id: "r1",
        state: "match",
        confidence: 0.85,
        explanation: "根拠あり",
        evidence_ids: ["e1"],
      }]),
    DatabaseOperationError,
    "requirement_evaluations.candidate_upsert",
  );
});

function failingEvidenceSelectDb(): SupabaseClient {
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    is() {
      return query;
    },
    order() {
      return query;
    },
    limit() {
      return Promise.resolve({
        data: null,
        error: { message: "forced Evidence read failure" },
      });
    },
  };
  return {
    from(table: string) {
      if (table !== "evidence") throw new Error(`unexpected table: ${table}`);
      return query;
    },
  } as unknown as SupabaseClient;
}

Deno.test("database error: shared Evidence SELECT失敗を未解決扱いにせずrejectする", async () => {
  await assertRejects(
    () =>
      planKnownEvidenceForCandidate(
        failingEvidenceSelectDb(),
        { place_id: "place-1" },
        [{
          id: "r1",
          originalText: "クレジットカード利用可能",
          normalizedText: "クレジットカード利用可能",
          kind: "payment",
          priority: "must",
        }],
      ),
    DatabaseOperationError,
    "evidence.shared_select",
  );
});

function failingEvidenceInsertDb(): SupabaseClient {
  const staleQuery = {
    eq() {
      return staleQuery;
    },
    is() {
      return staleQuery;
    },
    gt() {
      return staleQuery;
    },
    order() {
      return staleQuery;
    },
    limit() {
      return staleQuery;
    },
    maybeSingle() {
      return Promise.resolve({ data: null, error: null });
    },
  };
  const insertQuery = {
    select() {
      return insertQuery;
    },
    single() {
      return Promise.resolve({
        data: null,
        error: { message: "forced Evidence insert failure" },
      });
    },
  };
  return {
    from(table: string) {
      if (table !== "evidence") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return staleQuery;
        },
        insert() {
          return insertQuery;
        },
      };
    },
  } as unknown as SupabaseClient;
}

Deno.test("database error: Evidence INSERT失敗を評価unknownへ変換しない", async () => {
  await assertRejects(
    () =>
      insertEvidenceIfStale(
        failingEvidenceInsertDb(),
        "place-1",
        "https://official.example/place-1",
        "公式",
        "official",
        [],
        "",
      ),
    DatabaseOperationError,
    "evidence.insert",
  );
});
