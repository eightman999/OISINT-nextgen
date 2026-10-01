-- 107_private_analytics.sql — #155 の集計・境界・削除保持テスト
--
-- 既存の investigations / members / sanitized events だけをfixtureに使う。
-- 実行時は scripts/test-rls.sh の専用scratch DBに限定する。

create extension if not exists dblink;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-00000000104a', false),
  ('00000000-0000-4000-8000-00000000104b', false),
  ('00000000-0000-4000-8000-00000000104c', false),
  ('00000000-0000-4000-8000-00000000104d', false),
  ('00000000-0000-4000-8000-00000000104e', false),
  ('00000000-0000-4000-8000-00000000105a', true);

insert into public.admin_allowlist (user_id, role)
values ('00000000-0000-4000-8000-00000000104a', 'auditor');

insert into public.investigations (
  id, created_by, title, raw_query, status, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000001041', '00000000-0000-4000-8000-00000000104a', 'fixture', 'fixture', 'complete', '2025-01-30 00:00:00+00', '2025-01-30 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001042', '00000000-0000-4000-8000-00000000104b', 'fixture', 'fixture', 'failed', '2025-01-28 00:00:00+00', '2025-01-28 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001043', '00000000-0000-4000-8000-00000000104c', 'fixture', 'fixture', 'complete', '2025-01-29 00:00:00+00', '2025-01-29 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001044', '00000000-0000-4000-8000-00000000104a', 'fixture', 'fixture', 'complete', '2025-01-10 00:00:00+00', '2025-01-10 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001045', '00000000-0000-4000-8000-00000000104e', 'fixture', 'fixture', 'draft', '2024-12-01 00:00:00+00', '2024-12-01 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001046', '00000000-0000-4000-8000-00000000104a', 'fixture', 'fixture', 'draft', now(), now());

insert into public.investigation_members (investigation_id, user_id, role, joined_at)
values
  ('00000000-0000-4000-8000-000000001041', '00000000-0000-4000-8000-00000000104a', 'owner', '2025-01-30 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001041', '00000000-0000-4000-8000-00000000104d', 'editor', '2025-01-30 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001042', '00000000-0000-4000-8000-00000000104b', 'owner', '2025-01-28 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001043', '00000000-0000-4000-8000-00000000104c', 'owner', '2025-01-29 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001044', '00000000-0000-4000-8000-00000000104a', 'owner', '2025-01-10 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001044', '00000000-0000-4000-8000-00000000104d', 'editor', '2025-01-10 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001045', '00000000-0000-4000-8000-00000000104e', 'owner', '2024-12-01 00:00:00+00'),
  ('00000000-0000-4000-8000-000000001046', '00000000-0000-4000-8000-00000000104a', 'owner', now());

insert into public.investigation_events (id, investigation_id, event_type, message, metadata, created_at)
values
  ('00000000-0000-4000-8000-000000001047', '00000000-0000-4000-8000-000000001041', 'step_started', null, '{"step":"complete"}', '2025-01-30 01:00:00+00'),
  ('00000000-0000-4000-8000-000000001048', '00000000-0000-4000-8000-000000001041', 'search_completed', null, '{"count":1}', '2025-01-30 01:00:00+00'),
  ('00000000-0000-4000-8000-000000001049', '00000000-0000-4000-8000-000000001042', 'investigation_failed', null, '{"step":"searching","code":"no_candidates"}', '2025-01-28 01:00:00+00'),
  ('00000000-0000-4000-8000-00000000104f', '00000000-0000-4000-8000-000000001043', 'step_started', null, '{"step":"complete"}', '2025-01-29 01:00:00+00'),
  ('00000000-0000-4000-8000-000000001050', '00000000-0000-4000-8000-000000001043', 'search_completed', null, '{"count":1}', '2025-01-29 01:00:00+00'),
  ('00000000-0000-4000-8000-000000001051', '00000000-0000-4000-8000-000000001044', 'step_started', null, '{"step":"complete"}', '2025-01-10 01:00:00+00'),
  ('00000000-0000-4000-8000-000000001052', '00000000-0000-4000-8000-000000001044', 'search_completed', null, '{"count":1}', '2025-01-10 01:00:00+00'),
  ('00000000-0000-4000-8000-000000001053', '00000000-0000-4000-8000-000000001046', 'progress', null, '{}', now() - interval '31 days'),
  ('00000000-0000-4000-8000-000000001054', '00000000-0000-4000-8000-000000001046', 'progress', null, '{}', now() - interval '29 days'),
  ('00000000-0000-4000-8000-000000001055', '00000000-0000-4000-8000-000000001046', 'progress', null, '{}', null);

insert into public.private_analytics_opt_outs (user_id)
values
  ('00000000-0000-4000-8000-00000000104c'),
  ('00000000-0000-4000-8000-00000000104e');

begin;
set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104a","role":"service_role","is_anonymous":false}';

do $$
declare
  v_result jsonb;
  v_day jsonb;
  v_week jsonb;
  v_month jsonb;
  v_empty_day jsonb;
begin
  v_result := public.refresh_private_analytics('2025-01-31 00:00:00+00');
  v_day := v_result -> 'windows' -> 0;
  v_week := v_result -> 'windows' -> 1;
  v_month := v_result -> 'windows' -> 2;

  if v_result ->> 'schema' <> 'oisint.private_analytics.v1'
     or jsonb_array_length(v_result -> 'windows') <> 3 then
    raise exception 'FAIL(107/a): unexpected analytics envelope';
  end if;
  if v_day ->> 'days' <> '1'
     or (v_day ->> 'active_users')::bigint <> 2
     or (v_day ->> 'investigations_created')::bigint <> 1
     or (v_day ->> 'investigations_completed')::bigint <> 1
     or (v_day ->> 'investigations_failed')::bigint <> 0
     or (v_day ->> 'shared_joins')::bigint <> 1
     or (v_day ->> 'search_successes')::bigint <> 1
     or (v_day ->> 'search_failures')::bigint <> 0
     or (v_day ->> 'search_success_rate')::numeric <> 1
     or v_day -> 'coverage' ->> 'search' <> 'measured' then
    raise exception 'FAIL(107/a): one-day metrics mismatch: %', v_day;
  end if;
  if v_week ->> 'days' <> '7'
     or (v_week ->> 'active_users')::bigint <> 3
     or (v_week ->> 'investigations_created')::bigint <> 2
     or (v_week ->> 'investigations_completed')::bigint <> 1
     or (v_week ->> 'investigations_failed')::bigint <> 1
     or (v_week ->> 'shared_joins')::bigint <> 1
     or (v_week ->> 'search_successes')::bigint <> 1
     or (v_week ->> 'search_failures')::bigint <> 1
     or (v_week ->> 'search_success_rate')::numeric <> 0.5
     or v_week -> 'coverage' ->> 'search' <> 'measured' then
    raise exception 'FAIL(107/a): seven-day metrics mismatch: %', v_week;
  end if;
  if v_month ->> 'days' <> '30'
     or (v_month ->> 'active_users')::bigint <> 3
     or (v_month ->> 'investigations_created')::bigint <> 3
     or (v_month ->> 'investigations_completed')::bigint <> 2
     or (v_month ->> 'investigations_failed')::bigint <> 1
     or (v_month ->> 'shared_joins')::bigint <> 2
     or (v_month ->> 'search_successes')::bigint <> 2
     or (v_month ->> 'search_failures')::bigint <> 1
     or (v_month ->> 'search_success_rate')::numeric <> 0.666666667 then
    raise exception 'FAIL(107/a): thirty-day metrics mismatch: %', v_month;
  end if;
  if v_result::text ~* '(raw_query|display_name|latitude|longitude|oauth|token|user_id|investigation_id)' then
    raise exception 'FAIL(107/a): unsafe field appeared in aggregate JSON';
  end if;

  v_empty_day := public.refresh_private_analytics('2025-02-28 00:00:00+00') -> 'windows' -> 0;
  if (v_empty_day ->> 'search_success_rate') is not null
     or v_empty_day -> 'coverage' ->> 'search' <> 'not_measured' then
    raise exception 'FAIL(107/a2): missing search sample was not marked not_measured';
  end if;

  -- The omitted-boundary overload must take its timestamp after its locks.
  v_result := public.refresh_private_analytics();
  if (v_result -> 'windows' -> 0 ->> 'window_end')::timestamptz
       < pg_catalog.date_trunc('day', clock_timestamp(), 'UTC')
     or (v_result -> 'windows' -> 0 ->> 'window_end')::timestamptz
       > clock_timestamp() then
    raise exception 'FAIL(107/a2b): no-argument refresh returned a stale or future boundary';
  end if;

  begin
    perform public.refresh_private_analytics(clock_timestamp() + interval '1 second');
    raise exception 'FAIL(107/a3): future analytics boundary was accepted';
  exception
    when invalid_parameter_value then null;
  end;
  begin
    perform public.refresh_private_analytics(null);
    raise exception 'FAIL(107/a4): explicit NULL analytics boundary was accepted';
  exception
    when invalid_parameter_value then null;
  end;
end $$;

do $$
begin
  if has_table_privilege('authenticated', 'public.private_analytics_snapshots', 'select')
     or has_table_privilege('authenticated', 'public.private_analytics_opt_outs', 'select') then
    raise exception 'FAIL(107/b): authenticated has direct aggregate/settings privilege';
  end if;
  if not has_table_privilege('service_role', 'public.private_analytics_snapshots', 'select') then
    raise exception 'FAIL(107/b): service_role cannot read snapshot table';
  end if;
end $$;

rollback;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000105a","role":"authenticated","is_anonymous":true}';

do $$
begin
  begin
    perform public.get_private_analytics_opt_out();
    raise exception 'FAIL(107/d2): anonymous user read opt-out setting';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.set_private_analytics_opt_out(true);
    raise exception 'FAIL(107/d2): anonymous user changed opt-out setting';
  exception
    when insufficient_privilege then null;
  end;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104b","role":"authenticated","is_anonymous":false}';

do $$
begin
  begin
    perform public.get_private_analytics();
    raise exception 'FAIL(107/c): ordinary user read analytics RPC';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.refresh_private_analytics('2025-01-31 00:00:00+00');
    raise exception 'FAIL(107/c2): ordinary user refreshed analytics RPC';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform (select count(*) from public.private_analytics_snapshots);
    raise exception 'FAIL(107/c): ordinary user read snapshot table';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform (select count(*) from public.private_analytics_opt_outs);
    raise exception 'FAIL(107/c): ordinary user read opt-out table';
  exception
    when insufficient_privilege then null;
  end;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104b","role":"service_role","is_anonymous":false}';

do $$
begin
  begin
    perform public.get_private_analytics();
    raise exception 'FAIL(107/d): forged service role claim read analytics';
  exception
    when insufficient_privilege then null;
  end;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104a","role":"authenticated","is_anonymous":false}';

do $$
declare
  v_result jsonb;
  v_cached jsonb;
  v_utc_day_start timestamptz := pg_catalog.date_trunc('day', clock_timestamp(), 'UTC');
begin
  -- A complete historical snapshot must not survive into another UTC day.
  perform public.refresh_private_analytics('2025-01-31 00:00:00+00');
  v_result := public.get_private_analytics();
  if jsonb_array_length(v_result -> 'windows') <> 3
     or v_result::text ~* '(raw_query|display_name|latitude|longitude|oauth|token|user_id|investigation_id)' then
    raise exception 'FAIL(107/e): admin RPC envelope is not aggregate-only';
  end if;
  if (v_result -> 'windows' -> 0 ->> 'window_end')::timestamptz < v_utc_day_start
     or (v_result -> 'windows' -> 0 ->> 'window_end')::timestamptz > clock_timestamp() then
    raise exception 'FAIL(107/e2): get RPC returned a stale or future snapshot';
  end if;

  v_cached := public.get_private_analytics();
  if v_cached ->> 'computed_at' is distinct from v_result ->> 'computed_at' then
    raise exception 'FAIL(107/e3): same-day complete snapshot was not reused';
  end if;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104b","role":"authenticated","is_anonymous":false}';

do $$
begin
  if not public.set_private_analytics_opt_out(true)
     or not public.get_private_analytics_opt_out() then
    raise exception 'FAIL(107/f): own opt-out setting was not applied';
  end if;
end $$;
commit;

begin;
set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104a","role":"service_role","is_anonymous":false}';

do $$
declare
  v_week jsonb;
begin
  v_week := public.refresh_private_analytics('2025-01-31 00:00:00+00') -> 'windows' -> 1;
  if (v_week ->> 'active_users')::bigint <> 2
     or (v_week ->> 'investigations_created')::bigint <> 1
     or (v_week ->> 'search_successes')::bigint <> 1
     or (v_week ->> 'search_failures')::bigint <> 0
     or (v_week ->> 'search_success_rate')::numeric <> 1 then
    raise exception 'FAIL(107/f): opted-out user was included: %', v_week;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104b","role":"authenticated","is_anonymous":false}';

do $$
begin
  if public.set_private_analytics_opt_out(true) is distinct from true then
    raise exception 'FAIL(107/g): repeated opt-out was not idempotent';
  end if;
  if public.set_private_analytics_opt_out(false) is distinct from false
     or public.get_private_analytics_opt_out() then
    raise exception 'FAIL(107/g): own opt-out setting was not restored';
  end if;
end $$;

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104a","role":"service_role","is_anonymous":false}';

do $$
declare
  v_week jsonb;
begin
  v_week := public.refresh_private_analytics('2025-01-31 00:00:00+00') -> 'windows' -> 1;
  if (v_week ->> 'active_users')::bigint <> 3
     or (v_week ->> 'investigations_created')::bigint <> 2 then
    raise exception 'FAIL(107/g): opt-out restore mismatch: %', v_week;
  end if;
end $$;

do $$
begin
  if (select count(*) from public.private_analytics_snapshots) <> 3 then
    raise exception 'FAIL(107/h): expected three snapshots before purge';
  end if;
end $$;

select public.delete_user_account_data('00000000-0000-4000-8000-00000000104e');

do $$
begin
  if exists (select 1 from public.private_analytics_snapshots) then
    raise exception 'FAIL(107/h): account purge left a stale snapshot';
  end if;
  if not exists (select 1 from public.private_analytics_opt_outs
                 where user_id = '00000000-0000-4000-8000-00000000104e') then
    raise exception 'FAIL(107/h): purge removed opt-out before Auth deletion';
  end if;
end $$;

set local role postgres;
delete from auth.users
 where id = '00000000-0000-4000-8000-00000000104e';

do $$
begin
  if exists (select 1 from public.private_analytics_opt_outs
             where user_id = '00000000-0000-4000-8000-00000000104e') then
    raise exception 'FAIL(107/i): Auth cascade left opt-out row';
  end if;
end $$;

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000104a","role":"service_role","is_anonymous":false}';
select public.run_data_retention();

do $$
begin
  if exists (select 1 from public.investigation_events
             where id = '00000000-0000-4000-8000-000000001053') then
    raise exception 'FAIL(107/j): event older than 30 days was retained';
  end if;
  if exists (select 1 from public.investigation_events
             where id = '00000000-0000-4000-8000-000000001055') then
    raise exception 'FAIL(107/j): event with null created_at was retained forever';
  end if;
  if not exists (select 1 from public.investigation_events
                 where id = '00000000-0000-4000-8000-000000001054') then
    raise exception 'FAIL(107/j): event inside 30-day retention was deleted';
  end if;
end $$;

rollback;

-- Refresh and source invalidation must share one transaction lock.  First,
-- refresh commits before a waiting mutation; that mutation must remove every
-- just-computed row instead of leaving a stale snapshot behind.
select dblink_connect(
  'analytics_107_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'analytics_107_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('analytics_107_a', 'set role service_role');
select dblink_exec('analytics_107_b', 'set role service_role');
select dblink_exec('analytics_107_a', $$set statement_timeout = '10s'$$);
select dblink_exec('analytics_107_b', $$set statement_timeout = '10s'$$);
create temporary table analytics_107_connection_pids (
  connection_name text primary key,
  backend_pid integer not null
);
insert into analytics_107_connection_pids (connection_name, backend_pid)
select 'analytics_107_a', remote.backend_pid
  from dblink('analytics_107_a', 'select pg_backend_pid()') as remote(backend_pid integer)
union all
select 'analytics_107_b', remote.backend_pid
  from dblink('analytics_107_b', 'select pg_backend_pid()') as remote(backend_pid integer);
select dblink_exec('analytics_107_a', 'begin');
select dblink_exec('analytics_107_b', 'begin');
select dblink_exec(
  'analytics_107_a',
  $$do $proc$ begin
      perform public.refresh_private_analytics('2025-01-31 00:00:00+00');
    end $proc$;$$
);
do $$
declare
  v_dispatched integer;
begin
  v_dispatched := dblink_send_query(
    'analytics_107_b',
    $remote$do $proc$ begin
        insert into public.investigation_events
          (id, investigation_id, event_type, metadata, created_at)
        values (
          '00000000-0000-4000-8000-000000001056',
          '00000000-0000-4000-8000-000000001046',
          'progress', '{}', '2025-01-30 02:00:00+00'
        );
      end $proc$;$remote$
  );
  if v_dispatched <> 1 then
    raise exception 'FAIL(107/k): invalidation query was not dispatched';
  end if;
end $$;
do $$
declare
  v_pid integer;
  v_waiting boolean := false;
begin
  select backend_pid into strict v_pid
    from analytics_107_connection_pids
   where connection_name = 'analytics_107_b';
  for attempt in 1..200 loop
    select exists (
      select 1
        from pg_catalog.pg_stat_activity
       where pid = v_pid
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'
    ) into v_waiting;
    exit when v_waiting;
    perform pg_sleep(0.01);
  end loop;
  if not v_waiting or dblink_is_busy('analytics_107_b') <> 1 then
    raise exception 'FAIL(107/k): invalidation did not wait on the refresh advisory lock';
  end if;
end $$;
select dblink_exec('analytics_107_a', 'commit');
do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('analytics_107_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('analytics_107_b') <> 0 then
    raise exception 'FAIL(107/k): waiting invalidation did not finish';
  end if;
end $$;
select count(*) from dblink_get_result('analytics_107_b', true)
  as result(message text);
select count(*) from dblink_get_result('analytics_107_b', true)
  as result(message text);
select dblink_exec('analytics_107_b', 'commit');
do $$
begin
  if exists (select 1 from public.private_analytics_snapshots) then
    raise exception 'FAIL(107/k): mutation-after-refresh left stale snapshots';
  end if;
end $$;

-- Reverse the order: a refresh dispatched behind an uncommitted mutation must
-- wait, then publish all three rows after the mutation commits.
select dblink_exec('analytics_107_a', 'begin');
select dblink_exec('analytics_107_b', 'begin');
select dblink_exec(
  'analytics_107_a',
  $$do $proc$ begin
      insert into public.investigation_events
        (id, investigation_id, event_type, metadata, created_at)
      values (
        '00000000-0000-4000-8000-000000001057',
        '00000000-0000-4000-8000-000000001046',
        'search_completed', '{"count":1}', '2025-01-30 03:00:00+00'
      );
    end $proc$;$$
);
do $$
declare
  v_dispatched integer;
begin
  v_dispatched := dblink_send_query(
    'analytics_107_b',
    $remote$do $proc$ begin
        perform public.refresh_private_analytics('2025-01-31 00:00:00+00');
      end $proc$;$remote$
  );
  if v_dispatched <> 1 then
    raise exception 'FAIL(107/k2): refresh query was not dispatched';
  end if;
end $$;
do $$
declare
  v_pid integer;
  v_waiting boolean := false;
begin
  select backend_pid into strict v_pid
    from analytics_107_connection_pids
   where connection_name = 'analytics_107_b';
  for attempt in 1..200 loop
    select exists (
      select 1
        from pg_catalog.pg_stat_activity
       where pid = v_pid
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'
    ) into v_waiting;
    exit when v_waiting;
    perform pg_sleep(0.01);
  end loop;
  if not v_waiting or dblink_is_busy('analytics_107_b') <> 1 then
    raise exception 'FAIL(107/k2): refresh did not wait on the invalidation advisory lock';
  end if;
end $$;
select dblink_exec('analytics_107_a', 'commit');
do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('analytics_107_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('analytics_107_b') <> 0 then
    raise exception 'FAIL(107/k2): waiting refresh did not finish';
  end if;
end $$;
select count(*) from dblink_get_result('analytics_107_b', true)
  as result(message text);
select count(*) from dblink_get_result('analytics_107_b', true)
  as result(message text);
select dblink_exec('analytics_107_b', 'commit');
do $$
begin
  if (select count(*) from public.private_analytics_snapshots) <> 3 then
    raise exception 'FAIL(107/k2): mutation-before-refresh did not publish fresh snapshots';
  end if;
  if (select search_success_count
        from public.private_analytics_snapshots
       where window_days = 7) <> 2 then
    raise exception 'FAIL(107/k2): refresh did not include the committed search event';
  end if;
end $$;

-- A read dispatched behind an uncommitted source mutation must wait for that
-- mutation, refresh the invalidated snapshot, and return the committed metric.
select dblink_exec('analytics_107_a', 'begin');
select dblink_exec('analytics_107_b', 'begin');
select dblink_exec(
  'analytics_107_a',
  $$do $proc$ begin
      insert into public.investigation_events
        (id, investigation_id, event_type, metadata, created_at)
      values (
        '00000000-0000-4000-8000-000000001058',
        '00000000-0000-4000-8000-000000001046',
        'search_completed', '{"count":1}', clock_timestamp()
      );
    end $proc$;$$
);
do $$
declare
  v_dispatched integer;
begin
  v_dispatched := dblink_send_query(
    'analytics_107_b',
    'select public.get_private_analytics()::text as payload'
  );
  if v_dispatched <> 1 then
    raise exception 'FAIL(107/k3): reader query was not dispatched';
  end if;
end $$;
do $$
declare
  v_pid integer;
  v_waiting boolean := false;
begin
  select backend_pid into strict v_pid
    from analytics_107_connection_pids
   where connection_name = 'analytics_107_b';
  for attempt in 1..200 loop
    select exists (
      select 1
        from pg_catalog.pg_stat_activity
       where pid = v_pid
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'
    ) into v_waiting;
    exit when v_waiting;
    perform pg_sleep(0.01);
  end loop;
  if not v_waiting or dblink_is_busy('analytics_107_b') <> 1 then
    raise exception 'FAIL(107/k3): reader did not wait on the mutation advisory lock';
  end if;
end $$;
select dblink_exec('analytics_107_a', 'commit');
do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('analytics_107_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('analytics_107_b') <> 0 then
    raise exception 'FAIL(107/k3): waiting reader did not finish';
  end if;
end $$;
create temporary table analytics_107_reader_result (payload text not null);
insert into analytics_107_reader_result (payload)
select payload from dblink_get_result('analytics_107_b', true)
  as result(payload text);
select count(*) from dblink_get_result('analytics_107_b', true)
  as result(payload text);
select dblink_exec('analytics_107_b', 'commit');
do $$
declare
  v_result jsonb;
begin
  select payload::jsonb into strict v_result
    from analytics_107_reader_result;
  if (v_result -> 'windows' -> 1 ->> 'search_successes')::bigint <> 1 then
    raise exception 'FAIL(107/k3): reader returned a snapshot before the committed mutation';
  end if;
  if (v_result -> 'windows' -> 0 ->> 'window_end')::timestamptz
       < pg_catalog.date_trunc('day', clock_timestamp(), 'UTC') then
    raise exception 'FAIL(107/k3): reader returned an expired UTC-day snapshot';
  end if;
end $$;

-- TRUNCATE takes AccessExclusive on the source relation before its statement
-- trigger asks for the analytics advisory lock.  Hold that relation lock in
-- one dblink transaction while another refresh is dispatched.  The refresh
-- must wait on the relation lock before acquiring the advisory lock; otherwise
-- the old advisory-to-source order and TRUNCATE's source-to-advisory order can
-- deadlock.  Every remote result below uses fail_on_error=true so any timeout,
-- deadlock, or remote ERROR fails this scratch test instead of being ignored.
select dblink_exec('analytics_107_a', 'begin');
select dblink_exec(
  'analytics_107_a',
  'lock table public.investigation_events in access exclusive mode'
);
select dblink_exec('analytics_107_b', 'begin');
do $$
declare
  v_dispatched integer;
begin
  v_dispatched := dblink_send_query(
    'analytics_107_b',
    $remote$select public.refresh_private_analytics('2025-01-31 00:00:00+00')::text as payload$remote$
  );
  if v_dispatched <> 1 then
    raise exception 'FAIL(107/k4): refresh behind TRUNCATE was not dispatched';
  end if;
end $$;
do $$
declare
  v_pid integer;
  v_waiting boolean := false;
  v_advisory_held boolean := false;
begin
  select backend_pid into strict v_pid
    from analytics_107_connection_pids
   where connection_name = 'analytics_107_b';
  for attempt in 1..200 loop
    select exists (
      select 1
        from pg_catalog.pg_stat_activity
       where pid = v_pid
         and wait_event_type = 'Lock'
         and wait_event = 'relation'
    ) into v_waiting;
    select exists (
      select 1
        from pg_catalog.pg_locks
       where pid = v_pid
         and locktype = 'advisory'
         and granted
    ) into v_advisory_held;
    exit when v_waiting;
    perform pg_sleep(0.01);
  end loop;
  if not v_waiting or dblink_is_busy('analytics_107_b') <> 1 then
    raise exception 'FAIL(107/k4): refresh did not wait on the TRUNCATE relation lock';
  end if;
  if v_advisory_held then
    raise exception 'FAIL(107/k4): refresh acquired advisory lock before relation lock';
  end if;
end $$;
do $$
declare
  v_dispatched integer;
begin
  v_dispatched := dblink_send_query(
    'analytics_107_a',
    'truncate table public.investigation_events'
  );
  if v_dispatched <> 1 then
    raise exception 'FAIL(107/k4): TRUNCATE query was not dispatched';
  end if;
end $$;
do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('analytics_107_a') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('analytics_107_a') <> 0 then
    raise exception 'FAIL(107/k4): TRUNCATE remained blocked (possible advisory deadlock)';
  end if;
end $$;
create temporary table analytics_107_truncate_result (message text not null);
insert into analytics_107_truncate_result (message)
select message
  from dblink_get_result('analytics_107_a', true)
    as result(message text);
-- Consume the trailing command result; fail_on_error=true is intentional.
select count(*)
  from dblink_get_result('analytics_107_a', true)
    as result(message text);
do $$
declare
  v_message text;
begin
  select coalesce(string_agg(message, E'\n'), '')
    into v_message
    from analytics_107_truncate_result;
  if v_message ~* '(error|fatal|deadlock|timeout)' then
    raise exception 'FAIL(107/k4): TRUNCATE remote error was ignored: %', v_message;
  end if;
end $$;
select dblink_exec('analytics_107_a', 'commit');
do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('analytics_107_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('analytics_107_b') <> 0 then
    raise exception 'FAIL(107/k4): refresh did not finish after TRUNCATE commit';
  end if;
end $$;
create temporary table analytics_107_truncate_metric (payload text not null);
insert into analytics_107_truncate_metric (payload)
select payload
  from dblink_get_result('analytics_107_b', true)
    as result(payload text);
-- Consume the trailing command result; remote refresh errors must fail closed.
select count(*)
  from dblink_get_result('analytics_107_b', true)
    as result(payload text);
select dblink_exec('analytics_107_b', 'commit');
do $$
declare
  v_result jsonb;
  v_day jsonb;
begin
  select payload::jsonb into strict v_result
    from analytics_107_truncate_metric;
  v_day := v_result -> 'windows' -> 0;
  if jsonb_array_length(v_result -> 'windows') <> 3
     or (v_day ->> 'investigations_completed')::bigint <> 0
     or (v_day ->> 'investigations_failed')::bigint <> 0
     or (v_day ->> 'search_successes')::bigint <> 0
     or (v_day ->> 'search_failures')::bigint <> 0
     or (v_day ->> 'search_success_rate') is not null
     or v_day -> 'coverage' ->> 'search' <> 'not_measured' then
    raise exception 'FAIL(107/k4): post-TRUNCATE metric was not fail-closed: %', v_day;
  end if;
  if exists (select 1 from public.investigation_events) then
    raise exception 'FAIL(107/k4): TRUNCATE left source events behind';
  end if;
end $$;

select dblink_disconnect('analytics_107_a');
select dblink_disconnect('analytics_107_b');
