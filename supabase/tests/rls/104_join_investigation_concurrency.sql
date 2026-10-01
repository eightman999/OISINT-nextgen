-- =============================================================================
-- 104_join_investigation_concurrency.sql — Issue #598
-- =============================================================================
-- 19人の調査へ2接続から同時joinし、investigation行ロック後の再判定で
-- 20人を超えないことを確認する。21人目のfull結果ではprofile/member/event
-- を作らない。接続経路はローカルscratch DBだけに限定した既存ハーネスと同じ。

create extension if not exists dblink;

create function pg_temp.assert_104(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'FAIL(104/%): assertion failed', p_message;
  end if;
end;
$$;

-- owner + 18 members = 19。Aが20人目、Bが21人目になるfixture。
insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000001041', false),
  ('00000000-0000-4000-8000-000000001042', false),
  ('00000000-0000-4000-8000-000000001043', false);

insert into auth.users (id, is_anonymous)
select md5('join-104-member-' || n)::uuid, false
  from generate_series(1, 18) as n;

insert into public.investigations (
  id,
  created_by,
  title,
  raw_query,
  share_token
) values (
  '00000000-0000-4000-8000-000000001040',
  '00000000-0000-4000-8000-000000001041',
  'Join concurrency fixture 104',
  'join concurrency fixture 104',
  'rls104_join_concurrency_token_0000000000001'
);

insert into public.investigation_members (investigation_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000001040',
  '00000000-0000-4000-8000-000000001041',
  'owner'
);

insert into public.investigation_members (investigation_id, user_id, role)
select
  '00000000-0000-4000-8000-000000001040',
  md5('join-104-member-' || n)::uuid,
  'editor'
from generate_series(1, 18) as n;

select pg_temp.assert_104(
  (select count(*) = 19
     from public.investigation_members
    where investigation_id = '00000000-0000-4000-8000-000000001040'),
  'fixture-count'
);

select dblink_connect(
  'join_104_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'join_104_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('join_104_a', 'set role service_role');
select dblink_exec('join_104_b', 'set role service_role');
select dblink_exec('join_104_a', 'begin');
select dblink_exec('join_104_b', 'begin');

-- Aは調査行を取得してから20人目を追加し、transactionを保持する。
-- Bは同じ行lockで待機するため、Aのcommit後にのみcountを再評価できる。
select pg_temp.assert_104(
  dblink_send_query(
    'join_104_a',
    $$do $proc$
    begin
      if not exists (
        select 1
          from public.join_investigation(
            'rls104_join_concurrency_token_0000000000001',
            '00000000-0000-4000-8000-000000001042'::uuid,
            'Concurrent A'
          )
         where status = 'joined'
      ) then
        raise exception 'first concurrent join did not succeed';
      end if;
      perform pg_sleep(1);
    end;
    $proc$;$$
  ) = 1,
  'first-dispatch'
);

select pg_sleep(0.1);

select pg_temp.assert_104(
  dblink_send_query(
    'join_104_b',
    $$select status
        from public.join_investigation(
          'rls104_join_concurrency_token_0000000000001',
          '00000000-0000-4000-8000-000000001043'::uuid,
          'Concurrent B'
        )$$
  ) = 1,
  'second-dispatch'
);

select pg_temp.assert_104(
  dblink_is_busy('join_104_b') = 1,
  'second-waits-on-investigation-lock'
);

do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('join_104_a') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('join_104_a') <> 0 then
    raise exception 'FAIL(104/first-finished): first concurrent join did not finish';
  end if;
end;
$$;

-- DOは行を返さないが、dblink_get_resultはPGresultを複数返すため、
-- 関数結果と末尾のcommand結果を両方drainしてからcommitする。
select * from dblink_get_result('join_104_a', false) as result(message text);
select count(*) from dblink_get_result('join_104_a', false) as result(message text);
select dblink_exec('join_104_a', 'commit');

do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('join_104_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('join_104_b') <> 0 then
    raise exception 'FAIL(104/second-finished): second concurrent join did not finish';
  end if;
end;
$$;

create temporary table join_104_second_result(status text);
insert into join_104_second_result(status)
  select status
    from dblink_get_result('join_104_b', false) as result(status text);
-- SELECT行結果に続くcommand結果も消費してからcommitする。
select count(*) from dblink_get_result('join_104_b', false) as result(status text);
select dblink_exec('join_104_b', 'commit');
select dblink_disconnect('join_104_a');
select dblink_disconnect('join_104_b');

select pg_temp.assert_104(
  (select status = 'full' from join_104_second_result),
  'second-is-full'
);
select pg_temp.assert_104(
  (select count(*) = 20
     from public.investigation_members
    where investigation_id = '00000000-0000-4000-8000-000000001040'),
  'member-cap'
);
select pg_temp.assert_104(
  not exists (
    select 1 from public.profiles
     where id = '00000000-0000-4000-8000-000000001043'
  ),
  'full-does-not-upsert-profile'
);
select pg_temp.assert_104(
  not exists (
    select 1 from public.investigation_members
     where investigation_id = '00000000-0000-4000-8000-000000001040'
       and user_id = '00000000-0000-4000-8000-000000001043'
  ),
  'full-does-not-insert-member'
);
select pg_temp.assert_104(
  (select count(*) = 1
     from public.investigation_events
    where investigation_id = '00000000-0000-4000-8000-000000001040'
      and event_type = 'member_joined'),
  'full-does-not-insert-event'
);
select pg_temp.assert_104(
  (select role = 'editor'
     from public.investigation_members
    where investigation_id = '00000000-0000-4000-8000-000000001040'
      and user_id = '00000000-0000-4000-8000-000000001042'),
  'successful-join-role'
);

-- 上限到達後も既参加ユーザーの再joinは冪等成功し、eventは増えない。
do $$
declare
  v_status text;
begin
  select status
    into v_status
    from public.join_investigation(
      'rls104_join_concurrency_token_0000000000001',
      '00000000-0000-4000-8000-000000001042'::uuid,
      'Concurrent A再表示'
    );
  if v_status <> 'already_member' then
    raise exception 'FAIL(104/rejoin): expected already_member, got %', v_status;
  end if;
end;
$$;
select pg_temp.assert_104(
  (select count(*) = 1
     from public.investigation_events
    where investigation_id = '00000000-0000-4000-8000-000000001040'
      and event_type = 'member_joined'),
  'rejoin-does-not-insert-event'
);

select '104_join_investigation_concurrency.sql: all assertions passed' as result;
