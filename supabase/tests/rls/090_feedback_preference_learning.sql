-- =============================================================================
-- 090_feedback_preference_learning.sql — #515 本人opt-in / receipt / RLS境界
-- =============================================================================

create extension if not exists dblink;

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000090a'),
  ('00000000-0000-0000-0000-00000000090b'),
  ('00000000-0000-0000-0000-00000000090c');

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000090a', 'Alice 090'),
  ('00000000-0000-0000-0000-00000000090b', 'Bob 090'),
  ('00000000-0000-0000-0000-00000000090c', 'Carol 090');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000901', 'fixture', '090', 'Shared place 090');

insert into public.place_feedback (id, place_id, user_id, rating, aspect, aspect_value)
values
  ('00000000-0000-0000-0000-000000000902',
   '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-00000000090a', 1, 'noise', 'quiet'),
  ('00000000-0000-0000-0000-000000000903',
   '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-00000000090b', 1, 'noise', 'loud'),
  ('00000000-0000-0000-0000-000000000904',
   '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-00000000090a', 1, 'noise', 'quiet');

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'preference_signal_receipts'
      and column_name in ('feedback_id', 'place_id', 'aspect_value')
  ) then
    raise exception 'FAIL(090/schema): receipt exposes feedback/place identity or raw value';
  end if;
end $$;

-- 保存だけでは学習行もreceiptも作られない（opt-inは別RPC呼出し）。
do $$
begin
  if exists (
    select 1 from public.user_preference_profiles
     where user_id = '00000000-0000-0000-0000-00000000090a'
  ) then
    raise exception 'FAIL(090/default-off): profile exists before explicit opt-in';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000090a","role":"authenticated","is_anonymous":false}';

select public.save_place_feedback_learning(
  '00000000-0000-0000-0000-000000000902',
  null,
  '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
  '{}'::text[],
  '{}'::text[],
  '{}'::jsonb,
  'personalization-v2',
  null::timestamptz,
  false
);

do $$
begin
  if (select count(*) from public.user_preference_profiles
      where user_id = '00000000-0000-0000-0000-00000000090a') <> 1
    or not exists (
      select 1 from public.user_preference_profiles
       where user_id = '00000000-0000-0000-0000-00000000090a'
         and source_kinds @> array['feedback']::text[]
    )
    or (select count(*) from public.preference_signal_receipts
        where user_id = '00000000-0000-0000-0000-00000000090a') <> 1
  then
    raise exception 'FAIL(090/opt-in): feedback profile or receipt missing';
  end if;
  if (select count(*) from public.user_product_audit_events
      where actor_user_id = '00000000-0000-0000-0000-00000000090a'
        and source = 'feedback') <> 1 then
    raise exception 'FAIL(090/audit): feedback audit missing';
  end if;
end $$;

-- forged aggregateはDB境界で拒否し、receiptを先に作らない。
do $$
begin
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-0000-0000-000000000902', null,
      '{"evidence":101,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], '{}'::jsonb,
      'personalization-v2',
      (select updated_at from public.user_preference_profiles where user_id = auth.uid()),
      true
    );
    raise exception 'FAIL(090/payload): forged aggregate was accepted';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.preference_signal_receipts
      where user_id = '00000000-0000-0000-0000-00000000090a') <> 1 then
    raise exception 'FAIL(090/payload): forged aggregate created receipt';
  end if;
end $$;

-- 有効範囲内でもhealth軸をfeedback経路から差し替えられない。
do $$
begin
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-0000-0000-000000000902', null,
      '{"evidence":50,"health":49,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], '{}'::jsonb,
      'personalization-v2',
      (select updated_at from public.user_preference_profiles where user_id = auth.uid()),
      true
    );
    raise exception 'FAIL(090/health): forged health axis was accepted';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.preference_signal_receipts
      where user_id = '00000000-0000-0000-0000-00000000090a') <> 1 then
    raise exception 'FAIL(090/health): rejected payload created receipt';
  end if;
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-0000-0000-000000000902', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], '{"axes":{"health":{"mean":49}}}'::jsonb,
      'personalization-v2',
      (select updated_at from public.user_preference_profiles where user_id = auth.uid()),
      true
    );
    raise exception 'FAIL(090/health): forged health belief was accepted';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- 同一signalはreceiptで二重適用しない。
select public.save_place_feedback_learning(
  '00000000-0000-0000-0000-000000000902',
  null,
  '{"evidence":50,"health":50,"quiet":20,"value":50,"novelty":50,"groupFit":50}'::jsonb,
  '{}'::text[],
  '{}'::text[],
  '{}'::jsonb,
  'personalization-v2',
  (select updated_at from public.user_preference_profiles where user_id = auth.uid()),
  true
);

do $$
begin
  if (select count(*) from public.user_preference_profiles
      where user_id = '00000000-0000-0000-0000-00000000090a') <> 1
    or (select count(*) from public.preference_signal_receipts
        where user_id = '00000000-0000-0000-0000-00000000090a') <> 1
  then
    raise exception 'FAIL(090/idempotence): duplicate signal changed profile or receipt';
  end if;
end $$;

-- 同じfeedbackを編集した場合は、DBが実値から新revisionを作る。
select public.update_place_feedback(
  '00000000-0000-0000-0000-000000000901'::uuid,
  '00000000-0000-0000-0000-000000000902'::uuid,
  null::date, -1::smallint, 'noise', 'loud'
);
select public.save_place_feedback_learning(
  '00000000-0000-0000-0000-000000000902',
  null,
  '{"evidence":50,"health":50,"quiet":20,"value":50,"novelty":50,"groupFit":50}'::jsonb,
  '{}'::text[], '{}'::text[], '{}'::jsonb,
  'personalization-v2',
  (select updated_at from public.user_preference_profiles where user_id = auth.uid()),
  true
);
do $$
begin
  if (select count(*) from public.preference_signal_receipts
      where user_id = '00000000-0000-0000-0000-00000000090a') <> 2 then
    raise exception 'FAIL(090/revision): edited feedback did not get a new server revision';
  end if;
end $$;

-- 他人のfeedbackを指定した場合はプロフィールもreceiptも更新できない。
do $$
begin
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-0000-0000-000000000903',
      null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], '{}'::jsonb,
      'personalization-v2',
      null::timestamptz,
      false
    );
    raise exception 'FAIL(090/owner): cross-user feedback was accepted';
  exception when sqlstate '42501' then null;
  end;
  if (select count(*) from public.preference_signal_receipts
      where user_id = '00000000-0000-0000-0000-00000000090a') <> 2 then
    raise exception 'FAIL(090/owner): cross-user call changed A receipt count';
  end if;
end $$;

-- receiptは直接書込み不可。
do $$
begin
  begin
    insert into public.preference_signal_receipts (user_id, event_digest, source_kind)
    values (auth.uid(), repeat('a', 32), 'feedback');
    raise exception 'FAIL(090/acl): authenticated inserted receipt directly';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 別ユーザーはAのprofileを見られない。
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000090b","role":"authenticated","is_anonymous":false}';
do $$
begin
  if exists (select 1 from public.user_preference_profiles
              where user_id = '00000000-0000-0000-0000-00000000090a') then
    raise exception 'FAIL(090/rls): B can read A profile';
  end if;
end $$;

-- anonymousはprofile保存RPCを実行できない。
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000090c","role":"authenticated","is_anonymous":true}';
do $$
begin
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-0000-0000-000000000902', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], '{}'::jsonb,
      'personalization-v2',
      (select updated_at from public.user_preference_profiles where user_id = auth.uid()),
      true
    );
    raise exception 'FAIL(090/anonymous): anonymous learning accepted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- reset/deleteはreceiptも削除する。
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000090a","role":"authenticated","is_anonymous":false}';

-- 同じfeedbackを2接続から同時適用しても、主キーreceiptが一方だけを通す。
-- dblinkはこのscratch DB内のpostgresへ固定接続し、production URLを受け取らない。
commit;
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000090a","role":"authenticated","is_anonymous":false}';
select dblink_connect(
  'feedback_dup_1',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'feedback_dup_2',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('feedback_dup_1', 'set role authenticated');
select dblink_exec('feedback_dup_2', 'set role authenticated');
select dblink_exec(
  'feedback_dup_1',
  $$set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000090a","role":"authenticated","is_anonymous":false}'$$
);
select dblink_exec(
  'feedback_dup_2',
  $$set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000090a","role":"authenticated","is_anonymous":false}'$$
);
select dblink_exec('feedback_dup_1', 'begin');
select dblink_exec('feedback_dup_2', 'begin');
select dblink_send_query(
  'feedback_dup_1',
  $$select public.save_place_feedback_learning(
    '00000000-0000-0000-0000-000000000904', null,
    '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[], '{}'::jsonb, 'personalization-v2'
    , (select updated_at from public.user_preference_profiles where user_id = auth.uid()), true
  )$$
);
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_dup_1') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_dup_1') <> 0 then
    raise exception 'FAIL(090/concurrency): first feedback RPC did not finish';
  end if;
end $$;
create temporary table feedback_dup_first(applied boolean);
insert into feedback_dup_first(applied)
  select applied
    from dblink_get_result('feedback_dup_1') as result(applied boolean);
-- dblinkは複数結果を返す実装でも接続をidleへ戻す。
select count(*) from dblink_get_result('feedback_dup_1') as result(applied boolean);
select dblink_send_query(
  'feedback_dup_2',
  $$select public.save_place_feedback_learning(
    '00000000-0000-0000-0000-000000000904', null,
    '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[], '{}'::jsonb, 'personalization-v2'
    , (select updated_at from public.user_preference_profiles where user_id = auth.uid()), true
  )$$
);
select dblink_exec('feedback_dup_1', 'commit');
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_dup_2') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_dup_2') <> 0 then
    raise exception 'FAIL(090/concurrency): duplicate feedback RPC did not finish';
  end if;
end $$;
create temporary table feedback_dup_second(applied boolean);
insert into feedback_dup_second(applied)
  select applied
    from dblink_get_result('feedback_dup_2') as result(applied boolean);
select count(*) from dblink_get_result('feedback_dup_2') as result(applied boolean);
select dblink_exec('feedback_dup_2', 'commit');
select dblink_disconnect('feedback_dup_1');
select dblink_disconnect('feedback_dup_2');
do $$
begin
  if not (select applied from feedback_dup_first)
    or (select applied from feedback_dup_second)
    or (select count(*) from public.preference_signal_receipts
        where user_id = '00000000-0000-0000-0000-00000000090a') <> 3 then
    raise exception 'FAIL(090/concurrency): same feedback was applied more than once';
  end if;
end $$;

select public.delete_user_preference_profile();
do $$
begin
  if exists (select 1 from public.user_preference_profiles
              where user_id = '00000000-0000-0000-0000-00000000090a')
    or exists (select 1 from public.preference_signal_receipts
                where user_id = '00000000-0000-0000-0000-00000000090a') then
    raise exception 'FAIL(090/delete): profile or feedback receipt remains';
  end if;
end $$;

rollback;
