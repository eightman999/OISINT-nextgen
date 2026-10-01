-- 202608300009: privacy-safe Growth Loop metrics (#541)
--
-- acquisition -> activation -> collaboration -> return を、調査×参加者の
-- 最小状態へ圧縮する。raw_query / display_name / requirement本文 / Taste本文 /
-- share_token / 店舗情報 / 通知本文は保存しない。

create table public.growth_actor_states (
  investigation_id uuid not null
    references public.investigations(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  share_opened_at timestamptz,
  joined_at timestamptz,
  activated_at timestamptz,
  returned_at timestamptz,
  push_returned_at timestamptz,
  first_new_investigation_at timestamptz,
  requirement_added_count integer not null default 0
    check (requirement_added_count >= 0),
  vote_cast_count integer not null default 0
    check (vote_cast_count >= 0),
  new_investigation_count integer not null default 0
    check (new_investigation_count >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (investigation_id, user_id),
  check (share_opened_at is not null or joined_at is not null),
  check (activated_at is null or joined_at is not null),
  check (returned_at is null or joined_at is not null),
  check (push_returned_at is null or returned_at is not null),
  check (first_new_investigation_at is null or joined_at is not null),
  check ((new_investigation_count = 0) = (first_new_investigation_at is null))
);

comment on table public.growth_actor_states is
  'Growth Loopの最小状態。本文・表示名・token・店舗情報を持たず、詳細な行動履歴も保存しない。';

create index idx_growth_actor_states_user_joined
  on public.growth_actor_states (user_id, joined_at desc)
  where joined_at is not null;

create table public.growth_ranking_states (
  investigation_id uuid primary key
    references public.investigations(id) on delete cascade,
  ranking_fingerprint text not null
    check (ranking_fingerprint ~ '^[0-9a-f]{32}$'),
  ranking_changed_count integer not null default 0
    check (ranking_changed_count >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table public.growth_ranking_states is
  '候補UUIDとrankだけから作るfingerprint。店名・score・条件本文を保存しない。';

alter table public.growth_actor_states enable row level security;
alter table public.growth_ranking_states enable row level security;

revoke all on public.growth_actor_states from public, anon, authenticated;
revoke all on public.growth_ranking_states from public, anon, authenticated;
grant all on public.growth_actor_states to service_role;
grant all on public.growth_ranking_states to service_role;

-- migration以前の共有参加だけは既存のmember行から再構成できる。過去の共有閲覧・
-- 初回行動・再訪は推測で補完せず0件から開始する。
insert into public.growth_actor_states (
  investigation_id,
  user_id,
  joined_at,
  updated_at
)
select
  m.investigation_id,
  m.user_id,
  coalesce(m.joined_at, i.created_at, clock_timestamp()),
  clock_timestamp()
  from public.investigation_members as m
  join public.investigations as i on i.id = m.investigation_id
  join auth.users as account on account.id = m.user_id
 where m.role <> 'owner'
   and i.anonymized_at is null
   and not exists (
     select 1
       from public.private_analytics_opt_outs as o
      where o.user_id = m.user_id
   )
on conflict (investigation_id, user_id) do nothing;

-- 現在の順位をbaselineにする。migration以前の順位変化回数は推測しない。
insert into public.growth_ranking_states (
  investigation_id,
  ranking_fingerprint
)
select
  c.investigation_id,
  md5(string_agg(
    c.id::text || ':' || coalesce(c.rank, -1)::text,
    ',' order by c.rank nulls last, c.id
  ))
  from public.candidates as c
  join public.investigations as i on i.id = c.investigation_id
 where i.anonymized_at is null
 group by c.investigation_id
on conflict (investigation_id) do nothing;

create or replace function public._growth_user_opted_out(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.private_analytics_opt_outs as o
     where o.user_id = p_user_id
  );
$function$;

revoke all on function public._growth_user_opted_out(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.record_growth_share_open(p_share_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_investigation_id uuid;
  v_member_role text;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_user_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_share_token is null
     or p_share_token !~ '^[0-9a-f]{32}$' then
    raise exception 'invalid share token' using errcode = '22023';
  end if;
  if public._growth_user_opted_out(v_user_id) then return false; end if;

  select
    i.id,
    (
      select m.role
        from public.investigation_members as m
       where m.investigation_id = i.id
         and m.user_id = v_user_id
       limit 1
    )
    into v_investigation_id, v_member_role
    from public.investigations as i
   where i.share_token = p_share_token
     and i.anonymized_at is null;

  if v_investigation_id is null then return false; end if;
  if v_member_role = 'owner' then return false; end if;
  if v_member_role is not null then
    -- 既参加者が同じ共有URLから戻った場合は、新しいacquisitionではなくreturn。
    return public._record_growth_return(v_investigation_id, v_user_id, false);
  end if;

  insert into public.growth_actor_states as state (
    investigation_id,
    user_id,
    share_opened_at
  ) values (
    v_investigation_id,
    v_user_id,
    clock_timestamp()
  )
  on conflict (investigation_id, user_id) do update set
    share_opened_at = coalesce(state.share_opened_at, excluded.share_opened_at),
    updated_at = case
      when state.share_opened_at is null then clock_timestamp()
      else state.updated_at
    end;

  return true;
end;
$function$;

revoke all on function public.record_growth_share_open(text) from public, anon;
grant execute on function public.record_growth_share_open(text)
  to authenticated, service_role;

create or replace function public._record_growth_return(
  p_investigation_id uuid,
  p_user_id uuid,
  p_from_push boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_investigation_id is null or p_user_id is null or p_from_push is null then
    raise exception 'invalid growth return' using errcode = '22023';
  end if;
  if public._growth_user_opted_out(p_user_id) then return false; end if;

  -- opt-out解除後などstateが無い既参加者は、過去期間を復元せず現在時刻から計測する。
  insert into public.growth_actor_states as state (
    investigation_id,
    user_id,
    joined_at,
    returned_at,
    push_returned_at
  )
  select
    m.investigation_id,
    m.user_id,
    clock_timestamp(),
    clock_timestamp(),
    case when p_from_push then clock_timestamp() else null end
    from public.investigation_members as m
    join public.investigations as i on i.id = m.investigation_id
   where m.investigation_id = p_investigation_id
     and m.user_id = p_user_id
     and m.role <> 'owner'
     and i.anonymized_at is null
  on conflict (investigation_id, user_id) do update set
    returned_at = coalesce(state.returned_at, excluded.returned_at),
    push_returned_at = case
      when p_from_push then coalesce(state.push_returned_at, excluded.push_returned_at)
      else state.push_returned_at
    end,
    updated_at = case
      when state.returned_at is null
        or (p_from_push and state.push_returned_at is null)
        then clock_timestamp()
      else state.updated_at
    end;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$function$;

revoke all on function public._record_growth_return(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.record_growth_return(p_investigation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_user_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  return public._record_growth_return(p_investigation_id, v_user_id, false);
end;
$function$;

revoke all on function public.record_growth_return(uuid) from public, anon;
grant execute on function public.record_growth_return(uuid)
  to authenticated, service_role;

create or replace function public._growth_member_join_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.role = 'owner' or public._growth_user_opted_out(new.user_id) then
    return null;
  end if;

  insert into public.growth_actor_states as state (
    investigation_id,
    user_id,
    joined_at
  ) values (
    new.investigation_id,
    new.user_id,
    coalesce(new.joined_at, clock_timestamp())
  )
  on conflict (investigation_id, user_id) do update set
    joined_at = coalesce(state.joined_at, excluded.joined_at),
    updated_at = case
      when state.joined_at is null then clock_timestamp()
      else state.updated_at
    end;
  return null;
end;
$function$;

revoke all on function public._growth_member_join_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_growth_member_join
after insert on public.investigation_members
for each row execute function public._growth_member_join_trigger();

create or replace function public._growth_participant_action_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_investigation_id uuid;
  v_user_id uuid;
  v_requirement_increment integer := 0;
  v_vote_increment integer := 0;
begin
  if tg_table_name = 'requirements' then
    if new.created_by is null then return null; end if;
    v_investigation_id := new.investigation_id;
    v_user_id := new.created_by;
    v_requirement_increment := 1;
  elsif tg_table_name = 'votes' then
    if tg_op = 'UPDATE' and old.value = new.value then return null; end if;
    v_investigation_id := new.investigation_id;
    v_user_id := new.user_id;
    v_vote_increment := 1;
  else
    return null;
  end if;

  if public._growth_user_opted_out(v_user_id) then return null; end if;

  update public.growth_actor_states as state
     set activated_at = coalesce(state.activated_at, clock_timestamp()),
         requirement_added_count = state.requirement_added_count + v_requirement_increment,
         vote_cast_count = state.vote_cast_count + v_vote_increment,
         updated_at = clock_timestamp()
   where state.investigation_id = v_investigation_id
     and state.user_id = v_user_id
     and state.joined_at is not null;
  return null;
end;
$function$;

revoke all on function public._growth_participant_action_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_growth_requirement_added
after insert on public.requirements
for each row execute function public._growth_participant_action_trigger();

create trigger trg_growth_vote_cast
after insert or update on public.votes
for each row execute function public._growth_participant_action_trigger();

create or replace function public._growth_ranking_change_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_fingerprint text;
begin
  if new.event_type <> 'ranking_completed' then return null; end if;

  select md5(string_agg(
    c.id::text || ':' || coalesce(c.rank, -1)::text,
    ',' order by c.rank nulls last, c.id
  ))
    into v_fingerprint
    from public.candidates as c
   where c.investigation_id = new.investigation_id;

  if v_fingerprint is null then return null; end if;

  insert into public.growth_ranking_states as state (
    investigation_id,
    ranking_fingerprint
  ) values (
    new.investigation_id,
    v_fingerprint
  )
  on conflict (investigation_id) do update set
    ranking_fingerprint = excluded.ranking_fingerprint,
    ranking_changed_count = state.ranking_changed_count + case
      when state.ranking_fingerprint is distinct from excluded.ranking_fingerprint then 1
      else 0
    end,
    updated_at = case
      when state.ranking_fingerprint is distinct from excluded.ranking_fingerprint
        then clock_timestamp()
      else state.updated_at
    end;
  return null;
end;
$function$;

revoke all on function public._growth_ranking_change_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_growth_ranking_changed
after insert on public.investigation_events
for each row execute function public._growth_ranking_change_trigger();

create or replace function public._growth_new_investigation_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_origin_investigation_id uuid;
begin
  if new.created_by is null or public._growth_user_opted_out(new.created_by) then
    return null;
  end if;

  -- 複数の過去Group Sessionへ二重帰属させず、直近の参加セッション1件だけへ帰属。
  select state.investigation_id
    into v_origin_investigation_id
    from public.growth_actor_states as state
   where state.user_id = new.created_by
     and state.joined_at is not null
     and state.joined_at < new.created_at
     and state.investigation_id <> new.id
   order by state.joined_at desc, state.investigation_id
   limit 1
   for update;

  if v_origin_investigation_id is null then return null; end if;

  update public.growth_actor_states as state
     set first_new_investigation_at = coalesce(
           state.first_new_investigation_at,
           new.created_at,
           clock_timestamp()
         ),
         new_investigation_count = state.new_investigation_count + 1,
         updated_at = clock_timestamp()
   where state.investigation_id = v_origin_investigation_id
     and state.user_id = new.created_by;
  return null;
end;
$function$;

revoke all on function public._growth_new_investigation_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_growth_new_investigation
after insert on public.investigations
for each row execute function public._growth_new_investigation_trigger();

-- 過去に新規調査を作成済みの参加者も、直前のGroup Session 1件へだけ帰属する。
with attributed as (
  select
    created.id as created_investigation_id,
    created.created_at,
    origin.investigation_id as origin_investigation_id,
    created.created_by as user_id
    from public.investigations as created
    cross join lateral (
      select state.investigation_id
        from public.growth_actor_states as state
       where state.user_id = created.created_by
         and state.joined_at is not null
         and state.joined_at < created.created_at
         and state.investigation_id <> created.id
       order by state.joined_at desc, state.investigation_id
       limit 1
    ) as origin
   where created.anonymized_at is null
), summarized as (
  select
    origin_investigation_id,
    user_id,
    min(created_at) as first_created_at,
    count(*)::integer as created_count
    from attributed
   group by origin_investigation_id, user_id
)
update public.growth_actor_states as state
   set first_new_investigation_at = summarized.first_created_at,
       new_investigation_count = summarized.created_count,
       updated_at = clock_timestamp()
  from summarized
 where state.investigation_id = summarized.origin_investigation_id
   and state.user_id = summarized.user_id;

create or replace function public._growth_opt_out_cleanup_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from public.growth_actor_states where user_id = new.user_id;
  return null;
end;
$function$;

revoke all on function public._growth_opt_out_cleanup_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_growth_opt_out_cleanup
after insert on public.private_analytics_opt_outs
for each row execute function public._growth_opt_out_cleanup_trigger();

create or replace function public._growth_anonymized_cleanup_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.anonymized_at is null and new.anonymized_at is not null then
    delete from public.growth_actor_states where investigation_id = new.id;
    delete from public.growth_ranking_states where investigation_id = new.id;
  end if;
  return null;
end;
$function$;

revoke all on function public._growth_anonymized_cleanup_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_growth_anonymized_cleanup
after update of anonymized_at on public.investigations
for each row execute function public._growth_anonymized_cleanup_trigger();

create view public.growth_session_metrics
with (security_invoker = true)
as
select
  i.id as investigation_id,
  i.created_at,
  i.status,
  count(state.user_id) filter (where state.share_opened_at is not null)::bigint
    as share_opened,
  count(state.user_id) filter (where state.joined_at is not null)::bigint
    as participant_joined,
  count(state.user_id) filter (where state.activated_at is not null)::bigint
    as participant_activated,
  coalesce(sum(state.requirement_added_count), 0)::bigint as requirement_added,
  coalesce(sum(state.vote_cast_count), 0)::bigint as vote_cast,
  coalesce(max(ranking.ranking_changed_count), 0)::bigint as ranking_changed,
  count(state.user_id) filter (where state.returned_at is not null)::bigint
    as participant_returned,
  count(state.user_id) filter (
    where state.returned_at is not null
      and state.joined_at is not null
      and state.returned_at <= state.joined_at + interval '7 days'
  )::bigint as participant_returned_7d,
  count(state.user_id) filter (where state.push_returned_at is not null)::bigint
    as participant_returned_via_push,
  coalesce(sum(state.new_investigation_count), 0)::bigint
    as participant_created_new_investigation
  from public.investigations as i
  left join public.growth_actor_states as state
    on state.investigation_id = i.id
  left join public.growth_ranking_states as ranking
    on ranking.investigation_id = i.id
 where i.anonymized_at is null
 group by i.id, i.created_at, i.status;

comment on view public.growth_session_metrics is
  'OISINT DB内で再構成できるGroup Session集計。本文・個人IDを返さないRPCの正本。';

revoke all on public.growth_session_metrics from public, anon, authenticated;
grant select on public.growth_session_metrics to service_role;

create or replace function public._growth_session_metrics_json(p_investigation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'schema', 'oisint.growth_session.v1',
    'events', jsonb_build_object(
      'investigation_created', 1,
      'share_opened', metrics.share_opened,
      'participant_joined', metrics.participant_joined,
      'participant_activated', metrics.participant_activated,
      'requirement_added', metrics.requirement_added,
      'vote_cast', metrics.vote_cast,
      'ranking_changed', metrics.ranking_changed,
      'participant_returned', metrics.participant_returned,
      'participant_returned_7d', metrics.participant_returned_7d,
      'participant_returned_via_push', metrics.participant_returned_via_push,
      'participant_created_new_investigation', metrics.participant_created_new_investigation
    ),
    'derived', jsonb_build_object(
      'share_to_join_conversion', case
        when metrics.share_opened = 0 then null
        else round(metrics.participant_joined::numeric / metrics.share_opened, 6)
      end,
      'join_to_first_action_conversion', case
        when metrics.participant_joined = 0 then null
        else round(metrics.participant_activated::numeric / metrics.participant_joined, 6)
      end,
      'group_completed', metrics.status = 'complete',
      'invite_coefficient', case
        when metrics.participant_joined = 0 then null
        else round(
          metrics.participant_created_new_investigation::numeric /
          metrics.participant_joined,
          6
        )
      end,
      'return_7d_rate', case
        when metrics.participant_joined = 0 then null
        else round(metrics.participant_returned_7d::numeric / metrics.participant_joined, 6)
      end
    )
  )
    from public.growth_session_metrics as metrics
   where metrics.investigation_id = p_investigation_id;
$function$;

revoke all on function public._growth_session_metrics_json(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_growth_session_metrics(p_investigation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_user_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_investigation_id is null or not exists (
    select 1
      from public.investigation_members as m
     where m.investigation_id = p_investigation_id
       and m.user_id = v_user_id
  ) then
    raise exception 'investigation membership required' using errcode = '42501';
  end if;

  v_result := public._growth_session_metrics_json(p_investigation_id);
  if v_result is null then
    raise exception 'growth metrics unavailable' using errcode = '22023';
  end if;
  return v_result;
end;
$function$;

revoke all on function public.get_growth_session_metrics(uuid) from public, anon;
grant execute on function public.get_growth_session_metrics(uuid)
  to authenticated, service_role;

create or replace function public.get_growth_loop_kpis(
  p_since timestamptz,
  p_until timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_since is null or p_until is null
     or p_since >= p_until
     or p_until > clock_timestamp() then
    raise exception 'invalid growth metrics boundary' using errcode = '22023';
  end if;

  with totals as (
    select
      count(*)::bigint as sessions_created,
      count(*) filter (where metrics.participant_joined > 0)::bigint
        as group_sessions,
      count(*) filter (
        where metrics.participant_joined > 0 and metrics.status = 'complete'
      )::bigint as group_sessions_completed,
      coalesce(sum(metrics.share_opened), 0)::bigint as share_opened,
      coalesce(sum(metrics.participant_joined), 0)::bigint as participant_joined,
      coalesce(sum(metrics.participant_activated), 0)::bigint as participant_activated,
      coalesce(sum(metrics.requirement_added), 0)::bigint as requirement_added,
      coalesce(sum(metrics.vote_cast), 0)::bigint as vote_cast,
      coalesce(sum(metrics.ranking_changed), 0)::bigint as ranking_changed,
      coalesce(sum(metrics.participant_returned), 0)::bigint as participant_returned,
      coalesce(sum(metrics.participant_returned_7d), 0)::bigint as participant_returned_7d,
      coalesce(sum(metrics.participant_returned_via_push), 0)::bigint
        as participant_returned_via_push,
      coalesce(sum(metrics.participant_created_new_investigation), 0)::bigint
        as participant_created_new_investigation
      from public.growth_session_metrics as metrics
     where metrics.created_at >= p_since
       and metrics.created_at < p_until
  )
  select jsonb_build_object(
    'schema', 'oisint.growth_kpis.v1',
    'window_start', p_since,
    'window_end', p_until,
    'events', jsonb_build_object(
      'investigation_created', totals.sessions_created,
      'share_opened', totals.share_opened,
      'participant_joined', totals.participant_joined,
      'participant_activated', totals.participant_activated,
      'requirement_added', totals.requirement_added,
      'vote_cast', totals.vote_cast,
      'ranking_changed', totals.ranking_changed,
      'participant_returned', totals.participant_returned,
      'participant_returned_7d', totals.participant_returned_7d,
      'participant_returned_via_push', totals.participant_returned_via_push,
      'participant_created_new_investigation', totals.participant_created_new_investigation
    ),
    'derived', jsonb_build_object(
      'share_to_join_conversion', case
        when totals.share_opened = 0 then null
        else round(totals.participant_joined::numeric / totals.share_opened, 6)
      end,
      'join_to_first_action_conversion', case
        when totals.participant_joined = 0 then null
        else round(totals.participant_activated::numeric / totals.participant_joined, 6)
      end,
      'group_completion_rate', case
        when totals.group_sessions = 0 then null
        else round(totals.group_sessions_completed::numeric / totals.group_sessions, 6)
      end,
      'invite_coefficient', case
        when totals.participant_joined = 0 then null
        else round(
          totals.participant_created_new_investigation::numeric /
          totals.participant_joined,
          6
        )
      end,
      'return_7d_rate', case
        when totals.participant_joined = 0 then null
        else round(totals.participant_returned_7d::numeric / totals.participant_joined, 6)
      end
    )
  ) into v_result
    from totals;

  return v_result;
end;
$function$;

revoke all on function public.get_growth_loop_kpis(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_growth_loop_kpis(timestamptz, timestamptz)
  to service_role;

-- #540 のrecipient本人/open契約を保ったまま、開封をreturn状態へ圧縮する。
create or replace function public.record_push_notification_open(
  p_notification_id uuid,
  p_stage text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_count integer := 0;
  v_investigation_id uuid;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_user_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_notification_id is null
     or p_stage not in ('notification_opened', 'deep_link_opened') then
    raise exception 'invalid push open event' using errcode = '22023';
  end if;

  update public.push_notification_outbox as outbox
     set opened_at = coalesce(outbox.opened_at, clock_timestamp()),
         deep_link_opened_at = case
           when p_stage = 'deep_link_opened'
             then coalesce(outbox.deep_link_opened_at, clock_timestamp())
           else outbox.deep_link_opened_at
         end,
         updated_at = clock_timestamp()
   where outbox.id = p_notification_id
     and outbox.recipient_user_id = v_user_id
     and outbox.state = 'sent'
  returning outbox.investigation_id into v_investigation_id;
  get diagnostics v_count = row_count;

  if v_count = 1 then
    perform public._record_growth_return(v_investigation_id, v_user_id, true);
  end if;
  return v_count = 1;
end;
$function$;

revoke all on function public.record_push_notification_open(uuid, text)
  from public, anon;
grant execute on function public.record_push_notification_open(uuid, text)
  to authenticated, service_role;
