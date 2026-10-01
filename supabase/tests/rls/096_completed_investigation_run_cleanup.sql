-- =============================================================================
-- 096_completed_investigation_run_cleanup.sql — #579 drain convergence
-- =============================================================================

create or replace function public.test_assert_096(ok boolean, message text)
returns void language plpgsql as $$
begin
  if not ok then raise exception '%', message; end if;
end;
$$;

begin;

insert into auth.users (id, is_anonymous)
values ('00000000-0000-4000-8000-000000000961', false);

insert into public.investigations (id, created_by, title, raw_query, status)
values (
  '00000000-0000-4000-8000-000000000962',
  '00000000-0000-4000-8000-000000000961',
  'Completed investigation fixture',
  'completed investigation fixture',
  'complete'
);

insert into public.investigation_runs (
  id, investigation_id, status, acceptance_state, accepted_at,
  request_id, current_step
)
values (
  '00000000-0000-4000-8000-000000000963',
  '00000000-0000-4000-8000-000000000962',
  'queued',
  'accepted',
  clock_timestamp() - interval '1 second',
  '00000000-0000-4000-8000-000000000964',
  'searching'
);

-- A drain claim returns the existing complete state and terminalizes the
-- orphaned accepted row in the same advisory/investigation lock boundary.
do $$
declare
  v_claim record;
begin
  select * into v_claim
    from public.claim_investigation_run(
      '00000000-0000-4000-8000-000000000962',
      '00000000-0000-4000-8000-000000000965',
      180,
      '00000000-0000-4000-8000-000000000964',
      false
    );
  if v_claim.acquired or v_claim.status <> 'complete' or not v_claim.accepted then
    raise exception 'FAIL(096/claim): complete investigation did not return terminal response: %', v_claim;
  end if;
end;
$$;

select public.test_assert_096(
  (select status = 'rejected'
      and acceptance_state = 'rejected'
      and lease_owner is null
      and lease_expires_at is null
      and last_error_code = 'investigation_already_complete'
     from public.investigation_runs
    where id = '00000000-0000-4000-8000-000000000963'),
  'FAIL(096/cleanup): queued accepted run was not terminalized'
);
select public.test_assert_096(
  not exists (
    select 1 from public.investigation_runs
     where investigation_id = '00000000-0000-4000-8000-000000000962'
       and status in ('queued', 'running')
  ),
  'FAIL(096/drain): active row remained eligible after 409 convergence'
);

-- A second drain call is a no-op and cannot recreate an active row.
do $$
declare
  v_claim record;
begin
  select * into v_claim
    from public.claim_investigation_run(
      '00000000-0000-4000-8000-000000000962',
      '00000000-0000-4000-8000-000000000966',
      180,
      '00000000-0000-4000-8000-000000000964',
      false
    );
  if v_claim.acquired or v_claim.status <> 'complete' then
    raise exception 'FAIL(096/repeat): second complete drain claim was not a no-op: %', v_claim;
  end if;
end;
$$;
select public.test_assert_096(
  (select count(*) = 1
     from public.investigation_runs
    where investigation_id = '00000000-0000-4000-8000-000000000962'
      and status = 'rejected'),
  'FAIL(096/repeat): duplicate terminalization changed run count'
);

rollback;

drop function public.test_assert_096(boolean, text);

\echo == 096_completed_investigation_run_cleanup.sql: all assertions passed
