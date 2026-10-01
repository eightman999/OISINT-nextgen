-- 202608240016: profile save/delete と feedback learning の同一 user lock/CAS (#515)
--
-- save_user_preference_profile は feedback learning と同じ全量 snapshot を更新する。
-- そのため別の advisory lock を使うと、feedback が反映した後に古い profile snapshot
-- が戻る。永続 profile の保存・削除も同じ user key を直列化し、保存は revision CAS
-- を必須にする。旧8/9引数の全量upsertは、呼出元がpayload作成時のrevisionを渡せず
-- lossless再計算もできないため、認証済み呼出でもSQLSTATE 40001でfail-closedにする。

create or replace function public.save_user_preference_profile(
  p_scenario_id text,
  p_axis_scores jsonb,
  p_likes text[],
  p_avoid text[],
  p_model_version text,
  p_source_kinds text[],
  p_learning_state jsonb,
  p_consent_version text,
  p_save_source text,
  p_expected_updated_at timestamptz,
  p_base_profile_exists boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_updated_at timestamptz;
  v_profile_exists boolean := false;
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  if p_base_profile_exists is null then
    raise exception 'profile base existence is required' using errcode = '22023';
  end if;
  if p_consent_version <> 'personalization-v2' then
    raise exception 'adaptive learning requires personalization-v2 consent' using errcode = '22023';
  end if;
  if p_save_source not in ('demo', 'account', 'maps_takeout') then
    raise exception 'invalid personalization save source' using errcode = '22023';
  end if;
  if not public.is_valid_taste_axis_scores(p_axis_scores)
    or not public.is_valid_preference_label_array(p_likes)
    or not public.is_valid_preference_label_array(p_avoid)
    or not public.is_valid_preference_learning_state(p_learning_state)
  then
    raise exception 'invalid aggregate preference learning payload' using errcode = '22023';
  end if;

  -- feedback CAS / profile save / profile delete は同じ user lock を使う。
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oisint-feedback-learning:' || auth.uid()::text,
      0
    )
  );

  select p.updated_at
    into v_current_updated_at
    from public.user_preference_profiles p
   where p.user_id = auth.uid()
   for update;
  v_profile_exists := found;

  if p_base_profile_exists then
    if not v_profile_exists
      or p_expected_updated_at is null
      or v_current_updated_at is distinct from p_expected_updated_at
    then
      raise exception 'preference profile changed; reload and retry' using errcode = '40001';
    end if;
  elsif v_profile_exists then
    raise exception 'preference profile was created; reload and retry' using errcode = '40001';
  end if;

  insert into public.user_preference_profiles (
    user_id, scenario_id, axis_scores, likes, avoid, model_version, source_kinds,
    learning_state, consent_version, consent_purpose, consented_at
  ) values (
    auth.uid(), p_scenario_id, p_axis_scores, p_likes, p_avoid, p_model_version,
    p_source_kinds, p_learning_state, p_consent_version,
    'restaurant_recommendations', now()
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

-- Keep the nine-argument signature discoverable for PostgREST, but fail closed.
-- Reading the current revision inside this shim would make a stale full snapshot
-- appear current and could overwrite feedback learning.
create or replace function public.save_user_preference_profile(
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
  raise exception
    'legacy save_user_preference_profile signature is deprecated; use revision CAS overload'
    using errcode = '40001';
end;
$$;

-- The eight-argument personalization-v1 overload from 0011 is also a full
-- snapshot upsert. It has no learning_state or caller revision, so retaining
-- its old implementation would leave the same lost-update path available.
create or replace function public.save_user_preference_profile(
  p_scenario_id text,
  p_axis_scores jsonb,
  p_likes text[],
  p_avoid text[],
  p_model_version text,
  p_source_kinds text[],
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
  raise exception
    'legacy save_user_preference_profile signature is deprecated; use revision CAS overload'
    using errcode = '40001';
end;
$$;

-- Profile deletion is an intentional destructive operation, so it does not use
-- a caller revision, but it must serialize against feedback/profile writes.
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oisint-feedback-learning:' || auth.uid()::text,
      0
    )
  );

  -- scopeごとに aggregate を再構築し、別ユーザーの寄与を削除しない。
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

revoke all on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text,
  timestamptz, boolean
) from public;
grant execute on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text,
  timestamptz, boolean
) to authenticated;

revoke all on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text
) from public;
grant execute on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text
) to authenticated;

revoke all on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], text, text
) from public;
grant execute on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], text, text
) to authenticated;

revoke all on function public.delete_user_preference_profile() from public;
grant execute on function public.delete_user_preference_profile() to authenticated;

comment on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text,
  timestamptz, boolean
) is
  'Serializes profile writes with feedback learning and rejects stale full snapshots with SQLSTATE 40001.';

comment on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], jsonb, text, text
) is
  'Deprecated compatibility signature; fails closed with SQLSTATE 40001 because a legacy full snapshot has no caller-bound revision.';

comment on function public.save_user_preference_profile(
  text, jsonb, text[], text[], text, text[], text, text
) is
  'Deprecated personalization-v1 signature; fails closed with SQLSTATE 40001 because a legacy full snapshot has no caller-bound revision.';

comment on function public.delete_user_preference_profile() is
  'Serializes profile deletion with feedback learning and rebuilds affected aggregate scopes without truncating global aggregates.';
