-- Normalize TRANSFER subjects consistently in both service-only RPCs.
-- Forward-only replacement: do not rewrite the deployed historical migration.
-- Case variants of canonical hyphenated UUIDs identify the same permanent user;
-- other UUID spellings, unknown users and anonymous users remain ineligible.
-- Reject duplicate known subjects after normalization (including conflicting
-- destination states), intersections, and arrays that cannot share 1-based indexes.
-- Existing advisory locks, event ledger and per-subject timestamp guards remain.
-- This does not repair historical processed events; see the remediation document.

create or replace function public.revoke_revenuecat_transfer(
  p_event_id text,
  p_event_timestamp_ms bigint,
  p_transferred_from text[],
  p_transferred_to text[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_id text;
  subject uuid;
  from_ids uuid[] := array[]::uuid[];
  to_ids uuid[] := array[]::uuid[];
  existing public.user_entitlements%rowtype;
  inserted integer;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 256
     or btrim(p_event_id) = ''
     or p_event_timestamp_ms is null or p_event_timestamp_ms < 0
     or p_event_timestamp_ms > 4102444800000
     -- Only ordinary one-dimensional, one-based arrays can share indexes.
     or array_ndims(p_transferred_from) is distinct from 1
     or array_ndims(p_transferred_to) is distinct from 1
     or array_lower(p_transferred_from, 1) is distinct from 1
     or array_lower(p_transferred_to, 1) is distinct from 1
     or coalesce(array_length(p_transferred_from, 1), 0) = 0
     or coalesce(array_length(p_transferred_to, 1), 0) = 0
     or coalesce(array_length(p_transferred_from, 1), 0) > 100
     or coalesce(array_length(p_transferred_to, 1), 0) > 100 then
    return 'ignored_invalid_transfer';
  end if;

  -- RevenueCatのTRANSFER配列は任意App User ID（匿名IDを含む）。
  -- UUIDかつ既存の非匿名auth userだけを採用し、未知/匿名IDはスキップする。
  foreach raw_id in array coalesce(p_transferred_from, array[]::text[]) loop
    begin
      subject := raw_id::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if lower(raw_id) <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    if subject = any(from_ids) then
      return 'ignored_invalid_transfer';
    end if;
    from_ids := array_append(from_ids, subject);
  end loop;
  foreach raw_id in array coalesce(p_transferred_to, array[]::text[]) loop
    begin
      subject := raw_id::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if lower(raw_id) <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    if subject = any(to_ids) then
      return 'ignored_invalid_transfer';
    end if;
    to_ids := array_append(to_ids, subject);
  end loop;
  if coalesce(array_length(from_ids, 1), 0) = 0
     and coalesce(array_length(to_ids, 1), 0) = 0 then
    return 'ignored_unknown_transfer_user';
  end if;
  if from_ids && to_ids then
    return 'ignored_invalid_transfer';
  end if;

  -- 並行transferとlifecycle通知のロック順をsubject UUID順に統一する。
  for subject in select unnest(from_ids || to_ids) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(subject::text, 0));
  end loop;

  insert into public.revenuecat_webhook_events (
    event_id, event_type, event_timestamp_ms, user_id, result
  ) values (
    p_event_id, 'TRANSFER', p_event_timestamp_ms, null, 'received'
  ) on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return 'ignored_duplicate';
  end if;

  foreach subject in array from_ids loop
    select * into existing from public.user_entitlements where user_id = subject for update;
    if existing.user_id is not null and p_event_timestamp_ms > existing.last_event_timestamp_ms then
      update public.user_entitlements
        set is_active = false,
            lifecycle_state = 'expired',
            will_renew = false,
            last_event_id = p_event_id,
            last_event_timestamp_ms = p_event_timestamp_ms,
            updated_at = now()
        where user_id = subject;
    end if;
  end loop;
  update public.revenuecat_webhook_events
    set result = 'transfer_revoked_old_requires_reconciliation'
    where event_id = p_event_id;
  -- destinationはpayloadだけではactive/product/expiryを証明できない。
  -- server-side subscriber照合が成功した後の別RPC適用までFreeのままにする。
  return 'transfer_revoked_old_requires_reconciliation';
end;
$$;

revoke all on function public.revoke_revenuecat_transfer(text, bigint, text[], text[]) from public;
grant execute on function public.revoke_revenuecat_transfer(text, bigint, text[], text[]) to service_role;

-- Subscriber API照合済みのdestination状態と旧subject revokeを同一transactionで適用する。
-- 外部照合失敗時はこのRPCを呼ばないため、旧行を先に消してdestinationだけFreeに
-- 固定する部分成功を作らない。配列中の未知/匿名App User IDは無視する。
create or replace function public.apply_revenuecat_transfer(
  p_event_id text,
  p_event_timestamp_ms bigint,
  p_app_id text,
  p_environment text,
  p_transferred_from text[],
  p_transferred_to text[],
  p_product_ids text[],
  p_expiration_at_ms bigint[],
  p_grace_period_expiration_at_ms bigint[],
  p_will_renew boolean[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_id text;
  subject uuid;
  from_ids uuid[] := array[]::uuid[];
  to_ids uuid[] := array[]::uuid[];
  existing public.user_entitlements%rowtype;
  inserted integer;
  i integer;
  expires_at timestamptz;
  grace_at timestamptz;
  next_state text;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 256
     or btrim(p_event_id) = ''
     or p_event_timestamp_ms is null or p_event_timestamp_ms < 0
     or p_event_timestamp_ms > 4102444800000
     -- Only ordinary one-dimensional, one-based arrays can share indexes.
     or array_ndims(p_transferred_from) is distinct from 1
     or array_ndims(p_transferred_to) is distinct from 1
     or array_lower(p_transferred_from, 1) is distinct from 1
     or array_lower(p_transferred_to, 1) is distinct from 1
     or coalesce(array_length(p_transferred_from, 1), 0) = 0
     or coalesce(array_length(p_transferred_to, 1), 0) = 0
     or coalesce(array_length(p_transferred_from, 1), 0) > 100
     or coalesce(array_length(p_transferred_to, 1), 0) > 100
     or array_ndims(p_product_ids) is distinct from 1
     or array_ndims(p_expiration_at_ms) is distinct from 1
     or array_ndims(p_grace_period_expiration_at_ms) is distinct from 1
     or array_ndims(p_will_renew) is distinct from 1
     or array_lower(p_product_ids, 1) is distinct from 1
     or array_lower(p_expiration_at_ms, 1) is distinct from 1
     or array_lower(p_grace_period_expiration_at_ms, 1) is distinct from 1
     or array_lower(p_will_renew, 1) is distinct from 1
     or coalesce(array_length(p_product_ids, 1), 0) <> coalesce(array_length(p_transferred_to, 1), 0)
     or coalesce(array_length(p_expiration_at_ms, 1), 0) <> coalesce(array_length(p_transferred_to, 1), 0)
     or coalesce(array_length(p_grace_period_expiration_at_ms, 1), 0) <> coalesce(array_length(p_transferred_to, 1), 0)
     or coalesce(array_length(p_will_renew, 1), 0) <> coalesce(array_length(p_transferred_to, 1), 0)
     or exists (
       select 1 from unnest(coalesce(p_expiration_at_ms, array[]::bigint[])) value
       where value < 0 or value > 4102444800000
     )
     or exists (
       select 1 from unnest(coalesce(p_grace_period_expiration_at_ms, array[]::bigint[])) value
       where value < 0 or value > 4102444800000
     ) then
    return 'ignored_invalid_transfer';
  end if;

  foreach raw_id in array p_transferred_from loop
    begin
      subject := raw_id::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if lower(raw_id) = subject::text and exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      if subject = any(from_ids) then
        return 'ignored_invalid_transfer';
      end if;
      from_ids := array_append(from_ids, subject);
    end if;
  end loop;
  foreach raw_id in array p_transferred_to loop
    begin
      subject := raw_id::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if lower(raw_id) = subject::text and exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      if subject = any(to_ids) then
        return 'ignored_invalid_transfer';
      end if;
      to_ids := array_append(to_ids, subject);
    end if;
  end loop;
  if coalesce(array_length(from_ids, 1), 0) = 0
     and coalesce(array_length(to_ids, 1), 0) = 0 then
    return 'ignored_unknown_transfer_user';
  end if;
  -- destinationが1件も既知でない場合は、このatomic RPCから旧subjectを
  -- revokeしない。匿名/未知のみの通知は上の安全なrevoke RPCが扱う。
  if coalesce(array_length(to_ids, 1), 0) = 0 then
    return 'ignored_unknown_transfer_user';
  end if;
  if from_ids && to_ids then
    return 'ignored_invalid_transfer';
  end if;

  -- 旧subjectを変更する前に、既知destinationの全状態を検証する。
  -- 途中のreturnでrevokeだけがcommitされる部分成功を許さない。
  for i in 1..coalesce(array_length(p_transferred_to, 1), 0) loop
    begin
      subject := p_transferred_to[i]::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if lower(p_transferred_to[i]) <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    if p_product_ids[i] is null
       or p_product_ids[i] not in ('oisint_plus_monthly', 'oisint_plus_annual')
       or (p_expiration_at_ms[i] is null
         and p_grace_period_expiration_at_ms[i] is null)
       or (p_expiration_at_ms[i] is not null
         and p_expiration_at_ms[i] < 0)
       or (p_grace_period_expiration_at_ms[i] is not null
         and p_grace_period_expiration_at_ms[i] < 0) then
      return 'ignored_invalid_transfer';
    end if;
    expires_at := case
      when p_expiration_at_ms[i] is null then null
      else to_timestamp(p_expiration_at_ms[i] / 1000.0)
    end;
    grace_at := case
      when p_grace_period_expiration_at_ms[i] is null then null
      else to_timestamp(p_grace_period_expiration_at_ms[i] / 1000.0)
    end;
    if (expires_at is null or expires_at <= now())
       and (grace_at is null or grace_at <= now()) then
      return 'ignored_invalid_transfer';
    end if;
  end loop;

  for subject in select unnest(from_ids || to_ids) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(subject::text, 0));
  end loop;

  insert into public.revenuecat_webhook_events (
    event_id, event_type, event_timestamp_ms, user_id, app_id, environment, result
  ) values (
    p_event_id, 'TRANSFER', p_event_timestamp_ms, null, p_app_id, p_environment, 'received'
  ) on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return 'ignored_duplicate';
  end if;

  foreach subject in array from_ids loop
    select * into existing
    from public.user_entitlements
    where user_id = subject
    for update;
    if existing.user_id is not null
       and p_event_timestamp_ms > existing.last_event_timestamp_ms then
      update public.user_entitlements
        set is_active = false,
            lifecycle_state = 'expired',
            will_renew = false,
            last_event_id = p_event_id,
            last_event_timestamp_ms = p_event_timestamp_ms,
            updated_at = now()
        where user_id = subject;
    end if;
  end loop;

  for i in 1..coalesce(array_length(p_transferred_to, 1), 0) loop
    begin
      subject := p_transferred_to[i]::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if lower(p_transferred_to[i]) <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    expires_at := case
      when p_expiration_at_ms[i] is null then null
      else to_timestamp(p_expiration_at_ms[i] / 1000.0)
    end;
    grace_at := case
      when p_grace_period_expiration_at_ms[i] is null then null
      else to_timestamp(p_grace_period_expiration_at_ms[i] / 1000.0)
    end;
    if (expires_at is null or expires_at <= now())
       and (grace_at is null or grace_at <= now()) then
      return 'ignored_invalid_transfer';
    end if;
    select * into existing
    from public.user_entitlements
    where user_id = subject
    for update;
    if existing.user_id is not null
       and p_event_timestamp_ms <= existing.last_event_timestamp_ms then
      continue;
    end if;
    next_state := case
      when grace_at is not null and grace_at > now()
        and (expires_at is null or expires_at <= now()) then 'grace'
      else 'active'
    end;
    insert into public.user_entitlements (
      user_id, entitlement_id, offering_id, product_id, app_user_id,
      store, environment, is_active, lifecycle_state, expires_at,
      will_renew, grace_period_expires_at, last_event_id,
      last_event_timestamp_ms, updated_at
    ) values (
      subject, 'plus', 'default', p_product_ids[i], subject::text,
      'TRANSFER_RECONCILIATION', p_environment, true, next_state, expires_at,
      coalesce(p_will_renew[i], false), grace_at, p_event_id,
      p_event_timestamp_ms, now()
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
  end loop;

  update public.revenuecat_webhook_events
    set result = 'applied_transfer'
    where event_id = p_event_id;
  return 'applied_transfer';
end;
$$;

revoke all on function public.apply_revenuecat_transfer(
  text, bigint, text, text, text[], text[], text[], bigint[], bigint[], boolean[]
) from public;
grant execute on function public.apply_revenuecat_transfer(
  text, bigint, text, text, text[], text[], text[], bigint[], bigint[], boolean[]
) to service_role;
