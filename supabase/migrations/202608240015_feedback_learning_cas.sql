-- 202608240015: serialize feedback learning and reject stale full snapshots (#515)
--
-- 202608240004 made the receipt idempotent, but a first profile row does not
-- exist to lock and two clients can still submit different full snapshots from
-- the same empty base.  The 9-argument overload below serializes one user's
-- feedback writes and requires the caller's profile existence/revision to
-- match.  A stale caller receives 40001; the client reloads the canonical row,
-- recomputes its one feedback observation, and retries.  The old 7-argument
-- overload is retained only as a deterministic deprecation error: a legacy
-- full snapshot has no caller-bound revision and cannot be losslessly merged.

create or replace function public.save_place_feedback_learning(
  p_feedback_id uuid,
  p_scenario_id text,
  p_axis_scores jsonb,
  p_likes text[],
  p_avoid text[],
  p_learning_state jsonb,
  p_consent_version text,
  p_expected_updated_at timestamptz,
  p_base_profile_exists boolean
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
  v_current_updated_at timestamptz;
  v_profile_exists boolean := false;
  v_model_version constant text := 'adaptive-preference-v4-feedback-v1';
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  -- This key is scoped to the authenticated user, not to a feedback/place
  -- identity.  It covers the row-not-yet-present case as well as updates.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oisint-feedback-learning:' || auth.uid()::text,
      0
    )
  );

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

  -- rating/aspect/aspect_valueの現在値をDBで結び、同一イベントのreceipt
  -- 判定に使う。並行duplicateが古いsnapshotを読んでいても、lock取得後に
  -- receiptを確認すれば、冪等duplicateだけは40001へ変換しない。
  v_event_digest := md5(concat_ws(
    '|', p_feedback_id::text, coalesce(v_feedback_rating::text, ''),
    coalesce(v_feedback_aspect, ''), coalesce(v_feedback_aspect_value, ''), v_model_version
  ));

  select p.axis_scores, p.learning_state, p.updated_at
    into v_existing_axis_scores, v_existing_learning_state, v_current_updated_at
  from public.user_preference_profiles p
  where p.user_id = auth.uid()
  for update;
  v_profile_exists := v_current_updated_at is not null;

  -- A full snapshot is safe only when it was derived from the row currently
  -- locked above.  For the first profile write, another transaction creating
  -- the row after the caller's read is also a conflict.
  if p_base_profile_exists then
    if not v_profile_exists
       or p_expected_updated_at is null
       or v_current_updated_at is distinct from p_expected_updated_at then
      if exists (
        select 1 from public.preference_signal_receipts r
         where r.user_id = auth.uid() and r.event_digest = v_event_digest
      ) then
        return false;
      end if;
      raise exception 'preference profile changed; reload and retry' using errcode = '40001';
    end if;
  elsif v_profile_exists then
    if exists (
      select 1 from public.preference_signal_receipts r
       where r.user_id = auth.uid() and r.event_digest = v_event_digest
    ) then
      return false;
    end if;
    raise exception 'preference profile was created; reload and retry' using errcode = '40001';
  end if;

  -- feedback観測は非health軸だけを扱う。cloudの既存値がある場合はその値を
  -- client payloadへ固定し、初回profileは中立値50以外を受け付けない。
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
  -- 010 established the label boundary (element length, NULL elements and
  -- aggregate byte size).  Keep using that shared validator here: a later
  -- CAS/revision wrapper must not silently widen an earlier RPC contract.
  if not public.is_valid_taste_axis_scores(p_axis_scores)
    or not public.is_valid_preference_label_array(p_likes)
    or not public.is_valid_preference_label_array(p_avoid)
    or not public.is_valid_preference_learning_state(p_learning_state)
  then
    raise exception 'invalid aggregate preference learning payload' using errcode = '22023';
  end if;

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

-- Keep the old signature discoverable for PostgREST, but fail closed. Reading a
-- revision inside this shim would make a stale full snapshot appear current.
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
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;
  raise exception
    'legacy save_place_feedback_learning signature is deprecated; use revision CAS overload'
    using errcode = '40001';
end;
$$;

revoke all on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text,
  timestamptz, boolean
) from public;
grant execute on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text,
  timestamptz, boolean
) to authenticated;

revoke all on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text
) from public;
grant execute on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text
) to authenticated;

comment on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text, timestamptz, boolean
) is
  'Serializes per-user feedback learning and requires the caller profile revision; stale snapshots return SQLSTATE 40001 for reload/recompute/retry.';

comment on function public.save_place_feedback_learning(
  uuid, text, jsonb, text[], text[], jsonb, text
) is
  'Deprecated compatibility signature; fails closed with SQLSTATE 40001 because a legacy full snapshot has no caller-bound revision.';
