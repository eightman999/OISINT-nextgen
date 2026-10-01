-- =============================================================================
-- 060_rpc_recall_and_summary.sql — vector recall RPC と feedback 集計 RPC の負例テスト
-- (spec.md §24, §33, §44.5 / migrations 0005 match_investigations,
--  0007 get_place_feedback_summary)
--
-- 登場人物 (このファイル専用の名前空間 ...060x / ...06xx):
--   A = ...060a : IA の owner (IA は embedding あり)
--   B = ...060b : IB の owner (IB は embedding あり)
--   C = ...060c : 非メンバー (どの investigation とも無関係)
--   D = ...060d : place_feedback を 1 行も持たない集計 RPC の呼び手
--
-- 検証:
--   a. match_investigations が RLS バイパスにならないこと (§24)。
--      security definer のため RLS ポリシーは適用されず、関数本文の
--      created_by = auth.uid() / membership フィルタだけが防壁。
--      - a-1: 非メンバー C の呼び出し → 0 行 (A の IA も B の IB も返らない)
--      - a-2: A の呼び出し → 自分の IA ちょうど 1 行。B の IB が混ざったら
--             cross-tenant リーク。返る列は investigation_id/title/similarity
--             のみ (raw_query / share_token / embedding を返さない §33)
--   b. get_place_feedback_summary の最小件数しきい値 (§33「最小3件」/ §44.5)。
--      実装 (0007 L292-349): aspects は同一 (aspect, aspect_value) の行数
--      count(*) >= 3 のグループのみ。visited_count (visited_at 非 null の
--      distinct user 数) と rating_count/rating_avg (rating 非 null の行) には
--      しきい値が無い。生の行・user_id は返さない (raw 行の不可視は 040/b1)。
--      - b-1: noise/quiet が 2 行 (+ space/cramped 1 行) の時点では aspects = []
--      - b-2: noise/quiet 3 行目を足すと aspects にそのグループだけが現れる
--             (2 行の space/cramped は現れない)
--
-- 技法: 768 次元 vector リテラルは array_fill で構築する。
--       fixture は postgres (RLS バイパス = service role 相当) で投入・COMMIT し、
--       RPC 呼び出しは begin; set local role authenticated; ...; rollback; で分離。
--       アサートは全て oisint_rls_test での実測挙動に基づく。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000060a'),  -- A
  ('00000000-0000-0000-0000-00000000060b'),  -- B
  ('00000000-0000-0000-0000-00000000060c'),  -- C
  ('00000000-0000-0000-0000-00000000060d');  -- D

-- embedding 付き investigation を 2 つ (recall 対象になる最低条件 embedding is not null)
insert into public.investigations (id, created_by, title, raw_query, embedding) values
  ('00000000-0000-0000-0000-000000000601',
   '00000000-0000-0000-0000-00000000060a',
   'IA 060 (A own)', 'IA raw query (must stay hidden)',
   ('[' || array_to_string(array_fill(0.1::float4, array[768]), ',') || ']')::vector(768)),
  ('00000000-0000-0000-0000-000000000602',
   '00000000-0000-0000-0000-00000000060b',
   'IB 060 (B own)', 'IB raw query (must stay hidden)',
   ('[' || array_to_string(array_fill(0.2::float4, array[768]), ',') || ']')::vector(768));

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-00000000060a', 'owner'),
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-00000000060b', 'owner');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000603', 'geoapify', 'rls060-p1', 'Place 060');

-- feedback 初期状態 (2 ユーザー 3 行。noise/quiet は 2 行 = しきい値未満):
--   F1: A visited 2026-08-01, rating +1, noise/quiet
--   F2: B visited 2026-08-02, rating -1, noise/quiet
--   F3: A visited なし, rating なし, space/cramped (しきい値未満の別グループ対照)
-- rating 合計 0 → rating_avg は float でも正確に 0 になる値を選んでいる
insert into public.place_feedback (place_id, user_id, visited_at, rating, aspect, aspect_value) values
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-00000000060a',
   date '2026-08-01', 1, 'noise', 'quiet'),
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-00000000060b',
   date '2026-08-02', -1, 'noise', 'quiet'),
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-00000000060a',
   null, null, 'space', 'cramped');

-- フィクスチャ健全性: embedding が本当に入っていること (a が空振りしないための担保)
do $$
begin
  if (select count(*) from public.investigations
      where id in ('00000000-0000-0000-0000-000000000601',
                   '00000000-0000-0000-0000-000000000602')
        and embedding is not null) <> 2 then
    raise exception 'FAIL(060/fixture): investigations with embedding expected 2';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- a-1. 非メンバー C の match_investigations → 0 行。
--      IA/IB とも embedding があり「ベクトル的には最近傍」だが、
--      アクセス可否フィルタで両方落ちること (§24 vector を RLS bypass にしない)。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000060c","role":"authenticated"}';

do $$
declare n int;
begin
  select count(*) into n
  from public.match_investigations(
    query_embedding => ('[' || array_to_string(array_fill(0.1::float4, array[768]), ',') || ']')::vector(768),
    match_count     => 5);
  if n <> 0 then
    raise exception 'FAIL(060/a1): non-member C got % rows from match_investigations (vector recall leaks other users'' investigations)', n;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- a-2. A の match_investigations → 自分の IA ちょうど 1 行。IB は返らない。
--      返る列集合も {investigation_id, title, similarity} ちょうどであること。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000060a","role":"authenticated"}';

do $$
declare n int; n_own int; n_other int; j jsonb; keys text;
begin
  select count(*),
         count(*) filter (where investigation_id = '00000000-0000-0000-0000-000000000601'),
         count(*) filter (where investigation_id = '00000000-0000-0000-0000-000000000602')
    into n, n_own, n_other
  from public.match_investigations(
    query_embedding => ('[' || array_to_string(array_fill(0.1::float4, array[768]), ',') || ']')::vector(768),
    match_count     => 5);
  if n_other <> 0 then
    raise exception 'FAIL(060/a2): A got B''s investigation IB from match_investigations (cross-tenant leak)';
  end if;
  if n_own <> 1 then
    raise exception 'FAIL(060/a2): A''s own IA not returned (% rows)', n_own;
  end if;
  if n <> 1 then
    raise exception 'FAIL(060/a2): A got % rows total (expected exactly 1 = own IA only)', n;
  end if;

  -- 列の露出境界 (030/e と同じ技法): id/title/similarity 以外を返さない
  select to_jsonb(t) into j
  from public.match_investigations(
    query_embedding => ('[' || array_to_string(array_fill(0.1::float4, array[768]), ',') || ']')::vector(768),
    match_count     => 5) t;
  if (j ? 'raw_query') or (j ? 'share_token') or (j ? 'embedding') or (j ? 'normalized_query') then
    raise exception 'FAIL(060/a2): match_investigations leaks sensitive columns: %', j;
  end if;
  select string_agg(k, ',' order by k) into keys from jsonb_object_keys(j) k;
  if keys <> 'investigation_id,similarity,title' then
    raise exception 'FAIL(060/a2): unexpected column set: %', keys;
  end if;
  if j->>'title' <> 'IA 060 (A own)' then
    raise exception 'FAIL(060/a2): returned row is not IA (title=%)', j->>'title';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- b-1. しきい値未満: noise/quiet 2 行 + space/cramped 1 行の時点では
--      aspects = '[]'。個人再識別を防ぐため visited/rating も母数3未満は
--      0/nullへマスクする。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000060d","role":"authenticated"}';

do $$
declare r record; n int;
begin
  select count(*) into n
  from public.get_place_feedback_summary(
    array['00000000-0000-0000-0000-000000000603']::uuid[]);
  if n <> 1 then
    raise exception 'FAIL(060/b1): summary returned % rows for 1 place (expected 1)', n;
  end if;

  select * into r
  from public.get_place_feedback_summary(
    array['00000000-0000-0000-0000-000000000603']::uuid[]);
  if r.visited_count <> 0 then
    raise exception 'FAIL(060/b1): visited_count=% (expected masked 0)', r.visited_count;
  end if;
  if r.rating_count <> 0 then
    raise exception 'FAIL(060/b1): rating_count=% (expected masked 0)', r.rating_count;
  end if;
  if r.rating_avg is not null then
    raise exception 'FAIL(060/b1): rating_avg=% (expected null)', r.rating_avg;
  end if;
  if r.aspects is distinct from '[]'::jsonb then
    raise exception 'FAIL(060/b1): aspects leaked below 3-row threshold: %', r.aspects;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- 3 行目の noise/quiet を postgres (service role 相当) で追加。
--   F4: C visited 2026-08-03, rating 0, noise/quiet
--   → noise/quiet = 3 行 (しきい値到達)。space/cramped は 1 行のまま。
--   rating 合計は 1 + (-1) + 0 = 0 のままなので rating_avg = 0 は不変。
-- ---------------------------------------------------------------------------
insert into public.place_feedback (place_id, user_id, visited_at, rating, aspect, aspect_value) values
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-00000000060c',
   date '2026-08-03', 0, 'noise', 'quiet');

-- ---------------------------------------------------------------------------
-- b-2. しきい値到達後: aspects は noise/quiet (count=3) ちょうど 1 エントリ。
--      space/cramped (1 行) は現れない。visited_count/rating_count は 3 に増える。
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000060d","role":"authenticated"}';

do $$
declare r record; expected jsonb;
begin
  select * into r
  from public.get_place_feedback_summary(
    array['00000000-0000-0000-0000-000000000603']::uuid[]);
  if r.visited_count <> 3 then
    raise exception 'FAIL(060/b2): visited_count=% (expected 3)', r.visited_count;
  end if;
  if r.rating_count <> 3 then
    raise exception 'FAIL(060/b2): rating_count=% (expected 3)', r.rating_count;
  end if;
  if r.rating_avg is distinct from 0::real then
    raise exception 'FAIL(060/b2): rating_avg=% (expected 0)', r.rating_avg;
  end if;

  -- jsonb の構造等価比較: ちょうど 1 エントリ {aspect:noise, aspect_value:quiet, count:3}
  expected := jsonb_build_array(
    jsonb_build_object('aspect', 'noise', 'aspect_value', 'quiet', 'count', 3));
  if r.aspects is distinct from expected then
    raise exception 'FAIL(060/b2): aspects mismatch. got=% expected=%', r.aspects, expected;
  end if;
end $$;
rollback;

\echo == 060_rpc_recall_and_summary.sql: all assertions passed
