-- 202608210001: Overture Places を canonical backbone へ promote する経路 (#559 / #549 / #530)
--
-- #549 の owner decision (2026-08-19) で Overture Places を OISINT DB v2 の canonical
-- backbone として Adopt した。その production 接続をここで行う。
--
--   benchmark.provider_observations / normalized_place_observations   (staging: #549 Phase 1-6)
--     → benchmark.validate_overture_promotion()   ライセンス / human label ゲート (fail-closed)
--     → benchmark.promote_overture_region()       明示的な promote step
--     → public.places + public.place_provider_links + public.place_discovery_index
--     → public.search_place_discovery_index()     runtime discovery (S3 parquet は読まない)
--
-- 設計上の前提 (#559「決定済みの前提」。ここで再検討しない):
--   - provider = 'overture' / storage_policy = 'persistent'
--     / attribution_policy = 'overture_cdla_attribution'
--   - ingest は自前 index の更新であり、runtime に外部 API を呼ばない
--   - promote は明示的なステップ。ingest から自動で本番へ流さない
--   - operating_status は実測でほぼ全件 null。「営業中」の保証には使えないため
--     canonical 側へ営業状態を一切持ち込まない (spec.md §30 / §36 Rule 6)

-- PostGIS は extensions schema にある (202608200001 と同じ前提)。
-- geography 型をこの migration 内で解決できるよう search_path を明示する。
set search_path = public, extensions;

-- ============================================================
-- 0. license 語彙 (fail-closed の基準)
-- ============================================================
-- #549 実測では飲食レコードは全件 CDLA-Permissive-2.0 で、OSM(ODbL) 由来は 0 件だった。
-- ただし release ごとに変わりうるため、ingest / promote のたびに実データを集計して検証する。
-- ここを「CDLA-Permissive で始まる」以外に広げない。広げるときは #473 の rights matrix を先に更新する。
create or replace function benchmark.is_cdla_permissive(p_license text)
returns boolean
language sql
immutable
as $$
  select p_license is not null and p_license like 'CDLA-Permissive-%'
$$;

comment on function benchmark.is_cdla_permissive(text) is
  'Overture の許容ライセンス判定 (#559)。これ以外が混ざったら promote を止める。語彙拡張は #473 の rights matrix 更新が先';

-- ============================================================
-- 1. public.place_discovery_index — runtime discovery の自前 index
-- ============================================================
-- #549 Key Questions 4 の「定期 ingest した自前 DB を runtime discovery index として使う」。
-- runtime に S3 parquet を読まない / 外部 API を呼ばないため、外部 API 障害でも候補 0 件にならない。
--
-- places 本体へ列を足さず別テーブルにしている理由:
--   - discovery 用の派生データ (name_key / is_food / 地理 index) を canonical の書き込み hot path
--     から分離し、promote step だけが更新する明確な所有者を持たせるため
--   - provider ごとの ingest release を index 側に持ち、差分 ingest で世代を追えるようにするため
create table public.place_discovery_index (
  place_id uuid primary key references public.places(id) on delete cascade,
  provider text not null,
  provider_place_id text not null,
  region_id text not null,
  release text,                            -- ingest した Overture release (例: 2026-07-22.0)
  name text not null,
  name_key text,                           -- 正規化済み店名。前方一致・完全一致検索用
  address text,
  lat double precision not null,
  lng double precision not null,
  -- 半径検索を meter で行うため geography を使う (rail と同じく PostGIS は extensions schema)
  geog geography(Point, 4326) not null,
  category text,
  website text,
  -- この行の元 observation が申告していたライセンス。promote 時点の実測値であり推定値ではない
  source_licenses text[] not null default '{}',
  promoted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_place_id)
);

create index idx_place_discovery_geog on public.place_discovery_index using gist (geog);
create index idx_place_discovery_provider on public.place_discovery_index (provider, region_id);
create index idx_place_discovery_name_key on public.place_discovery_index (name_key)
  where name_key is not null;

create trigger trg_place_discovery_index_updated_at before update on public.place_discovery_index
for each row execute function public.set_updated_at();

comment on table public.place_discovery_index is
  'runtime discovery の自前 index (#559)。promote step だけが書き込む。外部 API を呼ばずに候補を出すための唯一の探索元';
comment on column public.place_discovery_index.source_licenses is
  'promote 時に実測した sources[].license の集合。CDLA-Permissive 以外が入ることは validate で禁止 (#559)';

-- 営業状態 (operating_status) の列を意図的に持たない。#549 実測でほぼ全件 null であり、
-- 「営業中」を断定する根拠にならない (spec.md §30 / §36 Rule 6)。
-- 廃業が source から確定できた行は promote 対象から外す方針で扱う。

-- ============================================================
-- 2. promote の監査記録
-- ============================================================
create table benchmark.promotion_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  region_id text not null,
  release text,
  -- 実際に適用したゲート閾値。既定値を緩めて通したのかを後から検証できるようにする
  gate_params jsonb not null default '{}'::jsonb,
  validation jsonb not null default '{}'::jsonb,
  promoted_place_count integer not null default 0,
  promoted_link_count integer not null default 0,
  skipped_closed_count integer not null default 0,
  -- 今回の対象から外れたため discovery index から取り下げた件数 (旧 release の残骸)
  removed_index_count integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index idx_bm_promotion_runs_region on benchmark.promotion_runs (provider, region_id, started_at desc);

comment on table benchmark.promotion_runs is
  'benchmark → canonical promote の実行記録 (#559)。どの release を、どの閾値で、何件通したかの証跡';

-- ============================================================
-- 3. validate — license / human label の fail-closed ゲート
-- ============================================================
-- errors が空でなければ promote は実行されない。「たぶん大丈夫」で通さない。
create or replace function benchmark.validate_overture_promotion(
  p_region_id text,
  p_min_labeled_matches integer default 20,
  p_min_match_precision double precision default 0.90
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, benchmark, pg_temp
as $$
declare
  errors jsonb := '[]'::jsonb;
  source_count integer;
  unverified_count integer;
  bad_license_count integer;
  bad_obs_licenses text[];
  food_count integer;
  labeled_matches integer;
  true_positives integer;
  false_positives integer;
  precision_value double precision;
  licenses text[];
begin
  -- 閾値そのものを検証する。NULL を渡すと比較結果が UNKNOWN になり、
  -- 「ラベル 1 件・precision 0.0」でもゲートを素通りできてしまう (fail-open)。
  -- 実測で再現したため、不正な閾値は errors ではなく即例外にする。
  if p_min_labeled_matches is null or p_min_labeled_matches < 1
     or p_min_match_precision is null
     or p_min_match_precision <= 0 or p_min_match_precision > 1 then
    raise exception 'promote ゲートの閾値が不正です (minLabeledMatches=%, minMatchPrecision=%)',
      p_min_labeled_matches, p_min_match_precision;
  end if;

  select count(*) into source_count
  from benchmark.provider_sources
  where provider = 'overture' and region_id = p_region_id;

  if source_count = 0 then
    -- dataset 台帳が無い地域を「たぶん取得済み」で通さない
    errors := errors || to_jsonb(format('overture provider_sources が region %s に存在しません', p_region_id));
  end if;

  select count(*) into unverified_count
  from benchmark.provider_sources
  where provider = 'overture' and region_id = p_region_id
    and license_status <> 'verified';
  if unverified_count > 0 then
    errors := errors || to_jsonb(format('license_status が verified でない overture source が %s 件あります', unverified_count));
  end if;

  select count(*) into bad_license_count
  from benchmark.provider_sources
  where provider = 'overture' and region_id = p_region_id
    and not benchmark.is_cdla_permissive(license);
  if bad_license_count > 0 then
    errors := errors || to_jsonb(format('CDLA-Permissive 以外の license を持つ overture source が %s 件あります', bad_license_count));
  end if;

  -- release ごとに寄与元が変わりうるため、dataset 台帳だけでなく観測 1 行ごとの
  -- source_license も集計して検証する (#559 AC「ingest のたびに sources[].license を集計」)
  select array_agg(distinct o.source_license order by o.source_license)
    into licenses
  from benchmark.provider_observations o
  where o.provider = 'overture' and o.region_id = p_region_id;

  select array_agg(distinct o.source_license order by o.source_license)
    into bad_obs_licenses
  from benchmark.provider_observations o
  where o.provider = 'overture' and o.region_id = p_region_id
    and not benchmark.is_cdla_permissive(o.source_license);
  if bad_obs_licenses is not null then
    errors := errors || to_jsonb(format('CDLA-Permissive 以外の source_license を持つ観測があります: %s', bad_obs_licenses));
  end if;

  select count(*) into food_count
  from benchmark.normalized_place_observations n
  where n.provider = 'overture' and n.region_id = p_region_id
    and n.is_food
    and n.lat is not null and n.lng is not null;
  if food_count = 0 then
    errors := errors || to_jsonb(format('promote 対象の飲食観測が region %s に 0 件です', p_region_id));
  end if;

  -- entity resolution の human label ゲート (#549 Phase 6 のラベリング結果を使う)。
  -- 推定値ではなく human_label 列からのみ算出する。ラベルが無い地域は fail-closed。
  select
    count(*) filter (where human_label is not null),
    count(*) filter (where human_label = 'true_positive'),
    count(*) filter (where human_label = 'false_positive')
    into labeled_matches, true_positives, false_positives
  from benchmark.place_match_candidates
  where region_id = p_region_id and decision = 'match';

  if labeled_matches < p_min_labeled_matches then
    errors := errors || to_jsonb(format(
      'entity resolution の human label が不足しています (region %s: %s 件 / 必要 %s 件)',
      p_region_id, labeled_matches, p_min_labeled_matches));
  elsif (true_positives + false_positives) = 0 then
    errors := errors || to_jsonb(format(
      'human label に true_positive / false_positive が無く precision を実測できません (region %s)', p_region_id));
  else
    precision_value := true_positives::double precision / (true_positives + false_positives);
    if precision_value < p_min_match_precision then
      errors := errors || to_jsonb(format(
        'entity resolution の実測 precision が閾値未満です (region %s: %s < %s)',
        p_region_id, round(precision_value::numeric, 4), p_min_match_precision));
    end if;
  end if;

  return jsonb_build_object(
    'regionId', p_region_id,
    'sourceCount', source_count,
    'foodObservationCount', food_count,
    'observedLicenses', coalesce(to_jsonb(licenses), '[]'::jsonb),
    'labeledMatchCount', labeled_matches,
    'matchPrecision', precision_value,
    'gateParams', jsonb_build_object(
      'minLabeledMatches', p_min_labeled_matches,
      'minMatchPrecision', p_min_match_precision
    ),
    'errors', errors,
    'ok', jsonb_array_length(errors) = 0
  );
end $$;

comment on function benchmark.validate_overture_promotion(text, integer, double precision) is
  'promote 前のゲート判定 (#559)。license / human label のいずれかが欠けたら errors を返し、promote を止める';

-- ============================================================
-- 4. promote — benchmark → canonical
-- ============================================================
create or replace function benchmark.promote_overture_region(
  p_region_id text,
  p_release text default null,
  p_min_labeled_matches integer default 20,
  p_min_match_precision double precision default 0.90
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, benchmark, pg_temp
as $$
declare
  validation jsonb;
  run_id uuid;
  place_count integer := 0;
  link_count integer := 0;
  index_count integer := 0;
  removed_count integer := 0;
  closed_count integer := 0;
begin
  validation := benchmark.validate_overture_promotion(
    p_region_id, p_min_labeled_matches, p_min_match_precision);

  if not (validation ->> 'ok')::boolean then
    -- fail-closed。errors をそのまま例外文言に載せ、何が足りないかを運用側から見えるようにする
    raise exception 'overture promote gate failed for region %: %',
      p_region_id, validation -> 'errors';
  end if;

  insert into benchmark.promotion_runs (provider, region_id, release, gate_params, validation)
  values (
    'overture', p_region_id, p_release,
    jsonb_build_object(
      'minLabeledMatches', p_min_labeled_matches,
      'minMatchPrecision', p_min_match_precision
    ),
    validation
  )
  returning id into run_id;

  -- 廃業が source から確定した行は canonical へ入れない。closed is null (不明) は
  -- 「営業中」ではないので、営業状態を主張しないまま候補として保持する (§30)
  select count(*) into closed_count
  from benchmark.normalized_place_observations n
  where n.provider = 'overture' and n.region_id = p_region_id
    and n.is_food and n.closed is true;

  -- 同一トランザクション内で 2 地域を続けて promote しても衝突しないよう毎回作り直す
  drop table if exists tmp_overture_promote;
  create temporary table tmp_overture_promote on commit drop as
  -- provider_record_id を重複排除する。現行の observation_id 規約
  -- (provider:region:record_id + unique) では region 内で一意になるはずだが、
  -- 万一重複すると ON CONFLICT DO UPDATE が同一行を二度更新して promote 全体が落ちる。
  -- 観測が新しいものを残す (同着は observation_id 順で決定論的に決める)。
  select distinct on (o.provider_record_id)
    o.provider_record_id                              as provider_place_id,
    n.observation_id                                  as observation_id,
    coalesce(nullif(trim(n.normalized_name), ''), '') as name,
    n.name_key                                        as name_key,
    nullif(trim(coalesce(n.normalized_address, '')), '') as address,
    n.lat                                             as lat,
    n.lng                                             as lng,
    n.category                                        as category,
    nullif(trim(coalesce(o.raw_payload ->> 'website', '')), '') as website,
    o.source_license                                  as source_license,
    o.observed_at                                     as observed_at
  from benchmark.normalized_place_observations n
  join benchmark.provider_observations o on o.observation_id = n.observation_id
  where n.provider = 'overture'
    and n.region_id = p_region_id
    and n.is_food
    and n.lat is not null
    and n.lng is not null
    and coalesce(n.closed, false) = false
    and coalesce(nullif(trim(n.normalized_name), ''), '') <> ''
  order by o.provider_record_id, o.observed_at desc, n.observation_id;

  -- canonical Place。metadata には Overture 由来であることと寄与ライセンスだけを残し、
  -- 営業状態 (operating_status) は持ち込まない (#559 AC / §30)
  insert into public.places (provider, provider_place_id, name, address, lat, lng, metadata, refreshed_at)
  select
    'overture', t.provider_place_id, t.name, t.address, t.lat, t.lng,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'overture',
      'regionId', p_region_id,
      'release', p_release,
      'category', t.category,
      'website', t.website,
      'license', t.source_license,
      'attribution', 'Overture Maps Foundation'
    )),
    t.observed_at
  from tmp_overture_promote t
  on conflict (provider, provider_place_id) do update set
    name = excluded.name,
    address = excluded.address,
    lat = excluded.lat,
    lng = excluded.lng,
    metadata = excluded.metadata,
    refreshed_at = excluded.refreshed_at;
  get diagnostics place_count = row_count;

  -- provider identity の正本 (#530)。storage / attribution は #549 の決定どおり固定する
  insert into public.place_provider_links (
    place_id, provider, provider_place_id, source_url,
    storage_policy, expires_at, attribution_policy, last_seen_at
  )
  select
    p.id, 'overture', t.provider_place_id, t.website,
    'persistent', null, 'overture_cdla_attribution', t.observed_at
  from tmp_overture_promote t
  join public.places p
    on p.provider = 'overture' and p.provider_place_id = t.provider_place_id
  on conflict (provider, provider_place_id) do update set
    source_url = excluded.source_url,
    storage_policy = excluded.storage_policy,
    attribution_policy = excluded.attribution_policy,
    last_seen_at = excluded.last_seen_at;
  get diagnostics link_count = row_count;

  insert into public.place_discovery_index (
    place_id, provider, provider_place_id, region_id, release,
    name, name_key, address, lat, lng, geog, category, website,
    source_licenses, promoted_at
  )
  select
    p.id, 'overture', t.provider_place_id, p_region_id, p_release,
    t.name, t.name_key, t.address, t.lat, t.lng,
    st_setsrid(st_makepoint(t.lng, t.lat), 4326)::geography,
    t.category, t.website,
    array[t.source_license], now()
  from tmp_overture_promote t
  join public.places p
    on p.provider = 'overture' and p.provider_place_id = t.provider_place_id
  on conflict (provider, provider_place_id) do update set
    place_id = excluded.place_id,
    region_id = excluded.region_id,
    release = excluded.release,
    name = excluded.name,
    name_key = excluded.name_key,
    address = excluded.address,
    lat = excluded.lat,
    lng = excluded.lng,
    geog = excluded.geog,
    category = excluded.category,
    website = excluded.website,
    source_licenses = excluded.source_licenses,
    promoted_at = excluded.promoted_at;
  get diagnostics index_count = row_count;

  -- 旧 release で promote した店が今回の対象から外れた場合 (削除・廃業確定・非飲食化)、
  -- discovery index に残ると runtime 検索で返り続ける。index からは取り下げる。
  -- canonical の places / place_provider_links は provenance と candidates の参照のため残す
  -- (#530 purge は provider 停止時の別経路)。
  delete from public.place_discovery_index i
  where i.provider = 'overture'
    and i.region_id = p_region_id
    and not exists (
      select 1 from tmp_overture_promote t
      where t.provider_place_id = i.provider_place_id
    );
  get diagnostics removed_count = row_count;

  update benchmark.promotion_runs
  set promoted_place_count = place_count,
      promoted_link_count = link_count,
      skipped_closed_count = closed_count,
      removed_index_count = removed_count,
      finished_at = now()
  where id = run_id;

  return jsonb_build_object(
    'runId', run_id,
    'regionId', p_region_id,
    'release', p_release,
    'promotedPlaceCount', place_count,
    'promotedLinkCount', link_count,
    'discoveryIndexCount', index_count,
    'skippedClosedCount', closed_count,
    'removedIndexCount', removed_count,
    'validation', validation
  );
end $$;

comment on function benchmark.promote_overture_region(text, text, integer, double precision) is
  'benchmark staging から canonical (places / place_provider_links / place_discovery_index) への明示的 promote (#559)。ゲート不合格なら例外で止まる';

-- ============================================================
-- 5. runtime discovery — 自前 index の半径検索
-- ============================================================
-- Edge Function (service role) から呼ぶ。外部 API を一切叩かないため、
-- 外部 API 障害でも候補 0 件にならない (#559 AC)。
-- keyword による並べ替えは provider 側 (TypeScript) の既存ロジックを使うため、
-- ここでは距離順の候補プールを返すだけにする。
-- 半径は 50km で頭打ちにする。徒歩圏探索 (provider 側 1500m) に対して十分広く、
-- 誤設定や悪意ある巨大半径で全国スキャンを走らせられないようにするための上限。
create or replace function public.search_place_discovery_index(
  p_lat double precision,
  p_lng double precision,
  p_radius_m double precision,
  p_limit integer,
  p_provider text default 'overture'
)
returns table (
  place_id uuid,
  provider text,
  provider_place_id text,
  name text,
  address text,
  lat double precision,
  lng double precision,
  category text,
  website text,
  region_id text,
  release text,
  distance_m double precision,
  promoted_at timestamptz
)
language sql
stable
security definer
set search_path = extensions, public
as $$
  select
    i.place_id, i.provider, i.provider_place_id, i.name, i.address,
    i.lat, i.lng, i.category, i.website, i.region_id, i.release,
    st_distance(i.geog, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) as distance_m,
    i.promoted_at
  from public.place_discovery_index i
  where i.provider = p_provider
    and st_dwithin(
      i.geog,
      st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
      least(greatest(coalesce(p_radius_m, 0), 0), 50000)
    )
  order by distance_m, i.provider_place_id
  limit greatest(least(coalesce(p_limit, 0), 500), 0)
$$;

comment on function public.search_place_discovery_index(double precision, double precision, double precision, integer, text) is
  'runtime discovery の半径検索 (#559)。自前 index のみを読み、外部 API を呼ばない';

-- ============================================================
-- 6. GRANT / RLS (§19 / §34。anon には開けない)
-- ============================================================
alter table public.place_discovery_index enable row level security;

-- 店舗の公開情報 (§33) なので places と同じく authenticated の読み取りは許す。
-- 書き込みは promote step (service role) のみ。
grant select on public.place_discovery_index to authenticated;
grant all on public.place_discovery_index to service_role;

create policy place_discovery_index_select on public.place_discovery_index for select
  to authenticated using (true);

-- discovery RPC は security definer なので、実行権限を service role と authenticated に限る。
-- anon には渡さない。
revoke all on function public.search_place_discovery_index(double precision, double precision, double precision, integer, text) from public;
grant execute on function public.search_place_discovery_index(double precision, double precision, double precision, integer, text) to service_role, authenticated;

-- promote / validate は運用操作。クライアントからは一切呼べないようにする。
revoke all on function benchmark.validate_overture_promotion(text, integer, double precision) from public;
revoke all on function benchmark.promote_overture_region(text, text, integer, double precision) from public;
grant execute on function benchmark.validate_overture_promotion(text, integer, double precision) to service_role;
grant execute on function benchmark.promote_overture_region(text, text, integer, double precision) to service_role;

alter table benchmark.promotion_runs enable row level security;
revoke all on benchmark.promotion_runs from public, anon, authenticated;
grant all on benchmark.promotion_runs to service_role;
