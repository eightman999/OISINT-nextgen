// providers/geoapify.ts のユニットテスト (#530 DB v2 Core / §26 providers / §13 claims)
// fetch は全てスタブ (実ネットワークなし)。SUPABASE_URL を未設定にして external_cache 層を
// 無効化し、API キーはダミー値のみ使用。
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  extractClaims,
  firstHourRange,
  GeoapifyPlaceProvider,
  parseFeatures,
  pickGeocodeMatch,
  rankByKeyword,
  toResult,
} from "../functions/_shared/providers/geoapify.ts";
import { filterValidClaims } from "../functions/_shared/validation.ts";
import type { PlaceSearchResult } from "../functions/_shared/providers/types.ts";

function withEnv(vars: Record<string, string | null>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  return () => {
    for (const [k, old] of saved) {
      if (old === undefined) Deno.env.delete(k);
      else Deno.env.set(k, old);
    }
  };
}

function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return await handler(url);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ENV = {
  GEOAPIFY_API_KEY: "test-geo-key",
  SUPABASE_URL: null, // external_cache 無効化
  SUPABASE_SERVICE_ROLE_KEY: null,
};

// 実 API のレスポンス構造を模したフィクスチャ (Places API v2 / GeoJSON Feature)
const geocodeBody = {
  features: [{
    properties: {
      lat: 35.7295,
      lon: 139.7128,
      formatted: "池袋, 豊島区, 東京都",
    },
  }],
};

const featureFull = {
  type: "Feature" as const,
  properties: {
    place_id: "51f0a1b2c3d4e5f6",
    name: "焼肉 いけぶくろ",
    formatted: "東京都豊島区南池袋1-27-8",
    lat: 35.7294,
    lon: 139.7128,
    website: "https://example.com/yakiniku",
    categories: ["catering", "catering.restaurant"],
    datasource: {
      sourcename: "openstreetmap",
      attribution: "© OpenStreetMap contributors",
      license: "Open Database License",
      raw: {
        osm_id: 123456789,
        osm_type: "n",
        cuisine: "japanese;yakiniku",
        "payment:cards": "yes",
        reservation: "yes",
        smoking: "no",
        internet_access: "wlan",
        highchair: "yes",
        opening_hours: "Mo-Fr 17:00-23:00; Sa 12:00-22:00",
      },
    },
  },
};

const featureNoName = {
  type: "Feature" as const,
  properties: { place_id: "nameless-1", lat: 35.72, lon: 139.71 },
};

Deno.test("meta: Geoapify は persistent + OSM 帰属表記必須を申告する (#530 / #473)", () => {
  const { meta } = new GeoapifyPlaceProvider();
  assertEquals(meta.id, "geoapify");
  assertEquals(meta.storagePolicy, "persistent");
  assertEquals(meta.attributionPolicy, "osm_odbl_attribution");
  assertEquals(meta.ttlHours, null);
});

Deno.test("search: geocode → places の 2 段で候補を返し limit で切る", async () => {
  const restore = withEnv(ENV);
  const { calls, restore: restoreFetch } = stubFetch((url) => {
    if (url.includes("/geocode/search")) return jsonRes(geocodeBody);
    if (url.includes("/v2/places")) {
      return jsonRes({
        features: [featureFull, featureNoName, {
          ...featureFull,
          properties: {
            ...featureFull.properties,
            place_id: "b",
            name: "そば処",
          },
        }],
      });
    }
    throw new Error(`想定外の URL: ${url}`);
  });
  try {
    const results = await new GeoapifyPlaceProvider().search({
      area: "池袋",
      keyword: "焼肉",
      limit: 2,
    });
    assertEquals(results.length, 2);
    assertEquals(results[0].provider, "geoapify");
    assertEquals(results[0].providerPlaceId, "51f0a1b2c3d4e5f6");
    assertEquals(results[0].name, "焼肉 いけぶくろ");
    // 名前の無い POI は候補にしない
    assert(!results.some((r) => r.providerPlaceId === "nameless-1"));
    // geocode → places の順に 1 回ずつ
    assert(calls[0].includes("/geocode/search"));
    assert(calls[1].includes("/v2/places"));
    assert(calls[1].includes("filter=circle"));
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("search: 検索語が皆無なら API を叩かない", async () => {
  const restore = withEnv(ENV);
  const { calls, restore: restoreFetch } = stubFetch(() => {
    throw new Error("呼ばれてはいけない");
  });
  try {
    const results = await new GeoapifyPlaceProvider().search({
      area: "",
      limit: 3,
    });
    assertEquals(results, []);
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("search: 「現在地」系で keyword を地名にすると川崎市へ誤解決するため 0 件にする", async () => {
  const restore = withEnv(ENV);
  const { calls, restore: restoreFetch } = stubFetch((url) => {
    if (url.includes("/geocode/search")) return jsonRes(geocodeBody);
    return jsonRes({ features: [featureFull] });
  });
  try {
    const results = await new GeoapifyPlaceProvider().search({
      area: "現在地",
      keyword: "ラーメン",
      limit: 3,
    });
    assertEquals(results, []);
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("search: N02公開anchorは駅名を再geocodeせず通常cache経由でcircle/proximityへ渡す", async () => {
  const restore = withEnv(ENV);
  const { calls, restore: restoreFetch } = stubFetch((url) => {
    if (url.includes("/v2/places")) return jsonRes({ features: [featureFull] });
    throw new Error(`geocode/cache経路が呼ばれた: ${url}`);
  });
  try {
    const results = await new GeoapifyPlaceProvider().search({
      area: "現在地",
      keyword: "寿司",
      limit: 3,
      publicSearchAnchor: {
        lat: 35.7295,
        lng: 139.7109,
        cacheKey: "mlit_n02:N02-2025:line:component:main:station",
      },
    });
    assertEquals(results.length, 1);
    assertEquals(calls.length, 1);
    assert(calls[0].includes("/v2/places"));
    const params = new URL(calls[0]).searchParams;
    assertEquals(params.get("filter"), "circle:139.7109,35.7295,1500");
    assertEquals(params.get("bias"), "proximity:139.7109,35.7295");
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("search: N02公開anchorの緯度経度域外は fail-closed", async () => {
  const restore = withEnv(ENV);
  const { calls, restore: restoreFetch } = stubFetch(() => {
    throw new Error("呼ばれてはいけない");
  });
  try {
    await assertRejects(
      () =>
        new GeoapifyPlaceProvider().search({
          area: "現在地",
          keyword: "寿司",
          limit: 3,
          publicSearchAnchor: {
            lat: 91,
            lng: 139.7109,
            cacheKey: "mlit_n02:invalid",
          },
        }),
      Error,
      "公開検索anchor",
    );
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("search: GPS searchAnchor は geocode/cache を迂回して places へ直接送る", async () => {
  const restore = withEnv({
    GEOAPIFY_API_KEY: ENV.GEOAPIFY_API_KEY,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "test",
  });
  const { calls, restore: restoreFetch } = stubFetch((url) => {
    if (url.includes("/v2/places")) return jsonRes({ features: [featureFull] });
    throw new Error(`GPS anchor 検索で cache/geocode が呼ばれた: ${url}`);
  });
  try {
    const results = await new GeoapifyPlaceProvider().search({
      area: "現在地",
      keyword: "寿司",
      limit: 3,
      searchAnchor: { lat: 35.7295, lng: 139.7109 },
    });
    assertEquals(results.length, 1);
    assertEquals(calls.length, 1);
    assert(calls[0].includes("/v2/places"));
    const params = new URL(calls[0]).searchParams;
    assertEquals(params.get("filter"), "circle:139.7109,35.7295,1500");
    assertEquals(params.get("bias"), "proximity:139.7109,35.7295");
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("search: GPS searchAnchor の域外・NaN は fail-closed", async () => {
  const restore = withEnv(ENV);
  const { calls, restore: restoreFetch } = stubFetch(() => {
    throw new Error("呼ばれてはいけない");
  });
  try {
    for (
      const searchAnchor of [
        { lat: 91, lng: 139.7109 },
        { lat: 35.7295, lng: Number.NaN },
      ]
    ) {
      await assertRejects(
        () =>
          new GeoapifyPlaceProvider().search({
            area: "現在地",
            keyword: "寿司",
            limit: 3,
            searchAnchor,
          }),
        Error,
        "検索位置 anchor",
      );
    }
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("transport error は query URL と Geoapify API key を例外へ残さない", async () => {
  const secret = "must-not-appear-in-error";
  const restore = withEnv({ ...ENV, GEOAPIFY_API_KEY: secret });
  const { restore: restoreFetch } = stubFetch((url) => {
    throw new TypeError(`fetch failed for ${url}`);
  });
  try {
    const error = await assertRejects(
      () =>
        new GeoapifyPlaceProvider().search({
          area: "現在地",
          keyword: "寿司",
          limit: 3,
          searchAnchor: { lat: 35.7295, lng: 139.7109 },
        }),
      Error,
      "Geoapify API request failed",
    );
    const rendered = `${error.message}\n${error.stack ?? ""}`;
    assert(!rendered.includes(secret));
    assert(!rendered.includes("apiKey="));
    assert(!rendered.includes("api.geoapify.com"));
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("API キー未設定なら例外 (§34: secret はサーバ側のみ)", async () => {
  const restore = withEnv({ ...ENV, GEOAPIFY_API_KEY: null });
  try {
    await assertRejects(
      () => new GeoapifyPlaceProvider().search({ area: "池袋", limit: 3 }),
      Error,
      "GEOAPIFY_API_KEY",
    );
  } finally {
    restore();
  }
});

Deno.test("全件不正なレスポンスは例外にする (§30)", async () => {
  const restore = withEnv(ENV);
  const { restore: restoreFetch } = stubFetch((url) => {
    if (url.includes("/geocode/search")) return jsonRes(geocodeBody);
    return jsonRes({ features: [{ properties: { name: "place_id なし" } }] });
  });
  try {
    await assertRejects(
      () => new GeoapifyPlaceProvider().search({ area: "池袋", limit: 3 }),
      Error,
      "検証に失敗",
    );
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("壊れた feature が混ざっても残りは返す (実測: name=4 の POI が存在)", async () => {
  const restore = withEnv(ENV);
  const { restore: restoreFetch } = stubFetch((url) => {
    if (url.includes("/geocode/search")) return jsonRes(geocodeBody);
    return jsonRes({
      features: [
        { properties: { name: "place_id 欠落のため破棄" } },
        featureFull,
      ],
    });
  });
  try {
    const results = await new GeoapifyPlaceProvider().search({
      area: "池袋",
      limit: 3,
    });
    assertEquals(results.length, 1);
    assertEquals(results[0].providerPlaceId, "51f0a1b2c3d4e5f6");
  } finally {
    restoreFetch();
    restore();
  }
});

Deno.test("name が数値の POI も文字列として扱う (実測: 渋谷の name=4)", () => {
  const [f] = parseFeatures({
    features: [{
      properties: { place_id: "num-name", name: 4, lat: 35.6, lon: 139.7 },
    }],
  }, "places");
  assertEquals(f.properties.name, "4");
  assertEquals(toResult(f, "2026-08-19T00:00:00.000Z")?.name, "4");
});

Deno.test("toResult: OSM タグ由来の claim と帰属表記メタを持つ", () => {
  const r = toResult(featureFull, "2026-08-19T00:00:00.000Z")!;
  assertEquals(r.url, "https://example.com/yakiniku");
  assertEquals(r.metadata.attribution, "© OpenStreetMap contributors");
  assertEquals(r.metadata.source, "geoapify");
  assertEquals(r.fetchedAt, "2026-08-19T00:00:00.000Z");
  // 生成された claim が §13 の Zod schema を通ること
  const valid = filterValidClaims(r.structuredClaims);
  assertEquals(valid.length, r.structuredClaims.length);
  assert(r.structuredClaims.length > 0);
});

Deno.test("toResult: website が無ければ OSM の該当要素を source_url にする", () => {
  const f = {
    ...featureFull,
    properties: { ...featureFull.properties, website: undefined },
  };
  const r = toResult(f, "2026-08-19T00:00:00.000Z")!;
  assertEquals(r.url, "https://www.openstreetmap.org/node/123456789");
});

Deno.test("extractClaims: OSMの明示タグを構造化claimへ正規化", () => {
  const claims = extractClaims(featureFull.properties.datasource.raw);
  const byKey = Object.fromEntries(claims.map((c) => [c.key, c.value]));
  assertEquals(byKey.genre, ["japanese", "yakiniku"]);
  assertEquals(byKey.card_accepted, true);
  assertEquals(byKey.reservation, true);
  assertEquals(byKey.non_smoking, true);
  assertEquals(byKey.wifi_available, true);
  assertEquals(byKey.child_friendly, true);
  assertEquals(byKey.opening_hours, "17:00-23:00");
});

Deno.test("extractClaims: 禁煙・Wi-Fiの明示的な否定をfalseへ正規化", () => {
  assertEquals(extractClaims({ smoking: "yes" }), [{
    key: "non_smoking",
    value: false,
    rawText: "smoking=yes",
  }]);
  assertEquals(extractClaims({ internet_access: "no" }), [{
    key: "wifi_available",
    value: false,
    rawText: "internet_access=no",
  }]);
});

Deno.test("extractClaims: 曖昧な喫煙区分や設備なしからbooleanを捏造しない", () => {
  const claims = extractClaims({
    smoking: "outside",
    internet_access: "terminal",
    kids_area: "no",
    highchair: "no",
  });
  assertEquals(claims, []);
  assert(!claims.some((claim) => claim.key === "nearest_station_walk_minutes"));
});

Deno.test("extractClaims: 対応タグが無い key は入れない (§13 不明を捏造しない)", () => {
  const claims = extractClaims({ name: "店" });
  assertEquals(claims, []);
  // OSM に予算・個室・席数のタグは無いので、この provider からは出ない
  const full = extractClaims(featureFull.properties.datasource.raw);
  assert(!full.some((c) => c.key === "budget_dinner"));
  assert(!full.some((c) => c.key === "private_room"));
  assert(!full.some((c) => c.key === "capacity"));
});

Deno.test("extractClaims: payment:cards=no は false として取り込む", () => {
  const claims = extractClaims({ "payment:credit_cards": "no" });
  assertEquals(claims, [{
    key: "card_accepted",
    value: false,
    rawText: "payment:credit_cards=no",
  }]);
});

Deno.test("firstHourRange: 最初の H:MM-H:MM のみ。解釈不能なら null", () => {
  assertEquals(
    firstHourRange("Mo-Fr 17:00-23:00; Sa 12:00-22:00"),
    "17:00-23:00",
  );
  assertEquals(firstHourRange("24/7"), null);
  assertEquals(firstHourRange("Mo-Su off"), null);
});

Deno.test("rankByKeyword: 一致候補を優先し、3件未満にならないよう距離順の不一致を補充する", () => {
  const base = (
    id: string,
    name: string,
    genre: string[],
  ): PlaceSearchResult => ({
    provider: "geoapify",
    providerPlaceId: id,
    name,
    address: "",
    lat: null,
    lng: null,
    url: "https://example.com/",
    structuredClaims: genre.length
      ? [{ key: "genre", value: genre, rawText: "" }]
      : [],
    metadata: {},
  });
  const input = [
    base("a", "そば処", ["soba"]),
    base("b", "肉バル", ["yakiniku"]), // 日本語名は非一致だが cuisine が一致
    base("c", "焼肉 太郎", []), // 店名のみ一致
    base("d", "アイス屋", ["ice_cream"]),
  ];
  // cuisine 一致 (重み 2) > 店名一致 (重み 1)。不足分は距離順の無関係な店で補充する
  assertEquals(
    rankByKeyword(input, "焼肉").map((r) => r.providerPlaceId),
    ["b", "c", "a", "d"],
  );
  // 一致ゼロなら距離順のまま全件返す (候補 0 件にしない)
  assertEquals(
    rankByKeyword(input, "エチオピア料理").map((r) => r.providerPlaceId),
    ["a", "b", "c", "d"],
  );
  // keyword 無しなら元の順序のまま
  assertEquals(
    rankByKeyword(input, undefined).map((r) => r.providerPlaceId),
    ["a", "b", "c", "d"],
  );
});

Deno.test("pickGeocodeMatch: エリア名を含まない結果は採用しない (別地名への誤マッチ防止)", () => {
  // 実測: 「天神駅」の geocode は岐阜の「田神駅」を返す
  const props = [{ lat: 35.41, lon: 136.77, name: "田神駅", city: "岐阜市" }];
  assertEquals(pickGeocodeMatch(props, "天神"), null);
});

Deno.test("pickGeocodeMatch: importance 最大を選ぶ", () => {
  const props = [
    {
      lat: 1,
      lon: 1,
      name: "天神",
      city: "加東市",
      rank: { importance: 0.00005 },
    },
    {
      lat: 33.59,
      lon: 130.40,
      name: "天神",
      city: "福岡市",
      rank: { importance: 0.386 },
    },
  ];
  assertEquals(pickGeocodeMatch(props, "天神")?.city, "福岡市");
});

Deno.test("pickGeocodeMatch: importance 無しで同名が複数市区町村にあれば曖昧として選ばない", () => {
  const props = [
    { lat: 39.09, lon: 140.26, name: "天神", city: "由利本荘市" },
    { lat: 34.40, lon: 133.20, name: "天神", city: "尾道市" },
  ];
  // 推測でどちらかを選ぶと別の街を調査してしまう
  assertEquals(pickGeocodeMatch(props, "天神"), null);
  // 1 つだけなら採用する
  assertEquals(pickGeocodeMatch([props[0]], "天神")?.city, "由利本荘市");
});
