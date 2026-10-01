-- 202608240008: keep account-owned rows attached to auth.users (#167)
--
-- These constraints are intentionally NOT VALID so existing production
-- orphans are not deleted or made a migration blocker. PostgreSQL still
-- enforces them for every new INSERT/UPDATE, and matching rows cascade when
-- the owning auth.users row is deleted. A later, separately approved cleanup
-- may validate/repair historical rows.

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.investigations'::regclass
       and conname = 'investigations_created_by_auth_users_fkey'
  ) then
    alter table public.investigations
      add constraint investigations_created_by_auth_users_fkey
      foreign key (created_by) references auth.users(id)
      on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.investigation_members'::regclass
       and conname = 'investigation_members_user_id_auth_users_fkey'
  ) then
    alter table public.investigation_members
      add constraint investigation_members_user_id_auth_users_fkey
      foreign key (user_id) references auth.users(id)
      on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.requirements'::regclass
       and conname = 'requirements_created_by_auth_users_fkey'
  ) then
    alter table public.requirements
      add constraint requirements_created_by_auth_users_fkey
      foreign key (created_by) references auth.users(id)
      on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.votes'::regclass
       and conname = 'votes_user_id_auth_users_fkey'
  ) then
    alter table public.votes
      add constraint votes_user_id_auth_users_fkey
      foreign key (user_id) references auth.users(id)
      on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.place_feedback'::regclass
       and conname = 'place_feedback_user_id_auth_users_fkey'
  ) then
    alter table public.place_feedback
      add constraint place_feedback_user_id_auth_users_fkey
      foreign key (user_id) references auth.users(id)
      on delete cascade not valid;
  end if;
end;
$$;

comment on constraint investigations_created_by_auth_users_fkey
  on public.investigations is
  'Account owner cascade; NOT VALID preserves historical orphan rows until an approved purge.';
comment on constraint investigation_members_user_id_auth_users_fkey
  on public.investigation_members is
  'Account membership cascade; NOT VALID preserves historical orphan rows until an approved purge.';
comment on constraint requirements_created_by_auth_users_fkey
  on public.requirements is
  'Account author cascade; NULL authors remain allowed and historical orphans are preserved.';
comment on constraint votes_user_id_auth_users_fkey
  on public.votes is
  'Account voter cascade; NOT VALID preserves historical orphan rows until an approved purge.';
comment on constraint place_feedback_user_id_auth_users_fkey
  on public.place_feedback is
  'Account feedback cascade; NOT VALID preserves historical orphan rows until an approved purge.';
