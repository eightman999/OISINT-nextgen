-- 202608190001: canonical Place + provider links (#530 DB v2 Core / #516 / #297)
--
-- places.id を OISINT canonical Place identity とし、provider 固有 identity
-- (provider, provider_place_id) を link table へ分離する。1 canonical Place に
-- 複数 provider identity を紐付けられるようにし、provider 停止・契約終了時に
-- 「どのデータがどの provider 由来か」を provenance から列挙・purge できる状態を作る。
--
-- expand-contract の expand 側 (#172)。既存の places.provider /
-- places.provider_place_id / unique(provider, provider_place_id) はこの migration では
-- 削除しない。read path を link table へ段階移行し、十分な観測期間の後に別 PR で contract する。

-- ============================================================
-- 1. place_provider_links
-- ============================================================

create table public.place_provider_links (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  provider text not null,
  provider_place_id text not null,
  source_url text,
  -- storage policy (#530): provider 規約上どこまで保存してよいか
  --   persistent … 無期限保存可 (例: ODbL 系オープンデータ)
  --   ttl        … 期限付き保存のみ可。expires_at 必須
  --   id_only    … provider の place ID / URL のみ保持可。本文・属性は保存しない
  --   ephemeral  … 保存不可。実行時のみ利用
  storage_policy text not null default 'persistent'
    check (storage_policy in ('persistent','ttl','id_only','ephemeral')),
  expires_at timestamptz,
  -- 表示義務 (例: 'hotpepper_credit_required' / 'osm_odbl_attribution')
  attribution_policy text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_place_id),
  -- ttl / ephemeral は期限が無いと purge 対象を判定できない
  constraint place_provider_links_ttl_requires_expiry
    check (storage_policy <> 'ttl' or expires_at is not null)
);

create index idx_place_provider_links_place on public.place_provider_links (place_id);
create index idx_place_provider_links_provider on public.place_provider_links (provider);
create index idx_place_provider_links_expires on public.place_provider_links (expires_at)
  where expires_at is not null;

create trigger trg_place_provider_links_updated_at before update on public.place_provider_links
for each row execute function public.set_updated_at();

comment on table public.place_provider_links is
  'canonical Place (places.id) と provider 固有 identity の多対1 link。provider 停止時の列挙・TTL・purge の起点 (#530)';
comment on column public.place_provider_links.storage_policy is
  'persistent / ttl / id_only / ephemeral。provider 規約上の保存可否 (#473 provider rights matrix が正本)';
comment on column public.place_provider_links.expires_at is
  'storage_policy=ttl のときの保存期限。超過行は表示停止・purge の対象 (#276 / #297)';

comment on column public.places.id is
  'OISINT canonical Place identity。provider 固有 ID は place_provider_links 側に持つ (#530)';
comment on column public.places.provider is
  '[legacy / 移行期間] 初回登録した provider。正本は place_provider_links.provider。観測期間後に contract 予定 (#530 Phase 5)';
comment on column public.places.provider_place_id is
  '[legacy / 移行期間] 初回登録した provider の place ID。正本は place_provider_links.provider_place_id (#530 Phase 5)';

-- ============================================================
-- 2. evidence の provenance
-- ============================================================
-- Evidence #0 (place provider の構造化情報) がどの provider link 由来かを保持する。
-- Serper + fetcher 由来の Evidence は provider link を持たない (null のまま)。
alter table public.evidence
  add column provider_link_id uuid references public.place_provider_links(id) on delete set null;

create index idx_evidence_provider_link on public.evidence (provider_link_id)
  where provider_link_id is not null;

comment on column public.evidence.provider_link_id is
  'この Evidence の出所 provider link。provider 停止時に purge 対象を列挙するための provenance (#530 / #297)。Web 取得 Evidence は null';

-- ============================================================
-- 3. GRANT / RLS (0003 と同じ規律。anon には開けない §19)
-- ============================================================

-- provider link は places と同じく公開情報 (§33)。クライアントは読み取りのみ。
grant select on public.place_provider_links to authenticated;
grant all on public.place_provider_links to service_role;

alter table public.place_provider_links enable row level security;

create policy place_provider_link_select on public.place_provider_links for select
  to authenticated using (true);

-- ============================================================
-- 4. 既存 HotPepper identity の backfill
-- ============================================================
-- 既存 places 行 (provider, provider_place_id) を link table へ写す。
-- HotPepper はリクルート API 利用規約の 24h キャッシュ更新義務があるため ttl 扱いとし、
-- 既存 refreshed_at + 24h を expires_at の初期値にする (#289 / #297)。
insert into public.place_provider_links (
  place_id, provider, provider_place_id, storage_policy, expires_at,
  attribution_policy, first_seen_at, last_seen_at
)
select
  p.id,
  p.provider,
  p.provider_place_id,
  case when p.provider = 'hotpepper' then 'ttl' else 'persistent' end,
  case when p.provider = 'hotpepper' then coalesce(p.refreshed_at, p.created_at, now()) + interval '24 hours' end,
  case when p.provider = 'hotpepper' then 'hotpepper_credit_required' end,
  coalesce(p.created_at, now()),
  coalesce(p.refreshed_at, p.updated_at, p.created_at, now())
from public.places p
on conflict (provider, provider_place_id) do nothing;

-- 既存 Evidence #0 (place provider 由来) を link へ紐付ける
update public.evidence e
set provider_link_id = l.id
from public.place_provider_links l
where e.place_id = l.place_id
  and e.source_type = 'major_place_provider'
  and e.provider_link_id is null;

-- ============================================================
-- 5. provider 停止・purge 用の inventory ビュー (#297 close gate)
-- ============================================================
create view public.provider_data_inventory
with (security_invoker = on) as
select
  l.provider,
  count(distinct l.place_id)                                        as place_count,
  count(distinct l.id)                                              as link_count,
  count(distinct e.id)                                              as evidence_count,
  count(distinct l.id) filter (where l.storage_policy = 'ttl')      as ttl_link_count,
  count(distinct l.id) filter (where l.expires_at is not null
                                 and l.expires_at <= now())         as expired_link_count,
  min(l.first_seen_at)                                              as first_seen_at,
  max(l.last_seen_at)                                               as last_seen_at
from public.place_provider_links l
left join public.evidence e on e.provider_link_id = l.id
group by l.provider;

comment on view public.provider_data_inventory is
  'provider 単位の保存済みデータ件数。provider 停止 / 契約終了時の列挙起点 (#297 close gate / docs/ops/api-provider-stop-procedure.md)';

-- 集計とはいえ provider 契約状況に関わる運用情報なのでクライアントには開けない
grant select on public.provider_data_inventory to service_role;
