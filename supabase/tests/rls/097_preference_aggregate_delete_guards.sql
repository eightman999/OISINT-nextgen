-- =============================================================================
-- 097_preference_aggregate_delete_guards.sql — #515/#544 aggregate boundary
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000000971', false),
  ('00000000-0000-4000-8000-000000000972', false),
  ('00000000-0000-4000-8000-000000000973', false),
  ('00000000-0000-4000-8000-000000000974', false);

set local role service_role;
set local request.jwt.claims =
  '{"role":"service_role","sub":"00000000-0000-4000-8000-000000000971"}';

-- 768次元の小さなfixture。個人A/B/Cがquietへ寄与し、B/C/Dだけがvalueへ寄与する。
insert into public.user_attribute_vectors (
  user_id, attribute_key, embedding, model_version, source_version,
  consent_version, consent_purpose
)
select fixture.user_id, fixture.attribute_key,
       ('[' || repeat('1,', 767) || '1]')::public.vector,
       'fixture-097', 'test-097', 'personalization-v2', 'restaurant_recommendations'
  from (values
    ('00000000-0000-4000-8000-000000000971'::uuid, 'quiet'),
    ('00000000-0000-4000-8000-000000000972'::uuid, 'quiet'),
    ('00000000-0000-4000-8000-000000000973'::uuid, 'quiet'),
    ('00000000-0000-4000-8000-000000000972'::uuid, 'value'),
    ('00000000-0000-4000-8000-000000000973'::uuid, 'value'),
    ('00000000-0000-4000-8000-000000000974'::uuid, 'value')
  ) as fixture(user_id, attribute_key);

insert into public.attribute_vector_aggregates (
  attribute_key, vector_sum, sample_count, model_version, aggregation_unit,
  min_sample_count, anonymization_method, privacy_status
)
values
  ('quiet', ('[' || repeat('3,', 767) || '3]')::public.vector, 3,
   'fixture-097', 'global', 3, 'fixture-approved', 'approved'),
  ('value', ('[' || repeat('3,', 767) || '3]')::public.vector, 3,
   'fixture-097', 'global', 3, 'fixture-approved', 'approved');

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000971","is_anonymous":false}';

select public.delete_user_preference_profile();

set local role service_role;

do $$
begin
  if exists (
    select 1 from public.user_attribute_vectors
     where user_id = '00000000-0000-4000-8000-000000000971'
  ) then
    raise exception 'FAIL(097/personal): deleted user vector remains';
  end if;
  if (select count(*) from public.user_attribute_vectors
      where attribute_key = 'quiet' and model_version = 'fixture-097') <> 2 then
    raise exception 'FAIL(097/others): another users quiet vectors changed';
  end if;
  if exists (
    select 1 from public.attribute_vector_aggregates
     where attribute_key = 'quiet' and model_version = 'fixture-097'
  ) then
    raise exception 'FAIL(097/threshold): below-minimum aggregate was retained';
  end if;
  if (select sample_count from public.attribute_vector_aggregates
      where attribute_key = 'value' and model_version = 'fixture-097') <> 3 then
    raise exception 'FAIL(097/unrelated): unrelated aggregate was deleted or changed';
  end if;
end;
$$;

-- RPCの配列要素長・null・総量をDB側で拒否する。client schemaだけに依存しない。
set local role service_role;
insert into public.places (id, provider, provider_place_id, name)
values ('00000000-0000-4000-8000-000000000975', 'fixture', '097-place', 'Fixture 097');
insert into public.place_feedback (id, place_id, user_id, rating)
values (
  '00000000-0000-4000-8000-000000000976',
  '00000000-0000-4000-8000-000000000975',
  '00000000-0000-4000-8000-000000000971', 1
);
set local role authenticated;
do $$
begin
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000000976', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      array[repeat('x', 121)], '{}'::text[], '{}'::jsonb,
      'personalization-v2', null::timestamptz, false
    );
    raise exception 'FAIL(097/label-length): oversized like was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000000976', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      array[null::text], '{}'::text[], '{}'::jsonb,
      'personalization-v2', null::timestamptz, false
    );
    raise exception 'FAIL(097/label-null): null like was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000000976', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      array_fill(repeat('y', 120), array[18]), '{}'::text[], '{}'::jsonb,
      'personalization-v2', null::timestamptz, false
    );
    raise exception 'FAIL(097/label-total): oversized like payload was accepted';
  exception when sqlstate '22023' then null;
  end;

  -- The current CAS overload must preserve the same boundary. Supplying a
  -- first-profile base makes this an actual core invocation.
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000000976', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      array[repeat('x', 121)], '{}'::text[], '{}'::jsonb,
      'personalization-v2', null::timestamptz, false
    );
    raise exception 'FAIL(097/core-label-length): oversized like was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000000976', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      array[null::text], '{}'::text[], '{}'::jsonb,
      'personalization-v2', null::timestamptz, false
    );
    raise exception 'FAIL(097/core-label-null): null like was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_place_feedback_learning(
      '00000000-0000-4000-8000-000000000976', null,
      '{"evidence":50,"health":50,"quiet":86,"value":50,"novelty":50,"groupFit":50}'::jsonb,
      array_fill(repeat('y', 120), array[18]), '{}'::text[], '{}'::jsonb,
      'personalization-v2', null::timestamptz, false
    );
    raise exception 'FAIL(097/core-label-total): oversized like payload was accepted';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

rollback;

\echo == 097_preference_aggregate_delete_guards.sql: all assertions passed
