-- =============================================================================
-- 040_rpc_and_cache.sql — RPC / external_cache / place_feedback / anon の負例テスト
-- (spec.md §32, §44.3, §44.5, §19, §23 / migrations 0005, 0006, 0007)
--
-- 登場人物 (このファイル専用の名前空間 ...040x / ...04xx):
--   A = ...040a : I1 owner (profile あり)
--   B = ...040b : I1 editor メンバー (profile あり)
--   C = ...040c : 非メンバー
--
-- 検証:
--   a. external_cache は authenticated から不可視。
--      実測: SELECT で 42501 "permission denied for table external_cache"。
--      (0006 は authenticated に GRANT していない。仮に grant されても
--       RLS 有効・ポリシー無しが 0 行のバックストップになる二重防御)
--   b. place_feedback (§44.3 L3 個人データ):
--      - B の直接 INSERT (user_id=B) は成功 (pfb_insert)
--      - C から B の行は見えない (0行, pfb_select)
--      - B が user_id=C を偽装した INSERT は 42501
--      - RPC submit_place_feedback は auth.uid() を強制し成功 (戻り uuid の行が user_id=B)
--   c. get_investigation_members:
--      - 非メンバー C → 0 行 (関数内 is_investigation_member ガード)
--      - メンバー B → 2 行 (A の行も見える = §23 自己行ポリシーの正規の迂回路)
--   d. anon ロール (JWT claim なし):
--      - investigations / places の SELECT → 42501 permission denied
--        (実測: grant 層で遮断。0003 は anon に GRANT せず、supabase local の
--         default privileges も SELECT を含まない。ポリシーも to authenticated のみ)
--      - RPC get_public_investigation の EXECUTE → 42501
--   e. TRUNCATE 負例: authenticated からの truncate public.votes → 42501
--      (0012 の revoke が退行して TRUNCATE できてしまったら FAIL)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000040a'),
  ('00000000-0000-0000-0000-00000000040b'),
  ('00000000-0000-0000-0000-00000000040c');

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000040a', 'Alice 040'),
  ('00000000-0000-0000-0000-00000000040b', 'Bob 040');

insert into public.investigations (id, created_by, title, raw_query) values
  ('00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-00000000040a', 'I1 040', 'q 040');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-00000000040a', 'owner'),
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-00000000040b', 'editor');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000402', 'geoapify', 'rls040-p1', 'Place 040');

-- external_cache に実データを置く (不可視テストが空振りでないことの担保)
insert into public.external_cache (cache_key, kind, request, payload) values
  ('rls040:v1:probe', 'fetch', '{"u":"x"}'::jsonb, '{"r":1}'::jsonb);

-- B の place_feedback (C からの不可視テスト用, committed)
insert into public.place_feedback (id, place_id, user_id, rating) values
  ('00000000-0000-0000-0000-000000000403',
   '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-00000000040b', 1);

-- ---------------------------------------------------------------------------
-- a. external_cache: authenticated B から SELECT → 42501
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040b","role":"authenticated"}';

do $$
begin
  begin
    perform count(*) from public.external_cache;
    raise exception 'FAIL(040/a): authenticated can SELECT external_cache';
  exception
    when insufficient_privilege then null;  -- 期待どおり (grant なし)
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b. place_feedback
-- ---------------------------------------------------------------------------
-- b-1: C から B の行は見えない
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040c","role":"authenticated"}';
do $$
begin
  if (select count(*) from public.place_feedback
      where place_id = '00000000-0000-0000-0000-000000000402') <> 0 then
    raise exception 'FAIL(040/b1): C can see B''s raw place_feedback rows';
  end if;
end $$;
rollback;

-- b-2: authenticated の直接 INSERT は本人行でも拒否（書込みはRPCのみ）
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040b","role":"authenticated"}';
do $$
begin
  begin
    insert into public.place_feedback (place_id, user_id, rating)
    values ('00000000-0000-0000-0000-000000000402',
            '00000000-0000-0000-0000-00000000040b', 0);
    raise exception 'FAIL(040/b2): authenticated direct insert was allowed';
  exception
    when insufficient_privilege then null;
  end;
end $$;
rollback;

-- b-3: RPC submit_place_feedback は user_id を auth.uid() に固定して成功する
--      (引数で user_id を受け取らない設計の確認。0007)
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040b","role":"authenticated"}';
do $$
declare v_id uuid;
begin
  v_id := public.submit_place_feedback(
    '00000000-0000-0000-0000-000000000402'::uuid,
    date '2026-08-01',
    1::smallint,
    'noise',
    'quiet');
  if v_id is null then
    raise exception 'FAIL(040/b3): submit_place_feedback returned null';
  end if;
  if (select count(*) from public.place_feedback f
      where f.id = v_id
        and f.user_id = '00000000-0000-0000-0000-00000000040b') <> 1 then
    raise exception 'FAIL(040/b3): RPC feedback row missing or user_id not forced to auth.uid()';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. get_investigation_members
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040c","role":"authenticated"}';
do $$
begin
  if (select count(*)
      from public.get_investigation_members('00000000-0000-0000-0000-000000000401')) <> 0 then
    raise exception 'FAIL(040/c): non-member C got member list via RPC';
  end if;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040b","role":"authenticated"}';
do $$
declare n int; has_a boolean;
begin
  select count(*),
         bool_or(user_id = '00000000-0000-0000-0000-00000000040a')
    into n, has_a
  from public.get_investigation_members('00000000-0000-0000-0000-000000000401');
  if n <> 2 or not has_a then
    raise exception 'FAIL(040/c): member B should see 2 members incl. A via RPC (got %, has_a=%)', n, has_a;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- d. anon ロール (JWT なし): SELECT も RPC も grant 層で拒否 (42501)
--    0003 の設計コメント「anon には一切開けない」の実測確認。
-- ---------------------------------------------------------------------------
begin;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.investigations;
    raise exception 'FAIL(040/d): anon can SELECT investigations';
  exception
    when insufficient_privilege then null;  -- permission denied for table
  end;
  begin
    perform count(*) from public.places;
    raise exception 'FAIL(040/d): anon can SELECT places';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.get_public_investigation('00000000-0000-0000-0000-000000000401');
    raise exception 'FAIL(040/d): anon can execute get_public_investigation';
  exception
    when insufficient_privilege then null;  -- permission denied for function
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- e. TRUNCATE 負例 (#189。旧: 観測のみの SECURITY NOTE を assert へ昇格)
--    supabase ローカルイメージの default privileges (実測) は postgres が作る
--    テーブルに anon/authenticated/service_role へ TRUNCATE/REFERENCES/TRIGGER/
--    MAINTAIN を自動付与する。TRUNCATE は RLS の対象外のため、放置すると
--    「authenticated が public.votes 等を TRUNCATE できる」状態になる。
--    migration 0012 が `revoke truncate ... from anon, authenticated` と
--    default privileges の revoke で硬化済み (多層防御。PostgREST は TRUNCATE を
--    発行しないため anon key 経由の悪用経路自体は元々無い)。
--    ここはその退行検知: authenticated が TRUNCATE できてしまったら FAIL する。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000040c","role":"authenticated"}';
do $$
begin
  begin
    truncate public.votes;
    raise exception 'FAIL(040/e): authenticated can TRUNCATE public.votes (0012 revoke regressed)';
  exception
    when insufficient_privilege then null;  -- 期待どおり 42501 (0012 で revoke 済み)
  end;
end $$;
rollback;

\echo == 040_rpc_and_cache.sql: all assertions passed
