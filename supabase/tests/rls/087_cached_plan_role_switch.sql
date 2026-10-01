-- 087_cached_plan_role_switch.sql — prepared plan のロール切替回帰
--
-- PostgreSQL CVE-2023-2455 の upstream regression test と同じ形で、SQL-language
-- SRF を含む prepared statement を role A/B で再利用する。認可条件が plan に
-- 固定されると、anon が authenticated 向けの行を取得できてしまうため、
-- 実行時 role ごとの期待件数を statement 自身で検証する。
--
-- このテスト専用の表・function はトランザクション内で作成して必ず破棄する。

begin;

create table public.rls_cached_plan_fixture (
  id integer primary key,
  body text not null
);

insert into public.rls_cached_plan_fixture (id, body)
values (1, 'role-sensitive fixture');

alter table public.rls_cached_plan_fixture enable row level security;
grant select on public.rls_cached_plan_fixture to authenticated, anon;

create policy rls_cached_plan_authenticated
  on public.rls_cached_plan_fixture
  for select to authenticated
  using (true);

create policy rls_cached_plan_anon
  on public.rls_cached_plan_fixture
  for select to anon
  using (false);

create function public.rls_cached_plan_fixture_rows()
returns setof public.rls_cached_plan_fixture
stable
language sql
as $$
  select * from public.rls_cached_plan_fixture
$$;

-- PREPARE は postgres role のまま行い、実行時だけ role を切り替える。
-- current_user に応じた期待値も同じ prepared statement で評価する。
prepare rls_cached_plan_check as
  select (
    count(*) = case current_user
      when 'authenticated' then 1
      when 'anon' then 0
      else -1
    end
  ) as ok
  from public.rls_cached_plan_fixture_rows();

set local row_security = on;
set local role authenticated;
execute rls_cached_plan_check \gset rls_authenticated_
\if :rls_authenticated_ok
\else
  \echo 'FAIL(087/authenticated): prepared RLS plan returned an unexpected row count'
  \quit 1
\endif

set local role anon;
execute rls_cached_plan_check \gset rls_anon_
\if :rls_anon_ok
\else
  \echo 'FAIL(087/anon): prepared RLS plan reused the authenticated role policy'
  \quit 1
\endif

reset role;
deallocate rls_cached_plan_check;
drop function public.rls_cached_plan_fixture_rows();
drop table public.rls_cached_plan_fixture;
commit;

select '087_cached_plan_role_switch.sql: all assertions passed' as result;
