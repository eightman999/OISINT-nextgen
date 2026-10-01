-- 110_growth_loop_metrics.sql — #541 Growth Loopの集計・privacy/RLS境界
-- scripts/test-rls.sh の専用scratch DBで実行する。

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-00000000541a', false),
  ('00000000-0000-4000-8000-00000000541b', false),
  ('00000000-0000-4000-8000-00000000541c', true);

insert into public.investigations (
  id, created_by, title, raw_query, status, share_token
)
values (
  '00000000-0000-4000-8000-000000005411',
  '00000000-0000-4000-8000-00000000541a',
  'growth fixture',
  '本文はgrowthへ保存しない',
  'draft',
  '54100000000000000000000000000001'
);

insert into public.investigation_members (investigation_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000005411',
  '00000000-0000-4000-8000-00000000541a',
  'owner'
);

-- 参加前のshare openは同一subjectで冪等。tokenはstateへ保存しない。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000541c","role":"authenticated","is_anonymous":true}';

do $$
begin
  if not public.record_growth_share_open('54100000000000000000000000000001')
     or not public.record_growth_share_open('54100000000000000000000000000001') then
    raise exception 'FAIL(110/share): valid share open was not recorded';
  end if;
  begin
    perform public.record_growth_share_open('broken-token');
    raise exception 'FAIL(110/share-invalid): malformed token was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
commit;

do $$
begin
  if (
    select count(*)
      from public.growth_actor_states
     where investigation_id = '00000000-0000-4000-8000-000000005411'
       and user_id = '00000000-0000-4000-8000-00000000541c'
       and share_opened_at is not null
  ) <> 1 then
    raise exception 'FAIL(110/share-dedupe): share open was not compressed to one state';
  end if;
end;
$$;

insert into public.investigation_members (investigation_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000005411',
  '00000000-0000-4000-8000-00000000541c',
  'editor'
);

insert into public.requirements (
  id, investigation_id, created_by, text, normalized_text, kind, priority, weight
)
values (
  '00000000-0000-4000-8000-000000005412',
  '00000000-0000-4000-8000-000000005411',
  '00000000-0000-4000-8000-00000000541c',
  '条件本文はgrowthへ入れない',
  '条件本文はgrowthへ入れない',
  'other',
  'should',
  1
);

insert into public.places (id, provider, provider_place_id, name)
values
  ('00000000-0000-4000-8000-000000005413', 'mock', 'growth-541-a', '店名A'),
  ('00000000-0000-4000-8000-000000005414', 'mock', 'growth-541-b', '店名B');

insert into public.candidates (id, investigation_id, place_id, score, rank)
values
  (
    '00000000-0000-4000-8000-000000005415',
    '00000000-0000-4000-8000-000000005411',
    '00000000-0000-4000-8000-000000005413',
    0.8,
    1
  ),
  (
    '00000000-0000-4000-8000-000000005416',
    '00000000-0000-4000-8000-000000005411',
    '00000000-0000-4000-8000-000000005414',
    0.7,
    2
  );

insert into public.votes (investigation_id, candidate_id, user_id, value)
values (
  '00000000-0000-4000-8000-000000005411',
  '00000000-0000-4000-8000-000000005415',
  '00000000-0000-4000-8000-00000000541c',
  1
);

-- コメントだけの更新はvote_castに数えず、投票値の変更だけを数える。
update public.votes
   set comment = '本文はgrowthへ入れない'
 where candidate_id = '00000000-0000-4000-8000-000000005415'
   and user_id = '00000000-0000-4000-8000-00000000541c';

update public.votes
   set value = 0
 where candidate_id = '00000000-0000-4000-8000-000000005415'
   and user_id = '00000000-0000-4000-8000-00000000541c';

insert into public.investigation_events (
  investigation_id, event_type, message, metadata
)
values (
  '00000000-0000-4000-8000-000000005411',
  'ranking_completed',
  'baseline',
  '{}'::jsonb
);

update public.candidates
   set rank = case
     when id = '00000000-0000-4000-8000-000000005415' then 2
     else 1
   end
 where investigation_id = '00000000-0000-4000-8000-000000005411';

insert into public.investigation_events (
  investigation_id, event_type, message, metadata
)
values (
  '00000000-0000-4000-8000-000000005411',
  'ranking_completed',
  'changed',
  '{}'::jsonb
);

-- participant returnは繰り返し呼んでもtimestamp 1個へ圧縮する。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000541c","role":"authenticated","is_anonymous":true}';
select public.record_growth_share_open('54100000000000000000000000000001');
select public.record_growth_return('00000000-0000-4000-8000-000000005411');
select public.record_growth_return('00000000-0000-4000-8000-000000005411');
commit;

-- 参加者が次の調査を作ると、直近のGroup Session 1件だけへ帰属する。
insert into public.investigations (
  id, created_by, title, raw_query, status
)
values (
  '00000000-0000-4000-8000-000000005417',
  '00000000-0000-4000-8000-00000000541c',
  'next fixture',
  '次回本文もgrowthへ保存しない',
  'draft'
);

update public.investigations
   set status = 'complete'
 where id = '00000000-0000-4000-8000-000000005411';

-- OneSignal #540 の送信済み通知を本人が開くと、return via pushへ圧縮される。
insert into public.push_notification_outbox (
  id, recipient_user_id, investigation_id, event_type, dedupe_key,
  idempotency_key, state
)
values (
  '00000000-0000-4000-8000-000000005418',
  '00000000-0000-4000-8000-00000000541c',
  '00000000-0000-4000-8000-000000005411',
  'ranking_changed',
  'ranking_changed:00000000-0000-4000-8000-000000005411:00000000-0000-4000-8000-00000000541c:growth_test',
  '00000000-0000-4000-8000-000000005419',
  'sent'
);

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000541c","role":"authenticated","is_anonymous":true}';

do $$
declare
  v_metrics jsonb;
begin
  if not public.record_push_notification_open(
    '00000000-0000-4000-8000-000000005418',
    'notification_opened'
  ) then
    raise exception 'FAIL(110/push-return): own push open was rejected';
  end if;

  v_metrics := public.get_growth_session_metrics(
    '00000000-0000-4000-8000-000000005411'
  );
  if v_metrics ->> 'schema' <> 'oisint.growth_session.v1'
     or (v_metrics -> 'events' ->> 'share_opened')::bigint <> 1
     or (v_metrics -> 'events' ->> 'participant_joined')::bigint <> 1
     or (v_metrics -> 'events' ->> 'participant_activated')::bigint <> 1
     or (v_metrics -> 'events' ->> 'requirement_added')::bigint <> 1
     or (v_metrics -> 'events' ->> 'vote_cast')::bigint <> 2
     or (v_metrics -> 'events' ->> 'ranking_changed')::bigint <> 1
     or (v_metrics -> 'events' ->> 'participant_returned')::bigint <> 1
     or (v_metrics -> 'events' ->> 'participant_returned_7d')::bigint <> 1
     or (v_metrics -> 'events' ->> 'participant_returned_via_push')::bigint <> 1
     or (v_metrics -> 'events' ->> 'participant_created_new_investigation')::bigint <> 1
     or (v_metrics -> 'derived' ->> 'group_completed')::boolean is not true then
    raise exception 'FAIL(110/metrics): unexpected metrics %', v_metrics;
  end if;
  if v_metrics::text ~* '(raw_query|display_name|taste|share_token|user_id|investigation_id)' then
    raise exception 'FAIL(110/privacy-json): unsafe field appeared in metrics %', v_metrics;
  end if;
end;
$$;
commit;

-- 非memberはsession aggregateも読めない。clientの直接テーブル権限もない。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000541b","role":"authenticated","is_anonymous":false}';

do $$
begin
  if has_table_privilege('authenticated', 'public.growth_actor_states', 'select')
     or has_table_privilege('authenticated', 'public.growth_ranking_states', 'select')
     or has_table_privilege('authenticated', 'public.growth_session_metrics', 'select') then
    raise exception 'FAIL(110/rls): authenticated has direct growth table/view access';
  end if;
  begin
    perform public.get_growth_session_metrics(
      '00000000-0000-4000-8000-000000005411'
    );
    raise exception 'FAIL(110/member): outsider read group metrics';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;

-- opt-outすると本人の圧縮stateを即時削除し、以後のGroup集計から除外する。
insert into public.investigation_members (investigation_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000005411',
  '00000000-0000-4000-8000-00000000541b',
  'editor'
);
insert into public.private_analytics_opt_outs (user_id)
values ('00000000-0000-4000-8000-00000000541b');

do $$
begin
  if exists (
    select 1 from public.growth_actor_states
     where user_id = '00000000-0000-4000-8000-00000000541b'
  ) then
    raise exception 'FAIL(110/optout): opted-out state remained';
  end if;
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('growth_actor_states', 'growth_ranking_states')
       and column_name in (
         'raw_query', 'display_name', 'requirement_text', 'taste_profile',
         'share_token', 'restaurant_name', 'notification_body'
       )
  ) then
    raise exception 'FAIL(110/privacy-schema): unsafe growth column exists';
  end if;

end;
$$;

begin;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$
declare
  v_kpis jsonb;
begin
  v_kpis := public.get_growth_loop_kpis(
    clock_timestamp() - interval '1 day',
    clock_timestamp()
  );
  if v_kpis ->> 'schema' <> 'oisint.growth_kpis.v1'
     or v_kpis::text ~* '(raw_query|display_name|taste|share_token|user_id|investigation_id)' then
    raise exception 'FAIL(110/kpis): unsafe or invalid KPI response %', v_kpis;
  end if;
end;
$$;
rollback;

-- 調査の保持期限匿名化時は関連Growth状態を削除する。
update public.investigations
   set anonymized_at = clock_timestamp()
 where id = '00000000-0000-4000-8000-000000005411';

do $$
begin
  if exists (
    select 1 from public.growth_actor_states
     where investigation_id = '00000000-0000-4000-8000-000000005411'
  ) or exists (
    select 1 from public.growth_ranking_states
     where investigation_id = '00000000-0000-4000-8000-000000005411'
  ) then
    raise exception 'FAIL(110/retention): anonymized investigation growth state remained';
  end if;
end;
$$;
