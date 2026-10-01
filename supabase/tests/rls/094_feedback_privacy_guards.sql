-- =============================================================================
-- 094_feedback_privacy_guards.sql — #110 / #157 aggregate privacy boundary
-- =============================================================================

begin;

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000941'),
  ('00000000-0000-4000-8000-000000000942'),
  ('00000000-0000-4000-8000-000000000943'),
  ('00000000-0000-4000-8000-000000000944'),
  ('00000000-0000-4000-8000-000000000945');

insert into public.places (id, provider, provider_place_id, name)
values
  ('00000000-0000-4000-8000-000000000946', 'fixture', '094-two', 'Two rows'),
  ('00000000-0000-4000-8000-000000000947', 'fixture', '094-same', 'Same value'),
  ('00000000-0000-4000-8000-000000000948', 'fixture', '094-distinct', 'Distinct values'),
  ('00000000-0000-4000-8000-000000000949', 'fixture', '094-input', 'Input validation'),
  ('00000000-0000-4000-8000-000000000950', 'fixture', '094-duplicate-user', 'Duplicate user');

-- Direct writes are denied even when the JWT subject owns a row.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
do $$
declare
  v_blocked boolean := false;
begin
  begin
    insert into public.place_feedback (place_id, user_id, rating)
    values ('00000000-0000-4000-8000-000000000946',
      '00000000-0000-4000-8000-000000000941', 1);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/direct-insert): authenticated insert allowed'; end if;
  v_blocked := false;
  begin
    update public.place_feedback set rating = -1 where id = '00000000-0000-4000-8000-000000000951';
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/direct-update): authenticated update allowed'; end if;
  v_blocked := false;
  begin
    delete from public.place_feedback where id = '00000000-0000-4000-8000-000000000951';
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/direct-delete): authenticated delete allowed'; end if;
end;
$$;

-- Two rows are not exposed through the summary RPC.
set local role service_role;
insert into public.place_feedback
  (id, place_id, user_id, visited_at, rating, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000946',
   '00000000-0000-4000-8000-000000000941', date '2026-08-01', 1, 'noise', 'quiet'),
  ('00000000-0000-4000-8000-000000000952', '00000000-0000-4000-8000-000000000946',
   '00000000-0000-4000-8000-000000000942', date '2026-08-02', 0, 'noise', 'quiet');

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
do $$
declare
  v_row record;
begin
  select * into v_row from public.get_place_feedback_summary(
    array['00000000-0000-4000-8000-000000000946']::uuid[]
  );
  if v_row.visited_count <> 0 or v_row.rating_count <> 0
     or v_row.rating_avg is not null or v_row.aspects <> '[]'::jsonb then
    raise exception 'FAIL(094/subthreshold): summary exposed small cohort: %', v_row;
  end if;
end;
$$;

-- Third identical value crosses the threshold and is safely aggregate-only.
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000943","role":"authenticated"}';
select public.submit_place_feedback(
  '00000000-0000-4000-8000-000000000946', date '2026-08-03', -1::smallint, 'noise', 'quiet'
);
do $$
declare
  v_row record;
begin
  select * into v_row from public.get_place_feedback_summary(
    array['00000000-0000-4000-8000-000000000946']::uuid[]
  );
  if v_row.visited_count <> 3 or v_row.rating_count <> 3
     or v_row.rating_avg is distinct from 0::real
     or jsonb_array_length(v_row.aspects) <> 1
     or (v_row.aspects->0->>'count')::int <> 3 then
    raise exception 'FAIL(094/threshold): expected only 3-row aggregate: %', v_row;
  end if;
end;
$$;

-- Three rows from one user do not satisfy the distinct-user privacy threshold.
set local role service_role;
insert into public.place_feedback
  (id, place_id, user_id, visited_at, rating, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000959', '00000000-0000-4000-8000-000000000950', '00000000-0000-4000-8000-000000000941', date '2026-08-01', 1, 'noise', 'quiet'),
  ('00000000-0000-4000-8000-000000000960', '00000000-0000-4000-8000-000000000950', '00000000-0000-4000-8000-000000000941', date '2026-08-02', 0, 'noise', 'quiet'),
  ('00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000950', '00000000-0000-4000-8000-000000000941', date '2026-08-03', -1, 'noise', 'quiet');
select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000950', 'noise'
);
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
do $$
declare
  v_row record;
begin
  select * into v_row from public.get_place_feedback_summary(
    array['00000000-0000-4000-8000-000000000950']::uuid[]
  );
  if v_row.visited_count <> 0 or v_row.rating_count <> 0
     or v_row.rating_avg is not null or v_row.aspects <> '[]'::jsonb then
    raise exception 'FAIL(094/duplicate-user): one user crossed privacy threshold: %', v_row;
  end if;
  if exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000950'
       and key = 'noise_level'
  ) then
    raise exception 'FAIL(094/duplicate-user-fact): one user created a shared fact';
  end if;
end;
$$;

-- Three different free-text values do not create a fact.
set local role service_role;
insert into public.place_feedback
  (id, place_id, user_id, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000953', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000941', 'noise', 'a'),
  ('00000000-0000-4000-8000-000000000954', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000942', 'noise', 'b'),
  ('00000000-0000-4000-8000-000000000955', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000943', 'noise', 'c');
select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000948', 'noise'
);
do $$
begin
  if exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000948'
       and key = 'noise_level'
  ) then
    raise exception 'FAIL(094/distinct): one-value fact was created from three distinct values';
  end if;
end;
$$;

-- Three equal values produce a fact, and changing one row removes the stale
-- fact because no value retains three supporting rows.
insert into public.place_feedback
  (id, place_id, user_id, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000956', '00000000-0000-4000-8000-000000000947', '00000000-0000-4000-8000-000000000941', 'noise', 'quiet'),
  ('00000000-0000-4000-8000-000000000957', '00000000-0000-4000-8000-000000000947', '00000000-0000-4000-8000-000000000942', 'noise', 'quiet'),
  ('00000000-0000-4000-8000-000000000958', '00000000-0000-4000-8000-000000000947', '00000000-0000-4000-8000-000000000943', 'noise', 'quiet');
select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000947', 'noise'
);
do $$
begin
  if not exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000947'
       and key = 'noise_level' and value->>'value' = 'quiet'
       and evidence_count = 3
  ) then
    raise exception 'FAIL(094/equal): equal three-row fact was not created';
  end if;
end;
$$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
select public.update_place_feedback(
  '00000000-0000-4000-8000-000000000947',
  '00000000-0000-4000-8000-000000000956',
  null, null, 'noise', 'loud'
);
do $$
begin
  if exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000947'
       and key = 'noise_level'
  ) then
    raise exception 'FAIL(094/update-cleanup): stale fact remained below threshold';
  end if;
end;
$$;

-- 同一 user の古い aspect value が3件あっても、最新回答が user ごとに
-- 異なる場合は共有 fact/summary を生成しない。古い行を単純 count しない。
set role service_role;
insert into public.place_feedback
  (id, place_id, user_id, aspect, aspect_value, updated_at)
values
  ('00000000-0000-4000-8000-000000000962', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000941', 'noise', 'quiet', timestamptz '2026-08-04 00:00:00+00'),
  ('00000000-0000-4000-8000-000000000963', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000942', 'noise', 'quiet', timestamptz '2026-08-04 00:00:00+00'),
  ('00000000-0000-4000-8000-000000000964', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000943', 'noise', 'quiet', timestamptz '2026-08-04 00:00:00+00'),
  ('00000000-0000-4000-8000-000000000965', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000941', 'noise', 'alpha', timestamptz '2026-08-05 00:00:00+00'),
  ('00000000-0000-4000-8000-000000000966', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000942', 'noise', 'beta', timestamptz '2026-08-05 00:00:00+00'),
  ('00000000-0000-4000-8000-000000000967', '00000000-0000-4000-8000-000000000948', '00000000-0000-4000-8000-000000000943', 'noise', 'gamma', timestamptz '2026-08-05 00:00:00+00');
select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000948', 'noise'
);
set role authenticated;
set request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
do $$
declare
  v_row record;
begin
  select * into v_row from public.get_place_feedback_summary(
    array['00000000-0000-4000-8000-000000000948']::uuid[]
  );
  if v_row.aspects <> '[]'::jsonb then
    raise exception 'FAIL(094/latest-aspect): stale values were counted: %', v_row.aspects;
  end if;
  if exists (
    select 1 from public.place_facts
     where place_id = '00000000-0000-4000-8000-000000000948'
       and key = 'noise_level'
  ) then
    raise exception 'FAIL(094/latest-fact): stale user values created a fact';
  end if;
end;
$$;

-- RPC input is fail-closed and trims the bounded free-text field.
do $$
declare
  v_id uuid;
  v_blocked boolean := false;
begin
  begin
    perform public.submit_place_feedback('00000000-0000-4000-8000-000000000949');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/input-empty): empty submit accepted'; end if;
  v_blocked := false;
  begin
    perform public.submit_place_feedback(
      '00000000-0000-4000-8000-000000000949', null::date, null::smallint,
      null::text, repeat('x', 121)::text
    );
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/input-length): oversized value accepted'; end if;
  v_blocked := false;
  begin
    perform public.submit_place_feedback(
      '00000000-0000-4000-8000-000000000949', current_date + 1,
      null::smallint, null::text, null::text
    );
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/input-future): future date accepted'; end if;
  v_blocked := false;
  begin
    perform public.submit_place_feedback(
      '00000000-0000-4000-8000-000000000949', null::date, null::smallint,
      'noise'::text, '   '::text
    );
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/input-blank-value): blank value accepted'; end if;
  v_blocked := false;
  begin
    perform public.submit_place_feedback(
      '00000000-0000-4000-8000-000000000949', null::date, null::smallint,
      '   '::text, 'quiet'::text
    );
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL(094/input-blank-aspect): blank aspect accepted'; end if;
  v_id := public.submit_place_feedback(
    '00000000-0000-4000-8000-000000000949', null::date, null::smallint,
    'noise'::text, '  quiet  '::text
  );
  if (select aspect_value from public.place_feedback where id = v_id) <> 'quiet' then
    raise exception 'FAIL(094/input-trim): value was not normalized';
  end if;
end;
$$;

-- Empty, null, and oversized UUID arrays fail closed rather than expanding an
-- unbounded caller-controlled list.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from public.get_place_feedback_summary('{}'::uuid[]);
  if v_count <> 0 then
    raise exception 'FAIL(094/input-empty-array): empty array returned rows';
  end if;
  select count(*) into v_count
    from public.get_place_feedback_summary(null::uuid[]);
  if v_count <> 0 then
    raise exception 'FAIL(094/input-null-array): null array returned rows';
  end if;
  select count(*) into v_count
    from public.get_place_feedback_summary(
      array_fill('00000000-0000-4000-8000-000000000950'::uuid, ARRAY[101])
    );
  if v_count <> 0 then
    raise exception 'FAIL(094/input-array-limit): oversized array returned rows';
  end if;
end;
$$;

rollback;

\echo == 094_feedback_privacy_guards.sql: all assertions passed
