-- 202608240001: 管理者権限の最小境界 (#158)
--
-- 一般ユーザー向けアプリに管理者UIや昇格入力は持たせない。
-- allow-listの登録・変更は運営のservice_role経路だけが行い、
-- 判定はDB内の本人JWT subjectと匿名フラグを使う。

create table public.admin_allowlist (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('reviewer', 'moderator', 'operator', 'auditor')),
  granted_at timestamptz not null default now()
);

comment on table public.admin_allowlist is
  'Server-managed operator allow-list. Browser clients cannot read or mutate it.';
comment on column public.admin_allowlist.role is
  'Least-privilege operator role; current_user_is_admin() is display-only and grants no consumer data access.';

alter table public.admin_allowlist enable row level security;
revoke all on public.admin_allowlist from anon, authenticated;
grant all on public.admin_allowlist to service_role;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from auth.users u
      where u.id = auth.uid()
        and coalesce(u.is_anonymous, false) = false
    )
    and exists (
      select 1
      from public.admin_allowlist
      where user_id = auth.uid()
    );
$$;

revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to authenticated, service_role;
