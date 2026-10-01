-- 202608240002: RevenueCat の Plus entitlement 正本 (#571)
--
-- 境界:
--   * Free / Plus の2層だけを保存する。Pro、trial、coupon はこの契約に含めない。
--   * RevenueCat app_user_id は Supabase の恒久 user id (UUID) と完全一致させる。
--   * ブラウザ/モバイル client は自身の行を読むだけで、書き込みは webhook の
--     service_role RPC に限定する。
--   * webhook の生 payload、aliases、subscriber_attributes は保存しない。

create table public.user_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  entitlement_id text not null default 'plus'
    check (entitlement_id = 'plus'),
  offering_id text not null default 'default'
    check (offering_id = 'default'),
  product_id text
    check (product_id is null or product_id in ('oisint_plus_monthly', 'oisint_plus_annual')),
  app_user_id text not null,
  store text,
  environment text,
  is_active boolean not null default false,
  lifecycle_state text not null default 'free'
    check (lifecycle_state in ('free', 'active', 'canceled', 'grace', 'billing_issue', 'expired')),
  expires_at timestamptz,
  will_renew boolean,
  grace_period_expires_at timestamptz,
  last_event_id text not null,
  last_event_timestamp_ms bigint not null check (last_event_timestamp_ms >= 0),
  updated_at timestamptz not null default now(),
  constraint user_entitlements_app_user_id_is_subject
    check (app_user_id = user_id::text),
  constraint user_entitlements_event_id_nonempty
    check (length(last_event_id) between 1 and 256)
);

comment on table public.user_entitlements is
  'Server-resolved RevenueCat plus entitlement. Client writes are forbidden.';
comment on column public.user_entitlements.app_user_id is
  'Must equal user_id::text; RevenueCat aliases are not accepted as ownership.';

create table public.revenuecat_webhook_events (
  event_id text primary key check (length(event_id) between 1 and 256),
  event_type text not null,
  event_timestamp_ms bigint not null check (event_timestamp_ms >= 0),
  user_id uuid references auth.users(id) on delete set null,
  app_id text,
  environment text,
  result text not null,
  received_at timestamptz not null default now()
);

comment on table public.revenuecat_webhook_events is
  'Redacted webhook idempotency ledger; no RevenueCat raw payload or personal attributes.';

alter table public.user_entitlements enable row level security;
alter table public.revenuecat_webhook_events enable row level security;

revoke all on public.user_entitlements from anon, authenticated;
revoke all on public.revenuecat_webhook_events from anon, authenticated;
grant select on public.user_entitlements to authenticated;
grant all on public.user_entitlements to service_role;
grant all on public.revenuecat_webhook_events to service_role;

-- Auth削除とRevenueCat外部消去を二相にするための最小outbox。生payload/属性は保存しない。
create table public.revenuecat_customer_deletion_requests (
  user_id uuid primary key,
  app_user_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'local_cleanup_failed')),
  attempts integer not null default 0 check (attempts >= 0),
  -- 外部customer削除済みの事実は、ローカル掃除失敗後も失わない。
  external_deleted boolean not null default false,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint revenuecat_customer_deletion_subject
    check (app_user_id = user_id::text)
);
alter table public.revenuecat_customer_deletion_requests
  add column if not exists external_deleted boolean not null default false;
update public.revenuecat_customer_deletion_requests
set external_deleted = true
where status in ('succeeded', 'local_cleanup_failed')
  and external_deleted = false;
alter table public.revenuecat_customer_deletion_requests enable row level security;
revoke all on public.revenuecat_customer_deletion_requests from anon, authenticated;
grant all on public.revenuecat_customer_deletion_requests to service_role;

create policy user_entitlements_select_own on public.user_entitlements
  for select to authenticated
  using (user_id = auth.uid());

-- 明示的に INSERT/UPDATE/DELETE policy を作らない。テーブル権限も revoke 済み。

create or replace function public.enqueue_revenuecat_customer_deletion(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users u
    where u.id = p_user_id and coalesce(u.is_anonymous, false) = false
  ) then
    return 'ignored_unknown_user';
  end if;
  insert into public.revenuecat_customer_deletion_requests (user_id, app_user_id, status, updated_at)
  values (p_user_id, p_user_id::text, 'pending', now())
  on conflict (user_id) do update set
    app_user_id = excluded.app_user_id,
    status = case
      when public.revenuecat_customer_deletion_requests.external_deleted
        or public.revenuecat_customer_deletion_requests.status = 'succeeded'
        then 'succeeded'
      else 'pending'
    end,
    external_deleted = public.revenuecat_customer_deletion_requests.external_deleted,
    updated_at = now();
  select status into v_status
    from public.revenuecat_customer_deletion_requests
    where user_id = p_user_id;
  return case when v_status = 'succeeded' then 'succeeded' else 'pending' end;
end;
$$;
revoke all on function public.enqueue_revenuecat_customer_deletion(uuid) from public;
grant execute on function public.enqueue_revenuecat_customer_deletion(uuid) to service_role;

-- 外部customer消去とローカル掃除の各試行を、service_roleだけが原子的に記録する。
-- finalize前の失敗ではoutbox行を残し、同じsubjectの削除要求を再試行できる。
create or replace function public.record_revenuecat_customer_deletion(
  p_user_id uuid,
  p_status text,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  if p_user_id is null
     or p_status not in ('succeeded', 'failed', 'local_cleanup_failed')
     or (p_error_code is not null
       and p_error_code !~ '^[A-Za-z0-9_.-]{1,128}$') then
    return 'ignored_invalid_request';
  end if;
  update public.revenuecat_customer_deletion_requests
  set status = case
        when p_status = 'local_cleanup_failed' and external_deleted then 'local_cleanup_failed'
        else p_status
      end,
      external_deleted = external_deleted or p_status in ('succeeded', 'local_cleanup_failed'),
      attempts = attempts + 1,
      last_error_code = case when p_status = 'succeeded' then null else p_error_code end,
      updated_at = now()
  where user_id = p_user_id;
  get diagnostics updated = row_count;
  if updated = 0 then
    return 'ignored_unknown_user';
  end if;
  return 'recorded';
end;
$$;
revoke all on function public.record_revenuecat_customer_deletion(uuid, text, text) from public;
grant execute on function public.record_revenuecat_customer_deletion(uuid, text, text) to service_role;

-- 外部customer消去とlocal purgeが成功したsubjectのoutboxを最終化する。
-- Auth削除より前に呼び、失敗時はAuthを残して同じJWTで再試行できるようにする。
-- 成功時だけcanonical UUID/RC App User IDをDBから消す。
create or replace function public.finalize_revenuecat_customer_deletion(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then
    return 'ignored_invalid_request';
  end if;
  delete from public.revenuecat_customer_deletion_requests
   where user_id = p_user_id
     and external_deleted = true;
  get diagnostics deleted = row_count;
  return case when deleted = 1 then 'finalized' else 'ignored_unknown_user' end;
end;
$$;
revoke all on function public.finalize_revenuecat_customer_deletion(uuid) from public, anon, authenticated;
grant execute on function public.finalize_revenuecat_customer_deletion(uuid) to service_role;

-- Plus access is a derived, fail-closed decision.  A row may remain in the
-- database for audit/reconciliation even when it is malformed or stale, but
-- it must never be treated as access without a permanent auth subject, the
-- canonical App User ID, a known product, and a finite future expiry or an
-- explicitly recorded future grace window.
create or replace function public.revenuecat_entitlement_access_allowed(
  p_user_id uuid,
  p_app_user_id text,
  p_is_active boolean,
  p_lifecycle_state text,
  p_product_id text,
  p_expires_at timestamptz,
  p_grace_period_expires_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    p_user_id is not null
    and p_app_user_id = p_user_id::text
    and exists (
      select 1
        from auth.users u
       where u.id = p_user_id
         and coalesce(u.is_anonymous, false) = false
    )
    and p_is_active
    and p_product_id in ('oisint_plus_monthly', 'oisint_plus_annual')
    and p_lifecycle_state in ('active', 'canceled', 'grace', 'billing_issue')
    and (
      (p_expires_at is not null and p_expires_at > now())
      or (
        p_grace_period_expires_at is not null
        and p_grace_period_expires_at > now()
      )
    ),
    false
  );
$$;

revoke all on function public.revenuecat_entitlement_access_allowed(
  uuid, text, boolean, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.revenuecat_entitlement_access_allowed(
  uuid, text, boolean, text, text, timestamptz, timestamptz
) to service_role;

create or replace function public.get_my_entitlement()
returns table (
  user_id uuid,
  entitlement_id text,
  offering_id text,
  product_id text,
  app_user_id text,
  store text,
  environment text,
  is_active boolean,
  lifecycle_state text,
  expires_at timestamptz,
  will_renew boolean,
  grace_period_expires_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.user_id,
    e.entitlement_id,
    e.offering_id,
    e.product_id,
    e.app_user_id,
    e.store,
    e.environment,
    e.is_active,
    e.lifecycle_state,
    e.expires_at,
    e.will_renew,
    e.grace_period_expires_at,
    e.updated_at
  from public.user_entitlements e
  where e.user_id = auth.uid()
    and e.app_user_id = e.user_id::text
    and exists (
      select 1 from auth.users u
       where u.id = auth.uid()
         and coalesce(u.is_anonymous, false) = false
    )
  union all
  -- 不適格subject（匿名を含む）や不正app_user_id行が残っていても、
  -- native/webのRPC shapeを壊さず、常に明示的なFree 1行へ倒す。
  select
    auth.uid(), 'plus', 'default', null, auth.uid()::text, null, null,
    false, 'free', null, false, null, null
  where auth.uid() is not null
    and not exists (
      select 1
        from public.user_entitlements e
       where e.user_id = auth.uid()
         and e.app_user_id = e.user_id::text
         and exists (
           select 1 from auth.users u
            where u.id = auth.uid()
              and coalesce(u.is_anonymous, false) = false
         )
    );
$$;

revoke all on function public.get_my_entitlement() from public;
grant execute on function public.get_my_entitlement() to authenticated;

create or replace function public.resolve_current_entitlement()
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
  from (
    select *
      from public.user_entitlements
     where user_id = auth.uid()
       and app_user_id = user_id::text
       and exists (
         select 1 from auth.users u
          where u.id = auth.uid()
            and coalesce(u.is_anonymous, false) = false
       )
  ) e
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
  where auth.uid() is not null
    and not exists (
      select 1
        from public.user_entitlements e
       where e.user_id = auth.uid()
         and e.app_user_id = e.user_id::text
         and exists (
           select 1 from auth.users u
            where u.id = auth.uid()
              and coalesce(u.is_anonymous, false) = false
         )
    )
  limit 1;
$$;

revoke all on function public.resolve_current_entitlement() from public;
grant execute on function public.resolve_current_entitlement() to authenticated;
grant execute on function public.resolve_current_entitlement() to service_role;

create or replace function public.is_plus_for_user(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  row public.user_entitlements%rowtype;
begin
  -- EXECUTE は service_role にだけ付与する。認証済み client が UUID を差し替えて
  -- 他人の状態を照会できる経路を作らない。
  if p_user_id is null then
    return false;
  end if;
  select * into row from public.user_entitlements where user_id = p_user_id;
  return public.revenuecat_entitlement_access_allowed(
    row.user_id,
    row.app_user_id,
    row.is_active,
    row.lifecycle_state,
    row.product_id,
    row.expires_at,
    row.grace_period_expires_at
  );
end;
$$;

revoke all on function public.is_plus_for_user(uuid) from public;
grant execute on function public.is_plus_for_user(uuid) to service_role;

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
    if raw_id <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    if not (subject = any(from_ids)) then
      from_ids := array_append(from_ids, subject);
    end if;
  end loop;
  foreach raw_id in array coalesce(p_transferred_to, array[]::text[]) loop
    begin
      subject := raw_id::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if raw_id <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    if not (subject = any(to_ids)) then
      to_ids := array_append(to_ids, subject);
    end if;
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
     or coalesce(array_length(p_transferred_from, 1), 0) = 0
     or coalesce(array_length(p_transferred_to, 1), 0) = 0
     or coalesce(array_length(p_transferred_from, 1), 0) > 100
     or coalesce(array_length(p_transferred_to, 1), 0) > 100
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
    if raw_id = subject::text and exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) and not (subject = any(from_ids)) then
      from_ids := array_append(from_ids, subject);
    end if;
  end loop;
  foreach raw_id in array p_transferred_to loop
    begin
      subject := raw_id::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    if raw_id = subject::text and exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) and not (subject = any(to_ids)) then
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
    if p_transferred_to[i] <> subject::text or not exists (
      select 1 from auth.users u
      where u.id = subject and coalesce(u.is_anonymous, false) = false
    ) then
      continue;
    end if;
    if p_product_ids[i] not in ('oisint_plus_monthly', 'oisint_plus_annual')
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
    if p_transferred_to[i] <> subject::text or not exists (
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

  -- UUID でない app_user_id、削除済み/未登録ユーザー、別subjectの alias は grant しない。
  begin
    subject := p_app_user_id::uuid;
  exception when invalid_text_representation then
    return 'ignored_unknown_user';
  end;
  if p_app_user_id <> subject::text
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

  -- 同一subjectの行がまだ無い初回購入でも、異なるevent_idの並行通知が
  -- 時系列を逆転させないよう transaction advisory lock を先に取得する。
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

  -- TEST通知はダッシュボード疎通用であり、Plusをgrantしない。
  if p_event_type = 'TEST' then
    update public.revenuecat_webhook_events
      set result = 'ignored_test_event'
      where event_id = p_event_id;
    return 'ignored_test_event';
  end if;

  -- 未知のイベント、購入redeemなどは 2xx で受領するが、状態を推測して更新しない。
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
