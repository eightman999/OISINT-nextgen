-- =============================================================================
-- 070_share_preview.sql — 共有リンクプレビュー RPC の負例テスト
-- (spec.md §33 / migration 0020 get_investigation_preview / issue #335)
--
-- 登場人物 (このファイル専用の名前空間 ...070x / ...07xx):
--   A = ...070a : IP の owner
--   B = ...070b : IP の editor メンバー (member_count を 2 にするため)
--   C = ...070c : 非メンバー (share_token だけを知っている参加前ユーザー)
--
-- 検証:
--   a. 非メンバー C が有効な share_token で呼ぶ → ちょうど 1 行。
--      title / status / member_count(=2) が正しい (参加前プレビューの正例)
--   b. 列の露出境界: 返る列集合は {member_count, status, title} ちょうど。
--      id / share_token / raw_query / normalized_query / embedding を返さない (§33)
--   c. 存在しない token → 0 行 (エラーも詳細も出さない。列挙攻撃に使わせない)
--   d. anon ロール (JWT なし) → grant 層で拒否 (42501)。
--      0020 の「anon には開けない」の実測確認 (040/d と同じ技法)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000070a'),  -- A
  ('00000000-0000-0000-0000-00000000070b'),  -- B
  ('00000000-0000-0000-0000-00000000070c');  -- C

insert into public.investigations (id, created_by, title, raw_query, share_token) values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-00000000070a',
   'IP 070 preview title', 'IP raw query (must stay hidden)', 'rls070secret_token_0000000000001');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-00000000070a', 'owner'),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-00000000070b', 'editor');

-- ---------------------------------------------------------------------------
-- a. 非メンバー C + 有効 token → ちょうど 1 行 (title/status/member_count)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000070c","role":"authenticated"}';

do $$
declare n int; r record;
begin
  select count(*) into n
  from public.get_investigation_preview('rls070secret_token_0000000000001');
  if n <> 1 then
    raise exception 'FAIL(070/a): non-member C with a valid token got % rows (expected exactly 1)', n;
  end if;

  select * into r
  from public.get_investigation_preview('rls070secret_token_0000000000001');
  if r.title <> 'IP 070 preview title' then
    raise exception 'FAIL(070/a): title mismatch (got %)', r.title;
  end if;
  if r.status <> 'draft' then
    raise exception 'FAIL(070/a): status mismatch (got %)', r.status;
  end if;
  if r.member_count <> 2 then
    raise exception 'FAIL(070/a): member_count=% (expected 2)', r.member_count;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b. 列の露出境界 (030/e・060/a2 と同じ技法):
--    {member_count, status, title} ちょうど。§33 の非公開列を返さない。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000070c","role":"authenticated"}';

do $$
declare j jsonb; keys text;
begin
  select to_jsonb(t) into j
  from public.get_investigation_preview('rls070secret_token_0000000000001') t;
  if (j ? 'id') or (j ? 'share_token') or (j ? 'raw_query')
     or (j ? 'normalized_query') or (j ? 'embedding') or (j ? 'created_by') then
    raise exception 'FAIL(070/b): get_investigation_preview leaks sensitive columns: %', j;
  end if;
  select string_agg(k, ',' order by k) into keys from jsonb_object_keys(j) k;
  if keys <> 'member_count,status,title' then
    raise exception 'FAIL(070/b): unexpected column set: %', keys;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. 存在しない token → 0 行 (エラーにしない。有効/無効の区別は行数のみ)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000070c","role":"authenticated"}';

do $$
declare n int;
begin
  select count(*) into n
  from public.get_investigation_preview('rls070unknown_token_000000000000');
  if n <> 0 then
    raise exception 'FAIL(070/c): unknown token returned % rows (expected 0)', n;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- d. anon ロール (JWT なし): RPC を grant 層で拒否 (42501)。040/d と同じ技法。
-- ---------------------------------------------------------------------------
begin;
set local role anon;
do $$
begin
  begin
    perform * from public.get_investigation_preview('rls070secret_token_0000000000001');
    raise exception 'FAIL(070/d): anon can execute get_investigation_preview';
  exception
    when insufficient_privilege then null;  -- permission denied for function
  end;
end $$;
rollback;

\echo == 070_share_preview.sql: all assertions passed
