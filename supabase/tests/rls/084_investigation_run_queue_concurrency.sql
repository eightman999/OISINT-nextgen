-- 084_investigation_run_queue_concurrency.sql — #579 真のclaim/terminal並行回帰
--
-- 083の同一接続テストに加えて、dblinkの2接続で stale run の再claimを
-- advisory lock保持中に開始し、旧ownerのfailure RPCが新ownerを上書きしない
-- ことを確認する。専用scratch DB以外へ接続しない（088と同じ固定経路）。

create extension if not exists dblink;

create or replace function public.test_assert_084(ok boolean, message text)
returns void language plpgsql as $$
begin
  if not ok then raise exception '%', message; end if;
end $$;

begin;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000000841', false),
  ('00000000-0000-4000-8000-000000000844', false),
  ('00000000-0000-4000-8000-000000000845', false);

insert into public.investigations (id, created_by, title, raw_query, status)
values (
  '00000000-0000-4000-8000-000000000084',
  '00000000-0000-4000-8000-000000000841',
  'Run queue concurrency fixture 084',
  'run queue concurrency fixture 084',
  'searching'
);

insert into public.investigation_runs (
  id, investigation_id, status, acceptance_state, accepted_at,
  request_id, lease_owner, lease_expires_at, attempts, current_step
)
values (
  '00000000-0000-4000-8000-000000000842',
  '00000000-0000-4000-8000-000000000084',
  'running',
  'accepted',
  clock_timestamp() - interval '1 minute',
  '00000000-0000-4000-8000-000000000843',
  '00000000-0000-4000-8000-000000000844',
  clock_timestamp() - interval '1 second',
  1,
  'searching'
);

commit;

select dblink_connect(
  'run_queue_new',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'run_queue_old',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('run_queue_new', 'begin');
select dblink_exec('run_queue_old', 'begin');

-- 新ownerがadvisory lockを保持したまま stale runを再claimする。
select public.test_assert_084(
  dblink_send_query(
    'run_queue_new',
    $$select run_id, acquired, status, accepted
        from public.claim_investigation_run(
          '00000000-0000-4000-8000-000000000084',
          '00000000-0000-4000-8000-000000000845',
          180,
          '00000000-0000-4000-8000-000000000846',
          false
        )$$
  ) = 1,
  'FAIL(084/a): new owner claim was not dispatched'
);
create temporary table run_queue_new_result(
  run_id uuid,
  acquired boolean,
  status text,
  accepted boolean
);
insert into run_queue_new_result(run_id, acquired, status, accepted)
  select run_id, acquired, status, accepted
    from dblink_get_result('run_queue_new')
      as result(run_id uuid, acquired boolean, status text, accepted boolean);
select * from dblink_get_result('run_queue_new')
  as result(run_id uuid, acquired boolean, status text, accepted boolean);
select public.test_assert_084(
  (select run_id = '00000000-0000-4000-8000-000000000842'
      and acquired
      and status = 'running'
      and accepted
     from run_queue_new_result),
  'FAIL(084/b): stale run did not converge to the same run/new owner claim'
);

-- 旧workerのfailure RPCは同じadvisory lockの解放まで待つ。
select public.test_assert_084(
  dblink_send_query(
    'run_queue_old',
    $$select failure_count, terminal
        from public.record_investigation_run_failure(
          '00000000-0000-4000-8000-000000000842',
          '00000000-0000-4000-8000-000000000844',
          'searching',
          'stale_worker',
          3,
          '00000000-0000-4000-8000-000000000847'
        )$$
  ) = 1,
  'FAIL(084/c): stale failure was not dispatched'
);
select pg_sleep(0.2);
select public.test_assert_084(
  dblink_is_busy('run_queue_old') = 1,
  'FAIL(084/d): terminal failure did not wait for the new owner lock'
);

select dblink_exec('run_queue_new', 'commit');
create temporary table run_queue_old_result(failure_count integer, terminal boolean);
insert into run_queue_old_result(failure_count, terminal)
  select failure_count, terminal
    from dblink_get_result('run_queue_old')
      as result(failure_count integer, terminal boolean);
select * from dblink_get_result('run_queue_old')
  as result(failure_count integer, terminal boolean);
select public.test_assert_084(
  (select failure_count = 0 and not terminal from run_queue_old_result),
  'FAIL(084/e): stale worker changed failure state after reclaim'
);
select dblink_exec('run_queue_old', 'commit');
select dblink_disconnect('run_queue_new');
select dblink_disconnect('run_queue_old');

select public.test_assert_084(
  (select status = 'running'
      and lease_owner = '00000000-0000-4000-8000-000000000845'
      and step_failures = '{}'::jsonb
     from public.investigation_runs
    where id = '00000000-0000-4000-8000-000000000842'),
  'FAIL(084/f): new owner state was overwritten by stale worker'
);

select '084_investigation_run_queue_concurrency.sql: all assertions passed' as result;

drop function public.test_assert_084(boolean, text);
