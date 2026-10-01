-- 202608180001: 個人属性ベクトルと匿名属性集計ベクトルの分離 (#544)
--
-- 個人行 (user_attribute_vectors) と集計行 (attribute_vector_aggregates) を
-- 別テーブル・別権限で管理する。集計行には user_id、個人行ID、調査ID、場所ID、
-- 原文、個人単位の時刻を持たせない。health と hard constraint は集計経路へ入れない。

-- ============================================================
-- 1. 属性キーと個人属性ベクトル
-- ============================================================

create or replace function public.is_valid_personal_attribute_key(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value is not null
    and value in ('evidence', 'health', 'quiet', 'value', 'novelty', 'groupFit');
$$;

revoke all on function public.is_valid_personal_attribute_key(text) from public;
grant execute on function public.is_valid_personal_attribute_key(text)
  to authenticated, service_role;

create or replace function public.is_aggregateable_attribute_key(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value in ('evidence', 'quiet', 'value', 'novelty', 'groupFit');
$$;

revoke all on function public.is_aggregateable_attribute_key(text) from public;
grant execute on function public.is_aggregateable_attribute_key(text)
  to authenticated, service_role;

create table public.user_attribute_vectors (
  user_id uuid not null references auth.users(id) on delete cascade,
  attribute_key text not null
    check (public.is_valid_personal_attribute_key(attribute_key)),
  embedding vector(768) not null,
  model_version text not null check (
    model_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  source_version text not null check (
    source_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  consent_version text not null
    check (consent_version = 'personalization-v2'),
  consent_purpose text not null
    check (consent_purpose = 'restaurant_recommendations'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, attribute_key, model_version)
);

create index idx_user_attribute_vectors_user_attribute
  on public.user_attribute_vectors (user_id, attribute_key, updated_at desc);

create trigger trg_user_attribute_vectors_updated_at
before update on public.user_attribute_vectors
for each row execute function public.set_updated_at();

comment on table public.user_attribute_vectors is
  'Private per-user attribute vectors. Composite key keeps model generations addressable; raw prompts, places, events, and hard constraints are not stored.';
comment on column public.user_attribute_vectors.source_version is
  'Opaque producer/schema version only; never a user, investigation, place, or event identifier.';

alter table public.user_attribute_vectors enable row level security;

create policy user_attribute_vectors_select_own
on public.user_attribute_vectors for select
to authenticated
using (user_id = auth.uid() and public.current_user_is_permanent());

revoke all on public.user_attribute_vectors from anon, authenticated;
grant select on public.user_attribute_vectors to authenticated;
grant all on public.user_attribute_vectors to service_role;

-- real[] を受け取り、DB側で次元数・属性キー・同意目的を再検証してから保存する。
-- クライアントの直接 INSERT/UPDATE/DELETE 権限は与えない。
create or replace function public.save_user_attribute_vector(
  p_attribute_key text,
  p_embedding real[],
  p_model_version text,
  p_source_version text,
  p_consent_version text,
  p_consent_purpose text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_embedding public.vector(768);
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  if not public.is_valid_personal_attribute_key(p_attribute_key) then
    raise exception 'invalid personal attribute key' using errcode = '22023';
  end if;

  if coalesce(array_length(p_embedding, 1), 0) <> 768 then
    raise exception 'personal attribute vector must have 768 dimensions' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(p_embedding) as component(value)
    where component.value is null
      or component.value::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception 'personal attribute vector contains a non-finite value' using errcode = '22023';
  end if;

  if p_model_version is null or p_model_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
    or p_source_version is null or p_source_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  then
    raise exception 'invalid personal attribute vector version' using errcode = '22023';
  end if;

  if p_consent_version <> 'personalization-v2'
    or p_consent_purpose <> 'restaurant_recommendations'
  then
    raise exception 'unsupported personal attribute vector consent' using errcode = '22023';
  end if;

  -- pgvector の入力形式へ変換する。値域を補正 (clamp) せず、異常値は拒否する。
  v_embedding := format('[%s]', array_to_string(p_embedding, ','))::public.vector;

  insert into public.user_attribute_vectors (
    user_id, attribute_key, embedding, model_version, source_version,
    consent_version, consent_purpose
  ) values (
    v_uid, p_attribute_key, v_embedding, p_model_version, p_source_version,
    p_consent_version, p_consent_purpose
  )
  on conflict (user_id, attribute_key, model_version) do update set
    embedding = excluded.embedding,
    source_version = excluded.source_version,
    consent_version = excluded.consent_version,
    consent_purpose = excluded.consent_purpose;
end;
$$;

revoke all on function public.save_user_attribute_vector(
  text, real[], text, text, text, text
) from public;
grant execute on function public.save_user_attribute_vector(
  text, real[], text, text, text, text
) to authenticated;

-- ============================================================
-- 2. 匿名属性集計ベクトル
-- ============================================================

create table public.attribute_vector_aggregates (
  attribute_key text not null
    check (public.is_aggregateable_attribute_key(attribute_key)),
  vector_sum vector(768) not null,
  sample_count integer not null check (sample_count >= 0),
  model_version text not null check (
    model_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  aggregation_unit text not null default 'global'
    check (aggregation_unit = 'global'),
  min_sample_count integer not null check (min_sample_count >= 3),
  anonymization_method text not null
    check (char_length(anonymization_method) between 1 and 120),
  privacy_status text not null default 'pending_privacy_review'
    check (privacy_status in ('pending_privacy_review', 'approved', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (attribute_key, model_version, aggregation_unit),
  check (sample_count >= min_sample_count)
);

create trigger trg_attribute_vector_aggregates_updated_at
before update on public.attribute_vector_aggregates
for each row execute function public.set_updated_at();

comment on table public.attribute_vector_aggregates is
  'Service-role-only aggregate vector projection. Deliberately contains no user, personal vector, investigation, place, raw text, or per-person timestamp columns.';
comment on column public.attribute_vector_aggregates.anonymization_method is
  'Must describe noise/re-identification review before approval; exact sum alone is not treated as anonymous.';
comment on column public.attribute_vector_aggregates.privacy_status is
  'pending_privacy_review rows are not a published or ranking-usable anonymous aggregate.';

alter table public.attribute_vector_aggregates enable row level security;
revoke all on public.attribute_vector_aggregates from public, anon, authenticated;
grant all on public.attribute_vector_aggregates to service_role;

create or replace function public.refresh_attribute_vector_aggregate(
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

  for v_row in
    select embedding
      from public.user_attribute_vectors
     where attribute_key = p_attribute_key
       and model_version = p_model_version
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

  if v_sample_count < v_min_sample_count then
    delete from public.attribute_vector_aggregates
     where attribute_key = p_attribute_key
       and model_version = p_model_version
       and aggregation_unit = 'global';
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
  )
  on conflict (attribute_key, model_version, aggregation_unit) do update set
    vector_sum = excluded.vector_sum,
    sample_count = excluded.sample_count,
    min_sample_count = excluded.min_sample_count,
    anonymization_method = excluded.anonymization_method,
    privacy_status = 'pending_privacy_review';

  return jsonb_build_object(
    'status', 'pending_privacy_review',
    'attribute_key', p_attribute_key,
    'model_version', p_model_version,
    'sample_count', v_sample_count,
    'min_sample_count', v_min_sample_count
  );
end;
$$;

revoke all on function public.refresh_attribute_vector_aggregate(text, text, integer) from public;
grant execute on function public.refresh_attribute_vector_aggregate(text, text, integer)
  to service_role;

create or replace function public.approve_attribute_vector_aggregate(
  p_attribute_key text,
  p_model_version text,
  p_anonymization_method text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_anonymization_method is null
    or char_length(p_anonymization_method) not between 1 and 120
    or lower(p_anonymization_method) like '%exact_sum%'
  then
    raise exception 'exact sum cannot be approved as anonymous' using errcode = '22023';
  end if;

  update public.attribute_vector_aggregates
     set anonymization_method = p_anonymization_method,
         privacy_status = 'approved'
   where attribute_key = p_attribute_key
     and model_version = p_model_version
     and aggregation_unit = 'global'
     and sample_count >= min_sample_count;

  if not found then
    raise exception 'aggregate is missing or below minimum sample count' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.approve_attribute_vector_aggregate(text, text, text) from public;
grant execute on function public.approve_attribute_vector_aggregate(text, text, text)
  to service_role;

-- ============================================================
-- 3. 既存の「好みだけ削除」に個人属性ベクトルを接続
-- ============================================================

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

  delete from public.user_attribute_vectors where user_id = auth.uid();
  -- 個人寄与を逆引きできない派生集計は、好みだけ削除でも破棄して再計算する。
  delete from public.attribute_vector_aggregates;
  delete from public.user_preference_profiles where user_id = auth.uid();
  insert into public.user_product_audit_events (actor_user_id, event_type, source)
  values (auth.uid(), 'preference_profile_deleted', 'account');
end;
$$;

revoke all on function public.delete_user_preference_profile() from public;
grant execute on function public.delete_user_preference_profile() to authenticated;

-- ============================================================
-- 4. アカウント削除 (#167) から呼ぶ個人データ掃除RPC
-- ============================================================

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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  -- 個人が所有する調査を先に消す。candidates / requirements / evaluations /
  -- investigation_events は既存FKの cascade、evidence は shared資産として set null される。
  delete from public.investigations where created_by = p_user_id;
  get diagnostics v_investigations_deleted = row_count;

  -- 他人の調査に残った本人の個人行も消す。
  delete from public.requirements where created_by = p_user_id;
  get diagnostics v_requirements_deleted = row_count;
  delete from public.votes where user_id = p_user_id;
  get diagnostics v_votes_deleted = row_count;
  delete from public.place_feedback where user_id = p_user_id;
  get diagnostics v_feedback_deleted = row_count;
  delete from public.investigation_members where user_id = p_user_id;
  get diagnostics v_memberships_deleted = row_count;

  -- 他人の調査へ参加した痕跡は、イベント行自体を壊さず個人識別子と表示名を落とす。
  update public.investigation_events
     set metadata = coalesce(metadata, '{}'::jsonb) - 'userId',
         message = '[匿名化済み]'
   where metadata ->> 'userId' = p_user_id::text;
  get diagnostics v_events_anonymized = row_count;

  -- 集計テーブルには逆引き情報がないため、本人の寄与だけを差し引けない。
  -- アカウント削除時は全派生集計を破棄し、残存ユーザーから再計算・再審査する。
  delete from public.attribute_vector_aggregates;
  get diagnostics v_aggregates_deleted = row_count;

  delete from public.user_attribute_vectors where user_id = p_user_id;
  get diagnostics v_vectors_deleted = row_count;
  delete from public.user_preference_profiles where user_id = p_user_id;
  get diagnostics v_preference_profiles_deleted = row_count;
  delete from public.profiles where id = p_user_id;
  get diagnostics v_profiles_deleted = row_count;

  -- 製品監査イベントは監査目的で残し、actorだけを匿名化する。
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
    'audit_events_anonymized', v_audit_events_anonymized
  );
end;
$$;

revoke all on function public.delete_user_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_account_data(uuid) to service_role;

comment on function public.delete_user_account_data(uuid) is
  'Service-role-only purge called by account deletion. Removes individual vectors and user rows; preserves only non-identifying shared assets and redacts participation events.';
