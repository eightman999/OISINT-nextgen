-- 202608190002: Overture / 行政OD / Geoapify ベンチマーク staging (#549)
--
-- 計画書 OISINT_549_Overture_AdminOD_Geoapify_Integration_Plan.md Phase 1。
-- 本番 public.places へ直接投入せず、検証用 staging を別 schema に置く。
--   raw → normalized → match candidate → entity resolution → benchmark → 採用判定
--        → （明示的な promote step を経て初めて） places / place_provider_links
--
-- なぜ public ではなく専用 schema か:
--   supabase の PostgREST 公開 schema は public / graphql_public のみ。benchmark schema に
--   置けば anon / authenticated からは API 経由でも到達できず、ライセンス確認前の raw を
--   クライアントへ露出させない (§19 / §34)。RLS も有効にして二重の deny とする。

create schema if not exists benchmark;

comment on schema benchmark is
  '#549 の provider ベンチマーク staging。production canonical (public.places) とは分離し、promote step 経由でのみ本番へ流す';

revoke all on schema benchmark from public;
grant usage on schema benchmark to service_role;

-- ============================================================
-- 1. provider_sources — dataset 単位の provenance / license
-- ============================================================
-- 行政OD は自治体ごとにライセンスが異なるため、dataset 単位で license を持つ (#473)。
-- license が確認できていない dataset は license_status='unknown' のまま置き、
-- promote step でブロックする（「Webで公開されている」だけでは採用しない）。
create table benchmark.provider_sources (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                 -- overture | public_food_license | geoapify
  region_id text not null,                -- regions.json の region_id
  authority text,                         -- 公開主体（都道府県 / 保健所設置市 / 特別区 / 財団）
  dataset_page_url text,
  dataset_file_url text,
  dataset_type text,                      -- csv | xlsx | geojson | parquet | api
  license text,
  license_url text,
  license_status text not null default 'unknown'
    check (license_status in ('verified','unknown','not_permitted')),
  storage_policy text not null default 'unknown'
    check (storage_policy in ('persistent','ttl','id_only','ephemeral','unknown')),
  attribution_policy text,
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  extraction_rule jsonb not null default '{}'::jsonb,  -- 飲食店抽出条件を再現可能にする
  coverage_notes text,
  content_sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, region_id, dataset_file_url)
);

comment on table benchmark.provider_sources is
  'dataset 単位の取得元・ライセンス台帳 (#549 Phase 0 / #473)。license_status=verified 以外は canonical へ promote しない';
comment on column benchmark.provider_sources.extraction_rule is
  '飲食店レコードの抽出条件（列名・値・カテゴリ）。再現性のため機械可読で持つ (#549 AC「抽出条件を再現可能にする」)';

-- ============================================================
-- 2. provider_observations — raw 観測
-- ============================================================
create table benchmark.provider_observations (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references benchmark.provider_sources(id) on delete cascade,
  observation_id text not null,           -- f"{provider}:{region_id}:{provider_record_id}"
  provider text not null,
  provider_record_id text not null,
  region_id text not null,
  raw_payload jsonb not null,             -- 個人情報を落とした後の原文 (data minimization)
  observed_at timestamptz not null,
  source_license text not null default 'unknown',
  created_at timestamptz not null default now(),
  unique (observation_id)
);

create index idx_bm_observations_source on benchmark.provider_observations (source_id);
create index idx_bm_observations_region on benchmark.provider_observations (region_id, provider);

comment on table benchmark.provider_observations is
  'provider ごとの生観測 1 行 = provider の 1 レコード（行政OD は許可 1 件。Place ではない）';
comment on column benchmark.provider_observations.raw_payload is
  '個人営業者氏名等を除外した後の原文 (#230 / #276 data minimization)。除外前の原本はDBへ入れない';

-- ============================================================
-- 3. normalized_place_observations — 突合用の正規化ビュー
-- ============================================================
create table benchmark.normalized_place_observations (
  observation_id text primary key references benchmark.provider_observations(observation_id) on delete cascade,
  provider text not null,
  region_id text not null,
  normalized_name text,
  name_key text,
  normalized_address text,
  address_key text,
  municipality text,
  lat double precision,
  lng double precision,
  phone text,
  category text,
  is_food boolean not null default false,
  closed boolean,                         -- 廃業・失効が判明した場合のみ true/false。不明は null (§ unknown は false ではない)
  permit_id text,                         -- 行政OD の許可・届出番号。Place identity ではない
  created_at timestamptz not null default now()
);

create index idx_bm_normalized_region on benchmark.normalized_place_observations (region_id, provider) where is_food;
create index idx_bm_normalized_address on benchmark.normalized_place_observations (address_key) where address_key is not null;
create index idx_bm_normalized_phone on benchmark.normalized_place_observations (phone) where phone is not null;
create index idx_bm_normalized_name on benchmark.normalized_place_observations (name_key) where name_key is not null;

comment on column benchmark.normalized_place_observations.closed is
  '廃業・許可失効が source から確定できる場合のみ true/false。不明は null のまま（unknown を false にしない）';

-- ============================================================
-- 4. place_match_candidates — entity resolution の候補と判定
-- ============================================================
create table benchmark.place_match_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,                            -- benchmark_runs.id （resolver 単独実行時は null 可）
  region_id text not null,
  left_observation text not null references benchmark.normalized_place_observations(observation_id) on delete cascade,
  right_observation text not null references benchmark.normalized_place_observations(observation_id) on delete cascade,
  match_method text not null,             -- address_exact | phone_exact | name_address | fuzzy_name_locality | coordinate_fuzzy | none
  score double precision not null,
  signals text[] not null default '{}',
  distance_m double precision,
  decision text not null check (decision in ('match','review','reject')),
  human_label text check (human_label in ('true_positive','false_positive','true_negative','false_negative','unclear')),
  human_labeled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint place_match_candidates_ordered check (left_observation < right_observation),
  unique (run_id, left_observation, right_observation)
);

create index idx_bm_candidates_region on benchmark.place_match_candidates (region_id, decision);
create index idx_bm_candidates_run on benchmark.place_match_candidates (run_id);

comment on table benchmark.place_match_candidates is
  'entity resolution v1 の候補ペア。precision > recall 方針のため decision=match は複数 signal 一致時のみ (#549 Phase 4)';
comment on column benchmark.place_match_candidates.human_label is
  'Phase 6 の層化サンプル目視結果。precision / recall はこの列からのみ算出する（推定値を入れない）';

-- ============================================================
-- 5. benchmark_runs / benchmark_metrics
-- ============================================================
create table benchmark.benchmark_runs (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  providers text[] not null,
  region_ids text[] not null,
  resolver_version text not null,
  weights jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  notes text
);

create table benchmark.benchmark_metrics (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references benchmark.benchmark_runs(id) on delete cascade,
  region_id text not null,
  metric_key text not null,               -- 例: overture.total / od.food_rows / coverage.od_only
  metric_value double precision,
  metric_text text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, region_id, metric_key)
);

create index idx_bm_metrics_run on benchmark.benchmark_metrics (run_id, region_id);

comment on table benchmark.benchmark_metrics is
  '地域×指標の実測値。推定値・目標値は入れない（実測のみ。#549 完了条件）';

-- ============================================================
-- 6. GRANT / RLS — service_role のみ。anon / authenticated には開けない (§19)
-- ============================================================
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'provider_sources','provider_observations','normalized_place_observations',
    'place_match_candidates','benchmark_runs','benchmark_metrics'
  ] loop
    execute format('alter table benchmark.%I enable row level security', tbl);
    execute format('revoke all on benchmark.%I from public, anon, authenticated', tbl);
    execute format('grant all on benchmark.%I to service_role', tbl);
  end loop;
end $$;

alter default privileges in schema benchmark revoke all on tables from public;

create trigger trg_bm_provider_sources_updated_at before update on benchmark.provider_sources
for each row execute function public.set_updated_at();
