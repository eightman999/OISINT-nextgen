-- 0015: profilesの直接参照を本人だけに限定する。
--
-- 共同調査のメンバー表示は、membershipを検証するsecurity definer RPC
-- get_investigation_members(inv)だけを正本とする。profiles全表をauthenticatedへ
-- 公開する必要はなく、Issue #158の「他ユーザーprofileを直接読めない」境界を固定する。

drop policy if exists prof_select on public.profiles;
drop policy if exists prof_select_own on public.profiles;

create policy prof_select_own on public.profiles for select
  to authenticated
  using (id = auth.uid());

comment on policy prof_select_own on public.profiles is
  'Authenticated users may read only their own profile. Shared-investigation member names use get_investigation_members().';
