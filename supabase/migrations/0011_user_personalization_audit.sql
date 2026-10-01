-- 0011: permanent-user-only personalization and immutable client audit events
--
-- Data minimization boundary:
-- - no raw demo answers
-- - no allergies, coordinates, place names, Takeout files, OAuth/provider tokens
-- - only aggregate taste axes and short tags
-- Authentication events remain in Supabase auth.audit_log_entries.

create or replace function public.current_user_is_permanent()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'is_anonymous', 'true') = 'false';
$$;

revoke all on function public.current_user_is_permanent() from public;
grant execute on function public.current_user_is_permanent() to authenticated, service_role;

create or replace function public.is_valid_taste_axis_scores(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'object'
    and (select count(*) from jsonb_object_keys(value)) = 6
    and (value - array['evidence', 'health', 'quiet', 'value', 'novelty', 'groupFit']) = '{}'::jsonb
    and not exists (
      select 1
      from jsonb_each(value) entry
      where jsonb_typeof(entry.value) <> 'number'
         or (entry.value #>> '{}')::numeric < 0
         or (entry.value #>> '{}')::numeric > 100
    );
$$;

revoke all on function public.is_valid_taste_axis_scores(jsonb) from public;
grant execute on function public.is_valid_taste_axis_scores(jsonb) to authenticated, service_role;

create table public.user_preference_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  scenario_id text check (scenario_id is null or char_length(scenario_id) between 1 and 64),
  axis_scores jsonb not null
    check (public.is_valid_taste_axis_scores(axis_scores)),
  likes text[] not null default '{}'
    check (
      cardinality(likes) <= 24
      and array_position(likes, null) is null
      and octet_length(array_to_string(likes, ',')) <= 2048
    ),
  avoid text[] not null default '{}'
    check (
      cardinality(avoid) <= 24
      and array_position(avoid, null) is null
      and octet_length(array_to_string(avoid, ',')) <= 2048
    ),
  model_version text not null check (char_length(model_version) between 1 and 80),
  source_kinds text[] not null default '{}'
    check (
      cardinality(source_kinds) between 1 and 2
      and source_kinds <@ array['demo_answers', 'maps_takeout']::text[]
    ),
  consent_version text not null
    check (consent_version = 'personalization-v1'),
  consent_purpose text not null default 'restaurant_recommendations'
    check (consent_purpose = 'restaurant_recommendations'),
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_user_preference_profiles_updated_at
before update on public.user_preference_profiles
for each row execute function public.set_updated_at();

create table public.user_product_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'preference_profile_saved',
    'preference_profile_deleted'
  )),
  source text not null check (source in ('demo', 'account', 'maps_takeout')),
  model_version text check (model_version is null or char_length(model_version) <= 80),
  consent_version text check (
    consent_version is null or consent_version = 'personalization-v1'
  ),
  schema_version smallint not null default 1 check (schema_version = 1),
  created_at timestamptz not null default now()
);

create index idx_user_product_audit_actor_created
  on public.user_product_audit_events (actor_user_id, created_at desc);

alter table public.user_preference_profiles enable row level security;
alter table public.user_product_audit_events enable row level security;

create policy user_preference_select_own
on public.user_preference_profiles for select
to authenticated
using (user_id = auth.uid() and public.current_user_is_permanent());

create policy user_product_audit_select_own
on public.user_product_audit_events for select
to authenticated
using (actor_user_id = auth.uid() and public.current_user_is_permanent());

revoke all on public.user_preference_profiles from anon, authenticated;
revoke all on public.user_product_audit_events from anon, authenticated;
grant select on public.user_preference_profiles to authenticated;
grant select on public.user_product_audit_events to authenticated;
grant all on public.user_preference_profiles, public.user_product_audit_events to service_role;
grant usage, select on sequence public.user_product_audit_events_id_seq to service_role;

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

  if p_consent_version <> 'personalization-v1' then
    raise exception 'unsupported personalization consent version' using errcode = '22023';
  end if;

  if p_save_source not in ('demo', 'account', 'maps_takeout') then
    raise exception 'invalid personalization save source' using errcode = '22023';
  end if;

  insert into public.user_preference_profiles (
    user_id, scenario_id, axis_scores, likes, avoid, model_version, source_kinds,
    consent_version, consent_purpose, consented_at
  ) values (
    auth.uid(), p_scenario_id, p_axis_scores, p_likes, p_avoid, p_model_version, p_source_kinds,
    p_consent_version, 'restaurant_recommendations', now()
  )
  on conflict (user_id) do update set
    scenario_id = excluded.scenario_id,
    axis_scores = excluded.axis_scores,
    likes = excluded.likes,
    avoid = excluded.avoid,
    model_version = excluded.model_version,
    source_kinds = excluded.source_kinds,
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

  delete from public.user_preference_profiles where user_id = auth.uid();
  insert into public.user_product_audit_events (actor_user_id, event_type, source)
  values (auth.uid(), 'preference_profile_deleted', 'account');
end;
$$;

revoke all on function public.save_user_preference_profile(text, jsonb, text[], text[], text, text[], text, text) from public;
revoke all on function public.delete_user_preference_profile() from public;
grant execute on function public.save_user_preference_profile(text, jsonb, text[], text[], text, text[], text, text) to authenticated;
grant execute on function public.delete_user_preference_profile() to authenticated;

comment on table public.user_preference_profiles is
  'Private aggregate personalization with explicit consent version/purpose; excludes raw answers, allergies, coordinates, places, files, and tokens.';
comment on table public.user_product_audit_events is
  'Append-only for authenticated clients. UPDATE/DELETE are intentionally not granted; service_role owns retention.';
