// OvertureIndexPlaceProvider の単体テスト (#559)。
// 自前 index (public.place_discovery_index) だけを読み、外部 API を呼ばないことを確かめる。
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type DiscoveryIndexRow,
  OvertureIndexPlaceProvider,
  parseDiscoveryRows,
  toResult,
} from "../functions/_shared/providers/overture.ts";

function row(overrides: Partial<DiscoveryIndexRow> = {}): DiscoveryIndexRow {
  return {
    place_id: "11111111-1111-1111-1111-111111111111",
    provider: "overture",
    provider_place_id: "08f2f5a1",
    name: "焼肉テスト",
    address: "東京都豊島区東池袋1-1-1",
    lat: 35.7295,
    lng: 139.7185,
    category: "korean_restaurant",
    website: "https://example.test/shop",
    region_id: "tokyo_toshima",
    release: "2026-07-22.0",
    distance_m: 120,
    promoted_at: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

// 呼び出しを記録する最小の fake。fetch は一切生やさない — 生えたらテストが落ちる
function fakeDb(
  rpcResult: { data: unknown; error: { message: string } | null },
  calls: unknown[] = [],
): SupabaseClient {
  return {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
}

Deno.test("index 行を PlaceSearchResult へ変換しても営業状態の claim を作らない", () => {
  const result = toResult(row(), "2026-08-21T10:00:00.000Z");
  assertEquals(result.provider, "overture");
  assertEquals(result.providerPlaceId, "08f2f5a1");
  assertEquals(result.url, "https://example.test/shop");
  // operating_status は実測でほぼ全件 null。営業中を断定しない (#559 AC / §30)
  assertEquals(result.structuredClaims, []);
  assertEquals(result.metadata.license, "CDLA-Permissive-2.0");
  assertEquals(result.metadata.categories, ["korean_restaurant"]);
  assertEquals("operatingStatus" in result.metadata, false);
});

Deno.test("website の無い行は URL を捏造せず空文字にする", () => {
  const result = toResult(row({ website: null }), "2026-08-21T10:00:00.000Z");
  assertEquals(result.url, "");
});

Deno.test("壊れた行だけを落とし、全件不正なら例外にする", () => {
  const kept = parseDiscoveryRows([row(), { name: "座標なし" }], "search");
  assertEquals(kept.length, 1);
  assertThrows(() => parseDiscoveryRows([{ name: "壊れ" }], "search"));
  // 0 件そのものは異常ではない (その地域がまだ promote されていないだけ)
  assertEquals(parseDiscoveryRows([], "search").length, 0);
});

Deno.test("search は自前 index の RPC だけを呼び、ジャンル一致で並べ替える", async () => {
  const calls: unknown[] = [];
  const db = fakeDb({
    data: [
      row({ provider_place_id: "near", name: "そば処", category: "soba" }),
      row({
        provider_place_id: "far",
        name: "焼肉ハウス",
        category: "yakiniku",
      }),
    ],
    error: null,
  }, calls);

  const results = await new OvertureIndexPlaceProvider(db).search({
    area: "池袋",
    keyword: "焼肉",
    limit: 3,
    publicSearchAnchor: {
      lat: 35.7295,
      lng: 139.7185,
      cacheKey: "mlit_n02:v1:ikebukuro",
    },
  });

  assertEquals(calls.length, 1);
  assertEquals(
    (calls[0] as { name: string }).name,
    "search_place_discovery_index",
  );
  assertEquals(
    (calls[0] as { args: Record<string, unknown> }).args.p_provider,
    "overture",
  );
  // 距離順のプールをジャンル一致で並べ替える（Geoapify と同じ rankByKeyword）
  assertEquals(results.map((r) => r.providerPlaceId), ["far", "near"]);
});

Deno.test("座標 anchor が無ければ別地名へ推測変換せず 0 件にする", async () => {
  const calls: unknown[] = [];
  const db = fakeDb({ data: [], error: null }, calls);
  const provider = new OvertureIndexPlaceProvider(db);

  assertEquals((await provider.search({ area: "天神", limit: 3 })).length, 0);
  assertEquals(
    (await provider.search({ area: "現在地", limit: 3 })).length,
    0,
  );
  // 解決できない検索で index を叩かない
  assertEquals(calls.length, 0);
});

Deno.test("index の検索失敗は例外にする (無言で 0 件へ倒さない)", async () => {
  const db = fakeDb({ data: null, error: { message: "boom" } });
  await assertRejects(() =>
    new OvertureIndexPlaceProvider(db).search({
      area: "池袋",
      limit: 3,
      publicSearchAnchor: {
        lat: 35.7295,
        lng: 139.7185,
        cacheKey: "mlit_n02:v1:ikebukuro",
      },
    })
  );
});

Deno.test("meta は #549 の決定どおり persistent / overture_cdla_attribution", () => {
  const meta = new OvertureIndexPlaceProvider(fakeDb({ data: [], error: null }))
    .meta;
  assertEquals(meta.id, "overture");
  assertEquals(meta.storagePolicy, "persistent");
  assertEquals(meta.attributionPolicy, "overture_cdla_attribution");
  // persistent なので TTL 自動再取得の対象にならない (#289 / provider_ttl.ts)
  assertEquals(meta.ttlHours, null);
});
