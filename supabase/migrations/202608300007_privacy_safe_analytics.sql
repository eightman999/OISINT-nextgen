-- 202608300007: privacy-safe operational analytics (#155)
--
-- Existing investigations, membership rows, and sanitized investigation events
-- are the only sources.  No new per-user activity event is introduced.

create table public.private_analytics_snapshots (
  window_days smallint primary key check (window_days in (1, 7, 30)),
  window_start timestamptz not null,
  window_end timestamptz not null,
  active_users_count bigint not null check (active_users_count >= 0),
  investigations_created_count bigint not null check (investigations_created_count >= 0),
  investigations_completed_count bigint not null check (investigations_completed_count >= 0),
  investigations_failed_count bigint not null check (investigations_failed_count >= 0),
  shared_joins_count bigint not null check (shared_joins_count >= 0),
  search_success_count bigint not null check (search_success_count >= 0),
  search_failure_count bigint not null check (search_failure_count >= 0),
  search_success_rate numeric(12, 9)
    check (search_success_rate is null or search_success_rate between 0 and 1),
  search_coverage text not null check (search_coverage in ('measured', 'not_measured')),
  computed_at timestamptz not null default clock_timestamp(),
  check (window_start < window_end),
  check (
    (search_coverage = 'measured' and search_success_count + search_failure_count > 0)
    or
    (search_coverage = 'not_measured' and search_success_count + search_failure_count = 0)
  )
);

comment on table public.private_analytics_snapshots is
  '運用専用の集計スナップショット。個別行・個別識別子を持たず、1日/7日/30日の集計値だけを保存する。';

create table public.private_analytics_opt_outs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  opted_out_at timestamptz not null default clock_timestamp()
);

comment on table public.private_analytics_opt_outs is
  '利用者が運用メトリクスの集計対象から外れる設定。service role と本人RPCだけが扱う。';

alter table public.private_analytics_snapshots enable row level security;
alter table public.private_analytics_opt_outs enable row level security;

revoke all on public.private_analytics_snapshots from public, anon, authenticated;
revoke all on public.private_analytics_opt_outs from public, anon, authenticated;
grant all on public.private_analytics_snapshots to service_role;
grant all on public.private_analytics_opt_outs to service_role;

-- The aggregate reads only bounded time windows.  Keep those scans indexable
-- without changing the source tables or introducing per-user analytics rows.
create index idx_private_analytics_investigations_created
  on public.investigations (created_at, created_by);
create index idx_private_analytics_members_joined
  on public.investigation_members (joined_at, user_id, investigation_id);
create index idx_private_analytics_events_created_type
  on public.investigation_events (created_at, event_type, investigation_id);

create or replace function public._invalidate_private_analytics_snapshots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- A refresh that read an old source snapshot must not commit after this
  -- invalidation.  The shared transaction lock establishes one total order:
  -- refresh→mutation leaves zero snapshots; mutation→refresh leaves fresh ones.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:private-analytics-snapshot', 0)
  );
  delete from public.private_analytics_snapshots;
  return null;
end;
$function$;

revoke all on function public._invalidate_private_analytics_snapshots() from public, anon, authenticated;
revoke all on function public._invalidate_private_analytics_snapshots() from service_role;

drop trigger if exists trg_private_analytics_investigations on public.investigations;
create trigger trg_private_analytics_investigations
after insert or update or delete or truncate on public.investigations
for each statement execute function public._invalidate_private_analytics_snapshots();

drop trigger if exists trg_private_analytics_members on public.investigation_members;
create trigger trg_private_analytics_members
after insert or update or delete or truncate on public.investigation_members
for each statement execute function public._invalidate_private_analytics_snapshots();

drop trigger if exists trg_private_analytics_events on public.investigation_events;
create trigger trg_private_analytics_events
after insert or update or delete or truncate on public.investigation_events
for each statement execute function public._invalidate_private_analytics_snapshots();

drop trigger if exists trg_private_analytics_opt_outs on public.private_analytics_opt_outs;
create trigger trg_private_analytics_opt_outs
after insert or update or delete or truncate on public.private_analytics_opt_outs
for each statement execute function public._invalidate_private_analytics_snapshots();

create or replace function public._refresh_private_analytics(p_as_of timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_window_days smallint;
  v_window_start timestamptz;
  v_computed_at timestamptz := clock_timestamp();
  v_active_users bigint;
  v_created bigint;
  v_completed bigint;
  v_failed bigint;
  v_shared_joins bigint;
  v_search_success bigint;
  v_search_failure bigint;
  v_search_total bigint;
  v_search_rate numeric;
  v_search_coverage text;
begin
  if p_as_of is null
     or p_as_of <= '-infinity'::timestamptz
     or p_as_of >= 'infinity'::timestamptz
     or p_as_of > clock_timestamp() then
    raise exception 'invalid analytics boundary' using errcode = '22023';
  end if;

  -- Source mutations (including TRUNCATE) hold their relation lock before the
  -- statement trigger asks for the analytics advisory lock.  Acquire every
  -- source/opt-out relation lock first so readers and refreshes use the same
  -- order and cannot form a relation-lock/advisory-lock cycle.
  lock table
    public.investigations,
    public.investigation_members,
    public.investigation_events,
    public.private_analytics_opt_outs
    in access share mode;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:private-analytics-snapshot', 0)
  );

  for v_window_days in
    select value::smallint
      from unnest(array[1, 7, 30]) as window_sizes(value)
  loop
    v_window_start := p_as_of - make_interval(days => v_window_days::integer);

    -- Active users are the distinct creators and members observed in the bucket.
    -- Event rows do not carry an actor, so they are not used to invent one.
    select count(*)
      into v_active_users
      from (
        select i.created_by as user_id
          from public.investigations as i
         where i.created_at >= v_window_start
           and i.created_at < p_as_of
        union
        select m.user_id
          from public.investigation_members as m
         where m.joined_at >= v_window_start
           and m.joined_at < p_as_of
      ) as active(user_id)
     where not exists (
       select 1
         from public.private_analytics_opt_outs as o
        where o.user_id = active.user_id
     );

    select count(*)
      into v_created
      from public.investigations as i
     where i.created_at >= v_window_start
       and i.created_at < p_as_of
       and not exists (
         select 1
           from public.private_analytics_opt_outs as o
          where o.user_id = i.created_by
       );

    select count(distinct e.investigation_id)
      into v_completed
      from public.investigation_events as e
      join public.investigations as i on i.id = e.investigation_id
     where e.created_at >= v_window_start
       and e.created_at < p_as_of
       and e.event_type = 'step_started'
       and e.metadata ->> 'step' = 'complete'
       and not exists (
         select 1
           from public.private_analytics_opt_outs as o
          where o.user_id = i.created_by
       );

    select count(distinct e.investigation_id)
      into v_failed
      from public.investigation_events as e
      join public.investigations as i on i.id = e.investigation_id
     where e.created_at >= v_window_start
       and e.created_at < p_as_of
       and e.event_type = 'investigation_failed'
       and not exists (
         select 1
           from public.private_analytics_opt_outs as o
          where o.user_id = i.created_by
       );

    select count(*)
      into v_shared_joins
      from public.investigation_members as m
      join public.investigations as i on i.id = m.investigation_id
     where m.joined_at >= v_window_start
       and m.joined_at < p_as_of
       and m.role <> 'owner'
       and not exists (
         select 1
           from public.private_analytics_opt_outs as o
          where o.user_id = m.user_id
       );

    -- Search is measured per investigation: one successful completion wins over
    -- retry/failure noise, and a failure is counted only when no success exists.
    select
      count(*) filter (where outcomes.search_succeeded),
      count(*) filter (where not outcomes.search_succeeded and outcomes.search_failed)
      into v_search_success, v_search_failure
      from (
        select
          e.investigation_id,
          bool_or(e.event_type = 'search_completed') as search_succeeded,
          bool_or(
            e.event_type = 'investigation_failed'
            and (
              e.metadata ->> 'step' = 'searching'
              or e.metadata ->> 'code' = 'no_candidates'
            )
          ) as search_failed
          from public.investigation_events as e
          join public.investigations as i on i.id = e.investigation_id
         where e.created_at >= v_window_start
           and e.created_at < p_as_of
           and e.event_type in ('search_completed', 'investigation_failed')
           and not exists (
             select 1
               from public.private_analytics_opt_outs as o
              where o.user_id = i.created_by
           )
         group by e.investigation_id
      ) as outcomes;

    v_search_total := v_search_success + v_search_failure;
    if v_search_total > 0 then
      v_search_rate := round(v_search_success::numeric / v_search_total, 9);
      v_search_coverage := 'measured';
    else
      v_search_rate := null;
      v_search_coverage := 'not_measured';
    end if;

    insert into public.private_analytics_snapshots (
      window_days,
      window_start,
      window_end,
      active_users_count,
      investigations_created_count,
      investigations_completed_count,
      investigations_failed_count,
      shared_joins_count,
      search_success_count,
      search_failure_count,
      search_success_rate,
      search_coverage,
      computed_at
    ) values (
      v_window_days,
      v_window_start,
      p_as_of,
      v_active_users,
      v_created,
      v_completed,
      v_failed,
      v_shared_joins,
      v_search_success,
      v_search_failure,
      v_search_rate,
      v_search_coverage,
      v_computed_at
    )
    on conflict (window_days) do update set
      window_start = excluded.window_start,
      window_end = excluded.window_end,
      active_users_count = excluded.active_users_count,
      investigations_created_count = excluded.investigations_created_count,
      investigations_completed_count = excluded.investigations_completed_count,
      investigations_failed_count = excluded.investigations_failed_count,
      shared_joins_count = excluded.shared_joins_count,
      search_success_count = excluded.search_success_count,
      search_failure_count = excluded.search_failure_count,
      search_success_rate = excluded.search_success_rate,
      search_coverage = excluded.search_coverage,
      computed_at = excluded.computed_at;
  end loop;
end;
$function$;

revoke all on function public._refresh_private_analytics(timestamptz) from public, anon, authenticated;
revoke all on function public._refresh_private_analytics(timestamptz) from service_role;

create or replace function public._private_analytics_snapshot_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'schema', 'oisint.private_analytics.v1',
    'computed_at', max(s.computed_at),
    'windows', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'days', s.window_days,
          'window_start', s.window_start,
          'window_end', s.window_end,
          'active_users', s.active_users_count,
          'investigations_created', s.investigations_created_count,
          'investigations_completed', s.investigations_completed_count,
          'investigations_failed', s.investigations_failed_count,
          'shared_joins', s.shared_joins_count,
          'search_successes', s.search_success_count,
          'search_failures', s.search_failure_count,
          'search_success_rate', s.search_success_rate,
          'coverage', jsonb_build_object(
            'active_users', 'measured',
            'investigations', 'measured',
            'shared_joins', 'measured',
            'search', s.search_coverage
          )
        ) order by s.window_days
      ),
      '[]'::jsonb
    )
  )
    from public.private_analytics_snapshots as s;
$function$;

revoke all on function public._private_analytics_snapshot_json() from public, anon, authenticated;
revoke all on function public._private_analytics_snapshot_json() from service_role;

create or replace function public.refresh_private_analytics(p_as_of timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(current_setting('role', true), '');
begin
  if v_role <> 'service_role'
     and (
       v_role <> 'authenticated'
       or not public.current_user_is_admin()
     ) then
    raise exception 'operator access required' using errcode = '42501';
  end if;

  perform public._refresh_private_analytics(p_as_of);
  return public._private_analytics_snapshot_json();
end;
$function$;

revoke all on function public.refresh_private_analytics(timestamptz) from public, anon, authenticated;
grant execute on function public.refresh_private_analytics(timestamptz) to authenticated, service_role;

-- The no-argument form chooses its rolling-window boundary only after the
-- relation and advisory locks are held.  Keeping it as a separate overload
-- also means an explicit NULL boundary still reaches _refresh and is rejected.
create or replace function public.refresh_private_analytics()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(current_setting('role', true), '');
  v_as_of timestamptz;
begin
  if v_role <> 'service_role'
     and (
       v_role <> 'authenticated'
       or not public.current_user_is_admin()
     ) then
    raise exception 'operator access required' using errcode = '42501';
  end if;

  lock table
    public.investigations,
    public.investigation_members,
    public.investigation_events,
    public.private_analytics_opt_outs
    in access share mode;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:private-analytics-snapshot', 0)
  );
  v_as_of := clock_timestamp();

  perform public._refresh_private_analytics(v_as_of);
  return public._private_analytics_snapshot_json();
end;
$function$;

revoke all on function public.refresh_private_analytics() from public, anon, authenticated;
grant execute on function public.refresh_private_analytics() to authenticated, service_role;

create or replace function public.get_private_analytics()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(current_setting('role', true), '');
  v_as_of timestamptz;
  v_utc_day_start timestamptz;
begin
  if v_role <> 'service_role'
     and (
       v_role <> 'authenticated'
       or not public.current_user_is_admin()
     ) then
    raise exception 'operator access required' using errcode = '42501';
  end if;

  -- Readers share the mutation/refresh transaction lock.  This makes the
  -- completeness/freshness decision and the returned JSON one atomic view.
  -- Keep the relation-lock-before-advisory order used by refreshes.  In
  -- particular, TRUNCATE must never hold AccessExclusive while waiting for
  -- an advisory lock that a reader is holding before it reads a source table.
  lock table
    public.investigations,
    public.investigation_members,
    public.investigation_events,
    public.private_analytics_opt_outs
    in access share mode;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:private-analytics-snapshot', 0)
  );
  -- The lock wait can cross UTC midnight; calculate the boundary only after
  -- the advisory lock is held so the returned snapshot is for the current day.
  v_as_of := clock_timestamp();
  v_utc_day_start := pg_catalog.date_trunc('day', v_as_of, 'UTC');

  -- Source-table statement triggers delete all three rows.  Reuse a complete
  -- snapshot only within the UTC day in which it was computed; otherwise a
  -- quiet database would retain an old rolling window indefinitely.
  if (
    select count(*) <> 3
      or count(distinct s.window_days) <> 3
      or min(s.window_days) <> 1
      or max(s.window_days) <> 30
      or count(distinct s.window_end) <> 1
      or min(s.window_end) < v_utc_day_start
      or max(s.window_end) > v_as_of
      from public.private_analytics_snapshots as s
  ) then
    perform public._refresh_private_analytics(v_as_of);
  end if;
  return public._private_analytics_snapshot_json();
end;
$function$;

revoke all on function public.get_private_analytics() from public, anon, authenticated;
grant execute on function public.get_private_analytics() to authenticated, service_role;

create or replace function public.get_private_analytics_opt_out()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(current_setting('role', true), '');
begin
  if v_role not in ('authenticated', 'service_role')
     or auth.uid() is null
     or not public.current_user_is_permanent() then
    raise exception 'permanent authenticated user required' using errcode = '42501';
  end if;

  return exists (
    select 1
      from public.private_analytics_opt_outs as o
     where o.user_id = auth.uid()
  );
end;
$function$;

revoke all on function public.get_private_analytics_opt_out() from public, anon, authenticated;
grant execute on function public.get_private_analytics_opt_out() to authenticated, service_role;

create or replace function public.set_private_analytics_opt_out(p_opted_out boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(current_setting('role', true), '');
begin
  if v_role not in ('authenticated', 'service_role')
     or auth.uid() is null
     or not public.current_user_is_permanent()
     or p_opted_out is null then
    raise exception 'permanent authenticated user and boolean setting required' using errcode = '42501';
  end if;

  if p_opted_out then
    insert into public.private_analytics_opt_outs (user_id)
    values (auth.uid())
    on conflict (user_id) do update set opted_out_at = excluded.opted_out_at;
  else
    delete from public.private_analytics_opt_outs
     where user_id = auth.uid();
  end if;

  delete from public.private_analytics_snapshots;
  return p_opted_out;
end;
$function$;

revoke all on function public.set_private_analytics_opt_out(boolean) from public, anon, authenticated;
grant execute on function public.set_private_analytics_opt_out(boolean) to authenticated, service_role;

-- 0017 is immutable.  This forward definition keeps its return contract while
-- aligning event retention with the longest 30-day analytics bucket.
create or replace function public.run_data_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target_ids uuid[];
  v_events_total_before bigint;
  v_events_deleted bigint := 0;
  v_events_total_after bigint;
  v_inv_targets bigint;
  v_inv_anonymized bigint := 0;
  v_req_anonymized bigint := 0;
  v_votes_deleted bigint := 0;
begin
  select count(*) into v_events_total_before from public.investigation_events;

  delete from public.investigation_events
   where created_at is null
      or created_at < now() - interval '30 days';
  get diagnostics v_events_deleted = row_count;

  select count(*) into v_events_total_after from public.investigation_events;

  raise log '[data_retention] investigation_events: before=% deleted=% after=%',
    v_events_total_before, v_events_deleted, v_events_total_after;

  select coalesce(array_agg(id), '{}') into v_target_ids
    from public.investigations
   where anonymized_at is null
     and (
       (status = 'complete' and updated_at < now() - interval '6 months')
       or (status <> 'complete' and updated_at < now() - interval '3 months')
     );

  v_inv_targets := coalesce(array_length(v_target_ids, 1), 0);

  if v_inv_targets > 0 then
    update public.requirements
       set text = '[匿名化済み]',
           normalized_text = null,
           embedding = null
     where investigation_id = any (v_target_ids);
    get diagnostics v_req_anonymized = row_count;

    delete from public.votes
     where investigation_id = any (v_target_ids);
    get diagnostics v_votes_deleted = row_count;

    update public.investigations
       set raw_query = '[匿名化済み]',
           title = '[匿名化済み]',
           normalized_query = null,
           embedding = null,
           anonymized_at = now()
     where id = any (v_target_ids);
    get diagnostics v_inv_anonymized = row_count;
  end if;

  raise log '[data_retention] investigations: targets=% anonymized=% requirements=% votes_deleted=%',
    v_inv_targets, v_inv_anonymized, v_req_anonymized, v_votes_deleted;

  perform public._refresh_private_analytics(clock_timestamp());

  return jsonb_build_object(
    'events_total_before', v_events_total_before,
    'events_deleted', v_events_deleted,
    'events_total_after', v_events_total_after,
    'investigations_targets', v_inv_targets,
    'investigations_anonymized', v_inv_anonymized,
    'requirements_anonymized', v_req_anonymized,
    'votes_deleted', v_votes_deleted
  );
end;
$function$;

revoke all on function public.run_data_retention() from public, anon, authenticated;
grant execute on function public.run_data_retention() to service_role;

comment on function public.run_data_retention() is
  'Applies the data retention policy and refreshes privacy-safe operational aggregates.';
