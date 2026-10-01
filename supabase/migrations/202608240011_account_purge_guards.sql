-- 202608240011: account purge must be scoped and fail-closed (#167/#515)
--
-- The historical account purge truncated every attribute aggregate and did not
-- refresh shared feedback facts.  This follow-up keeps the old migrations
-- immutable, serializes each affected scope, and removes account-owned access
-- rows before the Auth admin delete is attempted.  The RevenueCat deletion
-- outbox is intentionally retained so an external deletion can be retried.

create or replace function public.rebuild_attribute_vector_aggregate_scope(
  p_attribute_key text,
  p_model_version text,
  p_min_sample_count integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_embedding public.vector(768);
  v_row record;
  v_sample_count integer := 0;
  v_min_sample_count integer := greatest(coalesce(p_min_sample_count, 3), 3);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if not public.is_aggregateable_attribute_key(p_attribute_key)
     or p_model_version is null
     or p_model_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  then
    raise exception 'invalid aggregate vector scope' using errcode = '22023';
  end if;

  -- All aggregate writers, preference deletion, and account deletion use the
  -- same scope lock.  A concurrent refresh therefore observes a committed
  -- post-delete vector set instead of resurrecting a stale aggregate.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_attribute_key || ':' || p_model_version, 0)
  );

  select greatest(coalesce(a.min_sample_count, 3), 3)
    into v_min_sample_count
    from public.attribute_vector_aggregates as a
   where a.attribute_key = p_attribute_key
     and a.model_version = p_model_version
     and a.aggregation_unit = 'global';
  v_min_sample_count := greatest(
    coalesce(v_min_sample_count, greatest(coalesce(p_min_sample_count, 3), 3)),
    3
  );

  for v_row in
    select u.embedding
      from public.user_attribute_vectors as u
     where u.attribute_key = p_attribute_key
       and u.model_version = p_model_version
       and u.consent_version = 'personalization-v2'
       and u.consent_purpose = 'restaurant_recommendations'
  loop
    if v_embedding is null then
      v_embedding := v_row.embedding;
    else
      v_embedding := v_embedding OPERATOR(public.+) v_row.embedding;
    end if;
    v_sample_count := v_sample_count + 1;
  end loop;

  delete from public.attribute_vector_aggregates as a
   where a.attribute_key = p_attribute_key
     and a.model_version = p_model_version
     and a.aggregation_unit = 'global';

  if v_sample_count < v_min_sample_count or v_embedding is null then
    return jsonb_build_object(
      'status', 'held_below_minimum',
      'attribute_key', p_attribute_key,
      'model_version', p_model_version,
      'sample_count', v_sample_count,
      'min_sample_count', v_min_sample_count
    );
  end if;

  insert into public.attribute_vector_aggregates (
    attribute_key, vector_sum, sample_count, model_version, aggregation_unit,
    min_sample_count, anonymization_method, privacy_status
  ) values (
    p_attribute_key, v_embedding, v_sample_count, p_model_version, 'global',
    v_min_sample_count, 'exact_sum_pending_noise_and_reidentification_review',
    'pending_privacy_review'
  );

  return jsonb_build_object(
    'status', 'pending_privacy_review',
    'attribute_key', p_attribute_key,
    'model_version', p_model_version,
    'sample_count', v_sample_count,
    'min_sample_count', v_min_sample_count
  );
end;
$$;

revoke all on function public.rebuild_attribute_vector_aggregate_scope(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.rebuild_attribute_vector_aggregate_scope(text, text, integer)
  to service_role;

create or replace function public.refresh_attribute_vector_aggregate(
  p_attribute_key text,
  p_model_version text,
  p_min_sample_count integer default 3
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.rebuild_attribute_vector_aggregate_scope(
    p_attribute_key, p_model_version, p_min_sample_count
  );
$$;

revoke all on function public.refresh_attribute_vector_aggregate(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.refresh_attribute_vector_aggregate(text, text, integer)
  to service_role;

create or replace function public.delete_user_account_data(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_investigations_deleted bigint := 0;
  v_requirements_deleted bigint := 0;
  v_votes_deleted bigint := 0;
  v_feedback_deleted bigint := 0;
  v_memberships_deleted bigint := 0;
  v_events_anonymized bigint := 0;
  v_vectors_deleted bigint := 0;
  v_profiles_deleted bigint := 0;
  v_preference_profiles_deleted bigint := 0;
  v_aggregates_deleted bigint := 0;
  v_audit_events_anonymized bigint := 0;
  v_admin_rows_deleted bigint := 0;
  v_entitlements_deleted bigint := 0;
  v_receipts_deleted bigint := 0;
  v_webhook_rows_anonymized bigint := 0;
  v_scope record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  -- Serialize repeated/parallel purge attempts for one subject.  This also
  -- makes the operation idempotent after Auth deletion removed its FK rows.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint-account-purge:' || p_user_id::text, 0)
  );

  -- Capture scopes before deleting their last personal contribution.  Temp
  -- tables are dropped at the end of the transaction and recreated on a
  -- same-transaction retry, so no scope from another invocation is reused.
  drop table if exists pg_temp._account_purge_attribute_scopes;
  create temporary table _account_purge_attribute_scopes (
    attribute_key text not null,
    model_version text not null,
    primary key (attribute_key, model_version)
  ) on commit drop;
  insert into pg_temp._account_purge_attribute_scopes (attribute_key, model_version)
  select distinct u.attribute_key, u.model_version
    from public.user_attribute_vectors as u
   where u.user_id = p_user_id
     and public.is_aggregateable_attribute_key(u.attribute_key);

  drop table if exists pg_temp._account_purge_feedback_scopes;
  create temporary table _account_purge_feedback_scopes (
    place_id uuid not null,
    aspect text not null,
    primary key (place_id, aspect)
  ) on commit drop;
  insert into pg_temp._account_purge_feedback_scopes (place_id, aspect)
  select distinct f.place_id, f.aspect
    from public.place_feedback as f
   where f.user_id = p_user_id
     and f.aspect is not null;

  -- Lock scopes in stable order before any delete.  submit/update and the
  -- refresh RPC use the same keys, preventing stale shared facts.
  for v_scope in
    select s.place_id, s.aspect
      from pg_temp._account_purge_feedback_scopes as s
     order by s.place_id, s.aspect
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oisint-feedback:' || v_scope.place_id::text || ':' || v_scope.aspect,
        0
      )
    );
  end loop;
  for v_scope in
    select s.attribute_key, s.model_version
      from pg_temp._account_purge_attribute_scopes as s
     order by s.attribute_key, s.model_version
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_scope.attribute_key || ':' || v_scope.model_version, 0
      )
    );
  end loop;

  -- Remove private/account-owned access rows before the Auth admin delete.  A
  -- failed Auth deletion must not leave admin or Plus state usable by an old
  -- JWT.  The RevenueCat deletion request outbox is retained for retry and
  -- contains only the canonical subject, not raw customer payload.
  delete from public.admin_allowlist where user_id = p_user_id;
  get diagnostics v_admin_rows_deleted = row_count;
  delete from public.user_entitlements where user_id = p_user_id;
  get diagnostics v_entitlements_deleted = row_count;
  delete from public.preference_signal_receipts where user_id = p_user_id;
  get diagnostics v_receipts_deleted = row_count;
  update public.revenuecat_webhook_events
     set user_id = null
   where user_id = p_user_id;
  get diagnostics v_webhook_rows_anonymized = row_count;

  -- Owned investigations cascade their private children.  Shared places,
  -- evidence, and provider assets are deliberately preserved.
  delete from public.investigations where created_by = p_user_id;
  get diagnostics v_investigations_deleted = row_count;
  delete from public.requirements where created_by = p_user_id;
  get diagnostics v_requirements_deleted = row_count;
  delete from public.votes where user_id = p_user_id;
  get diagnostics v_votes_deleted = row_count;
  delete from public.place_feedback where user_id = p_user_id;
  get diagnostics v_feedback_deleted = row_count;
  delete from public.investigation_members where user_id = p_user_id;
  get diagnostics v_memberships_deleted = row_count;

  update public.investigation_events
     set metadata = coalesce(metadata, '{}'::jsonb) - 'userId',
         message = '[匿名化済み]'
   where metadata ->> 'userId' = p_user_id::text;
  get diagnostics v_events_anonymized = row_count;

  delete from public.user_attribute_vectors where user_id = p_user_id;
  get diagnostics v_vectors_deleted = row_count;
  for v_scope in
    select s.attribute_key, s.model_version
      from pg_temp._account_purge_attribute_scopes as s
     order by s.attribute_key, s.model_version
  loop
    select count(*) into v_aggregates_deleted
      from public.attribute_vector_aggregates as a
     where a.attribute_key = v_scope.attribute_key
       and a.model_version = v_scope.model_version
       and a.aggregation_unit = 'global';
    perform public.rebuild_attribute_vector_aggregate_scope(
      v_scope.attribute_key, v_scope.model_version, 3
    );
  end loop;

  for v_scope in
    select s.place_id, s.aspect
      from pg_temp._account_purge_feedback_scopes as s
     order by s.place_id, s.aspect
  loop
    perform public.refresh_place_feedback_fact(v_scope.place_id, v_scope.aspect);
  end loop;

  delete from public.user_preference_profiles where user_id = p_user_id;
  get diagnostics v_preference_profiles_deleted = row_count;
  delete from public.profiles where id = p_user_id;
  get diagnostics v_profiles_deleted = row_count;
  update public.user_product_audit_events
     set actor_user_id = null
   where actor_user_id = p_user_id;
  get diagnostics v_audit_events_anonymized = row_count;

  return jsonb_build_object(
    'investigations_deleted', v_investigations_deleted,
    'requirements_deleted', v_requirements_deleted,
    'votes_deleted', v_votes_deleted,
    'feedback_deleted', v_feedback_deleted,
    'memberships_deleted', v_memberships_deleted,
    'events_anonymized', v_events_anonymized,
    'aggregates_deleted', v_aggregates_deleted,
    'attribute_vectors_deleted', v_vectors_deleted,
    'preference_profiles_deleted', v_preference_profiles_deleted,
    'profiles_deleted', v_profiles_deleted,
    'audit_events_anonymized', v_audit_events_anonymized,
    'admin_rows_deleted', v_admin_rows_deleted,
    'entitlements_deleted', v_entitlements_deleted,
    'preference_receipts_deleted', v_receipts_deleted,
    'webhook_rows_anonymized', v_webhook_rows_anonymized
  );
end;
$$;

revoke all on function public.delete_user_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_account_data(uuid) to service_role;

comment on function public.delete_user_account_data(uuid) is
  'Service-role-only idempotent purge. Removes account-owned access/feedback/vector rows, rebuilds only affected aggregate and feedback scopes, preserves shared assets and the RevenueCat deletion outbox.';
