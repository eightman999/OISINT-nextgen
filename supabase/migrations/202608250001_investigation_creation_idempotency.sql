-- #592: 同期 create の timeout 再送を同じ investigation へ収束させる。
--
-- この台帳は query/display name を保存せず、ユーザー単位の
-- Idempotency-Key と request digest だけを service_role 経路で保持する。
-- provider/cost reservation より前に claim することで、通常の timeout
-- 再送を in_flight/completed replay へ収束させる。hard-kill で provider
-- 結果が不明なときだけは、旧費用attemptを永続化した上で別attemptとして再開する。

create table public.investigation_creation_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  request_digest text not null,
  investigation_id uuid references public.investigations(id) on delete cascade,
  share_token text,
  -- This is a current-attempt pointer, not ownership. A pre-provider release
  -- may delete the usage and ledger in one transaction, so defer the FK check
  -- until both operations finish. Cascaded ledger deletion never owns or
  -- deletes the operational provider_usage row.
  usage_id bigint references public.provider_usage(id)
    on delete no action deferrable initially deferred,
  lease_generation bigint not null default 1,
  lease_token uuid not null default gen_random_uuid(),
  state text not null default 'in_flight'
    check (state in ('in_flight', 'retryable', 'failed', 'complete')),
  parse_started_at timestamptz,
  parse_checkpoint jsonb,
  parse_completed_at timestamptz,
  embedding_started_at timestamptz,
  embedding_checkpoint real[],
  embedding_completed_at timestamptz,
  failure_code text check (
    failure_code is null or failure_code ~ '^[a-z0-9_]{1,64}$'
  ),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, idempotency_key),
  constraint investigation_creation_requests_key_format
    check (idempotency_key ~ '^[A-Za-z0-9._~-]{1,128}$'),
  constraint investigation_creation_requests_digest_format
    check (request_digest ~ '^[0-9a-f]{64}$'),
  constraint investigation_creation_requests_lease_generation
    check (lease_generation > 0),
  constraint investigation_creation_requests_response_pair
    check ((investigation_id is null and share_token is null)
      or (investigation_id is not null and share_token is not null)),
  constraint investigation_creation_requests_completed_response
    check (completed_at is null
      or (investigation_id is not null and share_token is not null)),
  constraint investigation_creation_requests_state_consistency
    check (
      (state = 'complete') = (completed_at is not null)
      and (state = 'failed') = (failure_code is not null)
    ),
  constraint investigation_creation_requests_parse_checkpoint
    check (
      (parse_checkpoint is null and parse_completed_at is null)
      or (parse_checkpoint is not null and parse_completed_at is not null)
    ),
  constraint investigation_creation_requests_embedding_checkpoint
    check (
      embedding_checkpoint is null or cardinality(embedding_checkpoint) = 768
    )
);

comment on table public.investigation_creation_requests is
  'Service-only synchronous-create ledger. Completed step checkpoints are reused; uncertain provider attempts are fenced and audited separately.';

-- provider_usage はprovider呼出しが始まった後に削除しない。ledgerの
-- current usage から外れたhard-kill attemptもこの表でlogical createへ紐付け、
-- 次の実provider attemptは別usageとして二重計上の過少を防ぐ。
create table public.investigation_creation_usage_attempts (
  user_id uuid not null,
  idempotency_key text not null,
  attempt_no bigint not null check (attempt_no > 0),
  usage_id bigint not null unique references public.provider_usage(id) on delete cascade,
  lease_generation bigint not null,
  lease_token uuid not null,
  last_step text check (last_step is null or last_step in ('parse', 'embedding')),
  state text not null default 'reserved'
    check (state in ('reserved', 'provider_started', 'checkpointed', 'uncertain', 'failed', 'complete')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key, attempt_no),
  foreign key (user_id, idempotency_key)
    references public.investigation_creation_requests(user_id, idempotency_key)
    on delete cascade
);

alter table public.investigation_creation_usage_attempts enable row level security;
revoke all on public.investigation_creation_usage_attempts
  from public, anon, authenticated;
grant all on public.investigation_creation_usage_attempts to service_role;

-- The request/attempt tables contain user/key retry state and therefore
-- cascade with the investigation or Auth user. provider_usage is deliberately
-- not owned by either table: it contains no query/key/user id and remains as a
-- detached operational cost row so deletion cannot reduce daily/monthly SUMs.

alter table public.investigation_creation_requests enable row level security;
revoke all on public.investigation_creation_requests from public, anon, authenticated;
grant all on public.investigation_creation_requests to service_role;

create or replace function public.claim_investigation_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text
)
returns table (
  claim_status text,
  investigation_id uuid,
  share_token text,
  usage_id bigint,
  lease_generation bigint,
  lease_token uuid,
  parse_checkpoint jsonb,
  parse_completed_at timestamptz,
  embedding_checkpoint real[],
  embedding_completed_at timestamptz,
  failure_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digest text;
  v_investigation_id uuid;
  v_share_token text;
  v_usage_id bigint;
  v_completed_at timestamptz;
  v_updated_at timestamptz;
  v_lease_generation bigint;
  v_lease_token uuid := gen_random_uuid();
  v_state text;
  v_parse_started_at timestamptz;
  v_parse_checkpoint jsonb;
  v_parse_completed_at timestamptz;
  v_embedding_started_at timestamptz;
  v_embedding_checkpoint real[];
  v_embedding_completed_at timestamptz;
  v_failure_code text;
  -- Five minutes is the named crash-recovery policy. Normal synchronous create
  -- requests are much shorter; only an abandoned worker may be reclaimed.
  v_stale_after constant interval := interval '5 minutes';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._~-]{1,128}$'
     or p_request_digest is null
     or p_request_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid investigation creation claim' using errcode = '22023';
  end if;

  insert into public.investigation_creation_requests (
    user_id, idempotency_key, request_digest, lease_token
  ) values (
    p_user_id, p_idempotency_key, p_request_digest, v_lease_token
  ) on conflict (user_id, idempotency_key) do nothing;

  if found then
    return query select 'claimed'::text, null::uuid, null::text, null::bigint,
      1::bigint, v_lease_token, null::jsonb, null::timestamptz,
      null::real[], null::timestamptz, null::text;
    return;
  end if;

  select r.request_digest, r.investigation_id, r.share_token, r.usage_id,
         r.completed_at, r.updated_at, r.lease_generation, r.lease_token,
         r.state, r.parse_started_at, r.parse_checkpoint, r.parse_completed_at,
         r.embedding_started_at, r.embedding_checkpoint,
         r.embedding_completed_at, r.failure_code
    into v_digest, v_investigation_id, v_share_token, v_usage_id,
         v_completed_at, v_updated_at, v_lease_generation, v_lease_token,
         v_state, v_parse_started_at, v_parse_checkpoint, v_parse_completed_at,
         v_embedding_started_at, v_embedding_checkpoint,
         v_embedding_completed_at, v_failure_code
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
   for update;

  if v_digest is distinct from p_request_digest then
    return query select 'mismatch'::text, null::uuid, null::text, null::bigint,
      null::bigint, null::uuid, null::jsonb, null::timestamptz,
      null::real[], null::timestamptz, null::text;
  elsif v_state = 'complete' and v_completed_at is not null then
    return query select 'complete'::text, v_investigation_id, v_share_token,
      v_usage_id, null::bigint, null::uuid, null::jsonb, null::timestamptz,
      null::real[], null::timestamptz, null::text;
  elsif v_state = 'failed' then
    return query select 'failed'::text, null::uuid, null::text, v_usage_id,
      null::bigint, null::uuid, null::jsonb, null::timestamptz,
      null::real[], null::timestamptz, v_failure_code;
  elsif v_state = 'retryable'
     or v_updated_at <= clock_timestamp() - v_stale_after then
    -- A hard-killed parse has an unknown provider outcome. Preserve its usage
    -- as an audited attempt, detach it from the current lease, and let the new
    -- invocation reserve a distinct usage before making at most one AI call.
    if v_parse_started_at is not null and v_parse_completed_at is null then
      if v_usage_id is not null then
        update public.investigation_creation_usage_attempts as attempt
           set state = 'uncertain',
               completed_at = clock_timestamp()
         where attempt.user_id = p_user_id
           and attempt.idempotency_key = p_idempotency_key
           and attempt.usage_id = v_usage_id
           and attempt.state = 'provider_started';
        if not found then
          raise exception 'uncertain provider attempt is not auditable'
            using errcode = '40001';
        end if;
      end if;
      update public.investigation_creation_requests
         set usage_id = null,
             parse_started_at = null,
             updated_at = clock_timestamp()
       where user_id = p_user_id and idempotency_key = p_idempotency_key;
      v_usage_id := null;
      v_parse_started_at := null;
    end if;
    -- Embedding is optional. If its response was lost, checkpoint a null result
    -- and continue without issuing a second embedding request.
    if v_embedding_started_at is not null and v_embedding_completed_at is null then
      if v_usage_id is not null then
        update public.investigation_creation_usage_attempts as attempt
           set state = 'uncertain',
               completed_at = clock_timestamp()
         where attempt.user_id = p_user_id
           and attempt.idempotency_key = p_idempotency_key
           and attempt.usage_id = v_usage_id
           and attempt.state = 'provider_started';
        if not found then
          raise exception 'uncertain embedding attempt is not auditable'
            using errcode = '40001';
        end if;
      end if;
      update public.investigation_creation_requests
         set embedding_completed_at = clock_timestamp(),
             embedding_checkpoint = null
       where user_id = p_user_id and idempotency_key = p_idempotency_key;
      v_embedding_completed_at := clock_timestamp();
      v_embedding_checkpoint := null;
    end if;
    update public.investigation_creation_requests as request
       set updated_at = clock_timestamp(),
           state = 'in_flight',
           failure_code = null,
           lease_generation = request.lease_generation + 1,
           lease_token = gen_random_uuid()
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
     returning request.lease_generation, request.lease_token
       into v_lease_generation, v_lease_token;
    return query select 'reclaimed'::text, v_investigation_id, v_share_token,
      v_usage_id, v_lease_generation, v_lease_token,
      v_parse_checkpoint, v_parse_completed_at,
      v_embedding_checkpoint, v_embedding_completed_at, null::text;
  else
    return query select 'in_flight'::text, v_investigation_id, v_share_token,
      v_usage_id, null::bigint, null::uuid, null::jsonb, null::timestamptz,
      null::real[], null::timestamptz, null::text;
  end if;
end;
$$;

revoke all on function public.claim_investigation_creation(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_investigation_creation(uuid, text, text)
  to service_role;

create or replace function public.touch_investigation_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_usage_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digest text;
  v_existing_usage_id bigint;
  v_completed_at timestamptz;
  v_state text;
  v_investigation_id uuid;
  v_usage_mode text;
  v_live_enabled boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_idempotency_key is null or p_request_digest is null
     or p_lease_generation is null or p_lease_token is null
     or p_usage_id is null then
    raise exception 'invalid investigation creation touch' using errcode = '22023';
  end if;

  select r.request_digest, r.usage_id, r.completed_at, r.state,
         r.investigation_id
    into v_digest, v_existing_usage_id, v_completed_at, v_state,
         v_investigation_id
    from public.investigation_creation_requests r
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
   for update;
  if not found or v_digest is distinct from p_request_digest then
    return false;
  end if;
  -- A concurrent finalization won the race. Do not let this worker continue
  -- into provider work after completion; the caller retries and receives replay.
  if v_completed_at is not null or v_state not in ('in_flight', 'retryable') then
    return false;
  end if;
  if p_usage_id is not null
     and v_existing_usage_id is not null
     and v_existing_usage_id is distinct from p_usage_id then
    return false;
  end if;
  if p_usage_id is not null then
    select u.mode into v_usage_mode
      from public.provider_usage u
     where u.id = p_usage_id
       and u.status = 'reserved'
       and u.stop_reason is null
       and u.action = 'create'
       and u.provider = 'gemini'
       and u.investigation_run_id is null
       and (u.investigation_id is null or u.investigation_id = v_investigation_id)
     for update;
    if not found then
      return false;
    end if;
    if v_usage_mode = 'live' then
      select c.enabled into v_live_enabled
        from public.runtime_controls c
       where c.key = 'provider_live'
       for update;
      if not found or not v_live_enabled then
        return false;
      end if;
    end if;
  end if;

  if exists (
    select 1
      from public.investigation_creation_usage_attempts a
      left join public.provider_usage u on u.id = a.usage_id
     where a.user_id = p_user_id
       and a.idempotency_key = p_idempotency_key
       and (
         u.id is null
         or u.status <> 'reserved'
         or u.stop_reason is not null
         or u.action <> 'create'
         or u.provider <> 'gemini'
         or u.investigation_run_id is not null
         or (u.investigation_id is not null
             and u.investigation_id is distinct from v_investigation_id)
       )
  ) then
    return false;
  end if;
  update public.investigation_creation_requests
     set usage_id = coalesce(usage_id, p_usage_id),
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token;
  if not found then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.touch_investigation_creation(
  uuid, text, text, bigint, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.touch_investigation_creation(
  uuid, text, text, bigint, uuid, bigint
)
  to service_role;

-- Cost reservation must be part of the same database transaction as the
-- idempotency ledger update. Calling reserve_provider_budget() from the Edge
-- handler and touching the ledger in a second request leaves a hard-kill gap
-- where a retry could reserve a second provider_usage row.
create or replace function public.reserve_provider_budget_for_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_action text,
  p_investigation_id uuid,
  p_provider text,
  p_model text,
  p_mode text,
  p_estimated_cost_microusd bigint,
  p_daily_limit_microusd bigint,
  p_monthly_limit_microusd bigint,
  p_enforce boolean
)
returns table(
  is_allowed boolean,
  stop_reason text,
  usage_id bigint,
  daily_used_microusd bigint,
  monthly_used_microusd bigint,
  new_alerts smallint[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digest text;
  v_existing_usage_id bigint;
  v_existing_status text;
  v_existing_reason text;
  v_existing_action text;
  v_existing_provider text;
  v_existing_mode text;
  v_existing_investigation_id uuid;
  v_existing_run_id uuid;
  v_ledger_investigation_id uuid;
  v_state text;
  v_completed_at timestamptz;
  v_live_enabled boolean;
  v_deleted integer;
  v_attempt_no bigint;
  v_result record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._~-]{1,128}$'
     or p_request_digest is null
     or p_request_digest !~ '^[0-9a-f]{64}$'
     or p_lease_generation is null
     or p_lease_token is null
     or p_action <> 'create'
     or p_provider <> 'gemini'
     or p_mode not in ('live', 'mock') then
    raise exception 'invalid investigation creation reservation' using errcode = '22023';
  end if;

  select r.request_digest, r.usage_id, r.completed_at, r.investigation_id,
         r.state
    into v_digest, v_existing_usage_id, v_completed_at,
         v_ledger_investigation_id, v_state
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
   for update;
  if not found or v_digest is distinct from p_request_digest then
    raise exception 'investigation creation claim is missing or mismatched'
      using errcode = '40001';
  end if;
  if v_completed_at is not null or v_state <> 'in_flight' then
    raise exception 'investigation creation claim is already complete'
      using errcode = '40001';
  end if;
  if p_investigation_id is distinct from v_ledger_investigation_id then
    raise exception 'investigation creation target is mismatched'
      using errcode = '40001';
  end if;

  if v_existing_usage_id is not null then
    select u.status, u.stop_reason, u.action, u.provider, u.mode,
           u.investigation_id, u.investigation_run_id
      into v_existing_status, v_existing_reason, v_existing_action,
           v_existing_provider, v_existing_mode,
           v_existing_investigation_id, v_existing_run_id
      from public.provider_usage u
     where u.id = v_existing_usage_id
     for update;
    if not found
       or v_existing_status <> 'reserved'
       or v_existing_reason is not null
       or v_existing_action <> 'create'
       or v_existing_provider <> 'gemini'
       or v_existing_mode <> p_mode
       or v_existing_run_id is not null
       or (v_existing_investigation_id is not null
           and v_existing_investigation_id is distinct from v_ledger_investigation_id) then
      raise exception 'provider usage reservation is invalid' using errcode = '40001';
    end if;
    if not exists (
      select 1
        from public.investigation_creation_usage_attempts a
       where a.user_id = p_user_id
         and a.idempotency_key = p_idempotency_key
         and a.usage_id = v_existing_usage_id
    ) then
      raise exception 'provider usage reservation is not linked to its attempt'
        using errcode = '40001';
    end if;
    update public.investigation_creation_usage_attempts
       set lease_generation = p_lease_generation,
           lease_token = p_lease_token
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and usage_id = v_existing_usage_id;
    if p_enforce and v_existing_mode = 'live' then
      select c.enabled into v_live_enabled
        from public.runtime_controls c
       where c.key = 'provider_live'
       for update;
      if not found or not v_live_enabled then
        return query select false, 'kill_switch'::text,
          v_existing_usage_id, 0::bigint, 0::bigint, '{}'::smallint[];
        return;
      end if;
    end if;
    return query select true, null::text,
      v_existing_usage_id, 0::bigint, 0::bigint, '{}'::smallint[];
    return;
  end if;

  select r.* into v_result
    from public.reserve_provider_budget(
      p_action,
      p_investigation_id,
      p_provider,
      p_model,
      p_mode,
      p_estimated_cost_microusd,
      p_daily_limit_microusd,
      p_monthly_limit_microusd,
      p_enforce
    ) r;

  -- A denied decision is not a billable attempt. Remove its usage row inside
  -- this transaction so it can never become an unowned idempotency artifact.
  if not v_result.is_allowed then
    if v_result.usage_id is not null then
      delete from public.provider_usage
       where id = v_result.usage_id
         and status = 'denied'
         and action = 'create';
      get diagnostics v_deleted = row_count;
      if v_deleted <> 1 then
        raise exception 'denied provider usage could not be cleaned up'
          using errcode = '40001';
      end if;
    end if;
    return query select false, v_result.stop_reason, null::bigint,
      v_result.daily_used_microusd, v_result.monthly_used_microusd,
      v_result.new_alerts;
    return;
  end if;

  -- Allowed rows are atomically bound to the logical create before returning.
  if v_result.is_allowed and v_result.usage_id is not null then
    update public.investigation_creation_requests
       set usage_id = v_result.usage_id,
           updated_at = clock_timestamp()
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and request_digest = p_request_digest
       and lease_generation = p_lease_generation
       and lease_token = p_lease_token;
    if not found then
      raise exception 'investigation creation claim disappeared' using errcode = '40001';
    end if;
    select coalesce(max(a.attempt_no), 0) + 1 into v_attempt_no
      from public.investigation_creation_usage_attempts a
     where a.user_id = p_user_id
       and a.idempotency_key = p_idempotency_key;
    insert into public.investigation_creation_usage_attempts (
      user_id, idempotency_key, attempt_no, usage_id,
      lease_generation, lease_token
    ) values (
      p_user_id, p_idempotency_key, v_attempt_no, v_result.usage_id,
      p_lease_generation, p_lease_token
    );
  end if;
  return query select v_result.is_allowed, v_result.stop_reason,
    v_result.usage_id, v_result.daily_used_microusd,
    v_result.monthly_used_microusd, v_result.new_alerts;
end;
$$;

revoke all on function public.reserve_provider_budget_for_creation(
  uuid, text, text, bigint, uuid, text, uuid, text, text, text, bigint, bigint,
  bigint, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_provider_budget_for_creation(
  uuid, text, text, bigint, uuid, text, uuid, text, text, text, bigint, bigint,
  bigint, boolean
) to service_role;

-- A step marker is committed before an external call. If the worker dies after
-- the call but before saving its result, a later claimant sees `uncertain` and
-- never repeats the potentially billable operation.
create or replace function public.begin_investigation_creation_step(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_step text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.investigation_creation_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_step not in ('parse', 'embedding') then
    raise exception 'invalid investigation creation step' using errcode = '22023';
  end if;

  select r.* into v_request
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.request_digest = p_request_digest
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
   for update;
  if not found or v_request.state <> 'in_flight'
     or v_request.completed_at is not null then
    return 'lost';
  end if;

  if p_step = 'parse' then
    if v_request.parse_completed_at is not null then
      return 'complete';
    end if;
    if v_request.parse_started_at is not null then
      return 'uncertain';
    end if;
    if v_request.usage_id is not null then
      update public.investigation_creation_usage_attempts
         set state = 'provider_started',
             last_step = 'parse',
             started_at = clock_timestamp(),
             completed_at = null
       where user_id = p_user_id
         and idempotency_key = p_idempotency_key
         and usage_id = v_request.usage_id
         and lease_generation = p_lease_generation
         and lease_token = p_lease_token
         and state in ('reserved', 'checkpointed');
      if not found then
        raise exception 'parse provider attempt is not reserved'
          using errcode = '40001';
      end if;
    end if;
    update public.investigation_creation_requests
       set parse_started_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where user_id = p_user_id and idempotency_key = p_idempotency_key;
    return 'started';
  end if;

  if v_request.parse_completed_at is null
     or v_request.investigation_id is null then
    return 'lost';
  end if;
  if v_request.embedding_completed_at is not null then
    return 'complete';
  end if;
  if v_request.embedding_started_at is not null then
    return 'uncertain';
  end if;
  if v_request.usage_id is not null then
    update public.investigation_creation_usage_attempts
       set state = 'provider_started',
           last_step = 'embedding',
           started_at = clock_timestamp(),
           completed_at = null
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and usage_id = v_request.usage_id
       and lease_generation = p_lease_generation
       and lease_token = p_lease_token
       and state = 'checkpointed';
    if not found then
      raise exception 'embedding provider attempt is not reserved'
        using errcode = '40001';
    end if;
  end if;
  update public.investigation_creation_requests
     set embedding_started_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where user_id = p_user_id and idempotency_key = p_idempotency_key;
  return 'started';
end;
$$;

revoke all on function public.begin_investigation_creation_step(
  uuid, text, text, bigint, uuid, text
) from public, anon, authenticated;
grant execute on function public.begin_investigation_creation_step(
  uuid, text, text, bigint, uuid, text
) to service_role;

create or replace function public.save_investigation_creation_parse_checkpoint(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_checkpoint jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_usage_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_checkpoint is null
     or jsonb_typeof(p_checkpoint) <> 'object'
     or jsonb_typeof(p_checkpoint->'title') <> 'string'
     or char_length(p_checkpoint->>'title') not between 1 and 500
     or jsonb_typeof(p_checkpoint->'normalizedQuery') <> 'string'
     or char_length(p_checkpoint->>'normalizedQuery') not between 1 and 2000
     or jsonb_typeof(p_checkpoint->'area') <> 'string'
     or char_length(p_checkpoint->>'area') not between 1 and 120
     or jsonb_typeof(p_checkpoint->'requirements') <> 'array'
     or jsonb_array_length(p_checkpoint->'requirements') < 1
     or coalesce(jsonb_typeof(p_checkpoint->'locationScope'), 'missing')
       not in ('object', 'null')
     or coalesce(jsonb_typeof(p_checkpoint->'budgetMax'), 'missing')
       not in ('number', 'null')
     or (
       jsonb_typeof(p_checkpoint->'budgetMax') = 'number'
       and ((p_checkpoint->>'budgetMax')::numeric < 0
            or (p_checkpoint->>'budgetMax')::numeric > 2147483647
            or (p_checkpoint->>'budgetMax')::numeric <> trunc((p_checkpoint->>'budgetMax')::numeric))
     ) then
    raise exception 'invalid parse checkpoint' using errcode = '22023';
  end if;

  update public.investigation_creation_requests
     set parse_checkpoint = p_checkpoint,
         parse_completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and state = 'in_flight'
     and completed_at is null
     and parse_started_at is not null
     and parse_completed_at is null
  returning usage_id into v_usage_id;
  if found then
    if v_usage_id is not null then
      update public.investigation_creation_usage_attempts
         set state = 'checkpointed',
             completed_at = clock_timestamp()
       where user_id = p_user_id
         and idempotency_key = p_idempotency_key
         and usage_id = v_usage_id
         and lease_generation = p_lease_generation
         and lease_token = p_lease_token
         and state = 'provider_started'
         and last_step = 'parse';
      if not found then
        raise exception 'parse provider attempt checkpoint was not fenced'
          using errcode = '40001';
      end if;
    end if;
    return true;
  end if;
  select r.parse_checkpoint into v_existing
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.request_digest = p_request_digest
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
     and r.state = 'in_flight'
     and r.parse_completed_at is not null;
  return found and v_existing = p_checkpoint;
end;
$$;

revoke all on function public.save_investigation_creation_parse_checkpoint(
  uuid, text, text, bigint, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.save_investigation_creation_parse_checkpoint(
  uuid, text, text, bigint, uuid, jsonb
) to service_role;

create or replace function public.save_investigation_creation_embedding_checkpoint(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_embedding real[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing real[];
  v_usage_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_embedding is not null and cardinality(p_embedding) <> 768 then
    raise exception 'invalid embedding checkpoint' using errcode = '22023';
  end if;

  update public.investigation_creation_requests
     set embedding_checkpoint = p_embedding,
         embedding_completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and state = 'in_flight'
     and completed_at is null
     and parse_completed_at is not null
     and investigation_id is not null
     and embedding_started_at is not null
     and embedding_completed_at is null
  returning usage_id into v_usage_id;
  if found then
    if v_usage_id is not null then
      update public.investigation_creation_usage_attempts
         set state = 'checkpointed',
             completed_at = clock_timestamp()
       where user_id = p_user_id
         and idempotency_key = p_idempotency_key
         and usage_id = v_usage_id
         and lease_generation = p_lease_generation
         and lease_token = p_lease_token
         and state = 'provider_started'
         and last_step = 'embedding';
      if not found then
        raise exception 'embedding provider attempt checkpoint was not fenced'
          using errcode = '40001';
      end if;
    end if;
    return true;
  end if;
  select r.embedding_checkpoint into v_existing
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.request_digest = p_request_digest
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
     and r.state = 'in_flight'
     and r.embedding_completed_at is not null;
  return found and v_existing is not distinct from p_embedding;
end;
$$;

revoke all on function public.save_investigation_creation_embedding_checkpoint(
  uuid, text, text, bigint, uuid, real[]
) from public, anon, authenticated;
grant execute on function public.save_investigation_creation_embedding_checkpoint(
  uuid, text, text, bigint, uuid, real[]
) to service_role;

-- Retryable failures happen only after every completed external step has been
-- checkpointed. A new lease can therefore resume DB work without another call.
create or replace function public.mark_investigation_creation_retryable(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.investigation_creation_requests
     set state = 'retryable',
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and state = 'in_flight'
     and completed_at is null
     and (parse_started_at is null or parse_completed_at is not null)
     and (embedding_started_at is null or embedding_completed_at is not null);
  return found;
end;
$$;

revoke all on function public.mark_investigation_creation_retryable(
  uuid, text, text, bigint, uuid
) from public, anon, authenticated;
grant execute on function public.mark_investigation_creation_retryable(
  uuid, text, text, bigint, uuid
) to service_role;

-- A known provider/schema failure is terminal for this logical create. Keep
-- every started usage attempt linked for conservative cost accounting, but
-- remove a partial investigation so it can never be replayed as completed.
create or replace function public.fail_investigation_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_investigation_id uuid,
  p_usage_id bigint,
  p_failure_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.investigation_creation_requests%rowtype;
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_failure_code not in (
    'parse_provider_error',
    'parse_schema_invalid',
    'invalid_checkpoint',
    'finalization_rejected'
  ) then
    raise exception 'invalid investigation creation failure' using errcode = '22023';
  end if;
  select r.* into v_request
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.request_digest = p_request_digest
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
   for update;
  if not found or v_request.state <> 'in_flight'
     or v_request.completed_at is not null
     or v_request.investigation_id is distinct from p_investigation_id
     or v_request.usage_id is distinct from p_usage_id then
    return false;
  end if;

  if p_usage_id is not null then
    update public.investigation_creation_usage_attempts
       set state = 'failed',
           completed_at = clock_timestamp()
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and usage_id = p_usage_id
       and state in ('reserved', 'provider_started', 'checkpointed');
    if not found then
      raise exception 'failed provider usage is not linked to this creation'
        using errcode = '40001';
    end if;
  end if;

  if p_investigation_id is not null then
    update public.investigation_creation_requests
       set investigation_id = null,
           share_token = null
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key;
    delete from public.investigations
     where id = p_investigation_id
       and created_by = p_user_id
       and status = 'parsing';
    get diagnostics v_deleted = row_count;
    if v_deleted <> 1 then
      raise exception 'partial investigation could not be removed'
        using errcode = '40001';
    end if;
  end if;

  update public.investigation_creation_requests
     set state = 'failed',
         failure_code = p_failure_code,
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and completed_at is null;
  if not found then
    raise exception 'investigation creation failure lost its lease'
      using errcode = '40001';
  end if;
  return true;
end;
$$;

revoke all on function public.fail_investigation_creation(
  uuid, text, text, bigint, uuid, uuid, bigint, text
) from public, anon, authenticated;
grant execute on function public.fail_investigation_creation(
  uuid, text, text, bigint, uuid, uuid, bigint, text
) to service_role;

create or replace function public.create_investigation_for_claim(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_title text,
  p_raw_query text,
  p_normalized_query text
)
returns table (
  investigation_id uuid,
  share_token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digest text;
  v_existing_id uuid;
  v_existing_token text;
  v_state text;
  v_completed_at timestamptz;
  v_parse_completed_at timestamptz;
  v_checkpoint jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null
     or p_idempotency_key is null
     or p_request_digest is null
     or p_lease_generation is null
     or p_lease_token is null
     or p_title is null
     or char_length(p_title) = 0
     or char_length(p_title) > 500
     or p_raw_query is null
     or char_length(p_raw_query) = 0
     or char_length(p_raw_query) > 500
     or p_normalized_query is null
     or char_length(p_normalized_query) = 0 then
    raise exception 'invalid investigation creation input' using errcode = '22023';
  end if;

  select r.request_digest, r.investigation_id, r.share_token, r.state,
         r.completed_at, r.parse_completed_at, r.parse_checkpoint
    into v_digest, v_existing_id, v_existing_token, v_state,
         v_completed_at, v_parse_completed_at, v_checkpoint
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
   for update;
  if not found or v_digest is distinct from p_request_digest
     or v_state <> 'in_flight' or v_completed_at is not null
     or v_parse_completed_at is null or v_checkpoint is null then
    raise exception 'investigation creation claim is missing or mismatched'
      using errcode = '40001';
  end if;
  if p_title is distinct from v_checkpoint->>'title'
     or p_normalized_query is distinct from v_checkpoint->>'normalizedQuery' then
    raise exception 'investigation creation input differs from checkpoint'
      using errcode = '40001';
  end if;
  if v_existing_id is not null then
    return query select v_existing_id, v_existing_token;
    return;
  end if;

  insert into public.investigations as inv (
    created_by, title, raw_query, normalized_query, status
  ) values (
    p_user_id, p_title, p_raw_query, p_normalized_query, 'parsing'
  ) returning inv.id, inv.share_token
    into v_existing_id, v_existing_token;

  update public.investigation_creation_requests
     set investigation_id = v_existing_id,
         share_token = v_existing_token,
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token;
  if not found then
    raise exception 'investigation creation claim disappeared' using errcode = '40001';
  end if;

  return query select v_existing_id, v_existing_token;
end;
$$;

revoke all on function public.create_investigation_for_claim(
  uuid, text, text, bigint, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_investigation_for_claim(
  uuid, text, text, bigint, uuid, text, text, text
) to service_role;

create or replace function public.complete_investigation_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_investigation_id uuid,
  p_usage_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.investigation_creation_requests%rowtype;
  v_requirements jsonb;
  v_area text;
  v_location_scope jsonb;
  v_budget_max integer;
  v_embedding real[];
  v_requirement record;
  v_inv_owner uuid;
  v_inv_status text;
  v_usage_investigation_id uuid;
  v_usage_status text;
  v_usage_reason text;
  v_usage_action text;
  v_usage_provider text;
  v_usage_mode text;
  v_usage_run_id uuid;
  v_live_enabled boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_idempotency_key is null
     or p_request_digest is null or p_lease_generation is null
     or p_lease_token is null or p_investigation_id is null
     or p_usage_id is null then
    raise exception 'invalid investigation creation finalization' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_investigation_id::text, 0)
  );
  select r.* into v_request
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
   for update;
  if not found or v_request.request_digest is distinct from p_request_digest
     or v_request.investigation_id is distinct from p_investigation_id
     or v_request.usage_id is distinct from p_usage_id then
    return false;
  end if;
  if v_request.completed_at is not null then
    return v_request.state = 'complete';
  end if;
  if v_request.state <> 'in_flight'
     or v_request.parse_completed_at is null
     or v_request.parse_checkpoint is null
     or v_request.embedding_completed_at is null then
    return false;
  end if;

  v_requirements := v_request.parse_checkpoint->'requirements';
  v_area := v_request.parse_checkpoint->>'area';
  v_location_scope := case
    when jsonb_typeof(v_request.parse_checkpoint->'locationScope') = 'null'
      then null
    else v_request.parse_checkpoint->'locationScope'
  end;
  v_budget_max := (v_request.parse_checkpoint->>'budgetMax')::integer;
  v_embedding := v_request.embedding_checkpoint;
  if jsonb_typeof(v_requirements) <> 'array'
     or jsonb_array_length(v_requirements) < 1
     or v_area is null or char_length(v_area) not between 1 and 120
     or (v_embedding is not null and cardinality(v_embedding) <> 768)
     or (v_budget_max is not null and v_budget_max < 0) then
    return false;
  end if;

  select i.created_by, i.status into v_inv_owner, v_inv_status
    from public.investigations i
   where i.id = p_investigation_id
   for update;
  if not found or v_inv_owner is distinct from p_user_id
     or v_inv_status <> 'parsing' then
    return false;
  end if;

  -- Completion is a second fail-closed budget boundary. A manipulated denied
  -- row, wrong action/provider/owner, or live kill-switch transition cannot be
  -- converted into a completed investigation.
  if p_usage_id is not null then
    select u.investigation_id, u.status, u.stop_reason, u.action, u.provider,
           u.mode, u.investigation_run_id
      into v_usage_investigation_id, v_usage_status, v_usage_reason,
           v_usage_action, v_usage_provider, v_usage_mode, v_usage_run_id
      from public.provider_usage u
     where u.id = p_usage_id
     for update;
    if not found
       or v_usage_status <> 'reserved'
       or v_usage_reason is not null
       or v_usage_action <> 'create'
       or v_usage_provider <> 'gemini'
       or v_usage_mode not in ('live', 'mock')
       or v_usage_run_id is not null
       or (v_usage_investigation_id is not null
           and v_usage_investigation_id is distinct from p_investigation_id)
       or not exists (
         select 1
           from public.investigation_creation_usage_attempts a
          where a.user_id = p_user_id
            and a.idempotency_key = p_idempotency_key
            and a.usage_id = p_usage_id
            and a.state in ('checkpointed', 'uncertain')
       ) then
      return false;
    end if;
    if v_usage_mode = 'live' then
      select c.enabled into v_live_enabled
        from public.runtime_controls c
       where c.key = 'provider_live'
       for update;
      if not found or not v_live_enabled then
        return false;
      end if;
    end if;
  end if;

  if exists (
    select 1
      from public.investigation_creation_usage_attempts a
      left join public.provider_usage u on u.id = a.usage_id
     where a.user_id = p_user_id
       and a.idempotency_key = p_idempotency_key
       and (
         u.id is null
         or u.status <> 'reserved'
         or u.stop_reason is not null
         or u.action <> 'create'
         or u.provider <> 'gemini'
         or u.investigation_run_id is not null
         or (u.investigation_id is not null
             and u.investigation_id is distinct from p_investigation_id)
       )
  ) then
    return false;
  end if;

  for v_requirement in
    select item->>'text' as text,
           item->>'normalizedText' as normalized_text,
           item->>'kind' as kind,
           item->>'priority' as priority,
           case when jsonb_typeof(item->'weight') = 'number'
             then (item->>'weight')::real else null end as weight
      from jsonb_array_elements(v_requirements) item
  loop
    if v_requirement.text is null or char_length(v_requirement.text) = 0
       or v_requirement.normalized_text is null
       or v_requirement.kind not in (
         'location', 'budget', 'cuisine', 'payment', 'reservation',
         'atmosphere', 'party_size', 'time', 'access', 'dietary', 'other'
       )
       or v_requirement.priority not in ('must', 'should', 'nice')
       or v_requirement.weight is null
       or v_requirement.weight < 0 or v_requirement.weight > 1 then
      raise exception 'invalid parsed requirement' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.requirements q
       where q.investigation_id = p_investigation_id
         and q.text = v_requirement.text
         and q.normalized_text is not distinct from v_requirement.normalized_text
         and q.kind is not distinct from v_requirement.kind
    ) then
      insert into public.requirements (
        investigation_id, created_by, text, normalized_text, kind, priority, weight
      ) values (
        p_investigation_id, p_user_id, v_requirement.text,
        v_requirement.normalized_text, v_requirement.kind,
        v_requirement.priority, v_requirement.weight
      );
    end if;
  end loop;

  insert into public.investigation_members (investigation_id, user_id, role)
  values (p_investigation_id, p_user_id, 'owner')
  on conflict (investigation_id, user_id) do update set role = 'owner';

  if not exists (
    select 1 from public.investigation_events e
     where e.investigation_id = p_investigation_id
       and e.event_type = 'parse_completed'
  ) then
    insert into public.investigation_events (
      investigation_id, event_type, message, metadata
    ) values (
      p_investigation_id, 'parse_completed', '条件を整理しました',
      jsonb_build_object(
        'area', v_area,
        'locationScope', coalesce(v_location_scope, 'null'::jsonb),
        'budgetMax', v_budget_max,
        'requirementCount', jsonb_array_length(v_requirements)
      )
    );
  end if;

  update public.provider_usage u
     set investigation_id = p_investigation_id
   where u.investigation_id is null
     and exists (
       select 1
         from public.investigation_creation_usage_attempts a
        where a.user_id = p_user_id
          and a.idempotency_key = p_idempotency_key
          and a.usage_id = u.id
     );
  update public.investigations
     set status = 'recalling',
         embedding = case
           when v_embedding is null then embedding
           else format('[%s]', array_to_string(v_embedding, ','))::public.vector
         end
   where id = p_investigation_id
     and created_by = p_user_id
     and status = 'parsing';
  if not found then
    raise exception 'investigation creation final status was not updated'
      using errcode = '40001';
  end if;

  update public.investigation_creation_requests
     set completed_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         state = 'complete',
         failure_code = null
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and investigation_id = p_investigation_id
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and state = 'in_flight'
     and completed_at is null;
  if not found then
    raise exception 'investigation creation finalization lost its claim'
      using errcode = '40001';
  end if;
  if p_usage_id is not null then
    update public.investigation_creation_usage_attempts
       set state = 'complete',
           completed_at = coalesce(completed_at, clock_timestamp())
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and usage_id = p_usage_id
       and state = 'checkpointed';
  end if;
  return true;
end;
$$;

revoke all on function public.complete_investigation_creation(
  uuid, text, text, bigint, uuid, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.complete_investigation_creation(
  uuid, text, text, bigint, uuid, uuid, bigint
) to service_role;

create or replace function public.abandon_investigation_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_investigation_id uuid,
  p_usage_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.investigation_creation_requests%rowtype;
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_idempotency_key is null
     or p_request_digest is null or p_lease_generation is null
     or p_lease_token is null or p_investigation_id is null then
    raise exception 'invalid investigation creation abandonment' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_investigation_id::text, 0)
  );
  select r.* into v_request
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
   for update;
  if not found or v_request.request_digest is distinct from p_request_digest
     or v_request.investigation_id is distinct from p_investigation_id
     or v_request.usage_id is distinct from p_usage_id
     or v_request.completed_at is not null
     or v_request.state not in ('in_flight', 'retryable')
     or v_request.parse_started_at is not null then
    return false;
  end if;

  -- Abandon is intentionally pre-provider only. A started provider attempt is
  -- finalized through fail/retryable and remains auditable instead of deleted.
  if p_usage_id is not null then
    delete from public.investigation_creation_usage_attempts
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and usage_id = p_usage_id
       and state = 'reserved'
       and started_at is null;
    get diagnostics v_deleted = row_count;
    if v_deleted <> 1 then
      raise exception 'pre-provider attempt could not be released'
        using errcode = '40001';
    end if;
    delete from public.provider_usage
     where id = p_usage_id
       and action = 'create'
       and provider = 'gemini'
       and status = 'reserved'
       and stop_reason is null
       and investigation_run_id is null
       and (investigation_id is null or investigation_id = p_investigation_id);
    get diagnostics v_deleted = row_count;
    if v_deleted <> 1 then
      raise exception 'investigation creation reservation could not be released'
        using errcode = '40001';
    end if;
  end if;

  update public.investigation_creation_requests
     set investigation_id = null,
         share_token = null,
         usage_id = null
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key;
  delete from public.investigations
   where id = p_investigation_id
     and created_by = p_user_id
     and status = 'parsing';
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'partial investigation could not be abandoned'
      using errcode = '40001';
  end if;
  delete from public.investigation_creation_requests
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and completed_at is null;
  return found;
end;
$$;

revoke all on function public.abandon_investigation_creation(
  uuid, text, text, bigint, uuid, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.abandon_investigation_creation(
  uuid, text, text, bigint, uuid, uuid, bigint
) to service_role;

create or replace function public.release_investigation_creation(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_lease_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage_id bigint;
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_idempotency_key is null
     or p_request_digest is null or p_lease_generation is null
     or p_lease_token is null then
    raise exception 'invalid investigation creation release' using errcode = '22023';
  end if;
  select r.usage_id into v_usage_id
    from public.investigation_creation_requests r
   where r.user_id = p_user_id
     and r.idempotency_key = p_idempotency_key
     and r.request_digest = p_request_digest
     and r.lease_generation = p_lease_generation
     and r.lease_token = p_lease_token
     and r.investigation_id is null
     and r.parse_started_at is null
     and r.state in ('in_flight', 'retryable')
     and r.completed_at is null
   for update;
  if not found then
    return false;
  end if;

  if v_usage_id is not null then
    delete from public.investigation_creation_usage_attempts
     where user_id = p_user_id
       and idempotency_key = p_idempotency_key
       and usage_id = v_usage_id
       and state = 'reserved'
       and started_at is null;
    get diagnostics v_deleted = row_count;
    if v_deleted <> 1 then
      raise exception 'pre-provider attempt could not be released'
        using errcode = '40001';
    end if;
    delete from public.provider_usage
     where id = v_usage_id
       and action = 'create'
       and provider = 'gemini'
       and status = 'reserved'
       and stop_reason is null
       and investigation_run_id is null
       and investigation_id is null;
    get diagnostics v_deleted = row_count;
    if v_deleted <> 1 then
      raise exception 'investigation creation reservation could not be released'
        using errcode = '40001';
    end if;
  end if;
  delete from public.investigation_creation_requests
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key
     and request_digest = p_request_digest
     and lease_generation = p_lease_generation
     and lease_token = p_lease_token
     and investigation_id is null
     and completed_at is null;
  return found;
end;
$$;

revoke all on function public.release_investigation_creation(
  uuid, text, text, bigint, uuid
) from public, anon, authenticated;
grant execute on function public.release_investigation_creation(
  uuid, text, text, bigint, uuid
)
  to service_role;
