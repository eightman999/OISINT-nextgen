-- 202608160002: aggregate-only adaptive preference learning
--
-- The browser may observe searches, candidate opens, votes, and decision copies. This migration
-- stores only bounded beliefs derived from those actions. Raw queries, place identity, URLs,
-- addresses, event IDs, and local dedupe tokens are deliberately outside this schema.

create or replace function public.is_valid_preference_belief(
  value jsonb,
  min_mean numeric,
  max_mean numeric
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  mean_value numeric;
  weight_value numeric;
  m2_value numeric;
  observation_value numeric;
begin
  if jsonb_typeof(value) <> 'object'
    or (value - array['mean', 'weight', 'm2', 'observations', 'sources']) <> '{}'::jsonb
    or (select count(*) from jsonb_object_keys(value)) <> 5
    or jsonb_typeof(value -> 'mean') <> 'number'
    or jsonb_typeof(value -> 'weight') <> 'number'
    or jsonb_typeof(value -> 'm2') <> 'number'
    or jsonb_typeof(value -> 'observations') <> 'number'
    or jsonb_typeof(value -> 'sources') <> 'array'
  then
    return false;
  end if;

  mean_value := (value ->> 'mean')::numeric;
  weight_value := (value ->> 'weight')::numeric;
  m2_value := (value ->> 'm2')::numeric;
  observation_value := (value ->> 'observations')::numeric;

  if mean_value < min_mean or mean_value > max_mean
    or weight_value < 0 or weight_value > 1000
    or m2_value < 0 or m2_value > 10000000
    or observation_value < 0 or observation_value > 100000
    or observation_value <> trunc(observation_value)
    or jsonb_array_length(value -> 'sources') > 5
  then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(value -> 'sources') source(value)
    where source.value not in (
      'demo_answers',
      'maps_takeout',
      'behavior_signals',
      'hearing_answers',
      'profile_edits'
    )
  ) then
    return false;
  end if;

  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.is_valid_preference_belief(jsonb, numeric, numeric) from public;
grant execute on function public.is_valid_preference_belief(jsonb, numeric, numeric)
  to authenticated, service_role;

create or replace function public.is_valid_preference_learning_state(value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  axis_name text;
  context_name text;
  context_value jsonb;
  tag_value jsonb;
  question_value jsonb;
  interaction_value numeric;
  schema_version text;
begin
  -- Empty is the migration default for an existing v1 row.
  if value = '{}'::jsonb then
    return true;
  end if;

  if jsonb_typeof(value) <> 'object'
    or octet_length(value::text) > 32768
    or (value - array[
      'schemaVersion', 'axes', 'tags', 'interactionCount',
      'answeredQuestionIds', 'confirmedAxes', 'contexts', 'updatedAt'
    ]) <> '{}'::jsonb
    or not (value ?& array[
      'schemaVersion', 'axes', 'tags', 'interactionCount',
      'answeredQuestionIds', 'updatedAt'
    ])
    or jsonb_typeof(value -> 'schemaVersion') <> 'number'
    or value ->> 'schemaVersion' not in ('1', '2', '3', '4')
    or jsonb_typeof(value -> 'axes') <> 'object'
    or jsonb_typeof(value -> 'tags') <> 'array'
    or jsonb_typeof(value -> 'interactionCount') <> 'number'
    or jsonb_typeof(value -> 'answeredQuestionIds') <> 'array'
    or jsonb_typeof(value -> 'updatedAt') <> 'string'
  then
    return false;
  end if;

  schema_version := value ->> 'schemaVersion';
  if schema_version = '1' then
    if (select count(*) from jsonb_object_keys(value)) <> 6
      or value ? 'confirmedAxes'
      or value ? 'contexts'
    then
      return false;
    end if;
  elsif schema_version = '2' then
    if (select count(*) from jsonb_object_keys(value)) <> 7
      or jsonb_typeof(value -> 'confirmedAxes') <> 'object'
      or value ? 'contexts'
    then
      return false;
    end if;
  elsif (select count(*) from jsonb_object_keys(value)) <> 8
    or jsonb_typeof(value -> 'confirmedAxes') <> 'object'
    or jsonb_typeof(value -> 'contexts') <> 'object'
  then
    return false;
  end if;

  if ((value -> 'axes') - array['evidence', 'health', 'quiet', 'value', 'novelty', 'groupFit'])
      <> '{}'::jsonb
    or (select count(*) from jsonb_object_keys(value -> 'axes')) <> 6
    or jsonb_array_length(value -> 'tags') > 24
    or jsonb_array_length(value -> 'answeredQuestionIds') > 40
    or char_length(value ->> 'updatedAt') > 40
  then
    return false;
  end if;

  if schema_version in ('2', '3', '4') then
    if ((value -> 'confirmedAxes') - array['evidence', 'quiet', 'value', 'novelty', 'groupFit'])
        <> '{}'::jsonb
      or (select count(*) from jsonb_object_keys(value -> 'confirmedAxes')) > 5
      or exists (
        select 1
        from jsonb_each(value -> 'confirmedAxes') entry
        where jsonb_typeof(entry.value) <> 'string'
          or (entry.value #>> '{}') not in ('high', 'low', 'situational')
      )
    then
      return false;
    end if;
  end if;

  if schema_version in ('3', '4') then
    if ((value -> 'contexts') - array['solo', 'group', 'quick', 'special']) <> '{}'::jsonb
      or (select count(*) from jsonb_object_keys(value -> 'contexts')) > 4
    then
      return false;
    end if;

    for context_name in select jsonb_object_keys(value -> 'contexts')
    loop
      context_value := value -> 'contexts' -> context_name;
      if jsonb_typeof(context_value) <> 'object'
        or jsonb_typeof(context_value -> 'axes') <> 'object'
        or jsonb_typeof(context_value -> 'confirmedAxes') <> 'object'
        or ((context_value -> 'axes') - array['evidence', 'quiet', 'value', 'novelty', 'groupFit'])
          <> '{}'::jsonb
        or (select count(*) from jsonb_object_keys(context_value -> 'axes')) > 5
        or ((context_value -> 'confirmedAxes') - array['evidence', 'quiet', 'value', 'novelty', 'groupFit'])
          <> '{}'::jsonb
        or (select count(*) from jsonb_object_keys(context_value -> 'confirmedAxes')) > 5
        or exists (
          select 1
          from jsonb_each(context_value -> 'confirmedAxes') entry
          where jsonb_typeof(entry.value) <> 'string'
            or (entry.value #>> '{}') not in ('high', 'low', 'situational')
        )
      then
        return false;
      end if;

      if schema_version = '3' then
        if (context_value - array['axes', 'confirmedAxes']) <> '{}'::jsonb
          or (select count(*) from jsonb_object_keys(context_value)) <> 2
        then
          return false;
        end if;
      elsif (context_value - array['axes', 'tags', 'confirmedAxes', 'confirmedTags'])
          <> '{}'::jsonb
        or (select count(*) from jsonb_object_keys(context_value)) <> 4
        or exists (
          select 1
          from jsonb_object_keys(context_value -> 'confirmedAxes') as confirmed_axis(axis_name)
          where not ((context_value -> 'axes') ? confirmed_axis.axis_name)
        )
        or jsonb_typeof(context_value -> 'tags') <> 'array'
        or jsonb_array_length(context_value -> 'tags') > 12
        or jsonb_typeof(context_value -> 'confirmedTags') <> 'object'
        or (select count(*) from jsonb_object_keys(context_value -> 'confirmedTags')) > 12
        or exists (
          select 1
          from jsonb_each(context_value -> 'confirmedTags') entry
          where char_length(trim(entry.key)) not between 1 and 40
            or jsonb_typeof(entry.value) <> 'string'
            or (entry.value #>> '{}') not in ('prefer', 'avoid', 'situational')
            or not exists (
              select 1
              from jsonb_array_elements(context_value -> 'tags') tag(item)
              where tag.item ->> 'label' = entry.key
            )
        )
      then
        return false;
      end if;

      for axis_name in select jsonb_object_keys(context_value -> 'axes')
      loop
        if not public.is_valid_preference_belief(
          context_value -> 'axes' -> axis_name,
          0,
          100
        ) then
          return false;
        end if;
      end loop;

      if schema_version = '4' then
        for tag_value in
          select item from jsonb_array_elements(context_value -> 'tags') as items(item)
        loop
          if jsonb_typeof(tag_value) <> 'object'
            or jsonb_typeof(tag_value -> 'label') <> 'string'
            or char_length(trim(tag_value ->> 'label')) not between 1 and 40
            or not public.is_valid_preference_belief(tag_value - 'label', -1, 1)
          then
            return false;
          end if;
        end loop;
      end if;
    end loop;
  end if;

  foreach axis_name in array array['evidence', 'health', 'quiet', 'value', 'novelty', 'groupFit']
  loop
    if not public.is_valid_preference_belief(value -> 'axes' -> axis_name, 0, 100) then
      return false;
    end if;
  end loop;

  for tag_value in
    select item from jsonb_array_elements(value -> 'tags') as items(item)
  loop
    if jsonb_typeof(tag_value) <> 'object'
      or jsonb_typeof(tag_value -> 'label') <> 'string'
      or char_length(trim(tag_value ->> 'label')) not between 1 and 40
      or not public.is_valid_preference_belief(tag_value - 'label', -1, 1)
    then
      return false;
    end if;
  end loop;

  for question_value in
    select item from jsonb_array_elements(value -> 'answeredQuestionIds') as items(item)
  loop
    if jsonb_typeof(question_value) <> 'string'
      or char_length(trim(question_value #>> '{}')) not between 1 and 100
    then
      return false;
    end if;
  end loop;

  interaction_value := (value ->> 'interactionCount')::numeric;
  if interaction_value < 0
    or interaction_value > 100000
    or interaction_value <> trunc(interaction_value)
  then
    return false;
  end if;

  -- Reject arbitrary strings while keeping the client-generated ISO timestamp representation.
  perform (value ->> 'updatedAt')::timestamptz;

  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.is_valid_preference_learning_state(jsonb) from public;
grant execute on function public.is_valid_preference_learning_state(jsonb)
  to authenticated, service_role;

alter table public.user_preference_profiles
  add column learning_state jsonb not null default '{}'::jsonb;

alter table public.user_preference_profiles
  drop constraint if exists user_preference_profiles_source_kinds_check;
alter table public.user_preference_profiles
  add constraint user_preference_profiles_source_kinds_check
  check (
    cardinality(source_kinds) between 1 and 5
    and source_kinds <@ array[
      'demo_answers',
      'maps_takeout',
      'behavior_signals',
      'hearing_answers',
      'profile_edits'
    ]::text[]
  );

alter table public.user_preference_profiles
  drop constraint if exists user_preference_profiles_consent_version_check;
alter table public.user_preference_profiles
  add constraint user_preference_profiles_consent_version_check
  check (consent_version in ('personalization-v1', 'personalization-v2'));

alter table public.user_preference_profiles
  add constraint user_preference_profiles_learning_state_check
  check (public.is_valid_preference_learning_state(learning_state));

alter table public.user_product_audit_events
  drop constraint if exists user_product_audit_events_consent_version_check;
alter table public.user_product_audit_events
  add constraint user_product_audit_events_consent_version_check
  check (consent_version is null or consent_version in ('personalization-v1', 'personalization-v2'));

-- Keep the eight-argument personalization-v1 overload from 0011 during the web rollout.
-- PostgREST selects the overload by argument names, so already-open clients can finish a save
-- while new clients use the aggregate-learning overload below. The old function never accepts
-- learning_state and therefore cannot introduce raw behavior into the new column.

create function public.save_user_preference_profile(
  p_scenario_id text,
  p_axis_scores jsonb,
  p_likes text[],
  p_avoid text[],
  p_model_version text,
  p_source_kinds text[],
  p_learning_state jsonb,
  p_consent_version text,
  p_save_source text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  if p_consent_version <> 'personalization-v2' then
    raise exception 'adaptive learning requires personalization-v2 consent' using errcode = '22023';
  end if;

  if p_save_source not in ('demo', 'account', 'maps_takeout') then
    raise exception 'invalid personalization save source' using errcode = '22023';
  end if;

  if not public.is_valid_preference_learning_state(p_learning_state) then
    raise exception 'invalid aggregate preference learning state' using errcode = '22023';
  end if;

  insert into public.user_preference_profiles (
    user_id, scenario_id, axis_scores, likes, avoid, model_version, source_kinds,
    learning_state, consent_version, consent_purpose, consented_at
  ) values (
    auth.uid(), p_scenario_id, p_axis_scores, p_likes, p_avoid, p_model_version, p_source_kinds,
    p_learning_state, p_consent_version, 'restaurant_recommendations', now()
  )
  on conflict (user_id) do update set
    scenario_id = excluded.scenario_id,
    axis_scores = excluded.axis_scores,
    likes = excluded.likes,
    avoid = excluded.avoid,
    model_version = excluded.model_version,
    source_kinds = excluded.source_kinds,
    learning_state = excluded.learning_state,
    consent_version = excluded.consent_version,
    consent_purpose = excluded.consent_purpose,
    consented_at = excluded.consented_at;

  insert into public.user_product_audit_events (
    actor_user_id, event_type, source, model_version, consent_version
  ) values (
    auth.uid(), 'preference_profile_saved', p_save_source,
    p_model_version, p_consent_version
  );
end;
$$;

revoke all on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text
) from public;
grant execute on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text
) to authenticated;

comment on column public.user_preference_profiles.learning_state is
  'Bounded aggregate beliefs only; excludes raw behavior, query/place identity, and local event tokens.';
