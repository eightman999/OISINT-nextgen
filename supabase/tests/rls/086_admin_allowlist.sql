-- 086_admin_allowlist.sql — 管理者allow-listのclient昇格防止 (#158)
--
-- admin_allowlistはservice_roleだけが管理し、判定RPCはJWT subjectと
-- is_anonymous=falseを必須にする。ここでは管理操作そのものは作らず、
-- 一般クライアントへ権限を渡さない境界だけを検証する。

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000086a', false),
  ('00000000-0000-0000-0000-00000000086b', false),
  ('00000000-0000-0000-0000-00000000086c', true);

begin;
set local role service_role;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000086a","role":"service_role","is_anonymous":false}';
insert into public.admin_allowlist (user_id, role)
values
  ('00000000-0000-0000-0000-00000000086a', 'auditor'),
  ('00000000-0000-0000-0000-00000000086c', 'reviewer');
commit;

-- allow-listの登録・変更はservice_roleのみに限定する。
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000086b","role":"authenticated","is_anonymous":false}';

do $$
begin
  begin
    insert into public.admin_allowlist (user_id, role)
    values ('00000000-0000-0000-0000-00000000086b', 'operator');
    raise exception 'FAIL(086/a): authenticated user inserted admin allow-list row';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.admin_allowlist;
    raise exception 'FAIL(086/b): authenticated user read admin allow-list';
  exception
    when insufficient_privilege then null;
  end;
end $$;

do $$
begin
  if public.current_user_is_admin() then
    raise exception 'FAIL(086/c): ordinary authenticated user was treated as admin';
  end if;
end $$;
rollback;

begin;
-- JWTのrole claimをservice_roleへ偽装しても、DBロールの権限やadmin判定は変わらない。
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000086b","role":"service_role","is_anonymous":false}';
do $$
begin
  begin
    insert into public.admin_allowlist (user_id, role)
    values ('00000000-0000-0000-0000-00000000086b', 'operator');
    raise exception 'FAIL(086/c2): forged service_role claim inserted admin allow-list row';
  exception
    when insufficient_privilege then null;
  end;

  if public.current_user_is_admin() then
    raise exception 'FAIL(086/c3): forged service_role claim was treated as admin';
  end if;
end $$;
rollback;

begin;
-- allow-listに存在しても匿名JWTは管理者になれない。
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000086c","role":"authenticated","is_anonymous":true}';
do $$
begin
  if public.current_user_is_admin() then
    raise exception 'FAIL(086/d): anonymous user was treated as admin';
  end if;
end $$;
rollback;

begin;
-- 登録済みの永久ユーザーだけがtrueになる。
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000086a","role":"authenticated","is_anonymous":false}';
do $$
begin
  if not public.current_user_is_admin() then
    raise exception 'FAIL(086/e): allow-listed permanent user was not treated as admin';
  end if;
end $$;

rollback;
