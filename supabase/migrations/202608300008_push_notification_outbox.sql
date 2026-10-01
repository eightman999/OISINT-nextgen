-- 202608300008: privacy-safe OneSignal push outbox (#540)
--
-- Push本文は固定文言、payloadはevent/investigation/outbox UUIDだけとする。
-- raw_query、店舗名、Taste Profile、token、display_nameはこの境界へ保存しない。

create table public.push_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notifications_enabled boolean not null default false,
  group_updates_enabled boolean not null default true,
  permission_status text not null default 'not_requested'
    check (permission_status in ('not_requested', 'granted', 'denied')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (not notifications_enabled or permission_status = 'granted')
);

comment on table public.push_notification_preferences is
  '本人のPush opt-inとグループ更新設定。SDK token/OneSignal IDは保存しない。';

create table public.push_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  event_type text not null check (event_type in (
    'investigation_completed',
    'group_update',
    'ranking_changed',
    'invite_activity'
  )),
  dedupe_key text not null unique check (
    length(dedupe_key) between 1 and 240
    and dedupe_key ~ '^[a-z0-9:_-]+$'
  ),
  idempotency_key uuid not null default gen_random_uuid() unique,
  state text not null default 'pending' check (state in (
    'pending', 'leased', 'retry', 'sent', 'dead'
  )),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  provider_message_id text check (
    provider_message_id is null or length(provider_message_id) between 1 and 128
  ),
  last_error_code text check (
    last_error_code is null or last_error_code in (
      'http_4xx', 'http_5xx', 'network', 'invalid_response', 'no_subscription',
      'rate_limited', 'credentials_unavailable'
    )
  ),
  opened_at timestamptz,
  deep_link_opened_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (state = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or
    (state <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  check (deep_link_opened_at is null or opened_at is not null)
);

comment on table public.push_notification_outbox is
  'OneSignal送信の短期outbox。固定eventとUUIDだけを保持し、本文・検索条件・店舗情報は保持しない。';

create index idx_push_notification_outbox_ready
  on public.push_notification_outbox (state, next_attempt_at, created_at)
  where state in ('pending', 'retry', 'leased');
create index idx_push_notification_outbox_recipient
  on public.push_notification_outbox (recipient_user_id, created_at desc);

create table public.push_investigation_state (
  investigation_id uuid primary key references public.investigations(id) on delete cascade,
  last_top_candidate_id uuid references public.candidates(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table public.push_investigation_state is
  '順位変化通知の決定論状態。候補本文やscoreは保持せずTop1 candidate UUIDだけを比較する。';

alter table public.push_notification_preferences enable row level security;
alter table public.push_notification_outbox enable row level security;
alter table public.push_investigation_state enable row level security;

revoke all on public.push_notification_preferences from public, anon, authenticated;
revoke all on public.push_notification_outbox from public, anon, authenticated;
revoke all on public.push_investigation_state from public, anon, authenticated;
grant all on public.push_notification_preferences to service_role;
grant all on public.push_notification_outbox to service_role;
grant all on public.push_investigation_state to service_role;

create or replace function public.get_push_notification_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text := coalesce(auth.role(), '');
  v_is_anonymous boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  v_result jsonb;
begin
  if v_role <> 'authenticated' or v_user_id is null or v_is_anonymous then
    raise exception 'permanent authenticated user required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'notifications_enabled', p.notifications_enabled,
    'group_updates_enabled', p.group_updates_enabled,
    'permission_status', p.permission_status
  )
    into v_result
    from public.push_notification_preferences as p
   where p.user_id = v_user_id;

  return coalesce(v_result, jsonb_build_object(
    'notifications_enabled', false,
    'group_updates_enabled', true,
    'permission_status', 'not_requested'
  ));
end;
$function$;

revoke all on function public.get_push_notification_preferences()
  from public, anon;
grant execute on function public.get_push_notification_preferences()
  to authenticated, service_role;

create or replace function public.set_push_notification_preferences(
  p_notifications_enabled boolean,
  p_group_updates_enabled boolean,
  p_permission_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text := coalesce(auth.role(), '');
  v_is_anonymous boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  v_result jsonb;
begin
  if v_role <> 'authenticated' or v_user_id is null or v_is_anonymous then
    raise exception 'permanent authenticated user required' using errcode = '42501';
  end if;
  if p_notifications_enabled is null or p_group_updates_enabled is null
     or p_permission_status not in ('not_requested', 'granted', 'denied')
     or (p_notifications_enabled and p_permission_status <> 'granted') then
    raise exception 'invalid push preferences' using errcode = '22023';
  end if;

  insert into public.push_notification_preferences as p (
    user_id,
    notifications_enabled,
    group_updates_enabled,
    permission_status
  ) values (
    v_user_id,
    p_notifications_enabled,
    p_group_updates_enabled,
    p_permission_status
  )
  on conflict (user_id) do update set
    notifications_enabled = excluded.notifications_enabled,
    group_updates_enabled = excluded.group_updates_enabled,
    permission_status = excluded.permission_status,
    updated_at = clock_timestamp()
  returning jsonb_build_object(
    'notifications_enabled', p.notifications_enabled,
    'group_updates_enabled', p.group_updates_enabled,
    'permission_status', p.permission_status
  ) into v_result;

  if not p_notifications_enabled then
    update public.push_notification_outbox as o
       set state = 'dead',
           lease_owner = null,
           lease_expires_at = null,
           last_error_code = null,
           updated_at = clock_timestamp()
     where o.recipient_user_id = v_user_id
       and o.state in ('pending', 'retry');
  end if;

  return v_result;
end;
$function$;

revoke all on function public.set_push_notification_preferences(boolean, boolean, text)
  from public, anon;
grant execute on function public.set_push_notification_preferences(boolean, boolean, text)
  to authenticated, service_role;

create or replace function public._queue_push_notifications(
  p_investigation_id uuid,
  p_event_type text,
  p_excluded_user_id uuid,
  p_dedupe_scope text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inserted integer := 0;
begin
  if p_investigation_id is null
     or p_event_type not in (
       'investigation_completed', 'group_update', 'ranking_changed', 'invite_activity'
     )
     or p_dedupe_scope is null
     or p_dedupe_scope !~ '^[a-z0-9_-]{1,80}$' then
    raise exception 'invalid push queue request' using errcode = '22023';
  end if;

  insert into public.push_notification_outbox (
    recipient_user_id,
    investigation_id,
    event_type,
    dedupe_key
  )
  select
    m.user_id,
    p_investigation_id,
    p_event_type,
    p_event_type || ':' || p_investigation_id::text || ':' || m.user_id::text || ':' || p_dedupe_scope
    from public.investigation_members as m
    join public.investigations as i on i.id = m.investigation_id
    join public.push_notification_preferences as pref on pref.user_id = m.user_id
   where m.investigation_id = p_investigation_id
     and m.user_id is distinct from p_excluded_user_id
     and pref.notifications_enabled
     and pref.permission_status = 'granted'
     and (
       p_event_type = 'investigation_completed'
       or pref.group_updates_enabled
     )
     and i.anonymized_at is null
     and (
       p_event_type = 'investigation_completed' and i.status = 'complete'
       or p_event_type <> 'investigation_completed' and i.status not in ('failed')
     )
  on conflict (dedupe_key) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$function$;

revoke all on function public._queue_push_notifications(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public._push_complete_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status is distinct from new.status and new.status = 'complete' then
    perform public._queue_push_notifications(new.id, 'investigation_completed', null, 'final');
  end if;
  return null;
end;
$function$;

revoke all on function public._push_complete_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_push_investigation_complete
after update of status on public.investigations
for each row execute function public._push_complete_trigger();

create or replace function public._push_group_change_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_investigation_id uuid;
  v_actor_id uuid;
  v_scope text := 'w' || floor(extract(epoch from clock_timestamp()) / 300)::bigint::text;
begin
  if tg_table_name = 'votes' then
    if tg_op = 'UPDATE'
       and old.value = new.value
       and old.comment is not distinct from new.comment then
      return null;
    end if;
    v_investigation_id := case when tg_op = 'DELETE' then old.investigation_id else new.investigation_id end;
    v_actor_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  elsif tg_table_name = 'requirements' then
    if tg_op = 'UPDATE'
       and old.text = new.text
       and old.normalized_text is not distinct from new.normalized_text
       and old.kind is not distinct from new.kind
       and old.priority is not distinct from new.priority
       and old.weight is not distinct from new.weight then
      return null;
    end if;
    v_investigation_id := case when tg_op = 'DELETE' then old.investigation_id else new.investigation_id end;
    v_actor_id := case when tg_op = 'DELETE' then old.created_by else new.created_by end;
    -- parser/providerが作るcreated_by=nullの初期条件は共同編集ではない。
    if v_actor_id is null then return null; end if;
  else
    return null;
  end if;

  perform public._queue_push_notifications(
    v_investigation_id,
    'group_update',
    v_actor_id,
    v_scope
  );
  return null;
end;
$function$;

revoke all on function public._push_group_change_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_push_vote_change
after insert or update or delete on public.votes
for each row execute function public._push_group_change_trigger();

create trigger trg_push_requirement_change
after insert or update or delete on public.requirements
for each row execute function public._push_group_change_trigger();

create or replace function public._push_member_join_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope text := 'w' || floor(extract(epoch from clock_timestamp()) / 300)::bigint::text;
begin
  perform public._queue_push_notifications(
    new.investigation_id,
    'invite_activity',
    new.user_id,
    v_scope
  );
  return null;
end;
$function$;

revoke all on function public._push_member_join_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_push_member_join
after insert on public.investigation_members
for each row execute function public._push_member_join_trigger();

create or replace function public._push_ranking_change_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current_top uuid;
  v_previous_top uuid;
  v_scope text := 'w' || floor(extract(epoch from clock_timestamp()) / 300)::bigint::text;
begin
  if new.event_type <> 'ranking_completed' then return null; end if;

  select c.id
    into v_current_top
    from public.candidates as c
   where c.investigation_id = new.investigation_id
     and c.rank = 1
   order by c.id
   limit 1;

  if v_current_top is null then return null; end if;

  select s.last_top_candidate_id
    into v_previous_top
    from public.push_investigation_state as s
   where s.investigation_id = new.investigation_id
   for update;

  if not found then
    insert into public.push_investigation_state (investigation_id, last_top_candidate_id)
    values (new.investigation_id, v_current_top)
    on conflict (investigation_id) do nothing;
    return null;
  end if;

  if v_previous_top is distinct from v_current_top then
    update public.push_investigation_state
       set last_top_candidate_id = v_current_top,
           updated_at = clock_timestamp()
     where investigation_id = new.investigation_id;
    perform public._queue_push_notifications(
      new.investigation_id,
      'ranking_changed',
      null,
      v_scope
    );
  end if;
  return null;
end;
$function$;

revoke all on function public._push_ranking_change_trigger()
  from public, anon, authenticated, service_role;

create trigger trg_push_ranking_change
after insert on public.investigation_events
for each row execute function public._push_ranking_change_trigger();

create or replace function public.lease_push_notification_outbox(
  p_worker_id uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 30
)
returns table (
  id uuid,
  recipient_user_id uuid,
  investigation_id uuid,
  event_type text,
  idempotency_key uuid,
  attempts smallint
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_worker_id is null or p_limit not between 1 and 50
     or p_lease_seconds not between 10 and 120 then
    raise exception 'invalid push lease request' using errcode = '22023';
  end if;

  update public.push_notification_outbox as expired
     set state = 'dead',
         lease_owner = null,
         lease_expires_at = null,
         updated_at = clock_timestamp()
   where expired.state = 'leased'
     and expired.lease_expires_at <= clock_timestamp()
     and expired.attempts >= 5;

  return query
  with ready as (
    select o.id
      from public.push_notification_outbox as o
      join public.push_notification_preferences as p
        on p.user_id = o.recipient_user_id
     where (
       o.state in ('pending', 'retry') and o.next_attempt_at <= clock_timestamp()
       or o.state = 'leased' and o.lease_expires_at <= clock_timestamp()
     )
       and o.attempts < 5
       and p.notifications_enabled
       and p.permission_status = 'granted'
       and (o.event_type = 'investigation_completed' or p.group_updates_enabled)
     order by o.created_at, o.id
     for update of o skip locked
     limit p_limit
  )
  update public.push_notification_outbox as o
     set state = 'leased',
         attempts = o.attempts + 1,
         lease_owner = p_worker_id,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
    from ready
   where o.id = ready.id
  returning o.id, o.recipient_user_id, o.investigation_id, o.event_type,
            o.idempotency_key, o.attempts;
end;
$function$;

revoke all on function public.lease_push_notification_outbox(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.lease_push_notification_outbox(uuid, integer, integer)
  to service_role;

create or replace function public.finish_push_notification_outbox(
  p_notification_id uuid,
  p_worker_id uuid,
  p_result text,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_notification_id is null or p_worker_id is null
     or p_result not in ('sent', 'no_subscription', 'retry', 'dead')
     or (p_provider_message_id is not null and length(p_provider_message_id) not between 1 and 128)
     or (p_error_code is not null and p_error_code not in (
       'http_4xx', 'http_5xx', 'network', 'invalid_response', 'no_subscription',
       'rate_limited', 'credentials_unavailable'
     ))
     or (p_retry_after_seconds is not null and p_retry_after_seconds not between 1 and 3600) then
    raise exception 'invalid push completion' using errcode = '22023';
  end if;

  update public.push_notification_outbox as o
     set state = case
           when p_result in ('sent', 'no_subscription') then 'sent'
           when p_result = 'retry' and o.attempts < 5 then 'retry'
           else 'dead'
         end,
         provider_message_id = case when p_result = 'sent' then p_provider_message_id else null end,
         last_error_code = case
           when p_result = 'no_subscription' then 'no_subscription'
           else p_error_code
         end,
         next_attempt_at = case
           when p_result = 'retry' and o.attempts < 5 then
             clock_timestamp() + make_interval(
               secs => coalesce(p_retry_after_seconds, least(300, 5 * (2 ^ greatest(0, o.attempts - 1))::integer))
             )
           else o.next_attempt_at
         end,
         lease_owner = null,
         lease_expires_at = null,
         updated_at = clock_timestamp()
   where o.id = p_notification_id
     and o.state = 'leased'
     and o.lease_owner = p_worker_id
     and o.lease_expires_at > clock_timestamp();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$function$;

revoke all on function public.finish_push_notification_outbox(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.finish_push_notification_outbox(uuid, uuid, text, text, text, integer)
  to service_role;

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
  v_is_anonymous boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_user_id is null
     or v_is_anonymous then
    raise exception 'permanent authenticated user required' using errcode = '42501';
  end if;
  if p_notification_id is null
     or p_stage not in ('notification_opened', 'deep_link_opened') then
    raise exception 'invalid push open event' using errcode = '22023';
  end if;

  update public.push_notification_outbox as o
     set opened_at = coalesce(o.opened_at, clock_timestamp()),
         deep_link_opened_at = case
           when p_stage = 'deep_link_opened'
             then coalesce(o.deep_link_opened_at, clock_timestamp())
           else o.deep_link_opened_at
         end,
         updated_at = clock_timestamp()
   where o.id = p_notification_id
     and o.recipient_user_id = v_user_id
     and o.state = 'sent';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$function$;

revoke all on function public.record_push_notification_open(uuid, text)
  from public, anon;
grant execute on function public.record_push_notification_open(uuid, text)
  to authenticated, service_role;

create or replace function public.run_push_notification_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted bigint := 0;
begin
  delete from public.push_notification_outbox
   where created_at < clock_timestamp() - interval '30 days'
     and not (
       state = 'leased'
       and lease_expires_at > clock_timestamp()
     );
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('outbox_deleted', v_deleted);
end;
$function$;

revoke all on function public.run_push_notification_retention()
  from public, anon, authenticated;
grant execute on function public.run_push_notification_retention()
  to service_role;

-- pg_cronはJWT claimを持たないDB sessionで動くため、実行権限をservice_roleと
-- migration ownerに限定し、関数内でauth.role()を要求しない。18:20 UTCは既存の
-- data retention (18:00) / external cache GC (18:10) の後に直列化する。
do $schedule$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '202608300008: pg_cron not installed, skipping cron.schedule (push-notification-retention-daily)';
    return;
  end if;
  perform cron.schedule(
    'push-notification-retention-daily',
    '20 18 * * *',
    'select public.run_push_notification_retention();'
  );
end
$schedule$;
