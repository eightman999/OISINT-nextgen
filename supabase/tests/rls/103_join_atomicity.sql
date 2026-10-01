-- =============================================================================
-- 103_join_atomicity.sql — join-investigation の原子性・権限・上限テスト (#598)
--
-- 検証:
--   a. service_role RPCは有効tokenでjoinedを返し、profile/member/eventを作る
--   b. 同じユーザーの再joinはalready_memberで冪等、eventを増やさない
--   c. 20人到達後はfullを返し、profile/member/eventを増やさない
--   d. 無効tokenは0行、authenticatedからのRPC直接呼出しは拒否
--   e. RPC定義がinvestigation行をFOR UPDATEでロックする
-- =============================================================================

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000103a'),
  ('00000000-0000-0000-0000-00000000103b'),
  ('00000000-0000-0000-0000-00000000103c');

insert into public.investigations (
  id,
  created_by,
  title,
  raw_query,
  share_token
) values (
  '00000000-0000-0000-0000-000000001031',
  '00000000-0000-0000-0000-00000000103a',
  'I103 join atomicity',
  'I103 private query',
  'rls103_join_atomicity_token_0000000000001'
);

insert into public.investigation_members (investigation_id, user_id, role)
values (
  '00000000-0000-0000-0000-000000001031',
  '00000000-0000-0000-0000-00000000103a',
  'owner'
);

-- a. 新規参加は一つのRPCでprofile/member/eventまで確定する。
begin;
set local role service_role;

do $$
declare
  r record;
begin
  select * into r
    from public.join_investigation(
      'rls103_join_atomicity_token_0000000000001',
      '00000000-0000-0000-0000-00000000103b'::uuid,
      '参加者103B'
    );
  if r.status <> 'joined' then
    raise exception 'FAIL(103/a): expected joined, got %', r.status;
  end if;
end $$;

-- 後続の永続状態assertと冪等性テストが同じ参加結果を観測できるよう確定する。
commit;

do $$
begin
  if not exists (
    select 1 from public.profiles
     where id = '00000000-0000-0000-0000-00000000103b'
       and display_name = '参加者103B'
  ) then
    raise exception 'FAIL(103/a): profile was not upserted';
  end if;
  if (select count(*) from public.investigation_members
      where investigation_id = '00000000-0000-0000-0000-000000001031') <> 2 then
    raise exception 'FAIL(103/a): expected two members';
  end if;
  if (select count(*) from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000001031'
        and event_type = 'member_joined') <> 1 then
    raise exception 'FAIL(103/a): expected one member_joined event';
  end if;
end $$;

-- b. 再joinは成功扱いだが、member_joined eventを重複記録しない。
begin;
set local role service_role;

do $$
declare
  r record;
begin
  select * into r
    from public.join_investigation(
      'rls103_join_atomicity_token_0000000000001',
      '00000000-0000-0000-0000-00000000103b'::uuid,
      '参加者103B再表示'
    );
  if r.status <> 'already_member' then
    raise exception 'FAIL(103/b): expected already_member, got %', r.status;
  end if;
end $$;

rollback;

do $$
begin
  if (select count(*) from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000001031'
        and event_type = 'member_joined') <> 1 then
    raise exception 'FAIL(103/b): duplicate member_joined event';
  end if;
end $$;

-- c. owner + 19 members = 20。21人目のprofile/member/eventは増やさない。
insert into auth.users (id)
select md5('rls103-member-' || n)::uuid
  from generate_series(1, 18) as n;

insert into public.investigation_members (investigation_id, user_id, role)
select
  '00000000-0000-0000-0000-000000001031',
  md5('rls103-member-' || n)::uuid,
  'editor'
from generate_series(1, 18) as n;

do $$
begin
  if (select count(*) from public.investigation_members
      where investigation_id = '00000000-0000-0000-0000-000000001031') <> 20 then
    raise exception 'FAIL(103/c fixture): expected 20 members';
  end if;
end $$;

begin;
set local role service_role;

do $$
declare
  r record;
begin
  select * into r
    from public.join_investigation(
      'rls103_join_atomicity_token_0000000000001',
      '00000000-0000-0000-0000-00000000103c'::uuid,
      '参加者103C'
    );
  if r.status <> 'full' then
    raise exception 'FAIL(103/c): expected full, got %', r.status;
  end if;
end $$;

rollback;

do $$
begin
  if exists (select 1 from public.profiles
             where id = '00000000-0000-0000-0000-00000000103c') then
    raise exception 'FAIL(103/c): full join created profile';
  end if;
  if exists (select 1 from public.investigation_members
             where investigation_id = '00000000-0000-0000-0000-000000001031'
               and user_id = '00000000-0000-0000-0000-00000000103c') then
    raise exception 'FAIL(103/c): full join created member';
  end if;
  if (select count(*) from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000001031'
        and event_type = 'member_joined') <> 1 then
    raise exception 'FAIL(103/c): full join created event';
  end if;
end $$;

-- d-1. 無効tokenは存在確認の詳細を返さず0行。
begin;
set local role service_role;

do $$
begin
  if exists (
    select 1 from public.join_investigation(
      'invalid-token-103',
      '00000000-0000-0000-0000-00000000103c'::uuid,
      '参加者103C'
    )
  ) then
    raise exception 'FAIL(103/d1): invalid token returned a row';
  end if;
end $$;

rollback;

-- d-2. service_role専用RPCをauthenticatedから直接呼び出せない。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000103c","role":"authenticated"}';

do $$
begin
  begin
    perform public.join_investigation(
      'rls103_join_atomicity_token_0000000000001',
      '00000000-0000-0000-0000-00000000103c'::uuid,
      '参加者103C'
    );
    raise exception 'FAIL(103/d2): authenticated direct RPC unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
end $$;

rollback;

-- e. 競合防止のためのinvestigation行ロックを関数定義から確認する。
do $$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.join_investigation(text,uuid,text)'::regprocedure
  ) into definition;
  if position('FOR UPDATE' in upper(definition)) = 0 then
    raise exception 'FAIL(103/e): join RPC does not lock investigation row';
  end if;
end $$;
