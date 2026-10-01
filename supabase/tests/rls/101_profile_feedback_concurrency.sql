-- =============================================================================
-- 101_profile_feedback_concurrency.sql — #515 profile save/delete and feedback CAS
-- =============================================================================
-- Profile writes and feedback learning both update the same aggregate snapshot.
-- The profile RPC must therefore hold the feedback user lock. Legacy full
-- snapshot overloads are fail-closed because they cannot carry a caller-bound
-- revision and must never be used to apply a stale payload.

create extension if not exists dblink;

insert into auth.users (id, is_anonymous)
values ('00000000-0000-4000-8000-000000001011', false);

insert into public.places (id, provider, provider_place_id, name)
values (
  '00000000-0000-4000-8000-000000001012',
  'fixture', '101-profile-feedback', 'Profile feedback 101'
);

set role service_role;
insert into public.place_feedback
  (id, place_id, user_id, rating, aspect, aspect_value)
values (
  '00000000-0000-4000-8000-000000001013',
  '00000000-0000-4000-8000-000000001012',
  '00000000-0000-4000-8000-000000001011',
  1, 'noise', 'quiet'
);
reset role;

select dblink_connect(
  'profile_feedback_cas_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'profile_feedback_cas_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('profile_feedback_cas_a', 'set role authenticated');
select dblink_exec('profile_feedback_cas_b', 'set role authenticated');
select dblink_exec(
  'profile_feedback_cas_a',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000001011","role":"authenticated","is_anonymous":false}'$$
);
select dblink_exec(
  'profile_feedback_cas_b',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000001011","role":"authenticated","is_anonymous":false}'$$
);
select dblink_exec('profile_feedback_cas_a', 'begin');
select dblink_exec('profile_feedback_cas_b', 'begin');

-- A commits a profile snapshot while retaining its transaction. This must hold
-- the same user lock used by save_place_feedback_learning.
select dblink_exec(
  'profile_feedback_cas_a',
  $cmd$do $proc$
  begin
    perform public.save_user_preference_profile(
      null,
      '{"evidence":50,"health":50,"quiet":70,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], 'profile-v1', array['profile_edits']::text[],
      '{}'::jsonb, 'personalization-v2', 'account', null::timestamptz, false
    );
  end;
  $proc$
  $cmd$
);

-- The current 9-argument feedback RPC enters the same lock. It must wait and,
-- after A commits, fail with a stale-profile conflict rather than losing the
-- event.
select dblink_send_query(
  'profile_feedback_cas_b',
  $$select public.save_place_feedback_learning(
    '00000000-0000-4000-8000-000000001013', null,
    '{"evidence":50,"health":50,"quiet":50,"value":86,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[], '{}'::jsonb, 'personalization-v2',
    null::timestamptz, false
  )$$
);
do $$
begin
  if dblink_is_busy('profile_feedback_cas_b') <> 1 then
    raise exception 'FAIL(101/lock): current feedback RPC did not wait for profile user lock';
  end if;
end;
$$;
select dblink_exec('profile_feedback_cas_a', 'commit');

do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('profile_feedback_cas_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('profile_feedback_cas_b') <> 0 then
    raise exception 'FAIL(101/stale): legacy feedback RPC did not finish';
  end if;
end;
$$;
create temporary table profile_feedback_cas_b_error(message text);
insert into profile_feedback_cas_b_error(message)
  select message
    from dblink_get_result('profile_feedback_cas_b', false)
      as result(message text);
select * from dblink_get_result('profile_feedback_cas_b', false)
  as result(message text);
do $$
begin
  if exists (
    select 1 from profile_feedback_cas_b_error
      where message not like '%preference profile was created%'
  ) then
    raise exception 'FAIL(101/stale-result): legacy feedback RPC returned an unexpected result';
  end if;
end;
$$;
select dblink_exec('profile_feedback_cas_b', 'rollback');

select dblink_disconnect('profile_feedback_cas_a');
select dblink_disconnect('profile_feedback_cas_b');

set role authenticated;
set request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001011","role":"authenticated","is_anonymous":false}';

-- The current 9-argument client retries with the canonical revision and keeps
-- the feedback receipt/event rather than silently dropping it.
do $$
declare
  v_revision timestamptz;
begin
  select updated_at into v_revision
    from public.user_preference_profiles
   where user_id = auth.uid();
  perform public.save_place_feedback_learning(
    '00000000-0000-4000-8000-000000001013', null,
    '{"evidence":50,"health":50,"quiet":70,"value":86,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[], '{}'::jsonb, 'personalization-v2', v_revision, true
  );
end;
$$;

do $$
declare
  v_scores jsonb;
begin
  select axis_scores into v_scores
    from public.user_preference_profiles
   where user_id = auth.uid();
  if v_scores ->> 'quiet' <> '70'
     or v_scores ->> 'value' <> '86'
     or (select count(*) from public.preference_signal_receipts where user_id = auth.uid()) <> 1
  then
    raise exception 'FAIL(101/retry): canonical feedback observation was not retained: %', v_scores;
  end if;
end;
$$;

-- All legacy full-snapshot overloads reject a payload that was already stale
-- before the RPC began. They must not read the current revision and forward it.
do $$
begin
  begin
    perform public.save_user_preference_profile(
      null,
      '{"evidence":50,"health":50,"quiet":1,"value":1,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], 'legacy-v1-stale', array['demo_answers']::text[],
      'personalization-v1', 'account'
    );
    raise exception 'FAIL(101/legacy-8): stale 8-argument profile snapshot was accepted';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.save_user_preference_profile(
      null,
      '{"evidence":50,"health":50,"quiet":2,"value":2,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], 'legacy-v2-stale', array['profile_edits']::text[],
      '{}'::jsonb, 'personalization-v2', 'account'
    );
    raise exception 'FAIL(101/legacy-9): stale 9-argument profile snapshot was accepted';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000001013', null,
      '{"evidence":50,"health":50,"quiet":3,"value":3,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], '{}'::jsonb, 'personalization-v2'
    );
    raise exception 'FAIL(101/legacy-7): stale 7-argument feedback snapshot was accepted';
  exception when sqlstate '40001' then null;
  end;
end;
$$;

-- A stale profile snapshot is rejected after the feedback event, proving that
-- account/profile saves cannot overwrite the newer learning aggregate.
do $$
begin
  begin
    perform public.save_user_preference_profile(
      null,
      '{"evidence":50,"health":50,"quiet":12,"value":12,"novelty":50,"groupFit":50}'::jsonb,
      '{}'::text[], '{}'::text[], 'profile-stale', array['profile_edits']::text[],
      '{}'::jsonb, 'personalization-v2', 'account',
      '2000-01-01T00:00:00Z'::timestamptz, true
    );
    raise exception 'FAIL(101/profile-cas): stale profile snapshot was accepted';
  exception when sqlstate '40001' then null;
  end;
end;
$$;

reset request.jwt.claims;
reset role;

-- The harness session owns auth.users; keep the cleanup on the bootstrap owner
-- role because the scratch service_role intentionally has no auth-table grant.
delete from public.user_product_audit_events
 where actor_user_id = '00000000-0000-4000-8000-000000001011';
delete from public.preference_signal_receipts
 where user_id = '00000000-0000-4000-8000-000000001011';
delete from public.user_preference_profiles
 where user_id = '00000000-0000-4000-8000-000000001011';
delete from public.place_feedback
 where id = '00000000-0000-4000-8000-000000001013';
delete from public.places
 where id = '00000000-0000-4000-8000-000000001012';
delete from auth.users
 where id = '00000000-0000-4000-8000-000000001011';

\echo == 101_profile_feedback_concurrency.sql: all assertions passed
