-- =============================================================================
-- 093_auth_user_cascade_guards.sql — #167 stale JWT / account cascade boundary
--
-- Auth deletion cascades only account-owned rows. Shared places/evidence remain
-- available, re-inserting the deleted UUID is rejected, and the service purge
-- boundary is not callable by authenticated clients.
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values ('00000000-0000-4000-8000-000000000931', false);

insert into public.places (id, provider, provider_place_id, name)
values ('00000000-0000-4000-8000-000000000932', 'fixture', '093-shared', 'Shared 093');

insert into public.investigations (id, created_by, title, raw_query, share_token)
values (
  '00000000-0000-4000-8000-000000000933',
  '00000000-0000-4000-8000-000000000931',
  'Account investigation 093', 'private query 093', 'share093'
);

insert into public.investigation_members (investigation_id, user_id, role)
values ('00000000-0000-4000-8000-000000000933', '00000000-0000-4000-8000-000000000931', 'owner');

insert into public.requirements (id, investigation_id, created_by, text)
values (
  '00000000-0000-4000-8000-000000000934',
  '00000000-0000-4000-8000-000000000933',
  '00000000-0000-4000-8000-000000000931',
  'private requirement 093'
);

insert into public.candidates (id, investigation_id, place_id, rank)
values (
  '00000000-0000-4000-8000-000000000935',
  '00000000-0000-4000-8000-000000000933',
  '00000000-0000-4000-8000-000000000932', 1
);

insert into public.votes (investigation_id, candidate_id, user_id, value)
values (
  '00000000-0000-4000-8000-000000000933',
  '00000000-0000-4000-8000-000000000935',
  '00000000-0000-4000-8000-000000000931', 1
);

insert into public.place_feedback (id, place_id, user_id, rating, aspect)
values (
  '00000000-0000-4000-8000-000000000936',
  '00000000-0000-4000-8000-000000000932',
  '00000000-0000-4000-8000-000000000931', 1, 'value'
);

insert into public.evidence (
  id, investigation_id, place_id, scope, source_type, source_url, observed_at
)
values (
  '00000000-0000-4000-8000-000000000937',
  null,
  '00000000-0000-4000-8000-000000000932',
  'shared', 'official_site', 'https://example.com/shared-093', now()
);

-- The cleanup RPC is service-role-only even for the account owner.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000931","role":"authenticated"}';
do $$
begin
  begin
    perform public.delete_user_account_data('00000000-0000-4000-8000-000000000931');
    raise exception 'FAIL(093/acl): authenticated executed account purge RPC';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000931","role":"service_role"}';

-- Auth deletion itself is the source-of-truth cascade boundary.
reset role;
delete from auth.users
 where id = '00000000-0000-4000-8000-000000000931';

do $$
begin
  if exists (select 1 from public.investigations where id = '00000000-0000-4000-8000-000000000933')
     or exists (select 1 from public.investigation_members where investigation_id = '00000000-0000-4000-8000-000000000933')
     or exists (select 1 from public.requirements where id = '00000000-0000-4000-8000-000000000934')
     or exists (select 1 from public.votes where candidate_id = '00000000-0000-4000-8000-000000000935')
     or exists (select 1 from public.place_feedback where id = '00000000-0000-4000-8000-000000000936') then
    raise exception 'FAIL(093/cascade): account-owned rows remain after auth deletion';
  end if;
  if not exists (select 1 from public.places where id = '00000000-0000-4000-8000-000000000932')
     or not exists (select 1 from public.evidence where id = '00000000-0000-4000-8000-000000000937') then
    raise exception 'FAIL(093/shared): shared place/evidence was deleted';
  end if;
end;
$$;

-- Re-running the service purge after Auth deletion is an idempotent no-op.
set local role service_role;
do $$
declare
  v_first jsonb;
  v_second jsonb;
begin
  v_first := public.delete_user_account_data(
    '00000000-0000-4000-8000-000000000931'
  );
  v_second := public.delete_user_account_data(
    '00000000-0000-4000-8000-000000000931'
  );
  if (v_first ->> 'investigations_deleted') <> '0'
     or (v_second ->> 'investigations_deleted') <> '0' then
    raise exception 'FAIL(093/idempotent): repeated deleted-account purge changed state: % %',
      v_first, v_second;
  end if;
end;
$$;

-- A stale JWT cannot recreate rows tied to the deleted subject.
do $$
begin
  begin
    insert into public.investigations (id, created_by, title, raw_query, share_token)
    values (
      '00000000-0000-4000-8000-000000000938',
      '00000000-0000-4000-8000-000000000931',
      'Stale account 093', 'stale query 093', 'share938'
    );
    raise exception 'FAIL(093/reinsert): deleted UUID was accepted';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

rollback;

\echo == 093_auth_user_cascade_guards.sql: all assertions passed
