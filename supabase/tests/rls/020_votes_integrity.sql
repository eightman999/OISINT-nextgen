-- =============================================================================
-- 020_votes_integrity.sql — votes の整合性負例テスト (spec.md §21, §23)
--
-- 登場人物 (このファイル専用の名前空間 ...020x / ...02xx):
--   A = ...020a : I1 と I2 の owner
--   B = ...020b : I1 のみ editor メンバー (I2 は非メンバー)
--
-- フィクスチャ:
--   I1 = ...0201 (A owner, B editor)   I2 = ...0202 (A owner のみ)
--   P1 = ...0203, P2 = ...0204
--   C1 = ...0205 (I1×P1, A の fixture vote あり)
--   C3 = ...0206 (I1×P2, vote なし = B の書き込み検証用)
--   C2 = ...0207 (I2×P1 = cross-investigation 攻撃素材)
--
-- 検証:
--   a. B が user_id=A で INSERT → 42501 (user_id = auth.uid() 強制)
--   b. B が I1 の投票として他調査 (I2) の candidate C2 に INSERT
--      → 42501 (exists による candidate/investigation 一致チェック)
--      B が I2 に直接 INSERT → 42501 (非メンバー)
--   c. B の正常 INSERT (value=1) 成功 / 自分の UPDATE 成功(1行) /
--      A の vote への UPDATE は 0 行 (silent。値も不変)
--   d. value=5 → check 制約違反 23514 (votes_value_check)
--      (RLS WITH CHECK は通過するため、観測されるのは check_violation。実測済み)
--   e. UPDATE の WITH CHECK バイパス試行: B が自分の vote の candidate_id を
--      他調査 I2 の candidate C2 へ付け替える → 42501 (行は不変)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000020a'),  -- A
  ('00000000-0000-0000-0000-00000000020b');  -- B

insert into public.investigations (id, created_by, title, raw_query) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-00000000020a', 'I1', 'q1'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-00000000020a', 'I2', 'q2');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-00000000020a', 'owner'),
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-00000000020b', 'editor'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-00000000020a', 'owner');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000203', 'geoapify', 'rls020-p1', 'Place 020-1'),
  ('00000000-0000-0000-0000-000000000204', 'geoapify', 'rls020-p2', 'Place 020-2');

insert into public.candidates (id, investigation_id, place_id) values
  ('00000000-0000-0000-0000-000000000205',
   '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000203'),  -- C1 (I1)
  ('00000000-0000-0000-0000-000000000206',
   '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000204'),  -- C3 (I1)
  ('00000000-0000-0000-0000-000000000207',
   '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000203');  -- C2 (I2)

-- A の既存 vote (B からの改竄対象)
insert into public.votes (investigation_id, candidate_id, user_id, value) values
  ('00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000205',
   '00000000-0000-0000-0000-00000000020a', 1);

-- ---------------------------------------------------------------------------
-- a. user_id 偽装 INSERT → 42501
--    (vote_insert WITH CHECK: user_id = auth.uid() が最初の条件)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000020b","role":"authenticated"}';

do $$
begin
  begin
    insert into public.votes (investigation_id, candidate_id, user_id, value)
    values ('00000000-0000-0000-0000-000000000201',
            '00000000-0000-0000-0000-000000000206',
            '00000000-0000-0000-0000-00000000020a',  -- A を騙る
            1);
    raise exception 'FAIL(020/a): B inserted a vote with forged user_id=A';
  exception
    when insufficient_privilege then null;  -- 期待どおり 42501
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b. cross-investigation candidate → 42501
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000020b","role":"authenticated"}';

do $$
begin
  -- b-1: investigation_id は自分がメンバーの I1、candidate は I2 のもの
  --      → exists (c.id=candidate_id and c.investigation_id=votes.investigation_id) が偽
  begin
    insert into public.votes (investigation_id, candidate_id, user_id, value)
    values ('00000000-0000-0000-0000-000000000201',
            '00000000-0000-0000-0000-000000000207',   -- C2 は I2 の candidate
            '00000000-0000-0000-0000-00000000020b',
            1);
    raise exception 'FAIL(020/b1): B inserted vote with mismatched candidate/investigation';
  exception
    when insufficient_privilege then null;
  end;
  -- b-2: 正しい対応 (I2×C2) だが B は I2 の非メンバー → member チェックで拒否
  begin
    insert into public.votes (investigation_id, candidate_id, user_id, value)
    values ('00000000-0000-0000-0000-000000000202',
            '00000000-0000-0000-0000-000000000207',
            '00000000-0000-0000-0000-00000000020b',
            1);
    raise exception 'FAIL(020/b2): non-member B inserted vote into I2';
  exception
    when insufficient_privilege then null;
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- c. 正常系 + 他人の vote UPDATE は 0 行
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000020b","role":"authenticated"}';

do $$
declare n int; a_value smallint;
begin
  -- 正常 INSERT (自分の vote, value=1)
  insert into public.votes (investigation_id, candidate_id, user_id, value)
  values ('00000000-0000-0000-0000-000000000201',
          '00000000-0000-0000-0000-000000000206',
          '00000000-0000-0000-0000-00000000020b',
          1);
  if (select count(*) from public.votes
      where candidate_id = '00000000-0000-0000-0000-000000000206'
        and user_id = '00000000-0000-0000-0000-00000000020b') <> 1 then
    raise exception 'FAIL(020/c): B''s own valid vote insert did not persist';
  end if;

  -- 自分の vote の UPDATE → 1 行
  update public.votes set value = -1
  where candidate_id = '00000000-0000-0000-0000-000000000206'
    and user_id = '00000000-0000-0000-0000-00000000020b';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL(020/c): B updating own vote affected % rows (expected 1)', n;
  end if;

  -- A の vote への UPDATE → 0 行 (vote_update using: user_id = auth.uid())
  update public.votes set value = -1
  where candidate_id = '00000000-0000-0000-0000-000000000205'
    and user_id = '00000000-0000-0000-0000-00000000020a';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL(020/c): B updated A''s vote (% rows)', n;
  end if;

  -- 値が本当に変わっていないこと (B はメンバーなので A の vote を SELECT はできる)
  select value into a_value from public.votes
  where candidate_id = '00000000-0000-0000-0000-000000000205'
    and user_id = '00000000-0000-0000-0000-00000000020a';
  if a_value <> 1 then
    raise exception 'FAIL(020/c): A''s vote value changed to %', a_value;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- d. value=5 → check 制約違反 (23514)。
--    実測: RLS WITH CHECK (user/member/candidate 一致) は満たすため、
--    votes_value_check (value in (-1,0,1)) が発火する。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000020b","role":"authenticated"}';

do $$
begin
  begin
    insert into public.votes (investigation_id, candidate_id, user_id, value)
    values ('00000000-0000-0000-0000-000000000201',
            '00000000-0000-0000-0000-000000000206',
            '00000000-0000-0000-0000-00000000020b',
            5);
    raise exception 'FAIL(020/d): vote with value=5 was accepted';
  exception
    when check_violation then null;  -- 期待どおり 23514 (votes_value_check)
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- e. UPDATE の WITH CHECK バイパス試行 (cross-investigation への付け替え)。
--    B が自分の vote (I1×C3) の candidate_id だけを I2 の candidate C2 に変える:
--      * USING (user_id=auth.uid() && member(I1)) は旧行に対して真 → 行は更新対象
--      * WITH CHECK の exists(c.id=candidate_id && c.investigation_id=votes.investigation_id)
--        が新行 (I1×C2) で偽 → ここが最後の砦
--    実測 (PG17): silent 0 行ではなく SQLSTATE=42501
--    'new row violates row-level security policy for table "votes"' が送出される。
--    42501 以外のカテゴリは再送出して FAIL (偽装パス防止)。
--    捕捉後、B の vote 行が不変 (candidate_id/value とも) であることも確認する。
--    注: votes の PK は (candidate_id, user_id) なので (C2,B) は衝突せず、
--        この試行を止められるのは RLS WITH CHECK だけである。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000020b","role":"authenticated"}';

do $$
declare denied boolean := false; v_state text := ''; v_msg text := '';
        v_cand uuid; v_val smallint;
begin
  -- 自分の正当な vote を用意 (vote_insert の正例。この tx 内でのみ存在し rollback で消える)
  insert into public.votes (investigation_id, candidate_id, user_id, value)
  values ('00000000-0000-0000-0000-000000000201',
          '00000000-0000-0000-0000-000000000206',
          '00000000-0000-0000-0000-00000000020b', 1);

  begin
    update public.votes
       set candidate_id = '00000000-0000-0000-0000-000000000207'  -- C2 = I2 の candidate
     where candidate_id = '00000000-0000-0000-0000-000000000206'
       and user_id = '00000000-0000-0000-0000-00000000020b';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42501' then
      raise;  -- 期待外カテゴリ (テスト自体の壊れ方) はそのまま FAIL させる
    end if;
    if v_msg not ilike '%row-level security%' then
      raise exception 'FAIL(020/e): got 42501 but unexpected message: %', v_msg;
    end if;
    denied := true;
  end;
  if not denied then
    raise exception 'FAIL(020/e): B repointed own vote to another investigation''s candidate (WITH CHECK did not fire)';
  end if;

  -- 拒否後、行が完全に不変であること (candidate_id も value も元のまま)
  select candidate_id, value into v_cand, v_val
  from public.votes
  where user_id = '00000000-0000-0000-0000-00000000020b';
  if v_cand is distinct from '00000000-0000-0000-0000-000000000206'::uuid or v_val is distinct from 1::smallint then
    raise exception 'FAIL(020/e): B''s vote row changed after denied update (candidate=%, value=%)', v_cand, v_val;
  end if;
  -- I2 側の candidate に vote 行が生えていないこと
  if (select count(*) from public.votes
      where candidate_id = '00000000-0000-0000-0000-000000000207') <> 0 then
    raise exception 'FAIL(020/e): a vote row appeared on I2''s candidate C2';
  end if;
end $$;
rollback;

\echo == 020_votes_integrity.sql: all assertions passed
