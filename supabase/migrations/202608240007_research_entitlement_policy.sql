-- 202608240007: accepted research runs pin a server-side entitlement policy (#554)
--
-- The policy snapshot contains only the resolved Free/Plus tier and bounded
-- numeric limits. RevenueCat app_user_id, product payloads, and aliases never
-- enter investigation_runs or the research pipeline.

alter table public.investigation_runs
  add column if not exists entitlement_tier text not null default 'free';

alter table public.investigation_runs
  add column if not exists budget_profile jsonb not null default
    '{"version":"v1","tier":"free","finalCandidateLimit":3,"broadCandidateLimit":3,"preRankCandidateLimit":3,"researchCandidateLimit":3,"providerCallLimit":3,"estimatedCostMicros":50000}'::jsonb;

alter table public.investigation_runs
  add column if not exists entitlement_snapshot_at timestamptz not null default now();

-- provider_usage_id is nullable by design: mock and an explicitly disabled cost
-- guard do not create a ledger row. Keep the acceptance decision explicit so a
-- durable service retry never infers authorization from a nullable FK alone.
alter table public.investigation_runs
  add column if not exists cost_guard_state text not null default 'pending';

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.investigation_runs'::regclass
       and conname = 'investigation_runs_entitlement_tier_check'
  ) then
    alter table public.investigation_runs
      add constraint investigation_runs_entitlement_tier_check
      check (entitlement_tier in ('free', 'plus'));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.investigation_runs'::regclass
       and conname = 'investigation_runs_cost_guard_state_check'
  ) then
    alter table public.investigation_runs
      add constraint investigation_runs_cost_guard_state_check
      check (cost_guard_state in (
        'pending', 'reserved', 'mock_bypassed', 'disabled_bypassed',
        'legacy_bypassed'
      ));
  end if;
end;
$$;

-- Rows accepted by the pre-#554 queue have no state column. Preserve those
-- already accepted decisions explicitly during rollout; new rows must use one
-- of the named states through mark_investigation_run_enqueued.
update public.investigation_runs as r
   set cost_guard_state = case
     when r.provider_usage_id is not null then 'reserved'
     else 'legacy_bypassed'
   end
 where r.acceptance_state = 'accepted'
   and r.cost_guard_state = 'pending';

comment on column public.investigation_runs.entitlement_tier is
  'Server-resolved Free/Plus tier pinned before acceptance; never client supplied.';
comment on column public.investigation_runs.budget_profile is
  'Bounded server research policy snapshot. No RevenueCat identifiers or purchase payloads.';
comment on column public.investigation_runs.entitlement_snapshot_at is
  'Time at which the server policy snapshot was resolved/pinned for this run.';
comment on column public.investigation_runs.cost_guard_state is
  'Explicit accepted-run cost decision: reserved ledger row, or named safe bypass for mock/disabled guard.';

-- Service-role only resolver for the verified JWT subject at the acceptance
-- boundary. Missing, anonymous, expired, or malformed state is Free.
create or replace function public.resolve_entitlement_for_user(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'tier', case
      when public.revenuecat_entitlement_access_allowed(
        e.user_id,
        e.app_user_id,
        e.is_active,
        e.lifecycle_state,
        e.product_id,
        e.expires_at,
        e.grace_period_expires_at
      )
      then 'plus' else 'free' end,
    'entitlement_id', coalesce(e.entitlement_id, 'plus'),
    'product_id', e.product_id,
    'offering_id', coalesce(e.offering_id, 'default'),
    'lifecycle_state', coalesce(e.lifecycle_state, 'free'),
    'expires_at', e.expires_at,
    'will_renew', e.will_renew,
    'grace_period_expires_at', e.grace_period_expires_at,
    'updated_at', e.updated_at
  )
  from (select * from public.user_entitlements where user_id = p_user_id) e
  where p_user_id is not null
    and exists (
      select 1 from auth.users u
       where u.id = p_user_id and coalesce(u.is_anonymous, false) = false
    )
  union all
  select jsonb_build_object(
    'tier', 'free',
    'entitlement_id', 'plus',
    'product_id', null,
    'offering_id', 'default',
    'lifecycle_state', 'free',
    'expires_at', null,
    'will_renew', false,
    'grace_period_expires_at', null,
    'updated_at', null
  )
  where not exists (
    select 1 from public.user_entitlements e where e.user_id = p_user_id
  )
     or not exists (
       select 1 from auth.users u
        where u.id = p_user_id and coalesce(u.is_anonymous, false) = false
     )
  limit 1;
$$;

revoke all on function public.resolve_entitlement_for_user(uuid) from public, anon, authenticated;
grant execute on function public.resolve_entitlement_for_user(uuid) to service_role;

-- Pin a validated policy while the run is still pending acceptance. Repeated
-- calls with the same snapshot are idempotent; a different tier/profile cannot
-- overwrite an already pinned run.
create or replace function public.set_investigation_run_policy(
  p_run_id uuid,
  p_lease_owner uuid,
  p_entitlement_tier text,
  p_budget_profile jsonb
)
returns table(configured boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_max integer;
begin
  if p_run_id is null or p_lease_owner is null
     or p_entitlement_tier not in ('free', 'plus')
     or p_budget_profile is null
     or pg_catalog.jsonb_typeof(p_budget_profile) <> 'object'
     or p_budget_profile ->> 'version' <> 'v1'
     or p_budget_profile ->> 'tier' <> p_entitlement_tier
     or p_budget_profile ->> 'finalCandidateLimit' <> '3'
     or p_budget_profile ->> 'broadCandidateLimit' is null
     or p_budget_profile ->> 'preRankCandidateLimit' is null
     or p_budget_profile ->> 'researchCandidateLimit' is null
     or p_budget_profile ->> 'providerCallLimit' is null
     or p_budget_profile ->> 'estimatedCostMicros' is null
     or (select count(*) from pg_catalog.jsonb_object_keys(p_budget_profile)) <> 8
     or exists (
       select 1
         from pg_catalog.jsonb_object_keys(p_budget_profile) as keys(key)
        where key not in (
          'version', 'tier', 'finalCandidateLimit', 'broadCandidateLimit',
          'preRankCandidateLimit', 'researchCandidateLimit',
          'providerCallLimit', 'estimatedCostMicros'
        )
     ) then
    raise exception 'invalid investigation research policy' using errcode = '22023';
  end if;

  -- #570 release slice freezes the existing P0 search/research depth at 3 for
  -- both tiers. Broader Plus discovery is a follow-up, not this snapshot gate.
  v_max := 3;
  if (p_budget_profile ->> 'broadCandidateLimit')::integer not between 1 and v_max
     or (p_budget_profile ->> 'preRankCandidateLimit')::integer not between 1 and v_max
     or (p_budget_profile ->> 'researchCandidateLimit')::integer not between 1 and v_max
     or (p_budget_profile ->> 'providerCallLimit')::integer not between 1 and v_max
     or (p_budget_profile ->> 'broadCandidateLimit')::integer
       <> (p_budget_profile ->> 'preRankCandidateLimit')::integer
     or (p_budget_profile ->> 'preRankCandidateLimit')::integer
       <> (p_budget_profile ->> 'researchCandidateLimit')::integer
     or (p_budget_profile ->> 'researchCandidateLimit')::integer
       <> (p_budget_profile ->> 'providerCallLimit')::integer
     or (p_budget_profile ->> 'estimatedCostMicros')::bigint not between 0 and 1000000000 then
    raise exception 'investigation research policy out of bounds' using errcode = '22023';
  end if;
  if (p_budget_profile ->> 'broadCandidateLimit')::integer <> 3
     or (p_budget_profile ->> 'preRankCandidateLimit')::integer <> 3
     or (p_budget_profile ->> 'researchCandidateLimit')::integer <> 3
     or (p_budget_profile ->> 'providerCallLimit')::integer <> 3 then
    raise exception 'investigation research policy is outside the P0 v1 profile'
      using errcode = '22023';
  end if;

  update public.investigation_runs as r
     set entitlement_tier = p_entitlement_tier,
         budget_profile = p_budget_profile,
         entitlement_snapshot_at = case
           when r.acceptance_state = 'pending' then clock_timestamp()
           else r.entitlement_snapshot_at
         end,
         updated_at = clock_timestamp()
   where r.id = p_run_id
     and r.status = 'running'
     and r.lease_owner = p_lease_owner
     and r.lease_expires_at > clock_timestamp()
     and (
       r.acceptance_state = 'pending'
       or (r.entitlement_tier = p_entitlement_tier
         and r.budget_profile = p_budget_profile)
     );
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.set_investigation_run_policy(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_investigation_run_policy(uuid, uuid, text, jsonb)
  to service_role;

-- An accepted run must carry the versioned policy shape and explicit cost
-- decision. This prevents a
-- manually inserted/legacy row from being dispatched with an unknown budget.
drop function if exists public.mark_investigation_run_enqueued(uuid, uuid);
create or replace function public.mark_investigation_run_enqueued(
  p_run_id uuid,
  p_lease_owner uuid,
  -- The pre-policy two-argument caller is intentionally removed. An accepted
  -- run must carry an explicit cost decision; legacy_bypassed is retained
  -- only for backfilled rows and is not a valid new input.
  p_cost_guard_state text
)
returns table(marked boolean, accepted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_accepted_at timestamptz;
begin
  if p_run_id is null or p_lease_owner is null
     or p_cost_guard_state not in (
       'reserved', 'mock_bypassed', 'disabled_bypassed'
     ) then
    raise exception 'invalid investigation run acceptance' using errcode = '22023';
  end if;

  update public.investigation_runs as r
     set acceptance_state = 'accepted',
         cost_guard_state = p_cost_guard_state,
         accepted_at = coalesce(r.accepted_at, clock_timestamp()),
         updated_at = clock_timestamp()
   where r.id = p_run_id
     and r.status = 'running'
     and r.lease_owner = p_lease_owner
     and r.lease_expires_at > clock_timestamp()
     and r.entitlement_tier in ('free', 'plus')
     and r.budget_profile ->> 'version' = 'v1'
     and r.budget_profile ->> 'tier' = r.entitlement_tier
     and r.budget_profile ->> 'finalCandidateLimit' = '3'
     and (
       (
         p_cost_guard_state = 'reserved'
         and r.provider_usage_id is not null
         and exists (
           select 1
             from public.provider_usage as pu
            where pu.id = r.provider_usage_id
              and pu.investigation_run_id = r.id
              and pu.investigation_id = r.investigation_id
              and pu.action = 'run'
              and pu.status = 'reserved'
         )
       )
       or (p_cost_guard_state <> 'reserved' and r.provider_usage_id is null)
     )
  returning r.accepted_at into v_accepted_at;
  get diagnostics v_count = row_count;
  return query select v_count = 1, v_accepted_at;
end;
$$;

revoke all on function public.mark_investigation_run_enqueued(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_investigation_run_enqueued(uuid, uuid, text)
  to service_role;
