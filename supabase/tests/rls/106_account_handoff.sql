-- =============================================================================
-- 106_account_handoff.sql — Issue #166
-- =============================================================================
-- Google identity linkは同じAuth UUIDを維持する。匿名時に予約した操作IDだけを
-- 恒久Google JWTのEdge/RPCが一度だけ完了でき、別ユーザー・client直接RPC・期限切れ
-- などは所有権やmember行を変更できないことを確認する。

begin;

create function pg_temp.assert_106(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'FAIL(106/%): assertion failed', p_message;
  end if;
end;
$$;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000001661', true),
  ('00000000-0000-4000-8000-000000001662', false);

insert into auth.identities (id, provider_id, provider, user_id, identity_data)
values (
  '00000000-0000-4000-8000-000000001663',
  'google-166-a',
  'google',
  '00000000-0000-4000-8000-000000001661',
  '{}'::jsonb
);

insert into public.investigations (
  id, created_by, title, raw_query, share_token
)
values (
  '00000000-0000-4000-8000-000000001660',
  '00000000-0000-4000-8000-000000001661',
  'Account handoff fixture 166',
  'account handoff fixture 166',
  'rls166_account_handoff_token_000000000001'
);

insert into public.investigation_members (investigation_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000001660',
  '00000000-0000-4000-8000-000000001661',
  'owner'
);

-- anonymous Aは同じ操作を再送しても同じpending operationを受け取る。
create temporary table handoff_166_operation (operation_id uuid);
grant select, insert on handoff_166_operation to authenticated, service_role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001661","role":"authenticated","is_anonymous":true}';

insert into handoff_166_operation
select public.prepare_account_handoff();
select pg_temp.assert_106(
  (select operation_id is not null from handoff_166_operation),
  'anonymous-prepare'
);

do $$
declare
  first_id uuid;
  second_id uuid;
begin
  select operation_id into first_id from handoff_166_operation;
  select public.prepare_account_handoff() into second_id;
  if first_id <> second_id then
    raise exception 'FAIL(106/prepare-idempotency): operation id changed';
  end if;
end $$;

-- operation tableと完了RPCはclientへ直接公開しない。
do $$
declare
  denied boolean := false;
begin
  begin
    perform 1 from public.account_handoff_operations;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'FAIL(106/operation-acl): authenticated selected operation table';
  end if;

  denied := false;
  begin
    perform public.complete_account_handoff(
      (select operation_id from handoff_166_operation),
      '00000000-0000-4000-8000-000000001661'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'FAIL(106/complete-acl): authenticated executed service RPC';
  end if;
end $$;

-- 未リンク匿名JWTは予約以外の完了経路へ進めない。
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001661","role":"authenticated","is_anonymous":false}';
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.prepare_account_handoff();
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'FAIL(106/permanent-prepare): anonymous-only RPC accepted wrong claim';
  end if;
end $$;

-- link後のAuth正本を再現する。client roleではAuth本体を更新できない。
reset role;
update auth.users
   set is_anonymous = false
 where id = '00000000-0000-4000-8000-000000001661';

-- JWT subjectが異なるB（Google連携済み）を準備する。Aのoperationは使えない。
insert into auth.identities (id, provider_id, provider, user_id, identity_data)
values (
  '00000000-0000-4000-8000-000000001664',
  'google-166-b',
  'google',
  '00000000-0000-4000-8000-000000001662',
  '{}'::jsonb
);

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001661","role":"service_role","is_anonymous":false}';

do $$
declare
  result_status text;
  result_events integer;
begin
  select status, event_count
    into result_status, result_events
    from public.complete_account_handoff(
      (select operation_id from handoff_166_operation),
      '00000000-0000-4000-8000-000000001661'
    );
  if result_status <> 'completed' or result_events <> 1 then
    raise exception 'FAIL(106/complete): status=% events=%', result_status, result_events;
  end if;

  -- 同じoperationのreplayは成功扱いだがeventを増やさない。
  select status, event_count
    into result_status, result_events
    from public.complete_account_handoff(
      (select operation_id from handoff_166_operation),
      '00000000-0000-4000-8000-000000001661'
    );
  if result_status <> 'already_completed' or result_events <> 0 then
    raise exception 'FAIL(106/replay): status=% events=%', result_status, result_events;
  end if;
end $$;

-- 他人のJWT subjectで同じoperationを実行しても、存在を漏らさず拒否する。
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.complete_account_handoff(
      (select operation_id from handoff_166_operation),
      '00000000-0000-4000-8000-000000001662'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'FAIL(106/cross-user): another user completed A operation';
  end if;
end $$;

select pg_temp.assert_106(
  (select created_by = '00000000-0000-4000-8000-000000001661'
     from public.investigations
    where id = '00000000-0000-4000-8000-000000001660'),
  'owner-unchanged'
);
select pg_temp.assert_106(
  (select role = 'owner'
     from public.investigation_members
    where investigation_id = '00000000-0000-4000-8000-000000001660'
      and user_id = '00000000-0000-4000-8000-000000001661'),
  'member-owner-unchanged'
);
select pg_temp.assert_106(
  (select count(*) = 1
     from public.investigation_events
    where investigation_id = '00000000-0000-4000-8000-000000001660'
      and event_type = 'account_handoff_completed'),
  'single-audit-event'
);
select pg_temp.assert_106(
  (select metadata = '{"method":"google_identity_link"}'::jsonb
     from public.investigation_events
    where investigation_id = '00000000-0000-4000-8000-000000001660'
      and event_type = 'account_handoff_completed'),
  'safe-audit-metadata'
);
select pg_temp.assert_106(
  (select count(*) = 0
     from public.investigation_members
    where investigation_id = '00000000-0000-4000-8000-000000001660'
      and user_id = '00000000-0000-4000-8000-000000001662'),
  'no-other-member-added'
);

-- 別ユーザーからは監査イベントも見えない。
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001662","role":"authenticated","is_anonymous":false}';
select pg_temp.assert_106(
  (select count(*) = 0
     from public.investigation_events
    where investigation_id = '00000000-0000-4000-8000-000000001660'
      and event_type = 'account_handoff_completed'),
  'event-rls-cross-user'
);


\echo == 106_account_handoff.sql: all assertions passed
rollback;
