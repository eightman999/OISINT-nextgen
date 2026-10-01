-- =============================================================================
-- 092_research_entitlement_policy.sql — #554 entitlement-aware run policy
--
-- The edge handler receives only an authenticated permanent UUID. This test
-- exercises the service-only resolver, policy snapshot pinning, cost decision
-- states, and the accepted-run retry boundary against the applied migrations.
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000921', false),
  ('00000000-0000-0000-0000-000000000922', false),
  ('00000000-0000-0000-0000-000000000923', true),
  ('00000000-0000-0000-0000-000000000928', false),
  ('00000000-0000-0000-0000-000000000929', false),
  ('00000000-0000-0000-0000-000000000930', false);

insert into public.user_entitlements (
  user_id, entitlement_id, offering_id, product_id, app_user_id,
  is_active, lifecycle_state, expires_at, last_event_id,
  last_event_timestamp_ms
)
values (
  '00000000-0000-0000-0000-000000000921', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-0000-0000-000000000921',
  true, 'active', clock_timestamp() + interval '1 hour', 'rls092-plus', 1
), (
  '00000000-0000-0000-0000-000000000922', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-0000-0000-000000000922',
  true, 'expired', clock_timestamp() - interval '1 hour', 'rls092-expired', 2
), (
  '00000000-0000-0000-0000-000000000923', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-0000-0000-000000000923',
  true, 'active', clock_timestamp() + interval '1 hour', 'rls092-anonymous-plus', 3
), (
  '00000000-0000-0000-0000-000000000929', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-0000-0000-000000000929',
  true, 'active', null, 'rls092-no-expiry', 4
);

insert into public.investigations (id, created_by, title, raw_query)
values
  ('00000000-0000-0000-0000-000000000924',
   '00000000-0000-0000-0000-000000000921',
   '092 Plus policy fixture', 'policy fixture plus'),
  ('00000000-0000-0000-0000-000000000925',
   '00000000-0000-0000-0000-000000000921',
   '092 reserved policy fixture', 'policy fixture reservation');

do $$
declare
  v_plus jsonb;
  v_expired jsonb;
  v_anonymous jsonb;
  v_unknown jsonb;
begin
  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000921'
  ) into v_plus;
  if v_plus ->> 'tier' <> 'plus'
     or v_plus ->> 'entitlement_id' <> 'plus'
     or v_plus ->> 'offering_id' <> 'default' then
    raise exception 'FAIL(092/plus-resolver): active Plus was not resolved: %', v_plus;
  end if;

  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000922'
  ) into v_expired;
  if v_expired ->> 'tier' <> 'free' then
    raise exception 'FAIL(092/expired): expired entitlement was not Free: %', v_expired;
  end if;

  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000923'
  ) into v_anonymous;
  if v_anonymous ->> 'tier' <> 'free' then
    raise exception 'FAIL(092/anonymous): anonymous user was not Free: %', v_anonymous;
  end if;

  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000929'
  ) into v_unknown;
  if v_unknown ->> 'tier' <> 'free' then
    raise exception 'FAIL(092/no-expiry): null expiry was granted Plus: %', v_unknown;
  end if;
  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000930'
  ) into v_unknown;
  if v_unknown ->> 'tier' <> 'free' then
    raise exception 'FAIL(092/unknown): missing entitlement was not Free: %', v_unknown;
  end if;

  -- Entitlement changes affect only a future run snapshot: Free upgrades to
  -- Plus when the verified server row becomes active, and downgrades back to
  -- Free after expiry. No client-declared tier is involved.
  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000928'
  ) into v_unknown;
  if v_unknown ->> 'tier' <> 'free' then
    raise exception 'FAIL(092/upgrade-free): missing entitlement was not Free: %', v_unknown;
  end if;
  insert into public.user_entitlements (
    user_id, entitlement_id, offering_id, product_id, app_user_id,
    is_active, lifecycle_state, expires_at, last_event_id,
    last_event_timestamp_ms
  ) values (
    '00000000-0000-0000-0000-000000000928', 'plus', 'default',
    'oisint_plus_monthly', '00000000-0000-0000-0000-000000000928',
    true, 'active', clock_timestamp() + interval '1 hour', 'rls092-upgrade', 4
  );
  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000928'
  ) into v_unknown;
  if v_unknown ->> 'tier' <> 'plus' then
    raise exception 'FAIL(092/upgrade-plus): active entitlement was not Plus: %', v_unknown;
  end if;
  update public.user_entitlements
     set is_active = false,
         lifecycle_state = 'expired',
         expires_at = clock_timestamp() - interval '1 second'
   where user_id = '00000000-0000-0000-0000-000000000928';
  select public.resolve_entitlement_for_user(
    '00000000-0000-0000-0000-000000000928'
  ) into v_unknown;
  if v_unknown ->> 'tier' <> 'free' then
    raise exception 'FAIL(092/downgrade-free): expired entitlement was not Free: %', v_unknown;
  end if;
end $$;

-- No client role can call the server resolver or mutate a run policy.
set local role authenticated;
do $$
begin
  if has_function_privilege(
       'authenticated',
       'public.resolve_entitlement_for_user(uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.set_investigation_run_policy(uuid,uuid,text,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.mark_investigation_run_enqueued(uuid,uuid,text)',
       'EXECUTE'
     ) then
    raise exception 'FAIL(092/acl): authenticated can execute server policy RPC';
  end if;
end $$;
rollback;

begin;
insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000921', false);

insert into public.user_entitlements (
  user_id, entitlement_id, offering_id, product_id, app_user_id,
  is_active, lifecycle_state, expires_at, last_event_id,
  last_event_timestamp_ms
)
values (
  '00000000-0000-0000-0000-000000000921', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-0000-0000-000000000921',
  true, 'active', clock_timestamp() + interval '1 hour', 'rls092-plus-2', 3
);

insert into public.investigations (id, created_by, title, raw_query)
values
  ('00000000-0000-0000-0000-000000000924',
   '00000000-0000-0000-0000-000000000921',
   '092 Plus policy fixture', 'policy fixture plus'),
  ('00000000-0000-0000-0000-000000000925',
   '00000000-0000-0000-0000-000000000921',
   '092 reserved policy fixture', 'policy fixture reservation');

set local role service_role;

do $$
declare
  v_investigation uuid := '00000000-0000-0000-0000-000000000924';
  v_owner uuid := '00000000-0000-0000-0000-000000000921';
  v_other_owner uuid := '00000000-0000-0000-0000-000000000926';
  v_run uuid;
  v_claim record;
  v_configured boolean;
  v_marked boolean;
  v_snapshot_at timestamptz;
  -- Test-only explicit price. Production Plus pricing is resolved from the
  -- server environment; this fixture must not become a tier multiplier.
  v_profile jsonb := jsonb_build_object(
    'version', 'v1',
    'tier', 'plus',
    'finalCandidateLimit', 3,
    'broadCandidateLimit', 12,
    'preRankCandidateLimit', 8,
    'researchCandidateLimit', 6,
    'providerCallLimit', 6,
    'estimatedCostMicros', 70000
  );
begin
  select * into v_claim
    from public.claim_investigation_run(
      v_investigation, v_owner, 180,
      '00000000-0000-0000-0000-000000000927', false
    );
  if not v_claim.acquired or v_claim.run_id is null or v_claim.accepted then
    raise exception 'FAIL(092/claim): expected pending run claim';
  end if;
  v_run := v_claim.run_id;

  select configured into v_configured
    from public.set_investigation_run_policy(
      v_run, v_owner, 'plus', v_profile
    );
  if not v_configured then
    raise exception 'FAIL(092/policy-set): Plus policy was not pinned';
  end if;
  begin
    perform public.set_investigation_run_policy(
      v_run, v_owner, 'plus',
      jsonb_set(v_profile, '{unexpected}', '"service-secret"'::jsonb)
    );
    raise exception 'FAIL(092/policy-keys): unexpected budget key was persisted';
  exception when others then
    if sqlerrm like 'FAIL(092/policy-keys)%' then raise; end if;
  end;
  if (select entitlement_tier from public.investigation_runs where id = v_run) <> 'plus'
     or (select budget_profile from public.investigation_runs where id = v_run) <> v_profile
     or (select budget_profile ->> 'finalCandidateLimit'
         from public.investigation_runs where id = v_run) <> '3' then
    raise exception 'FAIL(092/policy-snapshot): persisted Plus snapshot changed';
  end if;

  select marked into v_marked
    from public.mark_investigation_run_enqueued(v_run, v_owner, 'mock_bypassed');
  if not v_marked then
    raise exception 'FAIL(092/mock-accept): mock bypass was not accepted';
  end if;
  if (select acceptance_state from public.investigation_runs where id = v_run) <> 'accepted'
     or (select cost_guard_state from public.investigation_runs where id = v_run) <> 'mock_bypassed'
     or (select provider_usage_id from public.investigation_runs where id = v_run) is not null then
    raise exception 'FAIL(092/mock-state): nullable usage was mistaken for missing acceptance';
  end if;
  begin
    perform public.mark_investigation_run_enqueued(v_run, v_owner);
    raise exception 'FAIL(092/legacy-mark): two-argument acceptance unexpectedly succeeded';
  exception when undefined_function then
    null;
  end;
  select entitlement_snapshot_at into v_snapshot_at
    from public.investigation_runs where id = v_run;
  select configured into v_configured
    from public.set_investigation_run_policy(v_run, v_owner, 'plus', v_profile);
  if not v_configured
     or (select entitlement_snapshot_at from public.investigation_runs where id = v_run)
       is distinct from v_snapshot_at then
    raise exception 'FAIL(092/snapshot-time): accepted snapshot timestamp changed';
  end if;

  -- An accepted snapshot cannot be downgraded by changing the entitlement row.
  update public.user_entitlements
     set is_active = false, lifecycle_state = 'expired', expires_at = clock_timestamp() - interval '1 second'
   where user_id = v_owner;
  select configured into v_configured
    from public.set_investigation_run_policy(
      v_run, v_owner, 'free', jsonb_build_object(
        'version', 'v1', 'tier', 'free', 'finalCandidateLimit', 3,
        'broadCandidateLimit', 3, 'preRankCandidateLimit', 3,
        'researchCandidateLimit', 3, 'providerCallLimit', 3,
        'estimatedCostMicros', 70000
      )
    );
  if v_configured
     or (select entitlement_tier from public.investigation_runs where id = v_run) <> 'plus' then
    raise exception 'FAIL(092/snapshot-immutability): accepted Plus run was downgraded';
  end if;

  -- Duplicate claim converges to the same accepted run and never creates a new
  -- policy snapshot, even though the current entitlement is now Free.
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_other_owner, 180);
  if v_claim.acquired or v_claim.run_id <> v_run or not v_claim.accepted then
    raise exception 'FAIL(092/duplicate): accepted run did not converge';
  end if;
  if (select count(*) from public.investigation_runs where investigation_id = v_investigation) <> 1
     or (select budget_profile ->> 'tier' from public.investigation_runs where id = v_run) <> 'plus' then
    raise exception 'FAIL(092/duplicate-snapshot): duplicate changed run policy';
  end if;
end $$;

do $$
declare
  v_investigation uuid := '00000000-0000-0000-0000-000000000925';
  v_owner uuid := '00000000-0000-0000-0000-000000000921';
  v_run uuid;
  v_claim record;
  v_configured boolean;
  v_marked boolean;
  v_linked boolean;
  v_reservation record;
  v_wrong_usage_id bigint;
  -- Test-only explicit price; production does not infer this value.
  v_profile jsonb := jsonb_build_object(
    'version', 'v1', 'tier', 'plus', 'finalCandidateLimit', 3,
    'broadCandidateLimit', 12, 'preRankCandidateLimit', 8,
    'researchCandidateLimit', 6, 'providerCallLimit', 6,
    'estimatedCostMicros', 70000
  );
begin
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner, 180);
  if not v_claim.acquired then
    raise exception 'FAIL(092/reservation-claim): run was not acquired';
  end if;
  v_run := v_claim.run_id;
  select configured into v_configured
    from public.set_investigation_run_policy(v_run, v_owner, 'plus', v_profile);
  if not v_configured then
    raise exception 'FAIL(092/reservation-policy): policy was not pinned';
  end if;

  -- Existing, differently-owned usage ids must not be accepted as this run's
  -- reservation. The fixture is not linked to a run on purpose.
  insert into public.provider_usage (
    investigation_id, action, provider, model, mode, status,
    estimated_cost_microusd
  ) values (
    '00000000-0000-0000-0000-000000000924', 'run', 'fixture',
    'fixture-model', 'mock', 'reserved', 70000
  ) returning id into v_wrong_usage_id;

  begin
    perform public.reserve_provider_budget_for_run(
      'run', '00000000-0000-0000-0000-000000000924', v_run,
      'fixture', 'fixture-model', 'mock', 70000, 1000000, 10000000, false
    );
    raise exception 'FAIL(092/reservation-owner): mismatched run/investigation was accepted';
  exception when others then
    if sqlerrm like 'FAIL(092/reservation-owner)%' then raise; end if;
  end;

  select * into v_reservation
    from public.reserve_provider_budget_for_run(
      'run', v_investigation, v_run, 'fixture', 'fixture-model', 'mock',
      70000, 1000000, 10000000, false
    );
  if not v_reservation.is_allowed or v_reservation.usage_id is null then
    raise exception 'FAIL(092/reservation): Plus reservation was denied';
  end if;
  select linked into v_linked
    from public.link_investigation_run_usage(
      v_run, v_owner,
      v_wrong_usage_id
    );
  if v_linked then
    raise exception 'FAIL(092/reservation-wrong-link): another run usage was accepted';
  end if;
  select linked into v_linked
    from public.link_investigation_run_usage(
      v_run, v_owner, v_reservation.usage_id
    );
  if not v_linked then
    raise exception 'FAIL(092/reservation-link): reservation was not linked to run';
  end if;
  select marked into v_marked
    from public.mark_investigation_run_enqueued(v_run, v_owner, 'reserved');
  if not v_marked then
    raise exception 'FAIL(092/reservation-accept): reserved run was not accepted';
  end if;
  if (select cost_guard_state from public.investigation_runs where id = v_run) <> 'reserved'
     or (select provider_usage_id from public.investigation_runs where id = v_run) is null
     or (select estimated_cost_microusd from public.provider_usage where id = v_reservation.usage_id) <> 70000
     or (select count(*) from public.provider_usage where investigation_run_id = v_run and action = 'run') <> 1 then
    raise exception 'FAIL(092/reservation-state): policy cost was not linked exactly once';
  end if;

  select * into v_reservation
    from public.reserve_provider_budget_for_run(
      'run', v_investigation, v_run, 'fixture', 'fixture-model', 'mock',
      70000, 1000000, 10000000, false
    );
  if v_reservation.usage_id is distinct from (
       select provider_usage_id from public.investigation_runs where id = v_run
     )
     or (select count(*) from public.provider_usage where investigation_run_id = v_run and action = 'run') <> 1 then
    raise exception 'FAIL(092/reservation-idempotency): reservation duplicated';
  end if;
end $$;

rollback;

\echo == 092_research_entitlement_policy.sql: all assertions passed
