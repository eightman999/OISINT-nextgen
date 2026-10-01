-- =============================================================================
-- 010_membership_isolation.sql — メンバーシップ分離の負例テスト (spec.md §23, §33)
--
-- 登場人物 (uuid 末尾で識別。このファイル専用の名前空間 ...010x / ...01xx):
--   A = ...010a : investigation I1 の owner (investigation_members に owner)
--   B = ...010b : I1 の editor メンバー
--   C = ...010c : 非メンバー (authenticated だが I1 と無関係)
--
-- 検証 (private investigation):
--   a. C は I1 を SELECT できない (0行)
--   b. C は requirements/candidates/evidence/requirement_evaluations/votes/
--      investigation_events を SELECT できない (各0行)
--   c. B (member) は I1 と各データを読める (正例コントロール)
--   d. C の investigations UPDATE は 0行 (silent。inv_update は using のみ)
--   e. C の requirements INSERT は RLS 違反 42501
--      (e-0: editor B の同一経路 INSERT は成功する正例コントロール付き)
--   f. investigation_members は自己行のみ可視 (§23 推奨安全形)
--   g. share_token を知っていても RLS は investigations の行を返さない
--      (トークン参加は join-investigation Edge Function 経由が必須 §25.4)
--
-- 技法: フィクスチャは postgres (BYPASSRLS + owner) で投入し COMMIT。
--       各シナリオは begin; set local role authenticated;
--       set local request.jwt.claims = '{"sub":"<uuid>",...}'; …; rollback; で分離。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres として。RLS バイパス)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000010a'),  -- A
  ('00000000-0000-0000-0000-00000000010b'),  -- B
  ('00000000-0000-0000-0000-00000000010c');  -- C

insert into public.investigations (id, created_by, title, raw_query, share_token) values
  ('00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-00000000010a',
   'I1 private title', 'I1 secret raw query', 'rls010secret_token_0000000000001');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-00000000010a', 'owner'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-00000000010b', 'editor');

insert into public.requirements (id, investigation_id, created_by, text) values
  ('00000000-0000-0000-0000-000000000102',
   '00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-00000000010a', 'I1 requirement (secret)');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000103', 'geoapify', 'rls010-p1', 'Place 010');

insert into public.candidates (id, investigation_id, place_id) values
  ('00000000-0000-0000-0000-000000000104',
   '00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000103');

-- evidence は 2 種: investigation スコープ行 + shared 行 (investigation_id null, §23 例外構造)
insert into public.evidence (id, investigation_id, place_id, scope, source_type, source_url, observed_at) values
  ('00000000-0000-0000-0000-000000000105',
   '00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000103',
   'investigation', 'web', 'https://example.com/010/inv', now()),
  ('00000000-0000-0000-0000-000000000106',
   null,
   '00000000-0000-0000-0000-000000000103',
   'shared', 'web', 'https://example.com/010/shared', now());

insert into public.requirement_evaluations (id, investigation_id, candidate_id, requirement_id, state) values
  ('00000000-0000-0000-0000-000000000107',
   '00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000104',
   '00000000-0000-0000-0000-000000000102', 'match');

insert into public.votes (investigation_id, candidate_id, user_id, value) values
  ('00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000104',
   '00000000-0000-0000-0000-00000000010a', 1);

insert into public.investigation_events (id, investigation_id, event_type) values
  ('00000000-0000-0000-0000-000000000108',
   '00000000-0000-0000-0000-000000000101', 'created');

-- フィクスチャ健全性 (postgres 視点 = RLS バイパスで全行見える)
do $$
begin
  if (select count(*) from public.investigation_members
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 2 then
    raise exception 'FAIL(010/fixture): member rows expected 2';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- a+b. 非メンバー C: 全テーブル 0 行
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010c","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.investigations
      where id = '00000000-0000-0000-0000-000000000101') <> 0 then
    raise exception 'FAIL(010/a): C can see private investigation I1';
  end if;
  if (select count(*) from public.requirements
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 0 then
    raise exception 'FAIL(010/b): C can see requirements of I1';
  end if;
  if (select count(*) from public.candidates
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 0 then
    raise exception 'FAIL(010/b): C can see candidates of I1';
  end if;
  -- place_id で見る = investigation スコープ行と shared 行の両方をカバー
  if (select count(*) from public.evidence
      where place_id = '00000000-0000-0000-0000-000000000103') <> 0 then
    raise exception 'FAIL(010/b): C can see evidence of I1 (scoped or shared)';
  end if;
  if (select count(*) from public.requirement_evaluations
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 0 then
    raise exception 'FAIL(010/b): C can see requirement_evaluations of I1';
  end if;
  if (select count(*) from public.votes
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 0 then
    raise exception 'FAIL(010/b): C can see votes of I1';
  end if;
  if (select count(*) from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 0 then
    raise exception 'FAIL(010/b): C can see investigation_events of I1';
  end if;
  -- C はどの investigation のメンバーでもない → membership は全体で 0 行
  if (select count(*) from public.investigation_members) <> 0 then
    raise exception 'FAIL(010/b): C can see some investigation_members rows';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. メンバー B: 読める (正例コントロール。負例が「RLS が全部壊れて全員 0 行」で
--    偽装パスしていないことの証明)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010b","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.investigations
      where id = '00000000-0000-0000-0000-000000000101') <> 1 then
    raise exception 'FAIL(010/c): member B cannot see investigation I1';
  end if;
  if (select count(*) from public.candidates
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 1 then
    raise exception 'FAIL(010/c): member B cannot see candidates';
  end if;
  -- investigation スコープ行 + shared 行 (メンバー candidate 経由) = 2 行
  if (select count(*) from public.evidence
      where place_id = '00000000-0000-0000-0000-000000000103') <> 2 then
    raise exception 'FAIL(010/c): member B should see 2 evidence rows (scoped+shared)';
  end if;
  if (select count(*) from public.requirements
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 1 then
    raise exception 'FAIL(010/c): member B cannot see requirements';
  end if;
  if (select count(*) from public.requirement_evaluations
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 1 then
    raise exception 'FAIL(010/c): member B cannot see requirement_evaluations';
  end if;
  -- メンバーは他人 (A) の vote も読める (§23 vote_select は member 全体)
  if (select count(*) from public.votes
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 1 then
    raise exception 'FAIL(010/c): member B cannot see votes';
  end if;
  if (select count(*) from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000000101') <> 1 then
    raise exception 'FAIL(010/c): member B cannot see investigation_events';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- d. C の UPDATE は 42501 (migration 0010 で authenticated から UPDATE 権限
--    ごと revoke 済み。書き込みは owner RPC 経由のみ。RLS の silent 0-row
--    より強い保証なので、権限エラーそのものを期待値としてピン留めする)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010c","role":"authenticated"}';

do $$
begin
  update public.investigations set title = 'hacked by C'
  where id = '00000000-0000-0000-0000-000000000101';
  raise exception 'FAIL(010/d): C は investigations を UPDATE できてはならない (revoke 済みのはず)';
exception
  when insufficient_privilege then
    null;  -- 期待どおり (42501)
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- e-0. [正例コントロール] editor B は I1 に requirement を INSERT できる。
--      (req_insert with check: is_investigation_editor(inv) && created_by = auth.uid()
--       の両方が真になる唯一の正規経路)
--      直後の e (C の INSERT 拒否) が「INSERT 経路自体が壊れていて誰も挿せない」
--      という空虚な成立 (vacuous pass) でないことを証明する。
--      rollback で捨てるので後続シナリオのフィクスチャは汚さない。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010b","role":"authenticated"}';

do $$
declare n int;
begin
  insert into public.requirements (investigation_id, created_by, text)
  values ('00000000-0000-0000-0000-000000000101',
          '00000000-0000-0000-0000-00000000010b', 'requirement by editor B (positive control)');
  select count(*) into n from public.requirements
  where investigation_id = '00000000-0000-0000-0000-000000000101'
    and created_by = '00000000-0000-0000-0000-00000000010b';
  if n <> 1 then
    raise exception 'FAIL(010/e-0): editor B''s requirement insert did not persist (saw % rows)', n;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- e. C の requirements INSERT は RLS 違反 (42501)。
--    authenticated には INSERT の GRANT 自体はある (0003) ため、
--    失敗は grant 層ではなく WITH CHECK (is_investigation_editor && created_by=uid)。
--    e-0 で同一 INSERT 経路が authorized なら通ることを確認済みなので、
--    この拒否は「経路が壊れているだけ」ではなく RLS によるものと言える。
--    実測: sqlstate=42501 "new row violates row-level security policy"
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010c","role":"authenticated"}';

do $$
begin
  begin
    insert into public.requirements (investigation_id, created_by, text)
    values ('00000000-0000-0000-0000-000000000101',
            '00000000-0000-0000-0000-00000000010c', 'injected requirement');
    raise exception 'FAIL(010/e): C inserted a requirement into I1';
  exception
    when insufficient_privilege then
      null;  -- 期待どおり (42501)
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- f. investigation_members の自己行ポリシー (§23):
--    B は自分の行だけ見える。A の owner 行は見えない。
--    (メンバー一覧が必要な UI は get_investigation_members RPC を使う → 040 で検証)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010b","role":"authenticated"}';

do $$
declare n int; visible_user text;
begin
  -- min(uuid) は存在しないため text 経由で集約する
  select count(*), min(user_id::text) into n, visible_user
  from public.investigation_members
  where investigation_id = '00000000-0000-0000-0000-000000000101';
  if n <> 1 then
    raise exception 'FAIL(010/f): B sees % membership rows of I1 (expected 1 = own row)', n;
  end if;
  if visible_user <> '00000000-0000-0000-0000-00000000010b' then
    raise exception 'FAIL(010/f): B sees someone else''s membership row (%)', visible_user;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- g. share_token を知っていても RLS は超えられない。
--    (0003 の inv_select は created_by / membership のみを見る。トークンは
--     ポリシー条件に含まれないので、トークン参加は Edge Function join-investigation
--     が service role で行う設計 §25.4)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000010c","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.investigations
      where share_token = 'rls010secret_token_0000000000001') <> 0 then
    raise exception 'FAIL(010/g): C can read investigation via known share_token';
  end if;
end $$;
rollback;

\echo == 010_membership_isolation.sql: all assertions passed
