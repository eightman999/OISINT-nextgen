-- 202608240010: #515/#544 個人削除時の派生集計境界
--
-- 旧 migration の delete_user_preference_profile は、個人寄与を逆引きできない
-- という理由で attribute_vector_aggregates 全行を削除していた。後続migrationで
-- その挙動を廃止し、本人が実際に持つ aggregateable scope だけを再計算する。
-- 既存の集計・個人行は無断purgeせず、母数不足の scope のみ安全側へ落とす。

create or replace function public.is_valid_preference_label_array(value text[])
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item text;
  total_bytes bigint := 0;
begin
  if value is null or coalesce(cardinality(value), 0) > 24 then
    return false;
  end if;

  foreach item in array value loop
    if item is null
      or char_length(btrim(item)) not between 1 and 120
      or octet_length(item) > 480
    then
      return false;
    end if;
    total_bytes := total_bytes + octet_length(item);
    if total_bytes > 2048 then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.is_valid_preference_label_array(text[]) from public;
grant execute on function public.is_valid_preference_label_array(text[])
  to authenticated, service_role;

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
    or not public.is_valid_preference_label_array(p_likes)
    or not public.is_valid_preference_label_array(p_avoid)
    or not public.is_valid_preference_learning_state(p_learning_state)
  then
    raise exception 'invalid aggregate preference learning payload' using errcode = '22023';
  end if;

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
declare
  v_scope record;
  v_row record;
  v_embedding public.vector(768);
  v_sample_count integer;
  v_min_sample_count integer;
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  -- 先に本人の aggregateable scope を取得し、scopeごとに短いtransaction lockを
  -- 取る。別ユーザーのprofile/aggregateを全消去しない。
  for v_scope in
    select distinct u.attribute_key, u.model_version
      from public.user_attribute_vectors u
     where u.user_id = auth.uid()
       and public.is_aggregateable_attribute_key(u.attribute_key)
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_scope.attribute_key || ':' || v_scope.model_version, 0)
    );

    select greatest(coalesce(a.min_sample_count, 3), 3)
      into v_min_sample_count
      from public.attribute_vector_aggregates a
     where a.attribute_key = v_scope.attribute_key
       and a.model_version = v_scope.model_version
       and a.aggregation_unit = 'global';
    v_min_sample_count := greatest(coalesce(v_min_sample_count, 3), 3);

    delete from public.attribute_vector_aggregates
     where attribute_key = v_scope.attribute_key
       and model_version = v_scope.model_version
       and aggregation_unit = 'global';
    delete from public.user_attribute_vectors
     where user_id = auth.uid()
       and attribute_key = v_scope.attribute_key
       and model_version = v_scope.model_version;

    v_embedding := null;
    v_sample_count := 0;
    for v_row in
      select embedding
        from public.user_attribute_vectors
       where attribute_key = v_scope.attribute_key
         and model_version = v_scope.model_version
         and consent_version = 'personalization-v2'
         and consent_purpose = 'restaurant_recommendations'
    loop
      if v_embedding is null then
        v_embedding := v_row.embedding;
      else
        v_embedding := v_embedding OPERATOR(public.+) v_row.embedding;
      end if;
      v_sample_count := v_sample_count + 1;
    end loop;

    if v_sample_count >= v_min_sample_count and v_embedding is not null then
      insert into public.attribute_vector_aggregates (
        attribute_key, vector_sum, sample_count, model_version, aggregation_unit,
        min_sample_count, anonymization_method, privacy_status
      ) values (
        v_scope.attribute_key, v_embedding, v_sample_count, v_scope.model_version, 'global',
        v_min_sample_count, 'exact_sum_pending_noise_and_reidentification_review',
        'pending_privacy_review'
      );
    end if;
  end loop;

  delete from public.preference_signal_receipts where user_id = auth.uid();
  delete from public.user_attribute_vectors where user_id = auth.uid();
  delete from public.user_preference_profiles where user_id = auth.uid();
  insert into public.user_product_audit_events (actor_user_id, event_type, source)
  values (auth.uid(), 'preference_profile_deleted', 'account');
end;
$$;

revoke all on function public.delete_user_preference_profile() from public;
grant execute on function public.delete_user_preference_profile() to authenticated;

comment on function public.delete_user_preference_profile() is
  'Deletes only the caller preference rows and rebuilds affected aggregate scopes; never truncates global aggregates.';
