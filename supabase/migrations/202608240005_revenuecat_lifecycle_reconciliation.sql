-- 202608240005: lifecycle webhookの初回通知をSubscriber契約と整合させる (#571)
--
-- CANCELLATION/BILLING_ISSUE/PRODUCT_CHANGE/SUBSCRIPTION_PAUSED が購入通知より
-- 先に届いた場合でも、RevenueCatが署名した将来の有効期限/猶予期限を理由なく
-- Freeへ落とさない。期限・猶予が無い場合は従来どおりgrantせずfail-closedとする。

create or replace function public.apply_revenuecat_webhook_event(
  p_event_id text,
  p_event_type text,
  p_event_timestamp_ms bigint,
  p_app_user_id text,
  p_entitlement_id text,
  p_entitlement_ids text[],
  p_product_id text,
  p_offering_id text,
  p_store text,
  p_environment text,
  p_expiration_at_ms bigint,
  p_grace_period_expiration_at_ms bigint,
  p_will_renew boolean,
  p_app_id text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  subject uuid;
  existing public.user_entitlements%rowtype;
  inserted integer;
  next_active boolean;
  next_state text;
  next_expires_at timestamptz;
  next_grace_expires_at timestamptz;
  next_product_id text;
  has_future_access boolean;
  has_future_event_proof boolean;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 256
     or btrim(p_event_id) = ''
     or p_event_timestamp_ms is null or p_event_timestamp_ms < 0
     or p_event_timestamp_ms > 4102444800000
     or p_app_user_id is null or length(p_app_user_id) not between 1 and 256
     or length(p_event_type) > 80
     or length(p_entitlement_id) > 128
     or length(p_product_id) > 256
     or length(p_offering_id) > 256
     or length(p_store) > 256
     or length(p_environment) > 256
     or length(p_app_id) > 256
     or coalesce(array_length(p_entitlement_ids, 1), 0) > 20
     or exists (
       select 1 from unnest(coalesce(p_entitlement_ids, array[]::text[])) value
       where value is null or length(value) not between 1 and 128
     )
     or p_expiration_at_ms < 0 or p_expiration_at_ms > 4102444800000
     or p_grace_period_expiration_at_ms < 0
     or p_grace_period_expiration_at_ms > 4102444800000 then
    return 'ignored_invalid_event';
  end if;

  begin
    subject := trim(p_app_user_id)::uuid;
  exception when invalid_text_representation then
    return 'ignored_unknown_user';
  end;
  if lower(trim(p_app_user_id)) <> subject::text
     or not exists (
       select 1 from auth.users u
       where u.id = subject and coalesce(u.is_anonymous, false) = false
     ) then
    return 'ignored_unknown_user';
  end if;

  if p_entitlement_id is distinct from 'plus'
     and not ('plus' = any(coalesce(p_entitlement_ids, array[]::text[]))) then
    return 'ignored_non_plus';
  end if;
  if p_product_id is not null
     and p_product_id not in ('oisint_plus_monthly', 'oisint_plus_annual') then
    return 'ignored_unknown_product';
  end if;
  if p_offering_id is not null and p_offering_id <> 'default' then
    return 'ignored_unknown_offering';
  end if;
  if p_event_type is null or length(p_event_type) = 0 then
    return 'ignored_invalid_event';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(subject::text, 0));

  insert into public.revenuecat_webhook_events (
    event_id, event_type, event_timestamp_ms, user_id, app_id, environment, result
  ) values (
    p_event_id, p_event_type, p_event_timestamp_ms, subject, p_app_id, p_environment, 'received'
  ) on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return 'ignored_duplicate';
  end if;

  select * into existing
  from public.user_entitlements
  where user_id = subject
  for update;

  if existing.user_id is not null
     and p_event_timestamp_ms <= existing.last_event_timestamp_ms then
    update public.revenuecat_webhook_events
      set result = 'ignored_stale'
      where event_id = p_event_id;
    return 'ignored_stale';
  end if;

  if p_event_type = 'TEST' then
    update public.revenuecat_webhook_events
      set result = 'ignored_test_event'
      where event_id = p_event_id;
    return 'ignored_test_event';
  end if;

  if p_event_type not in (
    'INITIAL_PURCHASE', 'RENEWAL', 'CANCELLATION', 'EXPIRATION',
    'BILLING_ISSUE', 'PRODUCT_CHANGE', 'SUBSCRIPTION_PAUSED', 'UNCANCELLATION',
    'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED'
  ) then
    update public.revenuecat_webhook_events
      set result = 'ignored_unknown_event'
      where event_id = p_event_id;
    return 'ignored_unknown_event';
  end if;

  next_product_id := coalesce(p_product_id, existing.product_id);
  if next_product_id is null and p_event_type <> 'EXPIRATION' then
    update public.revenuecat_webhook_events
      set result = 'ignored_missing_product'
      where event_id = p_event_id;
    return 'ignored_missing_product';
  end if;
  next_expires_at := case
    when p_expiration_at_ms is null then existing.expires_at
    else to_timestamp(p_expiration_at_ms / 1000.0)
  end;
  next_grace_expires_at := case
    when p_grace_period_expiration_at_ms is null then existing.grace_period_expires_at
    else to_timestamp(p_grace_period_expiration_at_ms / 1000.0)
  end;

  -- A purchase/renewal/product-change event is not proof of access by itself.
  -- If RevenueCat omitted both windows, leave an existing state untouched and
  -- record a safe ignore.  Lifecycle notices may still preserve an already
  -- verified future expiry/grace window; without one they are applied as Free.
  has_future_access :=
    (next_expires_at is not null and next_expires_at > now())
    or (next_grace_expires_at is not null and next_grace_expires_at > now());
  has_future_event_proof :=
    (p_expiration_at_ms is not null
      and to_timestamp(p_expiration_at_ms / 1000.0) > now())
    or (p_grace_period_expiration_at_ms is not null
      and to_timestamp(p_grace_period_expiration_at_ms / 1000.0) > now());
  if p_event_type in (
       'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE',
       'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED'
     ) and not has_future_event_proof
     -- Subscriber API confirmed that the lifecycle is now Free.  The webhook
     -- boundary represents that fact with two explicit past zero timestamps;
     -- this path must not be treated as a purchase proof failure or fall back
     -- to an older row.
     and not (
       p_event_type in ('PRODUCT_CHANGE')
       and p_expiration_at_ms = 0
       and p_grace_period_expiration_at_ms = 0
     ) then
    update public.revenuecat_webhook_events
      set result = 'ignored_missing_expiration'
      where event_id = p_event_id;
    return 'ignored_missing_expiration';
  end if;

  next_active := case
    when p_event_type = 'EXPIRATION' then false
    else has_future_access
  end;
  next_state := case
    when p_event_type = 'EXPIRATION' then 'expired'
    when p_event_type = 'BILLING_ISSUE'
      and next_grace_expires_at is not null
      and next_grace_expires_at > now() then 'grace'
    when p_event_type = 'BILLING_ISSUE' then 'billing_issue'
    when p_event_type in ('CANCELLATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_PAUSED')
      then case when next_active then 'canceled' else 'free' end
    when next_active then 'active'
    else 'free'
  end;

  insert into public.user_entitlements (
    user_id, entitlement_id, offering_id, product_id, app_user_id,
    store, environment, is_active, lifecycle_state, expires_at,
    will_renew, grace_period_expires_at, last_event_id,
    last_event_timestamp_ms, updated_at
  ) values (
    subject, 'plus', 'default', next_product_id, subject::text,
    p_store, p_environment, next_active, next_state, next_expires_at,
    case when p_event_type in ('CANCELLATION', 'EXPIRATION', 'SUBSCRIPTION_PAUSED')
      then false else coalesce(p_will_renew, existing.will_renew, false) end,
    next_grace_expires_at, p_event_id, p_event_timestamp_ms, now()
  )
  on conflict (user_id) do update set
    product_id = excluded.product_id,
    store = excluded.store,
    environment = excluded.environment,
    is_active = excluded.is_active,
    lifecycle_state = excluded.lifecycle_state,
    expires_at = excluded.expires_at,
    will_renew = excluded.will_renew,
    grace_period_expires_at = excluded.grace_period_expires_at,
    last_event_id = excluded.last_event_id,
    last_event_timestamp_ms = excluded.last_event_timestamp_ms,
    updated_at = excluded.updated_at;

  update public.revenuecat_webhook_events
    set result = 'applied'
    where event_id = p_event_id;
  return 'applied';
end;
$$;

revoke all on function public.apply_revenuecat_webhook_event(
  text, text, bigint, text, text, text[], text, text, text, text, bigint, bigint, boolean, text
) from public;
grant execute on function public.apply_revenuecat_webhook_event(
  text, text, bigint, text, text, text[], text, text, text, text, bigint, bigint, boolean, text
) to service_role;
