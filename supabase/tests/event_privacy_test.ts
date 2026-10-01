import { assertEquals, assertRejects } from "@std/assert";
import {
  logEvent,
  sanitizeInvestigationEventMetadata,
} from "../functions/_shared/db.ts";

Deno.test("event metadata: event typeごとのclosed allow-listでraw query/GPSを保存しない", () => {
  const input = {
    raw_query: "卵アレルギーの依頼文",
    searchQueries: ["池袋 卵アレルギー"],
    locationScope: {
      type: "current_location",
      lat: 35.1234,
      longitude: 139.9876,
    },
    nested: {
      health_goal: "diet",
      healthPurpose: "健康目的",
      safeCount: 3,
      coordinates: { lat: 35.1, lng: 139.9 },
      point: { latitudeE7: 351234567, longitudeE7: 1399876543 },
    },
    requirements: [{ text: "個人的な条件" }],
    freeForm: { text: "要件本文が別名で混ざった場合" },
    similar: [{ title: "query本文を推測できるタイトル", similarity: 0.9 }],
    keyword: "アレルギー対応",
    message: "provider request に含まれた本文",
    places: [{ name: "共有店舗", avgVote: 1 }],
    count: 2,
  };

  const sanitized = sanitizeInvestigationEventMetadata(
    input,
    "search_executed",
  );

  assertEquals(sanitized, {});
  // 呼び出し側の値を破壊しないため、入力には sensitive 値が残る。
  assertEquals(input.raw_query, "卵アレルギーの依頼文");
});

Deno.test("event metadata: operational fields と null は保持する", () => {
  assertEquals(
    sanitizeInvestigationEventMetadata({
      request_id: "00000000-0000-4000-8000-000000000001",
      candidateId: "00000000-0000-4000-8000-000000000002",
      count: 0,
      optional: null,
      invalidNumber: Number.NaN,
    }),
    {
      request_id: "00000000-0000-4000-8000-000000000001",
      candidateId: "00000000-0000-4000-8000-000000000002",
      count: 0,
    },
  );
});

Deno.test("event metadata: rail scope/別名/深いnest/provider本文をfail-closedする", () => {
  assertEquals(
    sanitizeInvestigationEventMetadata({
      scope: { type: "line", line: "秘密の路線" },
      rail_scope: { lat: 35.1, lng: 139.1 },
      providerError: { message: "raw provider response" },
      payload: { nested: { text: "個人条件" } },
      request_id: "00000000-0000-4000-8000-000000000003",
      anchorCount: 2,
    }, "rail_scope_unresolved"),
    {},
  );
});

Deno.test("event metadata: parse scopeは許可された型だけを残し未知キーを捨てる", () => {
  assertEquals(
    sanitizeInvestigationEventMetadata({
      area: "池袋",
      locationScope: {
        type: "station_hops",
        origin: "池袋",
        maxStops: 2,
        lat: 35.7,
        unknown: "drop",
      },
      keyword: "アレルギー",
      requirementCount: 3,
    }, "parse_completed"),
    {
      area: "池袋",
      locationScope: { type: "station_hops", origin: "池袋", maxStops: 2 },
      requirementCount: 3,
    },
  );
});

Deno.test("event metadata: any_of / multi_origin の全要素を保持し、部分除去しない", () => {
  assertEquals(
    sanitizeInvestigationEventMetadata({
      locationScope: { type: "any_of", places: ["渋谷", "新宿"] },
    }, "parse_completed"),
    { locationScope: { type: "any_of", places: ["渋谷", "新宿"] } },
  );
  assertEquals(
    sanitizeInvestigationEventMetadata({
      locationScope: { type: "multi_origin", origins: ["渋谷", "新宿"] },
    }, "parse_completed"),
    { locationScope: { type: "multi_origin", origins: ["渋谷", "新宿"] } },
  );
  assertEquals(
    sanitizeInvestigationEventMetadata({
      locationScope: { type: "any_of", places: ["渋谷", 42] },
    }, "parse_completed"),
    {},
  );
});

Deno.test("logEvent: 書込み経路もサニタイズ済みmetadataだけを渡す", async () => {
  let inserted: Record<string, unknown> | null = null;
  const db = {
    from() {
      return {
        insert(values: Record<string, unknown>) {
          inserted = values;
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  } as unknown as Parameters<typeof logEvent>[0];

  await logEvent(db, "investigation-1", "search_executed", "調査しました", {
    raw_query: "秘密の依頼文",
    searchQueries: ["秘密の検索語"],
    count: 3,
  });

  const captured = inserted as unknown as Record<string, unknown>;
  assertEquals(captured.metadata, {});
  assertEquals(captured.message, "候補を調査しました");
});

Deno.test("logEvent: Supabaseの書込みエラーを呼び出し側へ返す", async () => {
  const db = {
    from() {
      return {
        insert() {
          return Promise.resolve({
            data: null,
            error: { message: "fixture event failure" },
          });
        },
      };
    },
  } as unknown as Parameters<typeof logEvent>[0];

  await assertRejects(
    () => logEvent(db, "investigation-1", "step_started", "開始"),
    Error,
    "investigation event unavailable",
  );
});
