import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { investigateAndPersist } from "../functions/_shared/pipeline.ts";

function withEnv(vars: Record<string, string | null>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = Deno.env.get(key);
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

Deno.test("pipeline: 本番調査対象外候補のスキップイベントに内部provider語を表示しない", async () => {
  const insertedEvaluations: Record<string, unknown>[] = [];
  const insertedEvents: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      if (table === "requirement_evaluations") {
        return {
          upsert(rows: Record<string, unknown>[]) {
            insertedEvaluations.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "investigation_events") {
        return {
          insert(row: Record<string, unknown>) {
            insertedEvents.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  await withEnv({ DATA_PROVIDER_MODE: "live" }, async () => {
    await investigateAndPersist(
      db,
      "investigation-skip-1",
      {
        id: "candidate-skip-1",
        place_id: "place-skip-1",
        places: {
          id: "place-skip-1",
          name: "池袋候補店",
          address: null,
          provider: "mock",
          provider_place_id: "candidate-skip-1",
        },
      },
      [{
        id: "requirement-skip-1",
        originalText: "静かな店",
        normalizedText: "静かな店",
        kind: "atmosphere",
        priority: "must",
        sourceAttested: true,
      }],
      { updateSummary: false },
    );
  });

  assertEquals(insertedEvaluations.length, 1);
  assertEquals(insertedEvaluations[0].state, "unknown");
  assertEquals(insertedEvents.length, 1);
  const event = insertedEvents[0];
  assertEquals(event.event_type, "candidate_skipped");
  assertEquals(event.message, "候補をスキップしました");
  assertStringIncludes(
    "本番調査の対象外の候補のため、調査をスキップしました",
    "調査をスキップしました",
  );
  for (const value of [event.message, JSON.stringify(event.metadata)]) {
    if (typeof value !== "string") continue;
    assertEquals(/mock|モック|fixture|provider/i.test(value), false);
  }
});
