-- =============================================================================
-- 030_visibility_boundaries.sql — visibility (private/public) 境界の負例テスト
-- (spec.md §33, §44.5 / migration 0007)
--
-- 登場人物 (このファイル専用の名前空間 ...030x / ...03xx):
--   A = ...030a : I1, I2 の owner (created_by)
--   B = ...030b : I1 の editor メンバー (owner ではない)
--   C = ...030c : 非メンバー (authenticated)
--
-- フィクスチャ:
--   I1 = ...0301 (最終的に public へ)   I2 = ...0302 (private のまま)
--   R1 = ...0303, P1 = ...0304, C1 = ...0305,
--   E1 = ...0306 (inv-scoped), E2 = ...0307 (shared), REv = ...0308, EV = ...0309
--
-- 検証:
--   a. owner A は visibility を変更できる
--      - 直接 UPDATE: 現行 0003 の inv_update (owner∈editor) + 0007 トリガーが許す。
--        ※将来 migration で直接 UPDATE を禁じる可能性があるため、恒久経路は
--          RPC set_investigation_visibility。本テストも RPC を正本の経路として commit する。
--      - RPC set_investigation_visibility(I1,'public') 成功
--   b. editor B の直接 UPDATE は trigger guard_visibility_change が例外
--      (SQLSTATE=P0001 ちょうど + メッセージに 'owner' を含む)
--   c. B の RPC は例外 (created_by = auth.uid() チェック)
--      (SQLSTATE=P0001 ちょうど + メッセージに 'not found or not owned' を含む)
--   d. public 化後: 非メンバー C は candidates/evidence/requirement_evaluations を
--      読める (is_investigation_readable) が、investigations 行そのもの・
--      requirements・votes・investigation_events は読めない (0007 §33 設計)
--   e. get_public_investigation は share_token / raw_query を返さない
--      (返す列は id/title/status/created_at のみ。private な I2 には 0 行)
--   f. service role 相当 (auth.uid() が null の postgres 直接実行) は
--      トリガーに阻まれず visibility を変更できる (Edge Function の status 更新等を壊さない)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000030a'),
  ('00000000-0000-0000-0000-00000000030b'),
  ('00000000-0000-0000-0000-00000000030c');

insert into public.investigations (id, created_by, title, raw_query, share_token) values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-00000000030a',
   'I1 going public', 'I1 raw query (must stay hidden)', 'rls030secret_token_0000000000001'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-00000000030a',
   'I2 stays private', 'I2 raw query', 'rls030secret_token_0000000000002');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-00000000030a', 'owner'),
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-00000000030b', 'editor'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-00000000030a', 'owner');

insert into public.requirements (id, investigation_id, created_by, text) values
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000301',
   '00000000-0000-0000-0000-00000000030a', 'I1 requirement text (must stay hidden)');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000304', 'geoapify', 'rls030-p1', 'Place 030');

insert into public.candidates (id, investigation_id, place_id) values
  ('00000000-0000-0000-0000-000000000305',
   '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000304');

insert into public.evidence (id, investigation_id, place_id, scope, source_type, source_url, observed_at) values
  ('00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-000000000301',
   '00000000-0000-0000-0000-000000000304', 'investigation', 'web', 'https://example.com/030/inv', now()),
  ('00000000-0000-0000-0000-000000000307', null,
   '00000000-0000-0000-0000-000000000304', 'shared', 'web', 'https://example.com/030/shared', now());

insert into public.requirement_evaluations (id, investigation_id, candidate_id, requirement_id, state) values
  ('00000000-0000-0000-0000-000000000308', '00000000-0000-0000-0000-000000000301',
   '00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000303', 'match');

insert into public.votes (investigation_id, candidate_id, user_id, value) values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000305',
   '00000000-0000-0000-0000-00000000030a', 1);

insert into public.investigation_events (id, investigation_id, event_type) values
  ('00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-000000000301', 'created');

-- ---------------------------------------------------------------------------
-- a-1. owner A ですら直接 UPDATE は 42501 (migration 0010 で authenticated から
--      UPDATE 権限ごと revoke 済み。visibility 変更の唯一の正規経路は
--      set_investigation_visibility RPC = a-2 の正例)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000030a","role":"authenticated"}';

do $$
begin
  update public.investigations set visibility = 'public'
  where id = '00000000-0000-0000-0000-000000000301';
  raise exception 'FAIL(030/a1): owner A の直接 UPDATE は revoke されているはず';
exception
  when insufficient_privilege then
    null;  -- 期待どおり (42501)
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b. editor B の直接 UPDATE → 42501 (0010 の revoke が最初の砦)。
--    guard_visibility_change トリガー (owner 限定 P0001) は service role 等の
--    UPDATE 権限を持つ経路向けの第二の砦として残っており、editor の
--    owner チェック文言検証は c (RPC 経由) が担う。
--    SQLSTATE 検証: 権限エラー 42501 ちょうどであること。
--    (別カテゴリのエラーで「何か落ちた」だけの偽装パスを許さない。
--     42501 以外は再送出して FAIL)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000030b","role":"authenticated"}';

do $$
begin
  update public.investigations set visibility = 'public'
  where id = '00000000-0000-0000-0000-000000000301';
  raise exception 'FAIL(030/b): editor B changed visibility via direct UPDATE';
exception
  when insufficient_privilege then
    null;  -- 期待どおり (42501)
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. editor B の RPC set_investigation_visibility → 例外。
--    (RPC 内 update ... where created_by = auth.uid() が 0 行 → if not found
--     → raise exception 'investigation not found or not owned by current user')
--    SQLSTATE 検証: b と同じく raise exception 由来の P0001 ちょうど。
--    それ以外のカテゴリは再送出して FAIL (偽装パス防止)。
--    メッセージ検証: 0007 の固定文言 'not found or not owned' を含むこと。
--    実測: sqlstate=P0001 msg='investigation not found or not owned by current user'
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000030b","role":"authenticated"}';

do $$
declare denied boolean := false; v_state text := ''; v_msg text := '';
begin
  begin
    perform public.set_investigation_visibility(
      '00000000-0000-0000-0000-000000000301', 'public');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> 'P0001' then
      raise;  -- 期待外カテゴリ (テスト自体の壊れ方) はそのまま FAIL させる
    end if;
    denied := true;
  end;
  if not denied then
    raise exception 'FAIL(030/c): editor B changed visibility via RPC';
  end if;
  if v_msg not ilike '%not found or not owned%' then
    raise exception 'FAIL(030/c): RPC raised P0001 but with unexpected message: %', v_msg;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- a-2. owner A が RPC で public 化 (これだけ COMMIT する。d/e の前提状態)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000030a","role":"authenticated"}';

do $$
begin
  perform public.set_investigation_visibility(
    '00000000-0000-0000-0000-000000000301', 'public');
  -- owner 自身は investigations を読めるので反映確認できる
  if (select visibility from public.investigations
      where id = '00000000-0000-0000-0000-000000000301') <> 'public' then
    raise exception 'FAIL(030/a2): RPC did not set visibility=public';
  end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- d. public 後の非メンバー C の可視境界 (0007 の設計):
--    見えるもの: candidates / evidence (scoped+shared) / requirement_evaluations
--    見えないまま: investigations 行・requirements・votes・investigation_events
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000030c","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.candidates
      where investigation_id = '00000000-0000-0000-0000-000000000301') <> 1 then
    raise exception 'FAIL(030/d): C cannot see candidates of public I1';
  end if;
  if (select count(*) from public.evidence
      where place_id = '00000000-0000-0000-0000-000000000304') <> 2 then
    raise exception 'FAIL(030/d): C should see 2 evidence rows of public I1 (scoped+shared)';
  end if;
  if (select count(*) from public.requirement_evaluations
      where investigation_id = '00000000-0000-0000-0000-000000000301') <> 1 then
    raise exception 'FAIL(030/d): C cannot see requirement_evaluations of public I1';
  end if;

  -- ここから「public でも見えてはいけないもの」(§33: raw_query / requirement 文面 /
  -- 投票 / グループ嗜好を公開ページへ露出しない)
  if (select count(*) from public.investigations
      where id = '00000000-0000-0000-0000-000000000301') <> 0 then
    raise exception 'FAIL(030/d): C can see investigations row of public I1 (should stay member-only)';
  end if;
  if (select count(*) from public.investigations
      where share_token = 'rls030secret_token_0000000000001') <> 0 then
    raise exception 'FAIL(030/d): C can see public I1 via share_token';
  end if;
  if (select count(*) from public.requirements
      where investigation_id = '00000000-0000-0000-0000-000000000301') <> 0 then
    raise exception 'FAIL(030/d): C can see requirements of public I1';
  end if;
  if (select count(*) from public.votes
      where investigation_id = '00000000-0000-0000-0000-000000000301') <> 0 then
    raise exception 'FAIL(030/d): C can see votes of public I1';
  end if;
  if (select count(*) from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000000301') <> 0 then
    raise exception 'FAIL(030/d): C can see investigation_events of public I1';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- e. get_public_investigation: 列の露出境界。
--    返り値の列集合は {id,title,status,created_at} ちょうど。
--    share_token / raw_query / normalized_query / embedding が含まれたら失敗。
--    private な I2 は 0 行。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000030c","role":"authenticated"}';

do $$
declare j jsonb; keys text;
begin
  select to_jsonb(t) into j
  from public.get_public_investigation('00000000-0000-0000-0000-000000000301') t;
  if j is null then
    raise exception 'FAIL(030/e): C got no row from get_public_investigation for public I1';
  end if;
  if (j ? 'share_token') or (j ? 'raw_query') or (j ? 'normalized_query') or (j ? 'embedding') then
    raise exception 'FAIL(030/e): get_public_investigation leaks sensitive columns: %', j;
  end if;
  select string_agg(k, ',' order by k) into keys from jsonb_object_keys(j) k;
  if keys <> 'created_at,id,status,title' then
    raise exception 'FAIL(030/e): unexpected column set: %', keys;
  end if;
  if j->>'title' <> 'I1 going public' then
    raise exception 'FAIL(030/e): title mismatch: %', j->>'title';
  end if;

  -- private な I2 は返らない
  if (select count(*)
      from public.get_public_investigation('00000000-0000-0000-0000-000000000302')) <> 0 then
    raise exception 'FAIL(030/e): get_public_investigation returned a private investigation';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- f. service role 相当 (auth.uid() = null) はトリガーの owner 制限対象外。
--    Edge Function (service role) による更新系を壊していないことの確認。
--    postgres 直接実行は auth.uid() が null になるので同じ分岐を通る。
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  update public.investigations set visibility = 'public'
  where id = '00000000-0000-0000-0000-000000000302';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL(030/f): service-role-like visibility update failed';
  end if;
  -- 元に戻す (I2 は private のままがこのファイルの前提)
  update public.investigations set visibility = 'private'
  where id = '00000000-0000-0000-0000-000000000302';
end $$;

\echo == 030_visibility_boundaries.sql: all assertions passed
