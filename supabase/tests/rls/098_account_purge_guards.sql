-- =============================================================================
-- 098_account_purge_guards.sql — scoped account purge / fail-partial boundary
--
-- Auth admin deletion is intentionally not called by this SQL fixture.  The
-- service purge is the pre-delete boundary: if the later Auth call fails,
-- admin/Plus/learning access must already be gone, while the external
-- RevenueCat deletion outbox remains retryable.
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000000981', false),
  ('00000000-0000-4000-8000-000000000982', false),
  ('00000000-0000-4000-8000-000000000983', false),
  ('00000000-0000-4000-8000-000000000984', false);

insert into public.places (id, provider, provider_place_id, name)
values
  ('00000000-0000-4000-8000-000000000985', 'fixture', '098-affected', 'Shared 098 affected'),
  ('00000000-0000-4000-8000-000000000986', 'fixture', '098-unrelated', 'Shared 098 unrelated');

-- A/B/C establish a shared fact at both places.  Purging A must remove only
-- the affected fact (2 distinct users remain), not the unrelated place fact.
insert into public.place_feedback (id, place_id, user_id, rating, aspect, aspect_value)
values
  ('00000000-0000-4000-8000-000000000987', '00000000-0000-4000-8000-000000000985', '00000000-0000-4000-8000-000000000981', 1, 'value', 'good'),
  ('00000000-0000-4000-8000-000000000988', '00000000-0000-4000-8000-000000000985', '00000000-0000-4000-8000-000000000982', 1, 'value', 'good'),
  ('00000000-0000-4000-8000-000000000989', '00000000-0000-4000-8000-000000000985', '00000000-0000-4000-8000-000000000983', 1, 'value', 'good'),
  ('00000000-0000-4000-8000-000000000990', '00000000-0000-4000-8000-000000000986', '00000000-0000-4000-8000-000000000982', 1, 'value', 'good'),
  ('00000000-0000-4000-8000-000000000991', '00000000-0000-4000-8000-000000000986', '00000000-0000-4000-8000-000000000983', 1, 'value', 'good'),
  ('00000000-0000-4000-8000-000000000992', '00000000-0000-4000-8000-000000000986', '00000000-0000-4000-8000-000000000984', 1, 'value', 'good');

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000981","role":"service_role"}';

select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000985', 'value'
);
select public.refresh_place_feedback_fact(
  '00000000-0000-4000-8000-000000000986', 'value'
);

insert into public.user_attribute_vectors (
  user_id, attribute_key, embedding, model_version, source_version,
  consent_version, consent_purpose
)
select fixture.user_id, 'quiet',
  ('[' || repeat('1,', 767) || '1]')::public.vector,
  'fixture-098', 'test-098', 'personalization-v2', 'restaurant_recommendations'
from (values
  ('00000000-0000-4000-8000-000000000981'::uuid),
  ('00000000-0000-4000-8000-000000000982'::uuid),
  ('00000000-0000-4000-8000-000000000983'::uuid),
  ('00000000-0000-4000-8000-000000000984'::uuid)
) as fixture(user_id);
select public.refresh_attribute_vector_aggregate('quiet', 'fixture-098', 3);

insert into public.admin_allowlist (user_id, role)
values ('00000000-0000-4000-8000-000000000981', 'operator');
insert into public.user_entitlements (
  user_id, entitlement_id, offering_id, product_id, app_user_id,
  is_active, lifecycle_state, expires_at, last_event_id, last_event_timestamp_ms
) values (
  '00000000-0000-4000-8000-000000000981', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-4000-8000-000000000981', true, 'active',
  '2099-01-01T00:00:00Z', 'evt-098', 1
);
insert into public.preference_signal_receipts (user_id, event_digest, source_kind)
values ('00000000-0000-4000-8000-000000000981', repeat('a', 32), 'feedback');
insert into public.revenuecat_webhook_events (
  event_id, event_type, event_timestamp_ms, user_id, result
) values ('evt-098-webhook', 'RENEWAL', 1,
  '00000000-0000-4000-8000-000000000981', 'applied');
insert into public.revenuecat_customer_deletion_requests (
  user_id, app_user_id, status, external_deleted
) values (
  '00000000-0000-4000-8000-000000000981',
  '00000000-0000-4000-8000-000000000981', 'succeeded', true
);

select public.delete_user_account_data(
  '00000000-0000-4000-8000-000000000981'
);

do $$
begin
  if exists (select 1 from public.admin_allowlist
             where user_id = '00000000-0000-4000-8000-000000000981') then
    raise exception 'FAIL(098/admin): admin access survived local purge';
  end if;
  if exists (select 1 from public.user_entitlements
             where user_id = '00000000-0000-4000-8000-000000000981') then
    raise exception 'FAIL(098/entitlement): Plus access survived local purge';
  end if;
  if exists (select 1 from public.preference_signal_receipts
             where user_id = '00000000-0000-4000-8000-000000000981') then
    raise exception 'FAIL(098/receipt): preference receipt survived local purge';
  end if;
  if exists (select 1 from public.place_feedback
             where user_id = '00000000-0000-4000-8000-000000000981') then
    raise exception 'FAIL(098/feedback): personal feedback survived local purge';
  end if;
  if exists (select 1 from public.place_facts
             where place_id = '00000000-0000-4000-8000-000000000985'
               and key = 'value_for_money') then
    raise exception 'FAIL(098/fact): affected stale fact survived local purge';
  end if;
  if not exists (select 1 from public.place_facts
                 where place_id = '00000000-0000-4000-8000-000000000986'
                   and key = 'value_for_money') then
    raise exception 'FAIL(098/shared): unrelated place fact was removed';
  end if;
  if not exists (select 1 from public.attribute_vector_aggregates
                 where attribute_key = 'quiet' and model_version = 'fixture-098') then
    raise exception 'FAIL(098/vector): unrelated aggregate was removed';
  end if;
  if (select sample_count from public.attribute_vector_aggregates
      where attribute_key = 'quiet' and model_version = 'fixture-098') <> 3 then
    raise exception 'FAIL(098/vector): surviving aggregate was not rebuilt safely';
  end if;
  if (select user_id from public.revenuecat_webhook_events
      where event_id = 'evt-098-webhook') is not null then
    raise exception 'FAIL(098/webhook): webhook subject was not anonymized';
  end if;
  if not exists (select 1 from public.revenuecat_customer_deletion_requests
                 where user_id = '00000000-0000-4000-8000-000000000981'
                   and external_deleted) then
    raise exception 'FAIL(098/outbox): external deletion retry record was lost';
  end if;
end;
$$;

-- Same-transaction retry must recreate temp scope tables and be a no-op.
select public.delete_user_account_data(
  '00000000-0000-4000-8000-000000000981'
);

do $$
begin
  if exists (select 1 from public.admin_allowlist
             where user_id = '00000000-0000-4000-8000-000000000981')
     or exists (select 1 from public.user_entitlements
                where user_id = '00000000-0000-4000-8000-000000000981') then
    raise exception 'FAIL(098/idempotent): access rows reappeared';
  end if;
end;
$$;

rollback;

\echo == 098_account_purge_guards.sql: all assertions passed
