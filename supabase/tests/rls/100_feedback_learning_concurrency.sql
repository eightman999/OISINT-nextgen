-- =============================================================================
-- 100_feedback_learning_concurrency.sql — #515 first-profile lost update
-- =============================================================================
-- Two different feedback events start from the same absent profile.  The first
-- transaction holds the per-user advisory lock while the second waits, gets a
-- 40001 stale-snapshot result, reloads the canonical revision, and retries
-- with both observations.  The final profile must contain both axes.

create extension if not exists dblink;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000001001', false),
  ('00000000-0000-4000-8000-000000001002', false);

insert into public.places (id, provider, provider_place_id, name)
values (
  '00000000-0000-4000-8000-000000001003',
  'fixture', '100-learning', 'Feedback learning 100'
);

set local role service_role;
insert into public.place_feedback
  (id, place_id, user_id, rating, aspect, aspect_value)
values
  (
    '00000000-0000-4000-8000-000000001004',
    '00000000-0000-4000-8000-000000001003',
    '00000000-0000-4000-8000-000000001001',
    1, 'noise', 'quiet'
  ),
  (
    '00000000-0000-4000-8000-000000001005',
    '00000000-0000-4000-8000-000000001003',
    '00000000-0000-4000-8000-000000001001',
    1, 'value', 'good'
  );
reset role;

select dblink_connect(
  'feedback_learning_cas_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'feedback_learning_cas_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('feedback_learning_cas_a', 'set role authenticated');
select dblink_exec('feedback_learning_cas_b', 'set role authenticated');
select dblink_exec(
  'feedback_learning_cas_a',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000001001","role":"authenticated","is_anonymous":false}'$$
);
select dblink_exec(
  'feedback_learning_cas_b',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000001001","role":"authenticated","is_anonymous":false}'$$
);
select dblink_exec('feedback_learning_cas_a', 'begin');
select dblink_exec('feedback_learning_cas_b', 'begin');

-- A starts from an absent profile and keeps its transaction open after the RPC.
select dblink_send_query(
  'feedback_learning_cas_a',
  $$select public.save_place_feedback_learning(
    '00000000-0000-4000-8000-000000001004', null,
    '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[],
    '{"schemaVersion":4,"axes":{
      "evidence":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "health":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "quiet":{"mean":86,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]},
      "value":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "novelty":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "groupFit":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]}},
      "tags":[{"label":"静かな店","mean":1,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]}],
      "interactionCount":0,"answeredQuestionIds":[],"confirmedAxes":{},"contexts":{},
      "updatedAt":"2026-08-24T00:00:00.000Z"}'::jsonb,
    'personalization-v2', null::timestamptz, false
  )$$
);
do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_learning_cas_a') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_learning_cas_a') <> 0 then
    raise exception 'FAIL(100/first): first feedback RPC did not finish';
  end if;
end;
$$;
create temporary table feedback_learning_cas_a_result(applied boolean);
insert into feedback_learning_cas_a_result(applied)
  select applied
    from dblink_get_result('feedback_learning_cas_a') as result(applied boolean);
-- Drain any trailing command result before issuing COMMIT on the same link.
select count(*) from dblink_get_result('feedback_learning_cas_a') as result(applied boolean);

-- B has the same absent-profile snapshot, so it must wait on the advisory lock.
select dblink_send_query(
  'feedback_learning_cas_b',
  $$select public.save_place_feedback_learning(
    '00000000-0000-4000-8000-000000001005', null,
    '{"evidence":50,"health":50,"quiet":50,"value":86,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[],
    '{"schemaVersion":4,"axes":{
      "evidence":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "health":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "quiet":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "value":{"mean":86,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]},
      "novelty":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "groupFit":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]}},
      "tags":[{"label":"コスパ重視","mean":1,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]}],
      "interactionCount":0,"answeredQuestionIds":[],"confirmedAxes":{},"contexts":{},
      "updatedAt":"2026-08-24T00:00:00.000Z"}'::jsonb,
    'personalization-v2', null::timestamptz, false
  )$$
);
do $$
begin
  if dblink_is_busy('feedback_learning_cas_b') <> 1 then
    raise exception 'FAIL(100/lock): second feedback RPC did not wait for user advisory lock';
  end if;
end;
$$;
select dblink_exec('feedback_learning_cas_a', 'commit');

do $$
begin
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_learning_cas_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_learning_cas_b') <> 0 then
    raise exception 'FAIL(100/stale): second stale RPC did not finish';
  end if;
end;
$$;
-- fail_on_error=false lets the expected 40001 travel back without aborting the
-- harness; the aborted remote transaction is then rolled back before retry.
create temporary table feedback_learning_cas_b_error(message text);
insert into feedback_learning_cas_b_error(message)
  select message
    from dblink_get_result('feedback_learning_cas_b', false)
      as result(message text);
select * from dblink_get_result('feedback_learning_cas_b', false)
  as result(message text);
do $$
begin
  -- PostgreSQL versions differ: dblink may expose the remote error as a
  -- text row or only emit a NOTICE and return zero rows.  Both are accepted;
  -- a successful boolean row is not.
  if exists (
    select 1 from feedback_learning_cas_b_error
     where message not like '%preference profile was created%'
  ) then
    raise exception 'FAIL(100/stale-result): second RPC returned an unexpected result';
  end if;
end;
$$;
select dblink_exec('feedback_learning_cas_b', 'rollback');

-- Client-side reload/recompute: retry B against A's committed revision with
-- both observations represented in the full snapshot.
do $$
declare
  v_revision text;
  v_query text;
begin
  select updated_at::text into v_revision
    from public.user_preference_profiles
   where user_id = '00000000-0000-4000-8000-000000001001';
  if v_revision is null then
    raise exception 'FAIL(100/reload): first canonical profile is missing';
  end if;
  perform dblink_exec('feedback_learning_cas_b', 'begin');
  v_query := format($sql$select public.save_place_feedback_learning(
    '00000000-0000-4000-8000-000000001005', null,
    '{"evidence":50,"health":50,"quiet":86,"value":86,"novelty":50,"groupFit":50}'::jsonb,
    '{}'::text[], '{}'::text[],
    '{"schemaVersion":4,"axes":{
      "evidence":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "health":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "quiet":{"mean":86,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]},
      "value":{"mean":86,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]},
      "novelty":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]},
      "groupFit":{"mean":50,"weight":0,"m2":0,"observations":0,"sources":[]}},
      "tags":[
        {"label":"静かな店","mean":1,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]},
        {"label":"コスパ重視","mean":1,"weight":3.2,"m2":0,"observations":1,"sources":["feedback"]}],
      "interactionCount":0,"answeredQuestionIds":[],"confirmedAxes":{},"contexts":{},
      "updatedAt":"2026-08-24T00:00:00.000Z"}'::jsonb,
    'personalization-v2', %L::timestamptz, true
  )$sql$, v_revision);
  perform dblink_send_query('feedback_learning_cas_b', v_query);
  for attempt in 1..100 loop
    exit when dblink_is_busy('feedback_learning_cas_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  if dblink_is_busy('feedback_learning_cas_b') <> 0 then
    raise exception 'FAIL(100/retry): recomputed feedback RPC did not finish';
  end if;
  create temporary table feedback_learning_cas_b_retry_result(applied boolean);
  insert into feedback_learning_cas_b_retry_result(applied)
    select applied
      from dblink_get_result('feedback_learning_cas_b')
        as result(applied boolean);
  if not exists (select 1 from feedback_learning_cas_b_retry_result where applied) then
    raise exception 'FAIL(100/retry-result): recomputed feedback RPC was not applied';
  end if;
end;
$$;
select count(*) from dblink_get_result('feedback_learning_cas_b') as result(applied boolean);
select dblink_exec('feedback_learning_cas_b', 'commit');

select dblink_disconnect('feedback_learning_cas_a');
select dblink_disconnect('feedback_learning_cas_b');

do $$
declare
  v_scores jsonb;
  v_state jsonb;
begin
  select axis_scores, learning_state
    into v_scores, v_state
    from public.user_preference_profiles
   where user_id = '00000000-0000-4000-8000-000000001001';
  if v_scores ->> 'quiet' <> '86' or v_scores ->> 'value' <> '86'
     or (select count(*) from public.preference_signal_receipts
          where user_id = '00000000-0000-4000-8000-000000001001') <> 2
     or (select count(*) from public.user_product_audit_events
          where actor_user_id = '00000000-0000-4000-8000-000000001001'
            and source = 'feedback') <> 2
     or jsonb_array_length(v_state -> 'tags') <> 2 then
    raise exception 'FAIL(100/final): one of two distinct feedback events was lost: scores=% state=%', v_scores, v_state;
  end if;
end;
$$;

set local role service_role;
delete from public.user_preference_profiles
 where user_id = '00000000-0000-4000-8000-000000001001';
delete from public.preference_signal_receipts
 where user_id = '00000000-0000-4000-8000-000000001001';
delete from public.user_product_audit_events
 where actor_user_id = '00000000-0000-4000-8000-000000001001';
delete from public.place_feedback
 where place_id = '00000000-0000-4000-8000-000000001003';
delete from public.places
 where id = '00000000-0000-4000-8000-000000001003';
delete from auth.users
 where id in (
   '00000000-0000-4000-8000-000000001001',
   '00000000-0000-4000-8000-000000001002'
 );
reset role;

\echo == 100_feedback_learning_concurrency.sql: all assertions passed
