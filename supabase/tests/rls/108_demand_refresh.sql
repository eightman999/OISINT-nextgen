-- 108_demand_refresh.sql — #123 demand-driven refresh boundary
--
-- migration適用後の scratch DB でのみ実行する SQL fixture。外部 provider、cron、
-- crawler/queue、embedding worker は呼ばず、service-role/RPC/trigger の契約を検査する。
begin;

insert into auth.users (id, is_anonymous)
values ('00000000-0000-0000-0000-000000001042', false);

insert into public.investigations (id, created_by, title, raw_query)
values (
  '00000000-0000-0000-0000-000000001041',
  '00000000-0000-0000-0000-000000001042',
  'refresh fixture',
  'refresh fixture'
);

insert into public.places (
  id, provider, provider_place_id, name, refreshed_at
)
values (
  '00000000-0000-0000-0000-000000001043',
  'fixture',
  'refresh-place-1043',
  'Refresh fixture place',
  clock_timestamp() - interval '2 days'
);

insert into public.place_provider_links (
  place_id, provider, provider_place_id, source_url
)
values (
  '00000000-0000-0000-0000-000000001043',
  'fixture',
  'refresh-place-1043',
  'https://fixture.example/places/1043'
);

insert into public.demand_refresh_config (
  id, config_version, provider, provider_domain,
  provider_ttl_hours, fact_ttl_hours, recent_usage_window_hours,
  batch_size, lease_seconds, provider_cooldown_seconds,
  usage_weight, freshness_weight, fact_importance_weight, enabled
)
values (
  1, 'fixture-108-v1', 'fixture', 'fixture.example',
  24, 48, 168, 2, 60, 30,
  1, 2, 3, true
);

insert into public.demand_refresh_fact_importance
  (config_version, key, importance)
values ('fixture-108-v1', 'capacity', 1);

insert into public.candidates (id, investigation_id, place_id)
values (
  '00000000-0000-0000-0000-000000001044',
  '00000000-0000-0000-0000-000000001041',
  '00000000-0000-0000-0000-000000001043'
);

insert into public.place_facts (
  place_id, key, value, confidence, evidence_count, conflicting, last_verified_at
)
values (
  '00000000-0000-0000-0000-000000001043',
  'capacity', '36'::jsonb, 0.85, 1, false,
  clock_timestamp() - interval '3 days'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
declare
  v_demand record;
begin
  select * into v_demand
    from public.place_refresh_demand
   where place_id = '00000000-0000-0000-0000-000000001043';
  if v_demand.use_count <> 1 then
    raise exception 'FAIL(108/demand): candidate usage was not aggregated';
  end if;
end;
$$;

-- 既存 fact の digest/job を基準化し、last_verified_at の更新だけでは dirty/job
-- が増えず、意味値変更時だけ version/job が進むことを確認する。
update public.places
   set vector_dirty = false
 where id = '00000000-0000-0000-0000-000000001043';

do $$
declare
  v_version text;
  v_jobs bigint;
begin
  select vector_source_version into v_version
    from public.places
   where id = '00000000-0000-0000-0000-000000001043';
  select count(*) into v_jobs
    from public.place_embedding_jobs
   where place_id = '00000000-0000-0000-0000-000000001043';

  update public.place_facts
     set last_verified_at = clock_timestamp()
   where place_id = '00000000-0000-0000-0000-000000001043'
     and key = 'capacity';
  if (select vector_dirty from public.places
       where id = '00000000-0000-0000-0000-000000001043') then
    raise exception 'FAIL(108/timestamp): freshness metadata marked vector dirty';
  end if;
  if (select count(*) from public.place_embedding_jobs
       where place_id = '00000000-0000-0000-0000-000000001043') <> v_jobs then
    raise exception 'FAIL(108/timestamp): freshness metadata enqueued a job';
  end if;

  update public.place_facts
     set value = '40'::jsonb
   where place_id = '00000000-0000-0000-0000-000000001043'
     and key = 'capacity';
  if not (select vector_dirty from public.places
           where id = '00000000-0000-0000-0000-000000001043') then
    raise exception 'FAIL(108/semantic): fact change did not mark vector dirty';
  end if;
  if (select vector_source_version from public.places
       where id = '00000000-0000-0000-0000-000000001043') = v_version then
    raise exception 'FAIL(108/semantic): fact change did not advance source version';
  end if;
  if (select count(*) from public.place_embedding_jobs
       where place_id = '00000000-0000-0000-0000-000000001043') <= v_jobs then
    raise exception 'FAIL(108/semantic): fact change did not enqueue a job';
  end if;
end;
$$;

-- selector の stale fixture を再構成する。last_verified_at は dirty 判定の対象外
-- なので、この更新自体は vector version/job を変えない。
update public.place_facts
   set last_verified_at = clock_timestamp() - interval '3 days'
 where place_id = '00000000-0000-0000-0000-000000001043'
   and key = 'capacity';

-- client role は service-only table/RPC に到達できない。
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
do $$
begin
  if has_table_privilege(
    'authenticated', 'public.place_refresh_runs', 'SELECT'
  ) then
    raise exception 'FAIL(108/rls): authenticated can read refresh runs';
  end if;
  if has_function_privilege(
    'authenticated', 'public.select_refresh_targets(integer,uuid)', 'EXECUTE'
  ) then
    raise exception 'FAIL(108/rls): authenticated can execute selector';
  end if;
end;
$$;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

insert into public.place_refresh_runs (
  id, idempotency_key, provider, provider_domain, config_version,
  status, requested_limit, lease_expires_at
)
values (
  '00000000-0000-4000-8000-000000001045',
  'fixture-108-run', 'fixture', 'fixture.example', 'fixture-108-v1',
  'running', 2, clock_timestamp() + interval '60 seconds'
);

do $$
declare
  v_target record;
begin
  select * into v_target
    from public.select_refresh_targets(
      1, '00000000-0000-4000-8000-000000001045'
    );
  if v_target.place_id <> '00000000-0000-0000-0000-000000001043' then
    raise exception 'FAIL(108/select): unexpected target %', v_target.place_id;
  end if;
  if not public.record_place_refresh_provider_call(
    '00000000-0000-4000-8000-000000001045', 1, 5, 'ok'
  ) then
    raise exception 'FAIL(108/metric): provider call was not recorded';
  end if;
  if not public.record_place_refresh_target(
    '00000000-0000-4000-8000-000000001045',
    v_target.place_id,
    v_target.lease_token,
    'unchanged', false, clock_timestamp(), null, false
  ) then
    raise exception 'FAIL(108/outcome): target outcome was not recorded';
  end if;
end;
$$;

select public.finish_place_refresh_run(
  '00000000-0000-4000-8000-000000001045', 'complete', 1, 0, null
);

do $$
begin
  if not exists (
    select 1 from public.place_refresh_runs
     where id = '00000000-0000-4000-8000-000000001045'
       and status = 'complete'
       and selected_count = 1
       and processed_count = 1
       and unchanged_count = 1
       and provider_call_count = 1
       and provider_item_count = 1
       and provider_duration_ms = 5
  ) then
    raise exception 'FAIL(108/metrics): run metrics are incomplete';
  end if;
end;
$$;

rollback;
