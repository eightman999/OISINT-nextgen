-- 089_place_feedback_update.sql — 来店フィードバック編集の本人境界と再集計
--
-- 検証対象 (migration 202608240003):
--   1. update_place_feedback は place + feedback + auth.uid() を固定する。
--   2. 他ユーザーは本人行を更新できない。
--   3. 3件の集計は更新後の多数派へ変わる。
--   4. 3件未満へ戻った旧 aspect の place_facts は削除される。
--   5. authenticated の直接 UPDATE 権限は閉じられている。

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000891'), -- A / owner
  ('00000000-0000-0000-0000-000000000892'), -- B / other user
  ('00000000-0000-0000-0000-000000000893'); -- C

insert into public.places (id, provider, provider_place_id, name)
values (
  '00000000-0000-0000-0000-000000000894',
  'geoapify',
  'rls089-p1',
  'Place 089'
);

insert into public.place_feedback
  (id, place_id, user_id, visited_at, rating, aspect, aspect_value)
values
  ('00000000-0000-0000-0000-000000000895',
   '00000000-0000-0000-0000-000000000894',
   '00000000-0000-0000-0000-000000000891',
   date '2026-08-01', 1, 'noise', 'quiet'),
  ('00000000-0000-0000-0000-000000000896',
   '00000000-0000-0000-0000-000000000894',
   '00000000-0000-0000-0000-000000000892',
   date '2026-08-02', 0, 'noise', 'quiet'),
  ('00000000-0000-0000-0000-000000000897',
   '00000000-0000-0000-0000-000000000894',
   '00000000-0000-0000-0000-000000000893',
   date '2026-08-03', -1, 'noise', 'loud');

-- A が自分の行を同じ値で更新すると、noise は3件の集計として作られる。
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000000891","role":"authenticated"}';
select public.update_place_feedback(
  '00000000-0000-0000-0000-000000000894',
  '00000000-0000-0000-0000-000000000895',
  date '2026-08-01', 1::smallint, 'noise', 'quiet'
);
commit;

do $$
declare
  v_value jsonb;
  v_count int;
begin
  select value, evidence_count into v_value, v_count
  from public.place_facts
  where place_id = '00000000-0000-0000-0000-000000000894'
    and key = 'noise_level';
  if v_count <> 3 or v_value->>'value' <> 'quiet' then
    raise exception 'FAIL(089/threshold): expected 3-row quiet fact, got value=% count=%', v_value, v_count;
  end if;
end $$;

-- A の編集で多数派が loud へ変わる。古い集計値を返さない。
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000000891","role":"authenticated"}';
select public.update_place_feedback(
  '00000000-0000-0000-0000-000000000894',
  '00000000-0000-0000-0000-000000000895',
  date '2026-08-01', 1::smallint, 'noise', 'loud'
);
commit;

do $$
declare
  v_value jsonb;
  v_count int;
begin
  select value, evidence_count into v_value, v_count
  from public.place_facts
  where place_id = '00000000-0000-0000-0000-000000000894'
    and key = 'noise_level';
  if v_count <> 3 or v_value->>'value' <> 'loud' then
    raise exception 'FAIL(089/recompute): expected 3-row loud fact after edit, got value=% count=%', v_value, v_count;
  end if;
end $$;

-- aspect を space へ移すと、noise は2件になり旧 fact を削除する。
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000000891","role":"authenticated"}';
select public.update_place_feedback(
  '00000000-0000-0000-0000-000000000894',
  '00000000-0000-0000-0000-000000000895',
  date '2026-08-01', 1::smallint, 'space', 'comfortable'
);
commit;

do $$
declare
  v_noise int;
  v_space int;
begin
  select count(*) into v_noise
  from public.place_facts
  where place_id = '00000000-0000-0000-0000-000000000894'
    and key = 'noise_level';
  select count(*) into v_space
  from public.place_facts
  where place_id = '00000000-0000-0000-0000-000000000894'
    and key = 'space_comfort';
  if v_noise <> 0 or v_space <> 0 then
    raise exception 'FAIL(089/threshold-cleanup): stale facts remain noise=% space=%', v_noise, v_space;
  end if;
end $$;

-- B は A の feedback id を知っていても更新できない。
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000000892","role":"authenticated"}';
do $$
declare
  v_blocked boolean := false;
begin
  begin
    perform public.update_place_feedback(
      '00000000-0000-0000-0000-000000000894',
      '00000000-0000-0000-0000-000000000895',
      date '2026-08-24', 1::smallint, 'noise', 'forged'
    );
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL(089/owner): another user updated the owner feedback row';
  end if;
end $$;
rollback;

do $$
declare
  v_aspect text;
  v_value text;
begin
  select aspect, aspect_value into v_aspect, v_value
  from public.place_feedback
  where id = '00000000-0000-0000-0000-000000000895';
  if v_aspect <> 'space' or v_value <> 'comfortable' then
    raise exception 'FAIL(089/owner): owner row changed after rejected update: aspect=% value=%', v_aspect, v_value;
  end if;
end $$;

-- direct UPDATE は権限でも閉じられ、再集計を迂回する経路がない。
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000000891","role":"authenticated"}';
do $$
declare
  v_blocked boolean := false;
begin
  begin
    update public.place_feedback
       set aspect = 'noise'
     where id = '00000000-0000-0000-0000-000000000895';
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL(089/direct-update): authenticated direct UPDATE is still available';
  end if;
end $$;
rollback;
