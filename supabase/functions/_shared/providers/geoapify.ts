// GeoapifyPlaceProvider (#530 DB v2 Core / #297 provider detach)
//
// Geoapify Places API (OpenStreetMap 由来 POI) を live の discovery provider として使う。
// 保存・キャッシュ・再配布に期限制限が無い代わりに、
// データは OSM タグのみで予算・個室・席数などの構造化項目を持たない (#530 の候補品質メモ参照)。
//
// 表示義務: OpenStreetMap への帰属表記が必須。Free プランでは Geoapify 表記も必須
// (Geoapify Terms and Conditions v5, 2024-02-02: "you must always provide OpenStreetMap
// attribution" / "Geoapify attribution is mandatory when using Free subscription plan")。
// 原文引用・条項の記録は docs/legal/provider-data-rights.md (#473) を正本とする。
//
// レスポンスは Zod で検証してから変換する (§30, §36 Rule 4)。
import { cuisineRecallTerms } from "../cuisine_lexicon.ts";
import type { StructuredClaim } from "../types.ts";
import type {
  PlaceSearchProvider,
  PlaceSearchQuery,
  PlaceSearchResult,
  ProviderMeta,
} from "./types.ts";
import { z } from "zod";
import { withCache } from "../cache.ts";
import { isCurrentLocationArea } from "./area.ts";
import { parseOpeningHoursValue } from "../opening_hours.ts";
import { locationAnchorSchema } from "../validation.ts";

const PLACES_URL = "https://api.geoapify.com/v2/places";
const PLACE_DETAILS_URL = "https://api.geoapify.com/v2/place-details";

// 飲食店の POI カテゴリ (Geoapify Places categories)。
// catering.restaurant を主とし、居酒屋・バー・カフェも候補に含める
const CATERING_CATEGORIES = [
  "catering.restaurant",
  "catering.bar",
  "catering.pub",
  "catering.cafe",
];

// エリア中心からの検索半径 (m)。駅名・地名の徒歩圏を想定
const SEARCH_RADIUS_M = 1500;

// 近傍だけを取ると条件に合う店を取りこぼす。実測 (2026-08-19 池袋 1500m):
// POI 500 件中 cuisine タグを持つのは 51%、「焼肉」に該当するのは name 一致 7 件 +
// cuisine=yakiniku 2 件で、いずれも最近傍 15 件には入らない。
// このため候補プールを広く取り、ジャンル一致で絞り込む (Places API 上限は 500 件)。
// 課金は 20 places = 1 credit なので 200 件 = 10 credit
const POOL_LIMIT = 200;

// place-details の 1 回あたり ID 数 (Geoapify は 1 ID / リクエスト)
const FETCH_BY_IDS_LIMIT = 20;

const publicSearchAnchorSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  cacheKey: z.string().min(1).max(240),
}).strict();

// OSM の name タグは数値だけのこともある (実測: 渋谷 1500m の POI に name=4 が存在)。
// 文字列前提で全体を弾くと 1 件の異常でエリア全体が 0 件になるため、数値も受けて文字列化する
type GeoapifyFeature = z.infer<typeof featureSchema>;

const looseText = z.union([z.string(), z.number()]).transform(String);

const featureSchema = z.object({
  type: z.literal("Feature").optional(),
  properties: z.object({
    place_id: z.string(),
    name: looseText.optional(),
    formatted: looseText.optional(),
    address_line2: looseText.optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    website: z.string().optional(),
    categories: z.array(z.string()).optional(),
    datasource: z.object({
      sourcename: z.string().optional(),
      attribution: z.string().optional(),
      license: z.string().optional(),
      url: z.string().optional(),
      raw: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  }),
});

export const geoapifyPlacesResponseSchema = z.object({
  features: z.array(z.unknown()),
});

// features を 1 件ずつ検証し、壊れた feature だけを落とす (§30)。
// 全件落ちた場合はレスポンス自体の異常とみなして例外にする
export function parseFeatures(
  body: unknown,
  context: string,
): GeoapifyFeature[] {
  const parsed = geoapifyPlacesResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Geoapify ${context} レスポンスの検証に失敗: ${parsed.error.message}`,
    );
  }
  const out: GeoapifyFeature[] = [];
  let dropped = 0;
  for (const f of parsed.data.features) {
    const one = featureSchema.safeParse(f);
    if (one.success) out.push(one.data);
    else dropped++;
  }
  if (dropped > 0) {
    console.warn(
      `[geoapify] 検証に失敗した feature を破棄 context=${context} dropped=${dropped} kept=${out.length}`,
    );
  }
  if (out.length === 0 && parsed.data.features.length > 0) {
    throw new Error(
      `Geoapify ${context} レスポンスの検証に失敗: 全 ${parsed.data.features.length} 件が不正`,
    );
  }
  return out;
}

const geocodePropsSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  formatted: z.string().optional(),
  name: z.string().optional(),
  address_line1: z.string().optional(),
  suburb: z.string().optional(),
  district: z.string().optional(),
  city: z.string().optional(),
  county: z.string().optional(),
  rank: z.object({ importance: z.number().optional() }).optional(),
});

const geocodeSchema = z.object({
  features: z.array(z.object({ properties: geocodePropsSchema })),
});

export type GeocodeProps = z.infer<typeof geocodePropsSchema>;

export class GeoapifyPlaceProvider implements PlaceSearchProvider {
  // Geoapify / OSM 由来データは保存・キャッシュ・再配布の期限制限が無い (persistent)。
  // ただし OSM (ODbL) の帰属表記は必須なので attributionPolicy を必ず記録する
  readonly meta: ProviderMeta = {
    id: "geoapify",
    storagePolicy: "persistent",
    attributionPolicy: "osm_odbl_attribution",
    ttlHours: null,
  };

  async search(query: PlaceSearchQuery): Promise<PlaceSearchResult[]> {
    const searchAnchor = query.searchAnchor !== undefined
      ? locationAnchorSchema.safeParse(query.searchAnchor)
      : null;
    if (query.searchAnchor !== undefined && !searchAnchor?.success) {
      throw new Error("検索位置 anchor が不正です");
    }

    // GPS anchor は一時的な run input であり、座標を external_cache のキーや
    // payload に残さない。geocode と cache を迂回して places API へ直接送る。
    if (searchAnchor?.success) {
      const results = await this.requestPlaces({
        lat: searchAnchor.data.lat,
        lon: searchAnchor.data.lng,
      }, POOL_LIMIT);
      return rankByKeyword(results, query.keyword).slice(0, query.limit);
    }

    const anchor = query.publicSearchAnchor
      ? publicSearchAnchorSchema.safeParse(query.publicSearchAnchor)
      : null;
    if (query.publicSearchAnchor !== undefined && !anchor?.success) {
      throw new Error("公開検索anchorが不正です");
    }
    // 「現在地」系の擬似エリア語は公開N02座標では解決できないため、
    // ユーザーGPSや別地名へ推測変換せず0件にする。
    if (!anchor?.success && isCurrentLocationArea(query.area)) return [];
    const areaText = query.area || "";
    if (!areaText) return []; // 検索語が皆無の呼び出しは API を叩かない

    const center = anchor?.success
      ? { lat: anchor.data.lat, lon: anchor.data.lng }
      : await this.geocode(areaText);
    if (!center) return [];

    // N02 station coordinates are public and therefore use the ordinary
    // provider cache. The dataset cache key prevents the same station name
    // from colliding across active versions without re-geocoding the name.
    const results = await withCache<PlaceSearchResult[]>(
      "geoapify",
      {
        publicSearchAnchor: anchor?.success
          ? { cacheKey: anchor.data.cacheKey }
          : undefined,
        lat: center.lat,
        lon: center.lon,
        radius: SEARCH_RADIUS_M,
        limit: POOL_LIMIT,
      },
      () => this.requestPlaces(center, POOL_LIMIT),
    ) ?? [];

    // 予算 (budgetMin/Max) は OSM に無いため検索側では絞れない。
    // 予算条件の突合は requirement_matching.ts のコード突合が Evidence 側で厳密に行う (#312)
    return rankByKeyword(results, query.keyword).slice(0, query.limit);
  }

  // 個別再取得。Geoapify は persistent provider のため自動更新では呼ばない。
  // 明示的な freshness 操作から使えるよう interface は実装しておく。
  async fetchByIds(providerPlaceIds: string[]): Promise<PlaceSearchResult[]> {
    const ids = [...new Set(providerPlaceIds)].sort().slice(
      0,
      FETCH_BY_IDS_LIMIT,
    );
    const out: PlaceSearchResult[] = [];
    for (const id of ids) {
      const one = await withCache<PlaceSearchResult[]>(
        "geoapify",
        { placeDetails: id },
        () => this.requestPlaceDetails(id),
      );
      if (one) out.push(...one);
    }
    return out;
  }

  // エリア名 → 座標。日本語のエリア名は Geoapify の geocode で 0 件になることがあるため
  // (実測: 「池袋」「新宿」「渋谷」「難波」は search で 0 件)、
  // search(そのまま) → search(<area>駅) → autocomplete の順に 1 段ずつ試す。
  // 別地名への誤マッチ (実測: 「天神駅」→ 岐阜「田神駅」) を防ぐため、
  // 結果の名称・住所にエリア名を含むものだけを採用し、importance 最大を選ぶ。
  private async geocode(
    text: string,
  ): Promise<{ lat: number; lon: number } | null> {
    const cached = await withCache<{ lat: number; lon: number } | null>(
      "geoapify",
      { geocode: text, v: 2 },
      async () => {
        const attempts: Array<
          { kind: "search" | "autocomplete"; text: string }
        > = [
          { kind: "search", text },
          { kind: "search", text: `${text}駅` },
          { kind: "autocomplete", text },
        ];
        for (const a of attempts) {
          const props = await this.requestGeocode(a.kind, a.text);
          const picked = pickGeocodeMatch(props, text);
          if (picked) return { lat: picked.lat, lon: picked.lon };
        }
        // どの段でも一意に決まらなければ「解決できない」として扱う。
        // 同名の別都市 (実測: 「天神」= 福岡 / 秋田 / 尾道 …) を勝手に選ぶと
        // 別の街の候補を調査してしまうため、推測で埋めない (§13 / AGENTS.md 11)
        return null;
      },
    );
    return cached ?? null;
  }

  private async requestGeocode(
    kind: "search" | "autocomplete",
    text: string,
  ): Promise<GeocodeProps[]> {
    const params = new URLSearchParams({
      text,
      lang: "ja",
      limit: "10",
      filter: "countrycode:jp",
      apiKey: apiKey(),
    });
    const parsed = geocodeSchema.safeParse(
      await getJson(`https://api.geoapify.com/v1/geocode/${kind}?${params}`),
    );
    if (!parsed.success) {
      throw new Error(
        `Geoapify geocode レスポンスの検証に失敗: ${parsed.error.message}`,
      );
    }
    return parsed.data.features.map((f) => f.properties);
  }

  private async requestPlaces(
    center: { lat: number; lon: number },
    limit: number,
  ): Promise<PlaceSearchResult[]> {
    const params = new URLSearchParams({
      categories: CATERING_CATEGORIES.join(","),
      filter: `circle:${center.lon},${center.lat},${SEARCH_RADIUS_M}`,
      bias: `proximity:${center.lon},${center.lat}`,
      limit: String(limit),
      lang: "ja",
      apiKey: apiKey(),
    });
    const fetchedAt = new Date().toISOString();
    return parseFeatures(await getJson(`${PLACES_URL}?${params}`), "places")
      .map((f) => toResult(f, fetchedAt))
      .filter((r): r is PlaceSearchResult => r !== null);
  }

  private async requestPlaceDetails(id: string): Promise<PlaceSearchResult[]> {
    const params = new URLSearchParams({
      id,
      lang: "ja",
      apiKey: apiKey(),
    });
    const fetchedAt = new Date().toISOString();
    return parseFeatures(
      await getJson(`${PLACE_DETAILS_URL}?${params}`),
      "place-details",
    )
      .map((f) => toResult(f, fetchedAt))
      .filter((r): r is PlaceSearchResult => r !== null);
  }
}

function apiKey(): string {
  const key = Deno.env.get("GEOAPIFY_API_KEY");
  if (!key) throw new Error("GEOAPIFY_API_KEY が未設定");
  return key;
}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // Geoapify は apiKey を query parameter で受け取る。Deno の fetch 例外は
    // request URL を cause に含めるため、そのまま上位へ伝播すると Edge log や
    // investigation event に secret が残り得る。URL/cause を捨てた固定文言へ置換する。
    throw new Error("Geoapify API request failed");
  }
  if (!res.ok) throw new Error(`Geoapify API error: ${res.status}`);
  return await res.json();
}

// geocode 結果からエリア名に一致する候補を選ぶ。
// 1. 名称・住所にエリア名を含むものだけを候補にする (別地名への誤マッチ防止)
// 2. importance (Geoapify の地物重要度) 最大を選ぶ。importance が全て無い場合、
//    異なる市区町村に同名候補が複数あれば曖昧として選ばない (推測で埋めない)
export function pickGeocodeMatch(
  props: GeocodeProps[],
  area: string,
): GeocodeProps | null {
  const matched = props.filter((p) =>
    [p.name, p.formatted, p.address_line1, p.suburb, p.district, p.city]
      .some((v) => typeof v === "string" && v.includes(area))
  );
  if (matched.length === 0) return null;
  const ranked = matched.filter((p) => typeof p.rank?.importance === "number");
  if (ranked.length > 0) {
    return ranked.reduce((best, p) =>
      (p.rank!.importance ?? 0) > (best.rank!.importance ?? 0) ? p : best
    );
  }
  const cities = new Set(
    matched.map((p) => p.city ?? p.county ?? p.formatted ?? ""),
  );
  return cities.size > 1 ? null : matched[0];
}

// キーワード (ジャンル語) に一致する候補を優先する。Places API はカテゴリと距離でしか
// 絞れないため、ジャンル突合はコード側で決定論的に行う (§29)。
// 一致候補を先頭に置き、limit 未満にならないよう不一致候補を距離順で補充する。
// 一致ゼロなら距離順のまま返す。
export function rankByKeyword(
  results: PlaceSearchResult[],
  keyword: string | undefined,
): PlaceSearchResult[] {
  const terms = (keyword ?? "").split(/[\s、,]+/).filter((t) => t.length > 0);
  if (terms.length === 0) return results;

  // 日本語のジャンル語 → OSM cuisine 値 (語彙台帳は _shared/cuisine_lexicon.ts)。
  // ここは候補の並べ替えなので、同値語だけでなく拡張語も使う
  const osmTerms = new Set<string>();
  for (const t of terms) {
    for (const value of cuisineRecallTerms(t)) osmTerms.add(value);
  }

  const score = (r: PlaceSearchResult): number => {
    const genre = r.structuredClaims.find((c) => c.key === "genre");
    const genreValues = Array.isArray(genre?.value)
      ? (genre.value as string[]).map((g) => g.toLowerCase())
      : [];
    const categories =
      (r.metadata.categories as string[] | undefined)?.map((c) =>
        c.toLowerCase()
      ) ?? [];
    // cuisine / categories の一致は店名の一致より強い根拠として重く見る
    const byCuisine =
      [...osmTerms].filter((t) =>
        genreValues.some((g) => g.includes(t)) ||
        categories.some((c) => c.includes(t))
      ).length * 2;
    const byName = terms.filter((t) => r.name.includes(t)).length;
    return byCuisine + byName;
  };

  const scored = results.map((r, i) => ({ r, i, s: score(r) }));
  const matched = scored.filter((x) => x.s > 0);
  const unmatched = scored.filter((x) => x.s === 0);
  const pool = matched.length > 0 ? [...matched, ...unmatched] : scored;
  // 同点は元の順序 (Geoapify の距離順) を保つ安定ソート
  return pool.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
}

export function toResult(
  f: GeoapifyFeature,
  fetchedAt: string,
): PlaceSearchResult | null {
  const p = f.properties;
  const name = p.name?.trim();
  if (!name) return null; // 名前の無い POI は候補にしない
  const lat = p.lat ?? null;
  const lon = p.lon ?? null;
  // 店舗ページ URL (Evidence #0 の source_url)。website が無ければ OSM の該当要素を指す
  const url = p.website ?? osmUrl(p.datasource?.raw) ??
    `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
  return {
    provider: "geoapify",
    providerPlaceId: p.place_id,
    name,
    address: p.formatted ?? p.address_line2 ?? "",
    lat,
    lng: lon,
    url,
    fetchedAt,
    structuredClaims: extractClaims(p.datasource?.raw ?? {}),
    metadata: {
      source: "geoapify",
      categories: p.categories ?? [],
      // 帰属表記の原文 (OSM / ODbL)。表示側で使う (§27)
      attribution: p.datasource?.attribution ?? "© OpenStreetMap contributors",
      license: p.datasource?.license ?? "ODbL",
      website: p.website ?? null,
    },
  };
}

function osmUrl(raw: Record<string, unknown> | undefined): string | null {
  const id = raw?.osm_id;
  const type = raw?.osm_type; // "n" | "w" | "r"
  if (typeof id !== "number" && typeof id !== "string") return null;
  const kind = type === "w" ? "way" : type === "r" ? "relation" : "node";
  return `https://www.openstreetmap.org/${kind}/${id}`;
}

// OSM タグ → §13 の ClaimKey へ正規化。
// 抽出できなかったキーは入れない (§13。null や "不明" を入れない)。
// budget_dinner / private_room / capacity / time_limit / 徒歩分数は、このproviderで
// 安全に正規化できるOSMタグが無いため出さない。特に徒歩分数は座標から推測しない。
// これらは公開情報に明記された値をSerper + fetcher由来のEvidenceで埋める。
export function extractClaims(raw: Record<string, unknown>): StructuredClaim[] {
  const claims: StructuredClaim[] = [];
  const tag = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  // cuisine=japanese;sushi → genre: ["japanese", "sushi"]
  const cuisine = tag("cuisine");
  if (cuisine) {
    const values = cuisine.split(";").map((c) => c.trim()).filter(Boolean);
    if (values.length > 0) {
      claims.push({
        key: "genre",
        value: values,
        rawText: `cuisine=${cuisine}`,
      });
    }
  }

  // payment:cards / payment:credit_cards = yes|no。rawText には実際に読んだタグ名を残す
  const cardTag = tag("payment:cards") !== null
    ? "payment:cards"
    : tag("payment:credit_cards") !== null
    ? "payment:credit_cards"
    : null;
  const cards = cardTag ? tag(cardTag) : null;
  if (cardTag && (cards === "yes" || cards === "no")) {
    claims.push({
      key: "card_accepted",
      value: cards === "yes",
      rawText: `${cardTag}=${cards}`,
    });
  }

  // smoking=no は施設全体の禁煙、smoking=yes は喫煙可能を明示する。
  // outside / separated / isolated 等は部分禁煙を単一booleanへ丸められないため捨てる。
  const smoking = tag("smoking")?.toLowerCase() ?? null;
  if (smoking === "no" || smoking === "yes") {
    claims.push({
      key: "non_smoking",
      value: smoking === "no",
      rawText: `smoking=${smoking}`,
    });
  }

  // OSM internet_access の明示値だけを採用する。terminal / wired 等は
  // Wi-Fiとは断定できないためwifi_availableへ写像しない。
  const internetAccess = tag("internet_access")?.toLowerCase() ?? null;
  if (
    internetAccess === "wlan" || internetAccess === "yes" ||
    internetAccess === "no"
  ) {
    claims.push({
      key: "wifi_available",
      value: internetAccess !== "no",
      rawText: `internet_access=${internetAccess}`,
    });
  }

  // kids_area / highchair の yes は子連れ設備の明示的な根拠になる。
  // no は設備1種類の不在にすぎず、店舗全体の子連れ非対応とは断定しない。
  const childFriendlyTag = ["kids_area", "highchair"].find((key) =>
    tag(key)?.toLowerCase() === "yes"
  );
  if (childFriendlyTag) {
    claims.push({
      key: "child_friendly",
      value: true,
      rawText: `${childFriendlyTag}=yes`,
    });
  }

  // reservation = yes|required|no
  const reservation = tag("reservation");
  if (reservation === "yes" || reservation === "required") {
    claims.push({
      key: "reservation",
      value: true,
      rawText: `reservation=${reservation}`,
    });
  } else if (reservation === "no") {
    claims.push({
      key: "reservation",
      value: false,
      rawText: "reservation=no",
    });
  }

  // opening_hours="Mo-Fr 11:00-14:00,17:00-23:00" → 最初の H:MM-H:MM のみ (§13 形式)
  const hours = tag("opening_hours");
  const range = hours ? firstHourRange(hours) : null;
  if (range) {
    claims.push({
      key: "opening_hours",
      value: range,
      rawText: `opening_hours=${hours}`,
    });
  }

  return claims;
}

// "Mo-Fr 11:00-14:00,17:00-23:00" から最初の "11:00-14:00" を取り出す。
// §13 の形式として妥当な場合のみ返す (parseOpeningHoursValue で検証)
export function firstHourRange(openingHours: string): string | null {
  const m = openingHours.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  const value = `${m[1]}-${m[2]}`;
  return parseOpeningHoursValue(value) !== null ? value : null;
}
