-- =============================================================================
-- 050_profiles.sql — profiles の本人限定読み書きテスト (spec.md §19, §22, §23 / #158)
--
-- migration 0015 (profile_visibility_hardening) 後の境界:
--   直接 SELECT は本人行のみ (prof_select_own)。共同調査メンバーの表示名は
--   membership 検証付き RPC get_investigation_members(inv) だけが正本。
--
-- 登場人物 (このファイル専用の名前空間 ...050x):
--   A = ...050a : profile あり ('Alice 050')。I5 の owner
--   B = ...050b : profile あり ('Bob 050')。I5 の editor
--   C = ...050c : profile なし (偽装 INSERT の的 + 本人 INSERT の正例)。I5 非メンバー
--
-- 検証:
--   a.   B の直接 SELECT は自分の行のみ (A の行は 0 行 = #158 境界)
--   a-2. [正例] B は共同調査 I5 の RPC 経由で A の表示名を読める
--   a-3. 非メンバー C は RPC でも I5 のメンバー名を読めない (0 行)
--   b.   B が A の profile を UPDATE → 0 行 (silent) かつ値は不変 (postgres で実測)
--   c.   B が自分の profile を UPDATE → 1 行
--   d.   B が id=C で INSERT (なりすまし作成) → 42501 (prof_insert with check)
--   e.   C 本人が自分の profile を INSERT → 成功 (§19 の匿名サインイン後の自己作成経路)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000050a'),
  ('00000000-0000-0000-0000-00000000050b'),
  ('00000000-0000-0000-0000-00000000050c');

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000050a', 'Alice 050'),
  ('00000000-0000-0000-0000-00000000050b', 'Bob 050');

-- RPC 正例用の共同調査 (A owner / B editor。C は非メンバー)
insert into public.investigations (id, created_by, title, raw_query, share_token) values
  ('00000000-0000-0000-0000-000000000501',
   '00000000-0000-0000-0000-00000000050a',
   'I5 profiles rpc fixture', 'I5 raw query', 'rls050secret_token_0000000000001');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-00000000050a', 'owner'),
  ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-00000000050b', 'editor');

-- ---------------------------------------------------------------------------
-- a〜d. B 視点
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000050b","role":"authenticated"}';

do $$
declare n int; a_name_via_rpc text;
begin
  -- a. 直接 SELECT は本人行のみ (0015 prof_select_own)。A の行は見えない
  if (select count(*) from public.profiles
      where id = '00000000-0000-0000-0000-00000000050b') <> 1 then
    raise exception 'FAIL(050/a): B cannot read own profile (prof_select_own)';
  end if;
  if (select count(*) from public.profiles
      where id = '00000000-0000-0000-0000-00000000050a') <> 0 then
    raise exception 'FAIL(050/a): B can read A''s profile directly (should be blocked by 0015)';
  end if;

  -- a-2. [正例] 共同調査メンバーの表示名は RPC 経由でだけ見える
  select display_name into a_name_via_rpc
  from public.get_investigation_members('00000000-0000-0000-0000-000000000501')
  where user_id = '00000000-0000-0000-0000-00000000050a';
  if a_name_via_rpc is distinct from 'Alice 050' then
    raise exception 'FAIL(050/a2): RPC did not return A''s display_name to co-member B (got %)',
      coalesce(a_name_via_rpc, 'NULL');
  end if;

  -- b. 他人 (A) の UPDATE → 0 行 (値の不変は rollback 後に postgres で実測)
  update public.profiles set display_name = 'hacked by B'
  where id = '00000000-0000-0000-0000-00000000050a';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL(050/b): B updated A''s profile (% rows)', n;
  end if;

  -- c. 自分の UPDATE → 1 行
  update public.profiles set display_name = 'Bob 050 renamed'
  where id = '00000000-0000-0000-0000-00000000050b';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL(050/c): B updating own profile affected % rows (expected 1)', n;
  end if;

  -- d. なりすまし INSERT (id=C) → 42501
  begin
    insert into public.profiles (id, display_name)
    values ('00000000-0000-0000-0000-00000000050c', 'fake C by B');
    raise exception 'FAIL(050/d): B created a profile impersonating C';
  exception
    when insufficient_privilege then null;  -- 期待どおり (with check id = auth.uid())
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- a-3. 非メンバー C は RPC でも I5 のメンバー名を読めない (0 行)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000050c","role":"authenticated"}';

do $$
begin
  if (select count(*)
      from public.get_investigation_members('00000000-0000-0000-0000-000000000501')) <> 0 then
    raise exception 'FAIL(050/a3): non-member C can read member names via RPC';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b 後段. A の display_name が不変であることを postgres (RLS 対象外) で実測
-- ---------------------------------------------------------------------------
do $$
declare a_name text;
begin
  select display_name into a_name from public.profiles
  where id = '00000000-0000-0000-0000-00000000050a';
  if a_name <> 'Alice 050' then
    raise exception 'FAIL(050/b): A''s display_name was changed to %', a_name;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- e. C 本人の自己 INSERT は成功 (正例コントロール)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000050c","role":"authenticated"}';

do $$
begin
  insert into public.profiles (id, display_name)
  values ('00000000-0000-0000-0000-00000000050c', 'Carol 050');
  if (select count(*) from public.profiles
      where id = '00000000-0000-0000-0000-00000000050c'
        and display_name = 'Carol 050') <> 1 then
    raise exception 'FAIL(050/e): C''s own profile insert did not persist';
  end if;
end $$;
rollback;

\echo == 050_profiles.sql: all assertions passed
