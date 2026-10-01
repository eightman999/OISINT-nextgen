// #567 canonical Place 先行照合の純粋テスト。
// 外部 provider は fake で数え、Geoapify/Geocoding/Details は一切呼ばない。
import { assert, assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type CanonicalPlaceRow,
  canonicalResultKey,
  readCanonicalPlaces,
  resolveCanonicalDiscovery,
  selectCanonicalPlaceHits,
} from "../functions/_shared/canonical_place_lookup.ts";
import {
  GeoapifyPlaceProvider,
} from "../functions/_shared/providers/geoapify.ts";
import type { PlaceSearchResult } from "../functions/_shared/providers/types.ts";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function id(number: number): string {
  return `00000000-0000-0000-0000-${number.toString().padStart(12, "0")}`;
}

function row(
  number: number,
  overrides: Partial<CanonicalPlaceRow> = {},
): CanonicalPlaceRow {
  return {
    id: id(number),
    provider: "geoapify",
    provider_place_id: `geo-${number}`,
    name: "焼肉 池袋店",
    address: "東京都豊島区池袋1-1-1",
    lat: 35.73,
    lng: 139.71,
    metadata: { area: "池袋", keywords: ["焼肉"], categories: ["焼肉"] },
    embedding: "[0.1,0.2]",
    updated_at: "2026-08-24T11:00:00.000Z",
    place_provider_links: [{
      id: id(number + 1000),
      provider: "geoapify",
      provider_place_id: `geo-${number}`,
      source_url: `https://example.test/${number}`,
      storage_policy: "persistent",
      expires_at: null,
      attribution_policy: "osm_odbl_attribution",
      last_seen_at: "2026-08-24T10:00:00.000Z",
    }],
    evidence: [{
      id: id(number + 2000),
      source_url: `https://example.test/${number}`,
      source_type: "major_place_provider",
      structured_claims: [{
        key: "genre",
        value: ["焼肉"],
        rawText: "焼肉",
      }],
      observed_at: "2026-08-24T09:00:00.000Z",
      provider_link_id: id(number + 1000),
    }],
    ...overrides,
  };
}

function input(
  overrides: Partial<Parameters<typeof selectCanonicalPlaceHits>[1]> = {},
) {
  return {
    area: "池袋",
    keyword: "焼肉",
    requiredCount: 3,
    broadLimit: 10,
    now: NOW,
    ...overrides,
  };
}

function providerResult(
  providerPlaceId: string,
  name = "外部候補",
  provider = "geoapify",
): PlaceSearchResult {
  return {
    provider,
    providerPlaceId,
    name,
    address: "東京都豊島区池袋9-9-9",
    lat: 35.73,
    lng: 139.71,
    url: "https://provider.example/place",
    structuredClaims: [],
    metadata: {},
  };
}

function fakeDb(
  data: unknown,
  error: { message: string } | null = null,
  calls: Array<Record<string, unknown>> = [],
): SupabaseClient {
  const query = {
    select(selection: string) {
      calls.push({ method: "select", selection });
      return query;
    },
    ilike(column: string, pattern: string) {
      calls.push({ method: "ilike", column, pattern });
      return query;
    },
    order(column: string, options: { ascending: boolean }) {
      calls.push({ method: "order", column, ...options });
      return query;
    },
    limit(value: number) {
      calls.push({ method: "limit", value });
      return Promise.resolve({ data, error });
    },
  };
  return {
    from(table: string) {
      calls.push({ method: "from", table });
      return query;
    },
  } as unknown as SupabaseClient;
}

Deno.test("canonical hit は requiredCount を満たすと provider search を呼ばない", async () => {
  const providerCalls = {
    geocode: 0,
    search: 0,
    details: 0,
    fetchByIds: 0,
  };
  const result = await resolveCanonicalDiscovery(
    () =>
      Promise.resolve(
        selectCanonicalPlaceHits([row(1), row(2), row(3)], input()),
      ),
    () => {
      providerCalls.search += 1;
      return Promise.resolve([providerResult("should-not-run")]);
    },
    { requiredCount: 3, broadLimit: 10 },
  );

  assertEquals(result.outcome, "hit");
  assertEquals(providerCalls, {
    geocode: 0,
    search: 0,
    details: 0,
    fetchByIds: 0,
  });
  assertEquals(result.externalProviderCalls, 0);
  assertEquals(result.results.map((candidate) => candidate.providerPlaceId), [
    "geo-1",
    "geo-2",
    "geo-3",
  ]);
  assertEquals(result.results[0].fetchedAt, "2026-08-24T10:00:00.000Z");
  assertEquals(result.canonicalHits.size, 3);
});

Deno.test("canonical hit は実 Geoapify adapter の geocode/places/details 到達を防ぐ", async () => {
  const geoapify = new GeoapifyPlaceProvider();
  let adapterCalls = 0;
  const result = await resolveCanonicalDiscovery(
    () =>
      Promise.resolve(
        selectCanonicalPlaceHits([row(4), row(5), row(6)], input()),
      ),
    () => {
      adapterCalls += 1;
      // このテストは --allow-net を付けずに実行する。resolver が
      // callbackを呼べば、Geoapifyのgeocode/places/detailsへ到達して失敗する。
      return geoapify.search({ area: "池袋", keyword: "焼肉", limit: 3 });
    },
    { requiredCount: 3, broadLimit: 10 },
  );
  assertEquals(result.outcome, "hit");
  assertEquals(result.externalProviderCalls, 0);
  assertEquals(adapterCalls, 0);
});

Deno.test("canonical partial は fallback provider search を一度だけ呼ぶ", async () => {
  let providerCalls = 0;
  const result = await resolveCanonicalDiscovery(
    () => Promise.resolve(selectCanonicalPlaceHits([row(1)], input())),
    () => {
      providerCalls += 1;
      return Promise.resolve([
        providerResult("geo-external-1"),
        providerResult("geo-external-2"),
      ]);
    },
    { requiredCount: 3, broadLimit: 3 },
  );

  assertEquals(result.outcome, "partial");
  assertEquals(providerCalls, 1);
  assertEquals(result.externalProviderCalls, 1);
  assertEquals(result.results.map((candidate) => candidate.providerPlaceId), [
    "geo-1",
    "geo-external-1",
    "geo-external-2",
  ]);
});

Deno.test("canonical miss は従来 discovery を一度だけ呼ぶ", async () => {
  let providerCalls = 0;
  const result = await resolveCanonicalDiscovery(
    () => Promise.resolve(selectCanonicalPlaceHits([], input())),
    () => {
      providerCalls += 1;
      return Promise.resolve([providerResult("geo-fallback")]);
    },
    { requiredCount: 3, broadLimit: 3 },
  );

  assertEquals(result.outcome, "miss");
  assertEquals(providerCalls, 1);
  assertEquals(result.externalProviderCalls, 1);
  assertEquals(result.results.length, 1);
});

Deno.test("同一 canonical Place の複数 provider link は候補1件、別linkのfallback重複も除外する", async () => {
  const duplicateLinks = row(10, {
    place_provider_links: [
      {
        id: id(1010),
        provider: "geoapify",
        provider_place_id: "geo-10",
        source_url: "https://example.test/geo-10",
        storage_policy: "persistent",
        expires_at: null,
        attribution_policy: "osm_odbl_attribution",
        last_seen_at: "2026-08-24T10:00:00.000Z",
      },
      {
        id: id(1011),
        provider: "overture",
        provider_place_id: "overture-10",
        source_url: "https://example.test/overture-10",
        storage_policy: "persistent",
        expires_at: null,
        attribution_policy: "overture_cdla_attribution",
        last_seen_at: "2026-08-24T11:00:00.000Z",
      },
    ],
  });
  const selected = selectCanonicalPlaceHits([duplicateLinks], input());
  assertEquals(selected.hits.length, 1);
  assertEquals(selected.hits[0].aliases.length, 2);

  let providerCalls = 0;
  const result = await resolveCanonicalDiscovery(
    () => Promise.resolve(selectCanonicalPlaceHits([duplicateLinks], input())),
    () => {
      providerCalls += 1;
      return Promise.resolve([
        providerResult("overture-10", "外部候補", "overture"),
      ]);
    },
    { requiredCount: 2, broadLimit: 5 },
  );
  assertEquals(providerCalls, 1); // requiredCount不足なので fallback は呼ぶ
  assertEquals(result.results.length, 1); // alias重複は再insertしない
  assertEquals(result.results[0].providerPlaceId, "overture-10");
  assertEquals(
    result.canonicalAliases.get(
      canonicalResultKey(providerResult("overture-10", "外部候補", "overture")),
    ),
    id(10),
  );
});

Deno.test("期限切れ・purged/表示不可 link は hit に使わない", () => {
  const invalidRows = [
    row(20, {
      place_provider_links: [{
        id: id(1020),
        provider: "geoapify",
        provider_place_id: "expired",
        source_url: "https://example.test/expired",
        storage_policy: "ttl",
        expires_at: "2026-08-24T11:59:59.000Z",
        attribution_policy: "osm_odbl_attribution",
      }],
    }),
    row(21, {
      place_provider_links: [{
        id: id(1021),
        provider: "geoapify",
        provider_place_id: "id-only",
        source_url: "https://example.test/id-only",
        storage_policy: "id_only",
        expires_at: null,
        attribution_policy: "osm_odbl_attribution",
      }],
    }),
    row(22, {
      place_provider_links: [{
        id: id(1022),
        provider: "geoapify",
        provider_place_id: "no-attribution",
        source_url: "https://example.test/no-attribution",
        storage_policy: "persistent",
        expires_at: null,
        attribution_policy: null,
      }],
    }),
    row(23, { place_provider_links: [] }),
  ];
  assertEquals(selectCanonicalPlaceHits(invalidRows, input()).hits.length, 0);
});

Deno.test("expired provider link の Evidence claims を有効 linkへ混ぜない", () => {
  const validLinkId = id(1124);
  const expiredLinkId = id(1125);
  const candidate = row(124, {
    name: "店舗",
    metadata: { area: "池袋" },
    place_provider_links: [
      {
        id: validLinkId,
        provider: "overture",
        provider_place_id: "overture-124",
        source_url: "https://example.test/overture-124",
        storage_policy: "persistent",
        expires_at: null,
        attribution_policy: "overture_cdla_attribution",
        last_seen_at: "2026-08-24T11:00:00.000Z",
      },
      {
        id: expiredLinkId,
        provider: "hotpepper",
        provider_place_id: "hotpepper-124",
        source_url: "https://example.test/hotpepper-124",
        storage_policy: "ttl",
        expires_at: "2026-08-24T11:59:59.000Z",
        attribution_policy: "hotpepper_credit_required",
        last_seen_at: "2026-08-24T11:00:00.000Z",
      },
    ],
    evidence: [{
      id: id(2124),
      source_url: "https://example.test/hotpepper-124",
      source_type: "major_place_provider",
      structured_claims: [{ key: "genre", value: ["焼肉"], rawText: "焼肉" }],
      observed_at: "2026-08-24T11:30:00.000Z",
      provider_link_id: expiredLinkId,
    }],
  });
  assertEquals(selectCanonicalPlaceHits([candidate], input()).hits.length, 0);

  const trusted = row(125, {
    name: "店舗",
    metadata: { area: "池袋" },
    evidence: [{
      id: id(2125),
      source_url: "https://example.test/overture-125",
      source_type: "major_place_provider",
      structured_claims: [{ key: "genre", value: ["焼肉"], rawText: "焼肉" }],
      observed_at: "2026-08-24T11:30:00.000Z",
      provider_link_id: id(1125),
    }],
  });
  const trustedResult = selectCanonicalPlaceHits(
    [trusted],
    input({ keyword: "焼肉" }),
  );
  assertEquals(trustedResult.hits.length, 1);
  assertEquals(trustedResult.hits[0].result.structuredClaims.length, 1);
});

Deno.test("canonical readのmetadataはnested raw query/GPS/Tasteを除外し公開属性を残す", () => {
  const candidate = row(130, {
    metadata: {
      area: "池袋",
      categories: ["焼肉"],
      nested: {
        rawQuery: "健康情報を含む秘密の依頼",
        searchAnchor: { lat: 35.7, lng: 139.7 },
        tasteProfile: { preference: "辛いもの" },
      },
    },
  });
  const result = selectCanonicalPlaceHits([candidate], input());
  assertEquals(result.hits.length, 1);
  assertEquals(result.hits[0].result.metadata.area, "池袋");
  const nested = result.hits[0].result.metadata.nested as Record<
    string,
    unknown
  >;
  assertEquals("rawQuery" in nested, false);
  assertEquals("searchAnchor" in nested, false);
  assertEquals("tasteProfile" in nested, false);
});

Deno.test("同名でも住所の異なる canonical Place を統合しない", () => {
  const first = row(30);
  const second = row(31, { address: "東京都豊島区西池袋2-2-2" });
  const selected = selectCanonicalPlaceHits(
    [first, second],
    input({ keyword: undefined }),
  );
  assertEquals(selected.hits.map((hit) => hit.canonicalPlaceId), [
    id(30),
    id(31),
  ]);
  assertEquals(
    new Set(selected.hits.map((hit) => hit.canonicalPlaceId)).size,
    2,
  );
});

Deno.test("住所欠損・壊れた座標は安全側で除外する", () => {
  const missingAddress = row(40, { address: null });
  const invalidCoordinates = row(41, { lat: 999 });
  const oneSidedCoordinates = row(42, { lat: 35.7, lng: null });
  assertEquals(
    selectCanonicalPlaceHits([
      missingAddress,
      invalidCoordinates,
      oneSidedCoordinates,
    ], input()).hits.length,
    0,
  );
});

Deno.test("再入しても canonical hit は同じ1件で provider再呼出し0", async () => {
  let providerCalls = 0;
  const lookup = () =>
    Promise.resolve(
      selectCanonicalPlaceHits([row(50)], input({ requiredCount: 1 })),
    );
  const search = () => {
    providerCalls += 1;
    return Promise.resolve([providerResult("never")]);
  };
  const first = await resolveCanonicalDiscovery(lookup, search, {
    requiredCount: 1,
    broadLimit: 3,
  });
  const second = await resolveCanonicalDiscovery(lookup, search, {
    requiredCount: 1,
    broadLimit: 3,
  });
  assertEquals(first.results.length, 1);
  assertEquals(second.results.length, 1);
  assertEquals(
    first.results[0].providerPlaceId,
    second.results[0].providerPlaceId,
  );
  assertEquals(providerCalls, 0);
});

Deno.test("通常queryのsearchAnchorはcanonical lookupを迂回せずprovider呼出し0", async () => {
  let providerCalls = 0;
  const canonical = selectCanonicalPlaceHits(
    [row(55)],
    input({ requiredCount: 1, searchAnchor: { lat: 35.7, lng: 139.7 } }),
  );
  assertEquals(canonical.outcome, "hit");
  const result = await resolveCanonicalDiscovery(
    () => Promise.resolve(canonical),
    () => {
      providerCalls += 1;
      return Promise.resolve([providerResult("must-not-run")]);
    },
    { requiredCount: 1, broadLimit: 3 },
  );
  assertEquals(result.outcome, "hit");
  assertEquals(result.externalProviderCalls, 0);
  assertEquals(providerCalls, 0);
});

Deno.test("searchAnchorはcurrent_locationだけでcanonical lookupをskipする", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await readCanonicalPlaces(
    fakeDb([row(56)], null, calls),
    input({
      currentLocationRequested: true,
      searchAnchor: { lat: 35.7, lng: 139.7 },
    }),
  );
  assertEquals(result.outcome, "skipped");
  assertEquals(result.hits.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("DB read path は area prefilter後に決定的な再検証を行う", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await readCanonicalPlaces(
    fakeDb([row(60)], null, calls),
    input(),
  );
  assertEquals(result.outcome, "partial");
  assertEquals(result.hits.length, 1);
  assertEquals(calls.map((call) => call.method), [
    "from",
    "select",
    "ilike",
    "order",
    "limit",
  ]);
  assertEquals(calls[0].table, "places");
  assertEquals(calls[2].column, "address");
  assert(String(calls[2].pattern).includes("池袋"));
  assertEquals(calls[3], { method: "order", column: "id", ascending: true });
});

Deno.test("DB read error は安全な error outcome、provider fallbackは呼び出し側で1回", async () => {
  const lookup = () =>
    readCanonicalPlaces(
      fakeDb(null, { message: "secret query detail" }),
      input(),
    );
  const result = await resolveCanonicalDiscovery(
    lookup,
    () => Promise.resolve([providerResult("geo-after-error")]),
    { requiredCount: 3, broadLimit: 3 },
  );
  assertEquals(result.outcome, "error");
  assertEquals(result.externalProviderCalls, 1);
  assertEquals(result.results.map((candidate) => candidate.providerPlaceId), [
    "geo-after-error",
  ]);
});

Deno.test("重複 canonical row は候補数を水増しせず、必要数不足ならfallbackする", async () => {
  const duplicated = selectCanonicalPlaceHits(
    [row(70), row(70)],
    input({ requiredCount: 2 }),
  );
  assertEquals(duplicated.hits.length, 1);
  assertEquals(duplicated.canonicalCandidateCount, 1);
  assertEquals(duplicated.outcome, "partial");

  let providerCalls = 0;
  const result = await resolveCanonicalDiscovery(
    () => Promise.resolve(duplicated),
    () => {
      providerCalls += 1;
      return Promise.resolve([providerResult("geo-70-fallback")]);
    },
    { requiredCount: 2, broadLimit: 3 },
  );
  assertEquals(providerCalls, 1);
  assertEquals(result.outcome, "partial");
  assertEquals(result.results.map((candidate) => candidate.providerPlaceId), [
    "geo-70",
    "geo-70-fallback",
  ]);
});

Deno.test("broadLimit が requiredCount 未満ならcanonical hit扱いにしない", async () => {
  const canonical = selectCanonicalPlaceHits(
    [row(80), row(81), row(82)],
    input({ requiredCount: 3, broadLimit: 2 }),
  );
  assertEquals(canonical.hits.length, 2);
  assertEquals(canonical.outcome, "partial");

  let providerCalls = 0;
  const result = await resolveCanonicalDiscovery(
    () => Promise.resolve(canonical),
    () => {
      providerCalls += 1;
      return Promise.resolve([providerResult("geo-82-fallback")]);
    },
    { requiredCount: 3, broadLimit: 3 },
  );
  assertEquals(providerCalls, 1);
  assertEquals(result.externalProviderCalls, 1);
  assertEquals(result.results.length, 3);
});
