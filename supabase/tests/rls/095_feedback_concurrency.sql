-- =============================================================================
-- 095_feedback_concurrency.sql — #110 / #157 distinct-user serialization
-- =============================================================================
--
-- 094 は同一接続の privacy assertions、ここでは dblink の独立 transaction
-- で submit/update を同時に実行する。seed/cleanup は専用 scratch DB 内だけで
-- 行い、外部 DB 名は current_database() からしか組み立てない。

create extension if not exists dblink;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000000951', false),
  ('00000000-0000-4000-8000-000000000952', false),
  ('00000000-0000-4000-8000-000000000953', false);

insert into public.places (id, provider, provider_place_id, name)
values (
  '00000000-0000-4000-8000-000000000954',
  'fixture', '095-concurrent', 'Concurrent feedback'
);

set role service_role;
insert into public.place_feedback
  (id, place_id, user_id, visited_at, rating, aspect, aspect_value)
values (
  '00000000-0000-4000-8000-000000000955',
  '00000000-0000-4000-8000-000000000954',
  '00000000-0000-4000-8000-000000000951',
  date '2026-08-01', 1, 'noise', 'quiet'
);
reset role;

-- 1) 既存1 user + 同時 submit 2 users: advisory lock 後に3 distinct usersへ収束。
select dblink_connect(
  'feedback_concurrent_submit_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'feedback_concurrent_submit_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('feedback_concurrent_submit_a', 'set role authenticated');
select dblink_exec('feedback_concurrent_submit_b', 'set role authenticated');
select dblink_exec(
  'feedback_concurrent_submit_a',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000952","role":"authenticated"}'$$
);
select dblink_exec(
  'feedback_concurrent_submit_b',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000953","role":"authenticated"}'$$
);
select dblink_exec('feedback_concurrent_submit_a', 'begin');
select dblink_exec('feedback_concurrent_submit_b', 'begin');
select dblink_send_query(
  'feedback_concurrent_submit_a',
  $$select public.submit_place_feedback(
    '00000000-0000-4000-8000-000000000954',
    date '2026-08-02', 0::smallint, 'noise', 'quiet'
  )$$
);
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_concurrent_submit_a') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_concurrent_submit_a') <> 0 then
    raise exception 'FAIL(095/submit-first): first submit did not finish';
  end if;
end;
$$;
create temporary table feedback_concurrent_submit_a_result(id uuid);
insert into feedback_concurrent_submit_a_result(id)
  select id
    from dblink_get_result('feedback_concurrent_submit_a') as result(id uuid);
select count(*) from dblink_get_result('feedback_concurrent_submit_a') as result(id uuid);
select dblink_send_query(
  'feedback_concurrent_submit_b',
  $$select public.submit_place_feedback(
    '00000000-0000-4000-8000-000000000954',
    date '2026-08-03', -1::smallint, 'noise', 'quiet'
  )$$
);
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_concurrent_submit_b') = 1;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_concurrent_submit_b') <> 1 then
    raise exception 'FAIL(095/submit-lock): second submit did not wait for advisory lock';
  end if;
end;
$$;
select dblink_exec('feedback_concurrent_submit_a', 'commit');
create temporary table feedback_concurrent_submit_b_result(id uuid);
insert into feedback_concurrent_submit_b_result(id)
  select id
    from dblink_get_result('feedback_concurrent_submit_b') as result(id uuid);
select count(*) from dblink_get_result('feedback_concurrent_submit_b') as result(id uuid);
select dblink_exec('feedback_concurrent_submit_b', 'commit');
select dblink_disconnect('feedback_concurrent_submit_a');
select dblink_disconnect('feedback_concurrent_submit_b');

do $$
declare
  v_users integer;
  v_facts integer;
begin
  select count(distinct user_id), count(*)
    into v_users, v_facts
    from public.place_feedback
   where place_id = '00000000-0000-4000-8000-000000000954'
     and aspect = 'noise' and aspect_value = 'quiet';
  if v_users <> 3 or v_facts <> 3 then
    raise exception 'FAIL(095/submit-count): expected 3 rows from 3 users, got users=% rows=%',
      v_users, v_facts;
  end if;
  if not exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000954'
       and key = 'noise_level'
       and evidence_count = 3
       and value->>'value' = 'quiet'
  ) then
    raise exception 'FAIL(095/submit-fact): concurrent submits did not create one fact';
  end if;
end;
$$;

-- 2) 3-user fact + 同時 update 2 rows: old value は threshold 未満へ下がり、
--    advisory lock 後の両 transaction が stale fact を残さない。
select dblink_connect(
  'feedback_concurrent_update_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'feedback_concurrent_update_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('feedback_concurrent_update_a', 'set role authenticated');
select dblink_exec('feedback_concurrent_update_b', 'set role authenticated');
select dblink_exec(
  'feedback_concurrent_update_a',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated"}'$$
);
select dblink_exec(
  'feedback_concurrent_update_b',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000952","role":"authenticated"}'$$
);
select dblink_exec('feedback_concurrent_update_a', 'begin');
select dblink_exec('feedback_concurrent_update_b', 'begin');
select dblink_send_query(
  'feedback_concurrent_update_a',
  $$select public.update_place_feedback(
    '00000000-0000-4000-8000-000000000954',
    (select id from public.place_feedback
      where place_id = '00000000-0000-4000-8000-000000000954'
        and user_id = '00000000-0000-4000-8000-000000000951'
      order by created_at, id limit 1),
    null::date, null::smallint, 'noise', 'loud'
  )$$
);
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_concurrent_update_a') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_concurrent_update_a') <> 0 then
    raise exception 'FAIL(095/update-first): first update did not finish';
  end if;
end;
$$;
create temporary table feedback_concurrent_update_a_result(id uuid);
insert into feedback_concurrent_update_a_result(id)
  select id
    from dblink_get_result('feedback_concurrent_update_a') as result(id uuid);
select count(*) from dblink_get_result('feedback_concurrent_update_a') as result(id uuid);
select dblink_send_query(
  'feedback_concurrent_update_b',
  $$select public.update_place_feedback(
    '00000000-0000-4000-8000-000000000954',
    (select id from public.place_feedback
      where place_id = '00000000-0000-4000-8000-000000000954'
        and user_id = '00000000-0000-4000-8000-000000000952'
      order by created_at, id limit 1),
    null::date, null::smallint, 'noise', 'loud'
  )$$
);
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_concurrent_update_b') = 1;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_concurrent_update_b') <> 1 then
    raise exception 'FAIL(095/update-lock): second update did not wait for advisory lock';
  end if;
end;
$$;
select dblink_exec('feedback_concurrent_update_a', 'commit');
create temporary table feedback_concurrent_update_b_result(id uuid);
insert into feedback_concurrent_update_b_result(id)
  select id
    from dblink_get_result('feedback_concurrent_update_b') as result(id uuid);
select count(*) from dblink_get_result('feedback_concurrent_update_b') as result(id uuid);
select dblink_exec('feedback_concurrent_update_b', 'commit');
select dblink_disconnect('feedback_concurrent_update_a');
select dblink_disconnect('feedback_concurrent_update_b');

do $$
begin
  if exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000954'
       and key = 'noise_level'
  ) then
    raise exception 'FAIL(095/update-fact): stale fact survived concurrent threshold drop';
  end if;
end;
$$;

-- cleanup is explicit because the dblink transactions were committed.
set role service_role;
delete from public.place_facts where place_id = '00000000-0000-4000-8000-000000000954';
delete from public.place_feedback where place_id = '00000000-0000-4000-8000-000000000954';
reset role;
delete from public.places where id = '00000000-0000-4000-8000-000000000954';
delete from auth.users
 where id in (
   '00000000-0000-4000-8000-000000000951',
   '00000000-0000-4000-8000-000000000952',
   '00000000-0000-4000-8000-000000000953'
 );

\echo == 095_feedback_concurrency.sql: all assertions passed
