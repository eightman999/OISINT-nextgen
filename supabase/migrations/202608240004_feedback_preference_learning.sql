-- 202608240004: #515 来店フィードバックから本人Taste Profileへ明示opt-inで反映
--
-- profile/auditには raw query、place identity、自由記述、feedback id を保存しない。
-- receiptは本人の同一イベントを一度だけ適用するための不透明キーだけを持ち、
-- feedback所有確認とprofile更新を同一security-definer RPCで行う。

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
    or jsonb_array_length(value -> 'sources') > 6
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
      'profile_edits',
      'feedback'
    )
  ) then
    return false;
  end if;

  return true;
exception when others then
  return false;
end;
$$;

alter table public.user_preference_profiles
  drop constraint if exists user_preference_profiles_source_kinds_check;
alter table public.user_preference_profiles
  add constraint user_preference_profiles_source_kinds_check
  check (
    cardinality(source_kinds) between 1 and 6
    and source_kinds <@ array[
      'demo_answers',
      'maps_takeout',
      'behavior_signals',
      'hearing_answers',
      'profile_edits',
      'feedback'
    ]::text[]
  );

alter table public.user_product_audit_events
  drop constraint if exists user_product_audit_events_source_check;
alter table public.user_product_audit_events
  add constraint user_product_audit_events_source_check
  check (source in ('demo', 'account', 'maps_takeout', 'feedback'));

create table public.preference_signal_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- feedback実値からDB内で計算したopaque digest。feedback id/place identityは保持しない。
  event_digest text not null check (event_digest ~ '^[0-9a-f]{32}$'),
  source_kind text not null check (source_kind = 'feedback'),
  created_at timestamptz not null default now(),
  primary key (user_id, event_digest)
);

alter table public.preference_signal_receipts enable row level security;
create policy preference_signal_receipts_select_own
on public.preference_signal_receipts for select
to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.preference_signal_receipts from anon, authenticated;
grant select on public.preference_signal_receipts to authenticated;
grant all on public.preference_signal_receipts to service_role;

create or replace function public.save_place_feedback_learning(
  p_feedback_id uuid,
  p_scenario_id text,
  p_axis_scores jsonb,
  p_likes text[],
  p_avoid text[],
  p_learning_state jsonb,
  p_consent_version text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted bigint;
  v_source_kinds text[];
  v_feedback_rating smallint;
  v_feedback_aspect text;
  v_feedback_aspect_value text;
  v_event_digest text;
  v_existing_axis_scores jsonb;
  v_existing_learning_state jsonb;
  v_model_version constant text := 'adaptive-preference-v4-feedback-v1';
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  select f.rating, f.aspect, f.aspect_value
    into v_feedback_rating, v_feedback_aspect, v_feedback_aspect_value
  from public.place_feedback f
  where f.id = p_feedback_id
    and f.user_id = auth.uid();
  if not found then
    raise exception 'feedback not found or not owned by current user' using errcode = '42501';
  end if;

  if p_consent_version <> 'personalization-v2' then
    raise exception 'feedback learning requires personalization-v2 consent' using errcode = '22023';
  end if;

  -- feedback観測は非health軸だけを扱う。cloudの既存値がある場合はその値を
  -- client payloadへ固定し、初回profileは中立値50以外を受け付けない。
  select p.axis_scores, p.learning_state
    into v_existing_axis_scores, v_existing_learning_state
  from public.user_preference_profiles p
  where p.user_id = auth.uid()
  for update;
  if v_existing_axis_scores is null then
    if p_axis_scores -> 'health' is distinct from '50'::jsonb then
      raise exception 'feedback learning cannot change health axis' using errcode = '22023';
    end if;
    if p_learning_state ? 'axes'
      and p_learning_state -> 'axes' -> 'health' -> 'mean' is distinct from '50'::jsonb
    then
      raise exception 'feedback learning cannot change health belief' using errcode = '22023';
    end if;
  else
    if p_axis_scores -> 'health' is distinct from v_existing_axis_scores -> 'health' then
      raise exception 'feedback learning cannot change health axis' using errcode = '22023';
    end if;
    if v_existing_learning_state ? 'axes'
      and p_learning_state -> 'axes' -> 'health' is distinct from
          v_existing_learning_state -> 'axes' -> 'health'
    then
      raise exception 'feedback learning cannot change health belief' using errcode = '22023';
    end if;
    if v_existing_learning_state = '{}'::jsonb
      and p_learning_state ? 'axes'
      and p_learning_state -> 'axes' -> 'health' -> 'mean' is distinct from
          v_existing_axis_scores -> 'health'
    then
      raise exception 'feedback learning cannot change health belief' using errcode = '22023';
    end if;
  end if;

  if p_scenario_id is not null and char_length(p_scenario_id) not between 1 and 64 then
    raise exception 'invalid scenario id' using errcode = '22023';
  end if;
  if not public.is_valid_taste_axis_scores(p_axis_scores)
    or p_likes is null
    or p_avoid is null
    or cardinality(p_likes) > 24
    or cardinality(p_avoid) > 24
    or not public.is_valid_preference_learning_state(p_learning_state)
  then
    raise exception 'invalid aggregate preference learning payload' using errcode = '22023';
  end if;

  -- rating/aspect/aspect_valueの現在値をDBで結び、編集後は新digestになる。
  -- md5は秘密用途ではなく、同一イベントの一意receiptだけに使う。
  v_event_digest := md5(concat_ws(
    '|', p_feedback_id::text, coalesce(v_feedback_rating::text, ''),
    coalesce(v_feedback_aspect, ''), coalesce(v_feedback_aspect_value, ''), v_model_version
  ));

  insert into public.preference_signal_receipts (
    user_id, event_digest, source_kind
  ) values (
    auth.uid(), v_event_digest, 'feedback'
  ) on conflict (user_id, event_digest) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;
  end if;

  select array_agg(source_kind order by source_kind)
    into v_source_kinds
  from (
    select distinct source_kind
    from unnest(
      coalesce(
        (select source_kinds from public.user_preference_profiles where user_id = auth.uid()),
        '{}'::text[]
      ) || array['feedback']::text[]
    ) as values(source_kind)
  ) as distinct_sources;

  insert into public.user_preference_profiles (
    user_id, scenario_id, axis_scores, likes, avoid, model_version, source_kinds,
    learning_state, consent_version, consent_purpose, consented_at
  ) values (
    auth.uid(), p_scenario_id, p_axis_scores, p_likes, p_avoid, v_model_version, v_source_kinds,
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
    auth.uid(), 'preference_profile_saved', 'feedback', v_model_version, p_consent_version
  );
  return true;
end;
$$;

revoke all on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text
) from public;
grant execute on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text
) to authenticated;

create or replace function public.delete_user_preference_profile()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  delete from public.preference_signal_receipts where user_id = auth.uid();
  delete from public.user_attribute_vectors where user_id = auth.uid();
  delete from public.attribute_vector_aggregates;
  delete from public.user_preference_profiles where user_id = auth.uid();
  insert into public.user_product_audit_events (actor_user_id, event_type, source)
  values (auth.uid(), 'preference_profile_deleted', 'account');
end;
$$;

revoke all on function public.delete_user_preference_profile() from public;
grant execute on function public.delete_user_preference_profile() to authenticated;

comment on table public.preference_signal_receipts is
  'Opaque per-user feedback event receipts for idempotent opt-in learning; digest is server-derived from the owned feedback row and fixed model revision, with no feedback id/place identity/free text retained.';
