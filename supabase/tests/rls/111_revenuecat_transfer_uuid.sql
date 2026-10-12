-- Isolated database only. Requires the public migrations, including 202610120001.
-- Synthetic identities only; all fixture changes are rolled back.
-- Run with psql -X -v ON_ERROR_STOP=1 -f this-file.sql against a disposable DB.
begin;

create function pg_temp.assert_transfer(ok boolean, message text)
returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception '%', message; end if;
end $$;

insert into auth.users (id, is_anonymous) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', false),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);

create function pg_temp.reset_transfer()
returns void language plpgsql as $$
begin
  delete from public.user_entitlements where user_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  );
  delete from public.revenuecat_webhook_events where event_id like 'fixture-transfer-%';
  insert into public.user_entitlements (
    user_id, app_user_id, product_id, is_active, lifecycle_state,
    expires_at, last_event_id, last_event_timestamp_ms
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'oisint_plus_monthly', true,
    'active', '2099-01-01T00:00:00Z', 'fixture-transfer-initial', 100
  );
end $$;

create function pg_temp.apply_transfer(
  origins text[], destinations text[],
  products text[] default array['oisint_plus_monthly'],
  expiries bigint[] default array[4102444800000::bigint],
  graces bigint[] default array[null::bigint],
  renewals boolean[] default array[true],
  event_id text default 'fixture-transfer-apply',
  event_time bigint default 200
) returns text language sql as $$
  select public.apply_revenuecat_transfer(
    event_id, event_time, 'fixture-app', 'SANDBOX', origins, destinations,
    products, expiries, graces, renewals
  );
$$;

-- Normalization, accepted/rejected identity forms, destination state alignment,
-- and validation must all run before any entitlement or ledger mutation.
do $$
declare
  a text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  b text := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  c text := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  anonymous_id text := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  unknown_id text := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  from_id text;
  to_id text;
  bad_id text;
  result text;
  mode integer;
  variant integer;
  actual_active boolean;
  origin_ids text[];
  destination_ids text[];
  product_ids text[];
  expiry_ids bigint[];
  grace_ids bigint[];
  renewal_ids boolean[];
begin
  -- All nine source/destination case combinations, for both Plus/no-Plus paths.
  foreach from_id in array array[a, upper(a), 'AaAaAaAa-aAaA-4AaA-8aAa-aAaAaAaAaAaA'] loop
    foreach to_id in array array[b, upper(b), 'BbBbBbBb-bBbB-4BbB-8bBb-bBbBbBbBbBbB'] loop
      for mode in 1..2 loop
        perform pg_temp.reset_transfer();
        if mode = 1 then
          result := pg_temp.apply_transfer(array[from_id], array[to_id]);
          perform pg_temp.assert_transfer(result = 'applied_transfer', 'case-normalized apply');
        else
          result := public.revoke_revenuecat_transfer(
            'fixture-transfer-revoke', 200, array[from_id], array[to_id]);
          perform pg_temp.assert_transfer(result = 'transfer_revoked_old_requires_reconciliation', 'case-normalized revoke');
        end if;
        select is_active into actual_active from public.user_entitlements where user_id = a::uuid;
        perform pg_temp.assert_transfer(actual_active = false, 'origin must be revoked');
        perform pg_temp.assert_transfer(
          (select count(*) from public.user_entitlements where user_id = b::uuid and is_active and app_user_id = b) = case when mode = 1 then 1 else 0 end,
          'only verified Plus path grants canonical destination');
        if mode = 1 then
          result := pg_temp.apply_transfer(array[a], array[b]);
        else
          result := public.revoke_revenuecat_transfer('fixture-transfer-revoke', 200, array[a], array[b]);
        end if;
        perform pg_temp.assert_transfer(result = 'ignored_duplicate', 'canonical replay must be duplicate');
      end loop;
    end loop;
  end loop;

  -- Invalid textual aliases, unknown users and anonymous users are skipped.
  foreach bad_id in array array[unknown_id, anonymous_id, '$RCAnonymousID:fixture', 'invalid', null,
    '{' || b || '}', replace(b, '-', ''), ' ' || b] loop
    perform pg_temp.reset_transfer();
    result := pg_temp.apply_transfer(array[bad_id], array[bad_id]);
    perform pg_temp.assert_transfer(result = 'ignored_unknown_transfer_user', 'ineligible subject cannot grant');
    result := public.revoke_revenuecat_transfer('fixture-transfer-unknown', 200, array[bad_id], array[bad_id]);
    perform pg_temp.assert_transfer(result = 'ignored_unknown_transfer_user', 'ineligible subject cannot revoke');
    perform pg_temp.assert_transfer((select is_active from public.user_entitlements where user_id = a::uuid), 'ineligible origin preserved');
  end loop;

  -- Unknown destination cannot grant; the revoke-only RPC may revoke a known source.
  perform pg_temp.reset_transfer();
  result := pg_temp.apply_transfer(array[upper(a)], array[unknown_id]);
  perform pg_temp.assert_transfer(result = 'ignored_unknown_transfer_user', 'no known destination: atomic path rejected');
  perform pg_temp.assert_transfer((select is_active from public.user_entitlements where user_id = a::uuid), 'atomic unknown destination leaves origin');
  result := public.revoke_revenuecat_transfer('fixture-transfer-unknown-to', 200, array[upper(a)], array[unknown_id]);
  perform pg_temp.assert_transfer(result = 'transfer_revoked_old_requires_reconciliation', 'revoke-only known origin with unknown destination');
  perform pg_temp.assert_transfer(not (select is_active from public.user_entitlements where user_id = a::uuid), 'revoke-only origin revoked');

  -- Unknown entries retain their original state-array positions; both real
  -- destinations receive the product, expiry and renewal from their own slot.
  perform pg_temp.reset_transfer();
  result := pg_temp.apply_transfer(
    array['invalid', upper(a), anonymous_id], array[unknown_id, upper(b), anonymous_id, c],
    array[null, 'oisint_plus_annual', null, 'oisint_plus_monthly'],
    array[null::bigint, 4102444800000, null, 4070908800000],
    array[null::bigint, null, null, null], array[null::boolean, false, null, true]);
  perform pg_temp.assert_transfer(result = 'applied_transfer', 'aligned filtered transfer');
  perform pg_temp.assert_transfer((select product_id = 'oisint_plus_annual' and not will_renew and expires_at = to_timestamp(4102444800) from public.user_entitlements where user_id = b::uuid), 'B state alignment');
  perform pg_temp.assert_transfer((select product_id = 'oisint_plus_monthly' and will_renew and expires_at = to_timestamp(4070908800) from public.user_entitlements where user_id = c::uuid), 'C state alignment');
  perform pg_temp.assert_transfer(not exists(select 1 from public.user_entitlements where user_id in (anonymous_id::uuid, unknown_id::uuid)), 'ineligible destinations skipped');

  -- Normalized intersections and duplicates are rejected before any writes.
  for variant in 1..3 loop
    for mode in 1..2 loop
      perform pg_temp.reset_transfer();
      origin_ids := case when variant = 1 then array[a, upper(a)] else array[a] end;
      destination_ids := case when variant = 2 then array[b, upper(b)] when variant = 3 then array[upper(a)] else array[b] end;
      if mode = 1 then
        result := pg_temp.apply_transfer(origin_ids, destination_ids,
          array_fill('oisint_plus_monthly'::text, array[cardinality(destination_ids)]),
          array_fill(4102444800000::bigint, array[cardinality(destination_ids)]),
          array_fill(null::bigint, array[cardinality(destination_ids)]),
          array_fill(true, array[cardinality(destination_ids)]));
      else
        result := public.revoke_revenuecat_transfer('fixture-transfer-conflict', 200, origin_ids, destination_ids);
      end if;
      perform pg_temp.assert_transfer(result = 'ignored_invalid_transfer', 'duplicate/intersection rejected');
      perform pg_temp.assert_transfer((select is_active from public.user_entitlements where user_id = a::uuid), 'rejected conflict preserves origin');
      perform pg_temp.assert_transfer(not exists(select 1 from public.revenuecat_webhook_events where event_id like 'fixture-transfer-%'), 'rejected conflict creates no ledger');
    end loop;
  end loop;

  -- Reject malformed array shapes/lengths and unverified product/expiry states.
  for variant in 1..30 loop
    perform pg_temp.reset_transfer();
    origin_ids := array[a]; destination_ids := array[b]; product_ids := array['oisint_plus_monthly'];
    expiry_ids := array[4102444800000::bigint]; grace_ids := array[null::bigint]; renewal_ids := array[true];
    case variant
      when 1 then origin_ids := null;
      when 2 then destination_ids := array[]::text[];
      when 3 then origin_ids := array[[a]];
      when 4 then destination_ids := array[[b]];
      when 5 then origin_ids := array_fill(a, array[1], array[0]);
      when 6 then destination_ids := array_fill(b, array[1], array[0]);
      when 7 then product_ids := array_fill('oisint_plus_monthly'::text, array[1], array[0]);
      when 8 then expiry_ids := array_fill(4102444800000::bigint, array[1], array[0]);
      when 9 then grace_ids := array_fill(null::bigint, array[1], array[0]);
      when 10 then renewal_ids := array_fill(true, array[1], array[0]);
      when 11 then product_ids := array[['oisint_plus_monthly']];
      when 12 then expiry_ids := array[[4102444800000::bigint]];
      when 13 then grace_ids := array[[null::bigint]];
      when 14 then renewal_ids := array[[true]];
      when 15 then product_ids := array[null::text];
      when 16 then product_ids := array['oisint_plus_unknown'];
      when 17 then expiry_ids := array[null::bigint];
      when 18 then expiry_ids := array[-1::bigint];
      when 19 then expiry_ids := array[4102444800001::bigint];
      when 20 then expiry_ids := array[0::bigint];
      when 21 then product_ids := null;
      when 22 then expiry_ids := array[]::bigint[];
      when 23 then grace_ids := array[null::bigint, null];
      when 24 then renewal_ids := array[]::boolean[];
      when 25 then origin_ids := array_fill(a, array[101]);
      when 26 then destination_ids := array_fill(b, array[101]);
      when 27 then grace_ids := array[-1::bigint];
      when 28 then grace_ids := array[4102444800001::bigint];
      when 29 then product_ids := array['oisint_plus_monthly', 'oisint_plus_annual'];
      when 30 then expiry_ids := array[4102444800000::bigint, 4102444800000];
    end case;
    result := pg_temp.apply_transfer(origin_ids, destination_ids, product_ids, expiry_ids, grace_ids, renewal_ids);
    perform pg_temp.assert_transfer(result = 'ignored_invalid_transfer', 'malformed apply variant ' || variant);
    perform pg_temp.assert_transfer((select is_active from public.user_entitlements where user_id = a::uuid), 'malformed apply preserves origin');
    perform pg_temp.assert_transfer(not exists(select 1 from public.revenuecat_webhook_events where event_id like 'fixture-transfer-%'), 'malformed apply creates no ledger');
    if variant <= 6 or variant in (25, 26) then
      result := public.revoke_revenuecat_transfer('fixture-transfer-malformed', 200, origin_ids, destination_ids);
      perform pg_temp.assert_transfer(result = 'ignored_invalid_transfer', 'malformed revoke variant ' || variant);
    end if;
  end loop;

  -- Conflicting state for two case spellings of one destination is ambiguous.
  perform pg_temp.reset_transfer();
  result := pg_temp.apply_transfer(array[a], array[b, upper(b)],
    array['oisint_plus_monthly', 'oisint_plus_annual'],
    array[4102444800000::bigint, 4070908800000], array[null::bigint, null], array[true, false]);
  perform pg_temp.assert_transfer(result = 'ignored_invalid_transfer', 'conflicting duplicate destination rejected');
  perform pg_temp.assert_transfer((select is_active from public.user_entitlements where user_id = a::uuid), 'conflicting destination preserves origin');

  -- A verified future grace window still grants when regular expiry is absent.
  perform pg_temp.reset_transfer();
  result := pg_temp.apply_transfer(array[upper(a)], array[upper(b)],
    expiries => array[null::bigint], graces => array[4102444800000::bigint]);
  perform pg_temp.assert_transfer(result = 'applied_transfer', 'grace-only transfer accepted');
  perform pg_temp.assert_transfer((select is_active and lifecycle_state = 'grace' and expires_at is null from public.user_entitlements where user_id = b::uuid), 'future grace state preserved');

  -- A historical ledger entry is not repaired merely by changing UUID casing.
  perform pg_temp.reset_transfer();
  insert into public.revenuecat_webhook_events(event_id, event_type, event_timestamp_ms, result)
    values ('fixture-transfer-apply', 'TRANSFER', 200, 'applied_transfer');
  result := pg_temp.apply_transfer(array[a], array[b]);
  perform pg_temp.assert_transfer(result = 'ignored_duplicate', 'historical processed event remains duplicate');
  perform pg_temp.assert_transfer((select is_active from public.user_entitlements where user_id = a::uuid), 'historical missed revoke requires separate remediation');

  -- An invalid later destination must never partially revoke or grant.
  perform pg_temp.reset_transfer();
  result := pg_temp.apply_transfer(array[upper(a)], array[upper(b), upper(c)],
    array['oisint_plus_annual', null], array[4102444800000::bigint, 4102444800000],
    array[null::bigint, null], array[true, true]);
  perform pg_temp.assert_transfer(result = 'ignored_invalid_transfer', 'invalid later destination rejected');
  perform pg_temp.assert_transfer((select count(*) = 1 and bool_and(is_active) from public.user_entitlements where user_id in (a::uuid, b::uuid, c::uuid)), 'no partial state changes');

  -- Existing per-subject ordering is preserved, including equal timestamps.
  for variant in 99..100 loop
    for mode in 1..2 loop
      perform pg_temp.reset_transfer();
      insert into public.user_entitlements(user_id, app_user_id, last_event_id, last_event_timestamp_ms)
        values (b::uuid, b, 'fixture-transfer-newer', 100);
      if mode = 1 then
        result := pg_temp.apply_transfer(array[upper(a)], array[upper(b)], event_time => variant);
        perform pg_temp.assert_transfer(result = 'applied_transfer', 'stale transfer retains existing result contract');
      else
        result := public.revoke_revenuecat_transfer('fixture-transfer-stale', variant, array[upper(a)], array[upper(b)]);
        perform pg_temp.assert_transfer(result = 'transfer_revoked_old_requires_reconciliation', 'stale revoke retains result contract');
      end if;
      perform pg_temp.assert_transfer((select is_active and last_event_timestamp_ms = 100 from public.user_entitlements where user_id = a::uuid), 'stale/equal source not overwritten');
      perform pg_temp.assert_transfer((select not is_active and last_event_timestamp_ms = 100 from public.user_entitlements where user_id = b::uuid), 'stale/equal destination not overwritten');
    end loop;
  end loop;
end $$;

-- CREATE OR REPLACE must retain the service-only privilege boundary.
select pg_temp.assert_transfer(
  has_function_privilege('service_role', 'public.revoke_revenuecat_transfer(text,bigint,text[],text[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.revoke_revenuecat_transfer(text,bigint,text[],text[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.revoke_revenuecat_transfer(text,bigint,text[],text[])', 'EXECUTE'),
  'revoke RPC service-only privileges');
select pg_temp.assert_transfer(
  has_function_privilege('service_role', 'public.apply_revenuecat_transfer(text,bigint,text,text,text[],text[],text[],bigint[],bigint[],boolean[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.apply_revenuecat_transfer(text,bigint,text,text,text[],text[],text[],bigint[],bigint[],boolean[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.apply_revenuecat_transfer(text,bigint,text,text,text[],text[],text[],bigint[],bigint[],boolean[])', 'EXECUTE'),
  'apply RPC service-only privileges');
rollback;
