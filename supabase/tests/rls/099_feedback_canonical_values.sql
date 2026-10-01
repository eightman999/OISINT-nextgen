-- =============================================================================
-- 099_feedback_canonical_values.sql — no free-text shared feedback
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000000991', false),
  ('00000000-0000-4000-8000-000000000992', false),
  ('00000000-0000-4000-8000-000000000993', false),
  ('00000000-0000-4000-8000-000000000994', false);
insert into public.places (id, provider, provider_place_id, name)
values ('00000000-0000-4000-8000-000000000995', 'fixture', '099', 'Canonical 099');

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000991","role":"authenticated","is_anonymous":false}';

do $$
begin
  begin
    perform public.submit_place_feedback(
      '00000000-0000-4000-8000-000000000995', null, null,
      'noise', '店内はとても静かです'
    );
    raise exception 'FAIL(099/free-text): hostile aspect value was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'feedback aspect_value is not canonical' then raise; end if;
  end;
  begin
    perform public.submit_place_feedback(
      '00000000-0000-4000-8000-000000000995', null, null,
      'space', 'quiet'
    );
    raise exception 'FAIL(099/mismatch): cross-aspect value was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'feedback aspect_value is not canonical' then raise; end if;
  end;
end;
$$;

select public.submit_place_feedback(
  '00000000-0000-4000-8000-000000000995', null, 1::smallint,
  'space', 'comfortable'
);

do $$
declare
  v_feedback uuid;
begin
  select f.id into v_feedback
    from public.place_feedback as f
   where f.place_id = '00000000-0000-4000-8000-000000000995'
     and f.user_id = '00000000-0000-4000-8000-000000000991'
     and f.aspect = 'space'
   order by f.created_at desc, f.id desc
   limit 1;
  begin
    perform public.update_place_feedback(
      '00000000-0000-4000-8000-000000000995', v_feedback,
      null, null, 'space', 'quiet'
    );
    raise exception 'FAIL(099/update-mismatch): hostile aspect value was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'feedback aspect_value is not canonical' then raise; end if;
  end;
end;
$$;

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000991","role":"service_role"}';

-- Legacy rows are retained, but cannot be promoted into a shared fact/summary.
insert into public.place_feedback
  (id, place_id, user_id, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000996', '00000000-0000-4000-8000-000000000995', '00000000-0000-4000-8000-000000000991', 'noise', '自由記述A'),
  ('00000000-0000-4000-8000-000000000997', '00000000-0000-4000-8000-000000000995', '00000000-0000-4000-8000-000000000992', 'noise', '自由記述B'),
  ('00000000-0000-4000-8000-000000000998', '00000000-0000-4000-8000-000000000995', '00000000-0000-4000-8000-000000000993', 'noise', '自由記述C');
insert into public.place_feedback
  (id, place_id, user_id, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000999', '00000000-0000-4000-8000-000000000995', '00000000-0000-4000-8000-000000000992', 'space', 'comfortable'),
  ('00000000-0000-4000-8000-000000001000', '00000000-0000-4000-8000-000000000995', '00000000-0000-4000-8000-000000000993', 'space', 'comfortable');
insert into public.place_facts (
  place_id, key, value, confidence, evidence_count, conflicting, last_verified_at
) values (
  '00000000-0000-4000-8000-000000000995', 'noise_level',
  '{"value":"自由記述A","count":3,"share":1}'::jsonb,
  1, 3, false, now()
) on conflict (place_id, key) do update set value = excluded.value;

select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000995', 'noise'
);
select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000995', 'space'
);

do $$
begin
  if exists (select 1 from public.place_facts
             where place_id = '00000000-0000-4000-8000-000000000995'
               and key = 'noise_level') then
    raise exception 'FAIL(099/fact): legacy free text was published';
  end if;
  if not public.is_canonical_place_feedback_value('noise', 'quiet')
     or not public.is_canonical_place_feedback_value('space', 'comfortable')
     or public.is_canonical_place_feedback_value('noise', '自由記述A')
     or public.is_canonical_place_feedback_value('space', 'quiet') then
    raise exception 'FAIL(099/vocabulary): canonical mapping is not closed';
  end if;
end;
$$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000991","role":"authenticated","is_anonymous":false}';
do $$
declare
  v_aspects jsonb;
begin
  select s.aspects into v_aspects
    from public.get_place_feedback_summary(
      array['00000000-0000-4000-8000-000000000995']::uuid[]
    ) s;
  if v_aspects <> '[{"aspect":"space","aspect_value":"comfortable","count":3}]'::jsonb then
    raise exception 'FAIL(099/summary): canonical/legacy filtering mismatch: %', v_aspects;
  end if;
end;
$$;

rollback;

\echo == 099_feedback_canonical_values.sql: all assertions passed
