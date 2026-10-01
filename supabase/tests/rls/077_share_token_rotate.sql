-- =============================================================================
-- 077_share_token_rotate.sql — rotate_share_token RPC の正例・負例テスト
-- (spec.md §8 Share Link Rule, §25.4, §33 / migrations 0019, issue #177)
--
-- ファイル番号 077 = issue #177 由来。並行レーンが 070 を取る可能性があるため
-- 名前空間ごとずらしている (このファイル専用の UUID 名前空間は ...077x / ...07xx)。
--
-- 登場人物:
--   A = ...077a : I1 owner (created_by)
--   B = ...077b : I1 editor メンバー
--   C = ...077c : 非メンバー
--
-- 検証:
--   a. owner A の rotate は成功する。
--      - 戻り値は 32 hex の新トークンで、旧トークンと異なる
--      - 旧トークンでは investigation を引けない (join-investigation の検索条件が
--        share_token 完全一致のため = 即時失効)
--      - 参加済み investigation_members は 2 人のまま維持 (get_investigation_members)
--      - investigation_events に share_token_rotated が 1 行記録される
--      - 新旧トークン値が message / metadata へ漏れていない (§33)
--   b. editor B の rotate は 0019 の owner 検証で拒否され、token も変わらない
--   c. 非メンバー C の rotate も同じエラーで拒否される (存在を漏らさない)
--   d. anon は EXECUTE 権限自体が無い (42501)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)。share_token は 0002 の default で自動発行される。
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000077a'),  -- A
  ('00000000-0000-0000-0000-00000000077b'),  -- B
  ('00000000-0000-0000-0000-00000000077c');  -- C

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000077a', 'Alice 077'),
  ('00000000-0000-0000-0000-00000000077b', 'Bob 077');

insert into public.investigations (id, created_by, title, raw_query) values
  ('00000000-0000-0000-0000-000000000771',
   '00000000-0000-0000-0000-00000000077a', 'I1 077', 'q 077');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000771', '00000000-0000-0000-0000-00000000077a', 'owner'),
  ('00000000-0000-0000-0000-000000000771', '00000000-0000-0000-0000-00000000077b', 'editor');

-- ---------------------------------------------------------------------------
-- a. owner A: rotate 成功 / 旧トークン即時失効 / members 維持 / イベント記録
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000077a","role":"authenticated"}';

do $$
declare
  v_old text;
  v_new text;
  v_members int;
  v_events int;
begin
  select share_token into v_old
  from public.investigations
  where id = '00000000-0000-0000-0000-000000000771';

  v_new := public.rotate_share_token('00000000-0000-0000-0000-000000000771');

  if v_new is null or v_new !~ '^[0-9a-f]{32}$' then
    raise exception 'FAIL(077/a): rotate did not return a 32-hex token (got %)', v_new;
  end if;
  if v_new = v_old then
    raise exception 'FAIL(077/a): rotate returned the unchanged token';
  end if;

  -- 旧トークンでの検索は 0 行 (= join-investigation は 404 を返す)
  if exists (select 1 from public.investigations where share_token = v_old) then
    raise exception 'FAIL(077/a): old share_token still resolves an investigation';
  end if;
  if (select share_token from public.investigations
      where id = '00000000-0000-0000-0000-000000000771') <> v_new then
    raise exception 'FAIL(077/a): investigations.share_token was not updated to the new token';
  end if;

  -- 参加済みメンバーは維持 (member A から見える正規の一覧 RPC で確認)
  select count(*) into v_members
  from public.get_investigation_members('00000000-0000-0000-0000-000000000771');
  if v_members <> 2 then
    raise exception 'FAIL(077/a): members were not preserved (got % rows)', v_members;
  end if;

  -- 監査イベントが 1 行 (event_select: member A から見える)
  select count(*) into v_events
  from public.investigation_events
  where investigation_id = '00000000-0000-0000-0000-000000000771'
    and event_type = 'share_token_rotated';
  if v_events <> 1 then
    raise exception 'FAIL(077/a): expected 1 share_token_rotated event, got %', v_events;
  end if;

  -- トークン値 (新旧) がイベントへ漏れていないこと (§33)
  if exists (
    select 1 from public.investigation_events
    where investigation_id = '00000000-0000-0000-0000-000000000771'
      and event_type = 'share_token_rotated'
      and (coalesce(message, '') like '%' || v_new || '%'
        or coalesce(message, '') like '%' || v_old || '%'
        or coalesce(metadata::text, '') like '%' || v_new || '%'
        or coalesce(metadata::text, '') like '%' || v_old || '%')
  ) then
    raise exception 'FAIL(077/a): share_token value leaked into investigation_events';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b. editor B: owner でないため拒否 (0019 の raise exception)。token は不変
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000077b","role":"authenticated"}';

do $$
declare
  v_before text;
begin
  select share_token into v_before
  from public.investigations
  where id = '00000000-0000-0000-0000-000000000771';

  begin
    perform public.rotate_share_token('00000000-0000-0000-0000-000000000771');
    raise exception 'FAIL(077/b): editor B rotated the share_token';
  exception
    when raise_exception then
      -- 自分の FAIL マーカーは握り潰さず、0019 のエラーメッセージのみ期待どおりとする
      if sqlerrm <> 'investigation not found or not owned by current user' then
        raise;
      end if;
  end;

  if (select share_token from public.investigations
      where id = '00000000-0000-0000-0000-000000000771') <> v_before then
    raise exception 'FAIL(077/b): share_token changed despite rejected rotate';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. 非メンバー C: b と同一のエラー (調査の存在を漏らさない)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000077c","role":"authenticated"}';

do $$
begin
  begin
    perform public.rotate_share_token('00000000-0000-0000-0000-000000000771');
    raise exception 'FAIL(077/c): non-member C rotated the share_token';
  exception
    when raise_exception then
      if sqlerrm <> 'investigation not found or not owned by current user' then
        raise;
      end if;
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- d. anon: EXECUTE 権限が無い (42501)
-- ---------------------------------------------------------------------------
begin;
set local role anon;

do $$
begin
  begin
    perform public.rotate_share_token('00000000-0000-0000-0000-000000000771');
    raise exception 'FAIL(077/d): anon can execute rotate_share_token';
  exception
    when insufficient_privilege then null;  -- 期待どおり (grant なし)
  end;
end $$;
rollback;

\echo == 077_share_token_rotate.sql: all assertions passed
