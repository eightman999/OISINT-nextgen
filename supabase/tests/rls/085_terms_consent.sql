-- =============================================================================
-- 085_terms_consent.sql — 規約同意記録の RLS / RPC テスト (#272)
--
-- migration 202608230001_terms_consent の境界:
--   - profiles.terms_version / terms_accepted_at は本人のみ読める (0015 prof_select_own)
--   - 書き込みは security definer RPC record_terms_consent が正本。永久アカウントのみ
--   - 監査イベントは追記専用。利用者に UPDATE/DELETE は許可されない (0011)
--
-- 登場人物 (このファイル専用の名前空間 ...085x):
--   A = ...085a : 永久アカウント (is_anonymous = false)。profile あり
--   B = ...085b : 匿名アカウント (is_anonymous = true)
--   C = ...085c : 永久アカウント (is_anonymous = false)。profile なし
--
-- 検証:
--   a.   A が record_terms_consent('terms-v1') → profiles に記録 + 監査イベント 1 件
--   b.   A が record_terms_consent('terms-v0') → 22023 (拒否、記録なし)
--   c.   匿名 B が record_terms_consent('terms-v1') → 42501 (永久アカウント必須)
--   d.   B が A の terms_version を直接 UPDATE → 0 行 (prof_update with check)
--   e.   C (profile なし) が record_terms_consent('terms-v1') → 行が作られ同意が記録される
--   f.   監査イベントの直接 UPDATE / DELETE → 0 行 (追記専用)
--   g.   同版の再送 → accepted_at / 監査件数を変えない（冪等）
--   h.   2接続の同時初回同意 → profile / audit を各1件だけ作る
-- =============================================================================

create extension if not exists dblink;

create or replace function public.test_assert_085(ok boolean, message text)
returns void language plpgsql as $$
begin
  if not ok then raise exception '%', message; end if;
end $$;

-- ---------------------------------------------------------------------------
-- migration forward-fix の契約: 戻り型、security definer、search_path、権限
-- ---------------------------------------------------------------------------
do $$
declare
  v_return_type text;
  v_security_definer boolean;
  v_search_path text[];
begin
  select pg_get_function_result(p.oid), p.prosecdef, p.proconfig
    into v_return_type, v_security_definer, v_search_path
    from pg_proc p
   where p.oid = 'public.record_terms_consent(text)'::regprocedure;

  if v_return_type <> 'timestamp with time zone' then
    raise exception 'FAIL(085/contract): record_terms_consent must return timestamptz, got %',
      coalesce(v_return_type, '<missing>');
  end if;
  if not v_security_definer then
    raise exception 'FAIL(085/contract): record_terms_consent must remain security definer';
  end if;
  if v_search_path is null or not ('search_path=""' = any(v_search_path)) then
    raise exception 'FAIL(085/contract): record_terms_consent search_path must be empty';
  end if;
  if not has_function_privilege(
    'authenticated', 'public.record_terms_consent(text)', 'EXECUTE'
  ) then
    raise exception 'FAIL(085/contract): authenticated EXECUTE grant is missing';
  end if;
  if has_function_privilege('anon', 'public.record_terms_consent(text)', 'EXECUTE') then
    raise exception 'FAIL(085/contract): anon must not execute record_terms_consent';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000085a', false),
  ('00000000-0000-0000-0000-00000000085b', true),
  ('00000000-0000-0000-0000-00000000085c', false),
  ('00000000-0000-0000-0000-00000000085d', false);

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000085a', 'Alice 085'),
  ('00000000-0000-0000-0000-00000000085d', 'Concurrent 085');

-- ---------------------------------------------------------------------------
-- a + b. A 視点 (永久アカウント)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000085a","role":"authenticated","is_anonymous":"false"}';

do $$
declare
  n int;
  first_accepted_at timestamptz;
  second_accepted_at timestamptz;
begin
  -- a. 正しい版数の同意が記録される
  perform public.record_terms_consent('terms-v1');
  if (select count(*) from public.profiles
      where id = '00000000-0000-0000-0000-00000000085a'
        and terms_version = 'terms-v1'
        and terms_accepted_at is not null) <> 1 then
    raise exception 'FAIL(085/a): terms consent was not recorded on profile';
  end if;
  if (select count(*) from public.user_product_audit_events
      where actor_user_id = '00000000-0000-0000-0000-00000000085a'
        and event_type = 'terms_consent_accepted'
        and source = 'account'
        and consent_version = 'terms-v1') <> 1 then
    raise exception 'FAIL(085/a): terms_consent_accepted audit event missing';
  end if;

  select terms_accepted_at into first_accepted_at
    from public.profiles
   where id = '00000000-0000-0000-0000-00000000085a';
  perform public.record_terms_consent('terms-v1');
  select terms_accepted_at into second_accepted_at
    from public.profiles
   where id = '00000000-0000-0000-0000-00000000085a';
  if second_accepted_at is distinct from first_accepted_at then
    raise exception 'FAIL(085/g): same-version resend changed accepted_at';
  end if;
  if (select count(*) from public.user_product_audit_events
      where actor_user_id = '00000000-0000-0000-0000-00000000085a'
        and event_type = 'terms_consent_accepted') <> 1 then
    raise exception 'FAIL(085/g): same-version resend appended an audit event';
  end if;

  -- b. 未知の版数は拒否される
  begin
    perform public.record_terms_consent('terms-v0');
    raise exception 'FAIL(085/b): unknown terms version was accepted';
  exception
    when invalid_parameter_value then null;  -- errcode 22023
  end;

  begin
    update public.profiles
       set terms_version = 'terms-v999'
     where id = '00000000-0000-0000-0000-00000000085a';
    raise exception 'FAIL(085/b2): unknown direct terms version was accepted';
  exception
    when check_violation then null;
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. 匿名 B は RPC を使えない (42501)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000085b","role":"authenticated","is_anonymous":"true"}';

do $$
begin
  begin
    perform public.record_terms_consent('terms-v1');
    raise exception 'FAIL(085/c): anonymous user recorded terms consent';
  exception
    when insufficient_privilege then null;  -- errcode 42501
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- d. B が A の terms_version を直接 UPDATE → 0 行 (RLS)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000085b","role":"authenticated","is_anonymous":"true"}';

do $$
declare n int;
begin
  update public.profiles set terms_version = 'terms-v1'
  where id = '00000000-0000-0000-0000-00000000085a';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL(085/d): B updated A''s terms_version (% rows)', n;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- e. C (profile なし) が record_terms_consent → 行が作られ同意が記録される
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000085c","role":"authenticated","is_anonymous":"false"}';

do $$
begin
  perform public.record_terms_consent('terms-v1');
  if (select count(*) from public.profiles
      where id = '00000000-0000-0000-0000-00000000085c'
        and terms_version = 'terms-v1') <> 1 then
    raise exception 'FAIL(085/e): consent did not create the profile row';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- f. 監査イベントは利用者に追記専用 (UPDATE / DELETE 不可)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000085a","role":"authenticated","is_anonymous":"false"}';

do $$
declare n int;
begin
  begin
    update public.user_product_audit_events set consent_version = 'terms-v1'
    where actor_user_id = '00000000-0000-0000-0000-00000000085a';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'FAIL(085/f): user updated audit events (% rows)', n;
    end if;
  exception when insufficient_privilege then null;  -- テーブル権限なしも追記専用の一部
  end;

  begin
    delete from public.user_product_audit_events
    where actor_user_id = '00000000-0000-0000-0000-00000000085a';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'FAIL(085/f): user deleted audit events (% rows)', n;
    end if;
  exception when insufficient_privilege then null;  -- テーブル権限なしも追記専用の一部
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- h. 2接続で同時に初回同意してもprofile/auditは1件だけ
-- ---------------------------------------------------------------------------
select dblink_connect(
  'terms_concurrent_a',
  format('host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres', current_database())
);
select dblink_connect(
  'terms_concurrent_b',
  format('host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres', current_database())
);
select dblink_exec('terms_concurrent_a', 'begin');
select dblink_exec('terms_concurrent_b', 'begin');
select dblink_exec('terms_concurrent_a', 'set local role authenticated');
select dblink_exec('terms_concurrent_b', 'set local role authenticated');
select dblink_exec(
  'terms_concurrent_a',
  $$set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000085d","role":"authenticated","is_anonymous":"false"}'$$
);
select dblink_exec(
  'terms_concurrent_b',
  $$set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000085d","role":"authenticated","is_anonymous":"false"}'$$
);

select public.test_assert_085(
  dblink_send_query('terms_concurrent_a', $$select public.record_terms_consent('terms-v1')$$) = 1,
  'FAIL(085/h0): first concurrent consent was not dispatched'
);
create temporary table terms_concurrent_a_result(accepted_at timestamptz);
insert into terms_concurrent_a_result(accepted_at)
  select accepted_at from dblink_get_result('terms_concurrent_a')
    as result(accepted_at timestamptz);
select * from dblink_get_result('terms_concurrent_a') as result(accepted_at timestamptz);

select public.test_assert_085(
  dblink_send_query('terms_concurrent_b', $$select public.record_terms_consent('terms-v1')$$) = 1,
  'FAIL(085/h1): second concurrent consent was not dispatched'
);
select pg_sleep(0.2);
select public.test_assert_085(
  dblink_is_busy('terms_concurrent_b') = 1,
  'FAIL(085/h2): second consent did not wait for the profile lock'
);

select dblink_exec('terms_concurrent_a', 'commit');
create temporary table terms_concurrent_b_result(accepted_at timestamptz);
insert into terms_concurrent_b_result(accepted_at)
  select accepted_at from dblink_get_result('terms_concurrent_b')
    as result(accepted_at timestamptz);
select * from dblink_get_result('terms_concurrent_b') as result(accepted_at timestamptz);
select public.test_assert_085(
  (select accepted_at from terms_concurrent_a_result limit 1) is not null
  and (select accepted_at from terms_concurrent_b_result limit 1) =
      (select accepted_at from terms_concurrent_a_result limit 1),
  'FAIL(085/h3): concurrent consent timestamps diverged'
);
select dblink_exec('terms_concurrent_b', 'commit');
select dblink_disconnect('terms_concurrent_a');
select dblink_disconnect('terms_concurrent_b');

select public.test_assert_085(
  (select count(*) from public.profiles
    where id = '00000000-0000-0000-0000-00000000085d'
      and terms_version = 'terms-v1') = 1
  and (select count(*) from public.user_product_audit_events
    where actor_user_id = '00000000-0000-0000-0000-00000000085d'
      and event_type = 'terms_consent_accepted') = 1,
  'FAIL(085/h4): concurrent consent created duplicate profile/audit rows'
);

\echo == 085_terms_consent.sql: all assertions passed

drop function public.test_assert_085(boolean, text);
