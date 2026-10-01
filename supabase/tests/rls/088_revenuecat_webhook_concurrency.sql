-- 088_revenuecat_webhook_concurrency.sql — 同一subjectの真の並行 webhook 回帰
--
-- test-rls.sh の専用scratch DBでのみ実行する。dblinkの2接続を使い、先行する
-- 新しいイベントがsubject advisory lockを保持している間に、古いイベントを
-- 並行投入する。古い側がlock解放後に stale と判定され、状態を戻さないことを確認する。

create extension if not exists dblink;

begin;

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-4000-8000-000000000591', false);

select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-591-seed', 'INITIAL_PURCHASE', 1000,
    '00000000-0000-4000-8000-000000000591', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'applied',
  'FAIL(088/a): concurrency fixture could not be seeded'
);

commit;

-- RLS harnessのローカルSupabase固定資格情報でsuperuser接続を2本開く。
-- 接続先DB名はcurrent_database()からのみ組み立て、外部DBを指定できない。
select dblink_connect(
  'rc_concurrent_new',
  format('host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres', current_database())
);
select dblink_connect(
  'rc_concurrent_old',
  format('host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres', current_database())
);
select dblink_exec('rc_concurrent_new', 'begin');
select dblink_exec('rc_concurrent_old', 'begin');

-- Newer event acquires and retains the subject lock until its transaction commits.
select test_assert(
  dblink_send_query(
  'rc_concurrent_new',
  $$select public.apply_revenuecat_webhook_event(
    'evt-591-new', 'RENEWAL', 3000,
    '00000000-0000-4000-8000-000000000591', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  )$$
  ) = 1,
  'FAIL(088/b0): newer event was not dispatched'
);
create temporary table rc_concurrent_new_result(result text);
insert into rc_concurrent_new_result(result)
  select result
  from dblink_get_result('rc_concurrent_new') as result(result text);
-- dblink_get_result は結果セットを読み切るまで接続を idle に戻さない。
-- SELECT の結果行を保存した後、空の結果セットも明示的に消費する。
select * from dblink_get_result('rc_concurrent_new') as result(result text);
select test_assert(
  (select result from rc_concurrent_new_result limit 1) = 'applied',
  'FAIL(088/b1): newer event was not applied'
);

-- Older event is sent while the first transaction still owns the advisory lock.
select test_assert(
  dblink_send_query(
    'rc_concurrent_old',
    $$select public.apply_revenuecat_webhook_event(
      'evt-591-old', 'EXPIRATION', 2000,
      '00000000-0000-4000-8000-000000000591', 'plus', array['plus'],
      null, 'default', 'TEST_STORE', 'SANDBOX',
      2000, null, false
    )$$
  ) = 1,
  'FAIL(088/b): concurrent stale event was not dispatched'
);
select pg_sleep(0.2);
select test_assert(
  dblink_is_busy('rc_concurrent_old') = 1,
  'FAIL(088/c): stale event did not block behind the subject lock'
);

select dblink_exec('rc_concurrent_new', 'commit');
create temporary table rc_concurrent_old_result(result text);
insert into rc_concurrent_old_result(result)
  select result
  from dblink_get_result('rc_concurrent_old') as result(result text);
select * from dblink_get_result('rc_concurrent_old') as result(result text);
select test_assert(
  (select result from rc_concurrent_old_result limit 1) = 'ignored_stale',
  'FAIL(088/d): stale concurrent event overwrote the newer state'
);
select dblink_exec('rc_concurrent_old', 'commit');
select dblink_disconnect('rc_concurrent_new');
select dblink_disconnect('rc_concurrent_old');

select test_assert(
  (select last_event_id = 'evt-591-new'
     and lifecycle_state = 'active'
     and is_active
   from public.user_entitlements
   where user_id = '00000000-0000-4000-8000-000000000591'),
  'FAIL(088/e): final entitlement state was not the newer event'
);

select '088_revenuecat_webhook_concurrency.sql: all assertions passed' as result;
