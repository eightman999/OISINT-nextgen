// #514 根本原因の回帰テスト:
// insertEvidenceIfStale が書いた provider Evidence #0 を、同じ pipeline が
// knownClaims として再利用できること (書いた行を自分で読めない状態にしない)。
//
// 症状: mergeEvidenceClaims が claim を key 昇順へ並べ替えて保存する一方、
// excerpt は呼び出し側が渡した入力順の連結を保存していたため、
// isTrustedPlaceProviderRow の `excerpt === claims.join("。")` が常に false になり、
// budget / genre / card_accepted などの provider claim が全て unknown へ落ちていた。
import { assert, assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { insertEvidenceIfStale } from "../functions/_shared/pipeline.ts";
import type { StructuredClaimInput } from "../functions/_shared/validation.ts";
import {
  EVIDENCE_EXCERPT_LIMIT,
  isReusableSafeSharedEvidence,
} from "../functions/_shared/evidence_content.ts";

interface Row {
  id: string;
  place_id: string;
  scope: string;
  investigation_id: string | null;
  source_type: string;
  source_url: string;
  source_title: string;
  excerpt: string;
  structured_claims: Array<{ key: string; value: unknown; rawText: string }>;
  source_quality: number;
  freshness_score: number;
  observed_at: string;
  embedding: string | null;
}

// insertEvidenceIfStale が必要とする最小の Supabase client スタブ。
function fakeDb(rows: Row[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "evidence") throw new Error(`unexpected table: ${table}`);
      const builder = {
        _filters: [] as Array<(row: Row) => boolean>,
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          builder._filters.push((row) =>
            (row as unknown as Record<string, unknown>)[column] === value
          );
          return builder;
        },
        is(column: string, value: unknown) {
          return builder.eq(column, value);
        },
        gt(column: string, value: string) {
          builder._filters.push((row) =>
            String((row as unknown as Record<string, unknown>)[column]) > value
          );
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return Promise.resolve({
            data: rows.filter((row) => builder._filters.every((f) => f(row))),
            error: null,
          });
        },
        insert(values: Omit<Row, "id">) {
          const inserted: Row = {
            ...values,
            id: `evidence-${rows.length + 1}`,
          };
          rows.push(inserted);
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({ data: inserted, error: null });
                },
              };
            },
          };
        },
      };
      return builder as unknown as ReturnType<SupabaseClient["from"]>;
    },
  } as unknown as SupabaseClient;
}

const URL_ = "https://www.openstreetmap.org/node/125258451";
const NO_EMBED = { embed: (t: string[]) => Promise.resolve(t.map(() => [])) };

Deno.test("#514: 書き込んだ provider Evidence を knownClaims として再利用できる", async () => {
  const rows: Row[] = [];
  // 入力順は key 昇順ではない (本番の place provider も同様)
  const claims: StructuredClaimInput[] = [
    {
      key: "opening_hours",
      value: "11:30-24:00",
      rawText: "営業時間 11:30〜翌0:00",
    },
    { key: "card_accepted", value: true, rawText: "カード利用可" },
    {
      key: "budget_dinner",
      value: { min: 3001, max: 4000 },
      rawText: "予算 3001〜4000円",
    },
    {
      key: "genre",
      value: ["焼肉・ホルモン"],
      rawText: "ジャンル: 焼肉・ホルモン",
    },
  ];
  const id = await insertEvidenceIfStale(
    fakeDb(rows),
    "place-1",
    URL_,
    "池袋いちば 西口店 - 店舗情報",
    "major_place_provider",
    claims,
    claims.map((c) => c.rawText).join("。"),
    new Date().toISOString(),
    NO_EMBED,
  );
  assertEquals(id, "evidence-1");
  assertEquals(rows.length, 1);
  // 保存された claim 順と excerpt が一致していること (契約)
  assertEquals(
    rows[0].excerpt,
    rows[0].structured_claims.map((c) => c.rawText).join("。"),
  );
  assert(isReusableSafeSharedEvidence(rows[0]));
});

Deno.test("#514: excerpt が保存上限で切られても再利用できる", async () => {
  const rows: Row[] = [];
  const claims: StructuredClaimInput[] = Array.from({ length: 30 }, (_, i) => ({
    key: "genre" as const,
    value: [`ジャンル${String(i).padStart(2, "0")}`],
    rawText: `ジャンル: ${"焼".repeat(20)}${String(i).padStart(2, "0")}`,
  }));
  await insertEvidenceIfStale(
    fakeDb(rows),
    "place-2",
    URL_,
    "長い店舗情報 - 店舗情報",
    "major_place_provider",
    claims,
    claims.map((c) => c.rawText).join("。"),
    new Date().toISOString(),
    NO_EMBED,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].excerpt.length, EVIDENCE_EXCERPT_LIMIT);
  assert(isReusableSafeSharedEvidence(rows[0]));
});
