// OvertureIndexPlaceProvider (#559 / #549 / #530)
//
// Overture Places を OISINT の canonical backbone として使う live discovery provider。
// **runtime に S3 parquet を読まない。** 定期 ingest → 明示的 promote step
// (benchmark.promote_overture_region) で作った自前 index
// (public.place_discovery_index) だけを検索する。外部 API を一切呼ばないため、
// 外部 API 障害で候補 0 件にならない (#559 AC)。
//
// 表示義務: Overture Maps Foundation の CDLA-Permissive-2.0 に基づく帰属表記。
// attribution_policy = 'overture_cdla_attribution' を meta で申告し、書き込み側
// (run-investigation) が place_provider_links へそのまま記録する。
// 寄与元 (meta / Foursquare / Microsoft / AllThePlaces) を個別に列挙するかは #473 の owner 判断待ち。
//
// operating_status: #549 の実測でほぼ全件 null。「営業中」の保証には使えないため、
// この provider は営業状態に関する claim を一切出さない (spec.md §30 / §36 Rule 6)。
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../db.ts";
import { rankByKeyword } from "./geoapify.ts";
import { isCurrentLocationArea } from "./area.ts";
import type {
  PlaceSearchProvider,
  PlaceSearchQuery,
  PlaceSearchResult,
  ProviderMeta,
} from "./types.ts";
import { locationAnchorSchema } from "../validation.ts";

// エリア中心からの検索半径 (m)。Geoapify と同じく徒歩圏を想定して揃える。
const SEARCH_RADIUS_M = 1500;

// 自前 index から取る候補プールの上限。ジャンル一致で絞る前の母数
// (Geoapify の POOL_LIMIT と同じ考え方)。DB 検索なので課金は増えない。
const POOL_LIMIT = 200;

const rowSchema = z.object({
  // uuid の厳格判定 (RFC のバージョン/バリアント bit) はしない。Postgres の uuid 型は
  // 任意の 128bit を許すため、厳格化すると実在行を静かに取りこぼして候補が減る
  place_id: z.string().min(1),
  // RPC 側でも provider を絞っているが、index に別 provider が混ざった行を
  // "overture" として表示してしまわないよう受け取り側でも固定する
  provider: z.literal("overture"),
  provider_place_id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().nullable(),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  category: z.string().nullable(),
  website: z.string().nullable(),
  region_id: z.string().nullable(),
  release: z.string().nullable(),
  distance_m: z.number().finite().nullable(),
  promoted_at: z.string().nullable(),
});

export type DiscoveryIndexRow = z.infer<typeof rowSchema>;

const publicSearchAnchorSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  cacheKey: z.string().min(1).max(240),
}).strict();

// 壊れた行だけを落とす (§30)。全件落ちたら index 側の異常として例外にする。
export function parseDiscoveryRows(
  body: unknown,
  context: string,
): DiscoveryIndexRow[] {
  if (!Array.isArray(body)) {
    throw new Error(`Overture ${context} の結果が配列ではありません`);
  }
  const out: DiscoveryIndexRow[] = [];
  let dropped = 0;
  for (const row of body) {
    const one = rowSchema.safeParse(row);
    if (one.success) out.push(one.data);
    else dropped++;
  }
  if (dropped > 0) {
    console.warn(
      `[overture] 検証に失敗した行を破棄 context=${context} dropped=${dropped} kept=${out.length}`,
    );
  }
  if (out.length === 0 && body.length > 0) {
    throw new Error(
      `Overture ${context} の結果検証に失敗: 全 ${body.length} 件が不正`,
    );
  }
  return out;
}

// index 行 → PlaceSearchResult。
// structuredClaims は空にする。Overture が持つのは名称・住所・座標・カテゴリであり、
// §13 の ClaimKey (opening_hours / budget_dinner / private_room …) に対応する
// 確からしい値を持たない。カテゴリを genre claim に流用すると「根拠のある主張」を
// 偽装することになるため、metadata に留めて claim にはしない (§36 Rule 6)。
export function toResult(
  row: DiscoveryIndexRow,
  fetchedAt: string,
): PlaceSearchResult {
  return {
    provider: "overture",
    providerPlaceId: row.provider_place_id,
    name: row.name,
    address: row.address ?? "",
    lat: row.lat,
    lng: row.lng,
    // 店舗ページ URL。Overture には per-record の公開ページが無いため、
    // website が無い場合は空文字にする。存在しない URL を組み立てない
    // (AGENTS.md 11「推測に基づく補完の禁止」)。Evidence #0 は URL がある場合のみ作られる。
    url: row.website ?? "",
    fetchedAt,
    structuredClaims: [],
    metadata: {
      source: "overture",
      // rankByKeyword が参照する。カテゴリは Overture の taxonomy 由来
      categories: row.category ? [row.category] : [],
      attribution: "© Overture Maps Foundation",
      license: "CDLA-Permissive-2.0",
      website: row.website,
      regionId: row.region_id,
      release: row.release,
      distanceM: row.distance_m,
      // 自前 index が最後に promote された時刻。取得の新しさの手掛かり (#559 定期 ingest)
      indexPromotedAt: row.promoted_at,
      // operating_status は意図的に持たない。null 率が高く「営業中」の根拠にならない (§30)
    },
  };
}

export class OvertureIndexPlaceProvider implements PlaceSearchProvider {
  // CDLA-Permissive-2.0 は保存・再配布の期限制限が無い (persistent)。
  // 帰属表記は必須なので attributionPolicy を必ず記録する (#549 決定済み)
  readonly meta: ProviderMeta = {
    id: "overture",
    storagePolicy: "persistent",
    attributionPolicy: "overture_cdla_attribution",
    ttlHours: null,
  };

  private readonly db: SupabaseClient;

  constructor(db?: SupabaseClient) {
    this.db = db ?? createServiceClient();
  }

  async search(query: PlaceSearchQuery): Promise<PlaceSearchResult[]> {
    const center = this.resolveCenter(query);
    if (!center) return [];

    const rows = await this.searchIndex(center, POOL_LIMIT);
    const fetchedAt = new Date().toISOString();
    // RPC が距離順で返すので、その順序を保ったままジャンル一致で並べ替える
    const results = rows.map((row) => toResult(row, fetchedAt));
    return rankByKeyword(results, query.keyword).slice(0, query.limit);
  }

  // 自前 index からの個別再取得。persistent provider なので TTL 自動更新の対象外
  // (provider_ttl.ts が ttlHours=null を見て呼ばない)。
  // 明示的な freshness 操作から使えるよう interface は実装しておく。
  async fetchByIds(providerPlaceIds: string[]): Promise<PlaceSearchResult[]> {
    const ids = [...new Set(providerPlaceIds)].sort();
    if (ids.length === 0) return [];
    const { data, error } = await this.db
      .from("place_discovery_index")
      .select(
        "place_id, provider, provider_place_id, name, address, lat, lng, category, website, region_id, release, promoted_at",
      )
      .eq("provider", "overture")
      .in("provider_place_id", ids);
    if (error) {
      throw new Error(`Overture index の取得に失敗: ${error.message}`);
    }
    const fetchedAt = new Date().toISOString();
    return parseDiscoveryRows(
      (data ?? []).map((row) => ({ ...row, distance_m: null })),
      "fetchByIds",
    ).map((row) => toResult(row, fetchedAt));
  }

  // 検索中心の決定。外部 geocoder を持たないため、座標 anchor が無ければ探索しない。
  // 「池袋」のような地名だけの指定は #509 / 鉄道 anchor 解決 (rail_resolver) 側で
  // 座標へ解決されてから publicSearchAnchor として渡ってくる。ここで別地名へ
  // 推測変換しない (実測: Geoapify geocode でも「天神駅」→ 岐阜「田神駅」の誤マッチがあった)。
  private resolveCenter(
    query: PlaceSearchQuery,
  ): { lat: number; lng: number } | null {
    const searchAnchor = query.searchAnchor !== undefined
      ? locationAnchorSchema.safeParse(query.searchAnchor)
      : null;
    if (query.searchAnchor !== undefined && !searchAnchor?.success) {
      throw new Error("検索位置 anchor が不正です");
    }
    if (searchAnchor?.success) {
      return { lat: searchAnchor.data.lat, lng: searchAnchor.data.lng };
    }

    const anchor = query.publicSearchAnchor !== undefined
      ? publicSearchAnchorSchema.safeParse(query.publicSearchAnchor)
      : null;
    if (query.publicSearchAnchor !== undefined && !anchor?.success) {
      throw new Error("公開検索anchorが不正です");
    }
    if (anchor?.success) return { lat: anchor.data.lat, lng: anchor.data.lng };

    // ここから先は座標が無い。「現在地」系の擬似エリア語も地名も、この provider には
    // 解決手段が無いので 0 件にする。推測で別座標へ倒さない (AGENTS.md 11)。
    // どちらの理由で 0 件になったかは運用上区別したいのでログにだけ残す。
    console.info(
      `[overture] 座標 anchor が無いため探索しない currentLocation=${
        isCurrentLocationArea(query.area)
      }`,
    );
    return null;
  }

  private async searchIndex(
    center: { lat: number; lng: number },
    limit: number,
  ): Promise<DiscoveryIndexRow[]> {
    // 自前 index のみを読む RPC。外部 API を呼ばないので external_cache も使わない
    // (キャッシュを挟むと promote 直後の更新が見えなくなるだけで、費用の節約にならない)。
    const { data, error } = await this.db.rpc("search_place_discovery_index", {
      p_lat: center.lat,
      p_lng: center.lng,
      p_radius_m: SEARCH_RADIUS_M,
      p_limit: limit,
      p_provider: "overture",
    });
    if (error) {
      throw new Error(`Overture index の検索に失敗: ${error.message}`);
    }
    return parseDiscoveryRows(data ?? [], "search");
  }
}
