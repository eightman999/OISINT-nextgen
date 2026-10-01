-- 202608240014: Plus research widths are server-configured policy (#554/#571)
--
-- 202608240007 intentionally froze both tiers at the P0 three-candidate
-- profile.  This forward migration keeps Free at that baseline while allowing
-- an explicitly configured Plus snapshot to widen discovery/research.  Each
-- stage has an independent bounded value.  The product values are supplied by
-- the Edge Function runtime and are never accepted from a client.

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
  v_broad integer;
  v_prerank integer;
  v_research integer;
  v_provider integer;
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

  -- Free remains the fixed P0 baseline. Plus is deliberately not assigned a
  -- product promise here: the Edge runtime supplies independently configured
  -- bounded values and pins them into this immutable run snapshot.
  -- 100 is the early #554 whole-pipeline safety ceiling only; it is not a
  -- deployed default. Every Plus stage value must still be explicit.
  v_max := case when p_entitlement_tier = 'plus' then 100 else 3 end;
  begin
    v_broad := (p_budget_profile ->> 'broadCandidateLimit')::integer;
    v_prerank := (p_budget_profile ->> 'preRankCandidateLimit')::integer;
    v_research := (p_budget_profile ->> 'researchCandidateLimit')::integer;
    v_provider := (p_budget_profile ->> 'providerCallLimit')::integer;
    if (p_budget_profile ->> 'estimatedCostMicros')::bigint not between 0 and 1000000000 then
      raise exception 'investigation research policy out of bounds';
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'investigation research policy out of bounds' using errcode = '22023';
  end;
  if v_broad not between (case when p_entitlement_tier = 'plus' then 4 else 1 end) and v_max
     or v_prerank not between (case when p_entitlement_tier = 'plus' then 4 else 1 end) and v_max
     or v_research not between (case when p_entitlement_tier = 'plus' then 4 else 1 end) and v_max
     or v_provider not between (case when p_entitlement_tier = 'plus' then 4 else 1 end) and v_max
     or v_broad < v_prerank
     or v_prerank < v_research
     or v_provider < v_research
     or (p_entitlement_tier = 'free' and (
       v_broad <> 3 or v_prerank <> 3 or v_research <> 3 or v_provider <> 3
     )) then
    raise exception 'investigation research policy out of bounds' using errcode = '22023';
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
