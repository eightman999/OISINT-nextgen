-- 202608300005: place_facts の需要駆動 refresh 契約 (#123)
--
-- この migration は crawler/frontier (#117) や候補生成 (#124) を実装しない。
-- 既存 candidates の利用実績を需要シグナルとして保持し、設定された鮮度・
-- importance・provider rate policy に従って少数の Place を claim する境界だけを
-- 追加する。config 行は意図的に seed しない。TTL・重み・batch・rate は owner が
-- 明示的に設定するまで service-role RPC が fail-closed になる。

-- ============================================================
-- 1. place vector の dirty/version と refresh Evidence の冪等キー
-- ============================================================

alter table public.places
  add column if not exists vector_dirty boolean not null default false,
  add column if not exists vector_source_version text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.places'::regclass
       and conname = 'places_vector_source_version_check'
  ) then
    alter table public.places
      add constraint places_vector_source_version_check
      check (
        vector_source_version is null
        or vector_source_version ~ '^place-facts-v1-[0-9a-f]{32}$'
      );
  end if;
end;
$$;

comment on column public.places.vector_dirty is
  'place_facts の意味的変更後に embedding 再計算が必要な状態。last_verified_at の更新だけでは dirty にしない (#123)。';
comment on column public.places.vector_source_version is
  '現在の place_facts 意味値を表す opaque digest。embedding job の冪等キーに使い、raw fact 値は保存しない (#123)。';
alter table public.evidence
  add column if not exists refresh_observation_key text;

create unique index if not exists idx_evidence_refresh_observation_key
  on public.evidence (refresh_observation_key)
  where refresh_observation_key is not null;

comment on column public.evidence.refresh_observation_key is
  'refresh run/place 単位の append observation 冪等キー。通常の Investigation Evidence では null。';

-- ============================================================
-- 2. owner 設定（未設定時は worker を起動しない）
-- ============================================================

create table public.demand_refresh_config (
  id smallint primary key check (id = 1),
  config_version text not null unique
    check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  provider text not null
    check (provider ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$'),
  provider_domain text not null
    check (provider_domain ~ '^[a-z0-9][a-z0-9.-]{0,251}$'),
  provider_ttl_hours integer not null check (provider_ttl_hours > 0),
  fact_ttl_hours integer not null check (fact_ttl_hours > 0),
  recent_usage_window_hours integer not null
    check (recent_usage_window_hours > 0),
  batch_size integer not null check (batch_size > 0),
  lease_seconds integer not null check (lease_seconds > 0),
  provider_cooldown_seconds integer not null
    check (provider_cooldown_seconds >= 0),
  usage_weight real not null check (usage_weight >= 0),
  freshness_weight real not null check (freshness_weight >= 0),
  fact_importance_weight real not null check (fact_importance_weight >= 0),
  enabled boolean not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint demand_refresh_config_weight_check check (
    usage_weight + freshness_weight + fact_importance_weight > 0
  )
);

comment on table public.demand_refresh_config is
  'Owner-managed #123 policy. No default row: TTL/weights/batch/rate are never inferred by the worker.';
comment on column public.demand_refresh_config.provider_ttl_hours is
  'places.refreshed_at の stale 判定。ProviderMeta または owner が確認した値を明示設定する。';
comment on column public.demand_refresh_config.fact_ttl_hours is
  'place_facts.last_verified_at の stale 判定。推測値を持たず owner 設定を必須にする。';
comment on column public.demand_refresh_config.provider_domain is
  '同一外部 provider domain の run を直列化し、cooldown を共有する論理 domain 名。';

create table public.demand_refresh_fact_importance (
  config_version text not null references public.demand_refresh_config(config_version)
    on delete cascade,
  key text not null check (char_length(key) between 1 and 80),
  importance real not null check (importance >= 0 and importance <= 1),
  primary key (config_version, key)
);

comment on table public.demand_refresh_fact_importance is
  'ClaimKey ごとの refresh importance。欠落キーは重要度を推測せず候補から除外する。';

-- ============================================================
-- 3. candidates の既存利用実績（blind scan を worker へ持ち込まない）
-- ============================================================

create table public.place_refresh_demand (
  place_id uuid primary key references public.places(id) on delete cascade,
  last_used_at timestamptz not null,
  use_count bigint not null check (use_count > 0),
  updated_at timestamptz not null default clock_timestamp()
);

create index idx_place_refresh_demand_recent
  on public.place_refresh_demand (last_used_at desc, place_id);

create index idx_place_facts_refresh_lookup
  on public.place_facts (place_id, last_verified_at, key);

comment on table public.place_refresh_demand is
  'candidates INSERT から更新する place 単位の需要集約。refresh worker は places 全件を走査しない (#123)。';

create or replace function public.record_place_refresh_demand()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used_at timestamptz := coalesce(new.updated_at, new.created_at, clock_timestamp());
begin
  insert into public.place_refresh_demand (place_id, last_used_at, use_count)
  values (new.place_id, v_used_at, 1)
  on conflict (place_id) do update set
    last_used_at = greatest(public.place_refresh_demand.last_used_at, excluded.last_used_at),
    use_count = public.place_refresh_demand.use_count + 1,
    updated_at = clock_timestamp();
  return new;
end;
$$;

revoke all on function public.record_place_refresh_demand() from public, anon, authenticated;

drop trigger if exists trg_candidates_refresh_demand on public.candidates;
create trigger trg_candidates_refresh_demand
after insert on public.candidates
for each row execute function public.record_place_refresh_demand();

-- 既存 candidates は migration 時だけ集約する。以後の worker はこの集約表と index
-- だけを読むため、毎回 candidates 全件を blind scan しない。
insert into public.place_refresh_demand (place_id, last_used_at, use_count)
select
  c.place_id,
  max(coalesce(c.updated_at, c.created_at, clock_timestamp())),
  count(*)::bigint
from public.candidates c
group by c.place_id
on conflict (place_id) do update set
  last_used_at = greatest(public.place_refresh_demand.last_used_at, excluded.last_used_at),
  use_count = greatest(public.place_refresh_demand.use_count, excluded.use_count),
  updated_at = clock_timestamp();

grant all on public.place_refresh_demand to service_role;
revoke all on public.place_refresh_demand from public, anon, authenticated;

-- ============================================================
-- 4. refresh run / per-place lease / provider-domain cooldown
-- ============================================================

create table public.place_refresh_provider_state (
  provider_domain text primary key
    check (provider_domain ~ '^[a-z0-9][a-z0-9.-]{0,251}$'),
  last_started_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.place_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique
    check (
      char_length(idempotency_key) between 1 and 200
      and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    ),
  provider text not null,
  provider_domain text not null,
  config_version text not null,
  status text not null check (status in ('running', 'complete', 'partial', 'failed')),
  requested_limit integer not null check (requested_limit > 0),
  lease_expires_at timestamptz not null,
  selected_count integer not null default 0 check (selected_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  provider_call_count integer not null default 0 check (provider_call_count >= 0),
  provider_item_count integer not null default 0 check (provider_item_count >= 0),
  provider_duration_ms bigint not null default 0 check (provider_duration_ms >= 0),
  evidence_appended_count integer not null default 0 check (evidence_appended_count >= 0),
  unchanged_count integer not null default 0 check (unchanged_count >= 0),
  changed_count integer not null default 0 check (changed_count >= 0),
  provider_error_count integer not null default 0 check (provider_error_count >= 0),
  closure_suspected_count integer not null default 0 check (closure_suspected_count >= 0),
  storage_error_count integer not null default 0 check (storage_error_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create index idx_place_refresh_runs_status
  on public.place_refresh_runs (status, updated_at);

create table public.place_refresh_state (
  place_id uuid primary key references public.places(id) on delete cascade,
  provider text not null,
  provider_place_id text not null,
  run_id uuid references public.place_refresh_runs(id) on delete set null,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_provider_error_at timestamptz,
  last_closure_suspected_at timestamptz,
  last_storage_error_at timestamptz,
  last_error_code text,
  attempt_count bigint not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

create index idx_place_refresh_state_lease
  on public.place_refresh_state (provider, lease_expires_at, last_attempted_at);

comment on table public.place_refresh_state is
  'place 単位の refresh lease と outcome。provider failure / closure suspicion / storage failure を別状態で保持する。';

grant all on public.place_refresh_provider_state to service_role;
grant all on public.place_refresh_runs to service_role;
grant all on public.place_refresh_state to service_role;
revoke all on public.place_refresh_provider_state from public, anon, authenticated;
revoke all on public.place_refresh_runs from public, anon, authenticated;
revoke all on public.place_refresh_state from public, anon, authenticated;

-- ============================================================
-- 5. embedding 再計算の非同期 job 契約（worker 本体は別責務）
-- ============================================================

create table public.place_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  source_version text not null
    check (source_version ~ '^place-facts-v1-[0-9a-f]{32}$'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (place_id, source_version)
);

create index idx_place_embedding_jobs_queue
  on public.place_embedding_jobs (status, available_at, created_at);

comment on table public.place_embedding_jobs is
  'place_facts digest 単位の async re-embed job 契約。#123 は enqueue のみで、AI/live embedding 実行はしない。';

grant all on public.place_embedding_jobs to service_role;
revoke all on public.place_embedding_jobs from public, anon, authenticated;

-- place_facts の semantic fields から opaque source version を作る。
-- last_verified_at は鮮度 metadata なので digest へ含めない。
create or replace function public.mark_place_vector_dirty_for_facts(p_place_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_version text;
  v_updated integer;
begin
  select 'place-facts-v1-' || md5(coalesce(string_agg(
    f.key || ':' || f.value::text || ':' || f.confidence::text || ':' ||
      f.evidence_count::text || ':' || f.conflicting::text,
    '|' order by f.key
  ), ''))
    into v_source_version
    from public.place_facts f
   where f.place_id = p_place_id;

  update public.places
     set vector_dirty = true,
         vector_source_version = v_source_version
   where id = p_place_id
     and vector_source_version is distinct from v_source_version;
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    insert into public.place_embedding_jobs (place_id, source_version)
    values (p_place_id, v_source_version)
    on conflict (place_id, source_version) do nothing;
  end if;
end;
$$;

revoke all on function public.mark_place_vector_dirty_for_facts(uuid)
  from public, anon, authenticated;

-- Statement trigger で複数 fact upsert を一つの最終 digest へ収束させる。
-- last_verified_at だけが変わった UPDATE は affected set に入れない。
create or replace function public.mark_place_vector_dirty_after_fact_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
begin
  for v_place in select distinct place_id from new_rows loop
    perform public.mark_place_vector_dirty_for_facts(v_place);
  end loop;
  return null;
end;
$$;

create or replace function public.mark_place_vector_dirty_after_fact_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
begin
  for v_place in
    select distinct affected.place_id
      from (
        select n.place_id
          from new_rows n
         where not exists (
           select 1
             from old_rows o
            where o.place_id = n.place_id
              and o.key = n.key
         )
            or exists (
           select 1
             from old_rows o
            where o.place_id = n.place_id
              and o.key = n.key
              and (
                n.value is distinct from o.value
                or n.confidence is distinct from o.confidence
                or n.evidence_count is distinct from o.evidence_count
                or n.conflicting is distinct from o.conflicting
              )
         )
        union
        select o.place_id
          from old_rows o
         where not exists (
           select 1
             from new_rows n
            where n.place_id = o.place_id
              and n.key = o.key
         )
      ) affected
  loop
    perform public.mark_place_vector_dirty_for_facts(v_place);
  end loop;
  return null;
end;
$$;

create or replace function public.mark_place_vector_dirty_after_fact_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
begin
  for v_place in select distinct place_id from old_rows loop
    perform public.mark_place_vector_dirty_for_facts(v_place);
  end loop;
  return null;
end;
$$;

revoke all on function public.mark_place_vector_dirty_after_fact_insert()
  from public, anon, authenticated;
revoke all on function public.mark_place_vector_dirty_after_fact_update()
  from public, anon, authenticated;
revoke all on function public.mark_place_vector_dirty_after_fact_delete()
  from public, anon, authenticated;

drop trigger if exists trg_place_facts_vector_dirty_insert on public.place_facts;
create trigger trg_place_facts_vector_dirty_insert
after insert on public.place_facts
referencing new table as new_rows
for each statement
execute function public.mark_place_vector_dirty_after_fact_insert();

drop trigger if exists trg_place_facts_vector_dirty_update on public.place_facts;
create trigger trg_place_facts_vector_dirty_update
after update on public.place_facts
referencing old table as old_rows new table as new_rows
for each statement
execute function public.mark_place_vector_dirty_after_fact_update();

drop trigger if exists trg_place_facts_vector_dirty_delete on public.place_facts;
create trigger trg_place_facts_vector_dirty_delete
after delete on public.place_facts
referencing old table as old_rows
for each statement
execute function public.mark_place_vector_dirty_after_fact_delete();

-- ============================================================
-- 6. service-role RPC: run の idempotent begin
-- ============================================================

create or replace function public.begin_place_refresh_run(p_idempotency_key text)
returns table(
  run_id uuid,
  status text,
  provider text,
  provider_domain text,
  config_version text,
  batch_size integer,
  lease_expires_at timestamptz,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.demand_refresh_config%rowtype;
  v_existing public.place_refresh_runs%rowtype;
  v_last_started timestamptz;
  v_now timestamptz := clock_timestamp();
  v_run_id uuid;
  v_lease_expires_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 1 and 200
     or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then
    raise exception 'invalid place refresh idempotency key' using errcode = '22023';
  end if;

  select * into v_config
    from public.demand_refresh_config
   where id = 1 and enabled;
  if not found then
    raise exception 'demand refresh config unavailable' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:place-refresh-domain:' || v_config.provider_domain, 0)
  );

  select * into v_existing
    from public.place_refresh_runs
   where idempotency_key = p_idempotency_key;
  if found then
    return query
    select v_existing.id,
           case
             when v_existing.status = 'running'
              and v_existing.lease_expires_at <= v_now then 'lease_expired'
             else v_existing.status
           end,
           v_existing.provider,
           v_existing.provider_domain,
           v_existing.config_version,
           v_existing.requested_limit,
           v_existing.lease_expires_at,
           null::integer;
    return;
  end if;

  select last_started_at into v_last_started
    from public.place_refresh_provider_state
   where provider_domain = v_config.provider_domain
   for update;
  if v_last_started is not null
     and v_last_started + v_config.provider_cooldown_seconds * interval '1 second' > v_now then
    return query
    select null::uuid,
           'rate_limited',
           v_config.provider,
           v_config.provider_domain,
           v_config.config_version,
           v_config.batch_size,
           null::timestamptz,
           ceil(extract(epoch from (
             v_last_started + v_config.provider_cooldown_seconds * interval '1 second' - v_now
           )))::integer;
    return;
  end if;

  v_run_id := gen_random_uuid();
  v_lease_expires_at := v_now + v_config.lease_seconds * interval '1 second';
  insert into public.place_refresh_runs (
    id, idempotency_key, provider, provider_domain, config_version,
    status, requested_limit, lease_expires_at
  ) values (
    v_run_id, p_idempotency_key, v_config.provider, v_config.provider_domain,
    v_config.config_version, 'running', v_config.batch_size, v_lease_expires_at
  );

  insert into public.place_refresh_provider_state (provider_domain, last_started_at)
  values (v_config.provider_domain, v_now)
  on conflict (provider_domain) do update set
    last_started_at = excluded.last_started_at,
    updated_at = clock_timestamp();

  return query
  select v_run_id,
         'running',
         v_config.provider,
         v_config.provider_domain,
         v_config.config_version,
         v_config.batch_size,
         v_lease_expires_at,
         null::integer;
end;
$$;

revoke all on function public.begin_place_refresh_run(text)
  from public, anon, authenticated;
grant execute on function public.begin_place_refresh_run(text) to service_role;

-- ============================================================
-- 7. service-role RPC: 決定論的 target 選定 + per-place claim
-- ============================================================

create or replace function public.select_refresh_targets(
  p_limit integer,
  p_run_id uuid default null
)
returns table(
  place_id uuid,
  provider text,
  provider_place_id text,
  source_url text,
  lease_token uuid,
  last_used_at timestamptz,
  last_verified_at timestamptz,
  refreshed_at timestamptz,
  fact_importance real,
  priority_score double precision,
  vector_source_version text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.demand_refresh_config%rowtype;
  v_now timestamptz := clock_timestamp();
  v_selected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'refresh limit must be positive' using errcode = '22023';
  end if;

  select * into v_config
    from public.demand_refresh_config
   where id = 1 and enabled;
  if not found then
    raise exception 'demand refresh config unavailable' using errcode = '55000';
  end if;
  if p_limit > v_config.batch_size then
    raise exception 'refresh limit exceeds configured batch size' using errcode = '22023';
  end if;
  if p_run_id is not null and not exists (
    select 1
      from public.place_refresh_runs r
     where r.id = p_run_id
       and r.status = 'running'
       and r.provider = v_config.provider
       and r.config_version = v_config.config_version
  ) then
    raise exception 'refresh run is not active' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:place-refresh-domain:' || v_config.provider_domain, 0)
  );

  return query
  with eligible_base as materialized (
    select
      p.id,
      p.provider,
      p.provider_place_id,
      p.refreshed_at,
      p.vector_source_version,
      d.last_used_at,
      link.source_url
    from public.place_refresh_demand d
    join public.places p on p.id = d.place_id
    left join public.place_refresh_state s on s.place_id = p.id
    left join lateral (
      select l.source_url
        from public.place_provider_links l
       where l.place_id = p.id
         and l.provider = v_config.provider
       order by l.last_seen_at desc, l.id asc
       limit 1
    ) link on true
    where p.provider = v_config.provider
      and d.last_used_at >= v_now - v_config.recent_usage_window_hours * interval '1 hour'
      and p.refreshed_at <= v_now - v_config.provider_ttl_hours * interval '1 hour'
      and (s.lease_expires_at is null or s.lease_expires_at <= v_now)
      and (
        s.last_attempted_at is null
        or s.last_attempted_at <= v_now - v_config.provider_cooldown_seconds * interval '1 second'
      )
  ),
  eligible as materialized (
    select
      b.id,
      b.provider,
      b.provider_place_id,
      b.refreshed_at,
      b.vector_source_version,
      b.last_used_at,
      min(f.last_verified_at) as oldest_fact_verified_at,
      max(i.importance)::real as fact_importance,
      b.source_url,
      (
        least(
          1::double precision,
          greatest(
            0::double precision,
            1::double precision - extract(epoch from (v_now - b.last_used_at)) /
              (v_config.recent_usage_window_hours * 3600.0)
          )
        ) * v_config.usage_weight
        + least(
          1::double precision,
          greatest(
            0::double precision,
            extract(epoch from (v_now - min(f.last_verified_at))) /
              (v_config.fact_ttl_hours * 3600.0)
          )
        ) * v_config.freshness_weight
        + max(i.importance) * v_config.fact_importance_weight
      )::double precision as priority_score
    from eligible_base b
    join public.place_facts f on f.place_id = b.id
    join public.demand_refresh_fact_importance i
      on i.config_version = v_config.config_version
     and i.key = f.key
    where f.last_verified_at <= v_now - v_config.fact_ttl_hours * interval '1 hour'
    group by
      b.id,
      b.provider,
      b.provider_place_id,
      b.refreshed_at,
      b.vector_source_version,
      b.last_used_at,
      b.source_url
    order by
      priority_score desc,
      b.last_used_at desc,
      min(f.last_verified_at) asc,
      b.id asc
    limit p_limit
  ),
  claimed as (
    insert into public.place_refresh_state (
      place_id, provider, provider_place_id, run_id, lease_token,
      lease_expires_at, last_attempted_at, last_error_code, attempt_count
    )
    select
      e.id,
      e.provider,
      e.provider_place_id,
      p_run_id,
      gen_random_uuid(),
      v_now + v_config.lease_seconds * interval '1 second',
      v_now,
      null,
      1
    from eligible e
    on conflict on constraint place_refresh_state_pkey do update set
      provider = excluded.provider,
      provider_place_id = excluded.provider_place_id,
      run_id = excluded.run_id,
      lease_token = excluded.lease_token,
      lease_expires_at = excluded.lease_expires_at,
      last_attempted_at = excluded.last_attempted_at,
      last_error_code = null,
      attempt_count = public.place_refresh_state.attempt_count + 1,
      updated_at = clock_timestamp()
    returning place_refresh_state.place_id, place_refresh_state.lease_token
  )
  select
    e.id,
    e.provider,
    e.provider_place_id,
    e.source_url,
    c.lease_token,
    e.last_used_at,
    e.oldest_fact_verified_at,
    e.refreshed_at,
    e.fact_importance,
    e.priority_score,
    e.vector_source_version
  from eligible e
  join claimed c on c.place_id = e.id
  order by
    e.priority_score desc,
    e.last_used_at desc,
    e.oldest_fact_verified_at asc,
    e.id asc;
  get diagnostics v_selected = row_count;

  if p_run_id is not null and v_selected > 0 then
    update public.place_refresh_runs
       set selected_count = selected_count + v_selected,
           updated_at = v_now
     where id = p_run_id
       and status = 'running';
  end if;
end;
$$;

revoke all on function public.select_refresh_targets(integer, uuid)
  from public, anon, authenticated;
grant execute on function public.select_refresh_targets(integer, uuid) to service_role;

-- ============================================================
-- 8. service-role RPC: per-target outcome と run metrics
-- ============================================================

create or replace function public.record_place_refresh_target(
  p_run_id uuid,
  p_place_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_fact_changed boolean default false,
  p_observed_at timestamptz default null,
  p_error_code text default null,
  p_evidence_appended boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_observed_at timestamptz := coalesce(p_observed_at, v_now);
  v_updated integer;
  v_error_code text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in (
    'unchanged', 'changed', 'provider_error', 'closure_suspected', 'storage_error'
  ) then
    raise exception 'invalid place refresh outcome' using errcode = '22023';
  end if;
  if p_run_id is null or p_place_id is null or p_lease_token is null then
    raise exception 'invalid place refresh lease' using errcode = '22023';
  end if;
  if p_error_code is not null
     and p_error_code !~ '^[a-z0-9][a-z0-9_:-]{0,79}$' then
    raise exception 'invalid place refresh error code' using errcode = '22023';
  end if;
  v_error_code := nullif(p_error_code, '');

  update public.place_refresh_state
     set last_succeeded_at = case
           when p_outcome in ('unchanged', 'changed') then v_observed_at
           else last_succeeded_at
         end,
         last_provider_error_at = case
           when p_outcome = 'provider_error' then v_now
           else last_provider_error_at
         end,
         last_closure_suspected_at = case
           when p_outcome = 'closure_suspected' then v_now
           else last_closure_suspected_at
         end,
         last_storage_error_at = case
           when p_outcome = 'storage_error' then v_now
           else last_storage_error_at
         end,
         last_error_code = v_error_code,
         lease_token = null,
         lease_expires_at = null,
         updated_at = v_now
   where place_id = p_place_id
     and run_id = p_run_id
     and lease_token = p_lease_token
     and lease_expires_at > v_now;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return false;
  end if;

  update public.place_refresh_runs
     set processed_count = processed_count + 1,
         evidence_appended_count = evidence_appended_count +
           case when p_evidence_appended then 1 else 0 end,
         unchanged_count = unchanged_count + case when p_outcome = 'unchanged' then 1 else 0 end,
         changed_count = changed_count + case when p_outcome = 'changed' or p_fact_changed then 1 else 0 end,
         provider_error_count = provider_error_count + case when p_outcome = 'provider_error' then 1 else 0 end,
         closure_suspected_count = closure_suspected_count + case when p_outcome = 'closure_suspected' then 1 else 0 end,
         storage_error_count = storage_error_count + case when p_outcome = 'storage_error' then 1 else 0 end,
         last_error_code = case when v_error_code is not null then v_error_code else last_error_code end,
         updated_at = v_now
   where id = p_run_id
     and status = 'running';
  return true;
end;
$$;

revoke all on function public.record_place_refresh_target(
  uuid, uuid, uuid, text, boolean, timestamptz, text, boolean
) from public, anon, authenticated;
grant execute on function public.record_place_refresh_target(
  uuid, uuid, uuid, text, boolean, timestamptz, text, boolean
) to service_role;

create or replace function public.record_place_refresh_provider_call(
  p_run_id uuid,
  p_item_count integer,
  p_duration_ms bigint,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_run_id is null
     or p_item_count is null or p_item_count < 0
     or p_duration_ms is null or p_duration_ms < 0
     or p_outcome is null or p_outcome not in ('ok', 'error') then
    raise exception 'invalid provider call metric' using errcode = '22023';
  end if;

  update public.place_refresh_runs
     set provider_call_count = provider_call_count + 1,
         provider_item_count = provider_item_count + p_item_count,
         provider_duration_ms = provider_duration_ms + p_duration_ms,
         updated_at = clock_timestamp()
   where id = p_run_id
     and status = 'running';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.record_place_refresh_provider_call(
  uuid, integer, bigint, text
) from public, anon, authenticated;
grant execute on function public.record_place_refresh_provider_call(
  uuid, integer, bigint, text
) to service_role;

create or replace function public.finish_place_refresh_run(
  p_run_id uuid,
  p_status text,
  p_selected_count integer,
  p_skipped_count integer default 0,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('complete', 'partial', 'failed')
     or p_run_id is null
     or p_selected_count is null or p_selected_count < 0
     or p_skipped_count is null or p_skipped_count < 0 then
    raise exception 'invalid place refresh run finish' using errcode = '22023';
  end if;
  if p_error_code is not null
     and p_error_code !~ '^[a-z0-9][a-z0-9_:-]{0,79}$' then
    raise exception 'invalid place refresh error code' using errcode = '22023';
  end if;

  update public.place_refresh_runs
     set status = p_status,
         selected_count = greatest(selected_count, p_selected_count),
         skipped_count = p_skipped_count,
         last_error_code = coalesce(nullif(p_error_code, ''), last_error_code),
         finished_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = p_run_id
     and status = 'running';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.finish_place_refresh_run(uuid, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.finish_place_refresh_run(uuid, text, integer, integer, text)
  to service_role;

-- 設定 table / importance table も service-role のみ。config が無ければ RPC は
-- begin/select ともに停止し、外部 provider を一度も呼ばない。
grant all on public.demand_refresh_config to service_role;
grant all on public.demand_refresh_fact_importance to service_role;
revoke all on public.demand_refresh_config from public, anon, authenticated;
revoke all on public.demand_refresh_fact_importance from public, anon, authenticated;
