-- 202608300006: safe crawler queue / URL frontier (#117)
--
-- scheduler (#123) はこのmigrationに含めない。job_id と purpose/schedule_window は
-- scheduler/呼び出し元から受け取り、ここでは enqueue と worker の状態遷移だけを担う。
-- HTML、raw本文、検索query、抽出claimは保存しない。保持するのは運用上必要な
-- canonical URL、budget、lease、content hash、robotsの解析済みrulesだけである。

create table public.crawl_budget_accounts (
  job_id uuid primary key,
  max_depth smallint not null default 2 check (max_depth between 0 and 2),
  max_pages_per_origin integer not null default 10
    check (max_pages_per_origin between 1 and 10),
  max_pages_total integer not null default 50
    check (max_pages_total between 1 and 50),
  max_bytes_per_response integer not null default 500000
    check (max_bytes_per_response between 1 and 500000),
  max_bytes_total bigint not null default 10000000
    check (max_bytes_total between 1 and 10000000),
  max_links_per_page integer not null default 30
    check (max_links_per_page between 1 and 30),
  max_query_variants_per_path smallint not null default 3
    check (max_query_variants_per_path between 1 and 3),
  reserved_pages_total integer not null default 0 check (reserved_pages_total >= 0),
  used_bytes_total bigint not null default 0 check (used_bytes_total >= 0),
  reserved_pages_by_origin jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reserved_pages_by_origin) = 'object'),
  reserved_query_variants_by_path jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reserved_query_variants_by_path) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crawl_origins (
  origin text primary key
    check (origin ~ '^https://[a-z0-9][a-z0-9.-]*$'),
  in_flight_count smallint not null default 0 check (in_flight_count between 0 and 1),
  next_allowed_at timestamptz not null default now(),
  crawl_delay_seconds integer not null default 10
    check (crawl_delay_seconds between 10 and 86400),
  robots_checked_at timestamptz,
  robots_status text not null default 'unknown'
    check (robots_status in ('unknown', 'allowed', 'denied', 'unavailable')),
  consecutive_failures smallint not null default 0 check (consecutive_failures >= 0),
  circuit_open boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.crawl_robots_cache (
  origin text primary key
    check (origin ~ '^https://[a-z0-9][a-z0-9.-]*$'),
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  available boolean not null,
  rules jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rules) = 'array'),
  crawl_delay_seconds integer
    check (crawl_delay_seconds is null or crawl_delay_seconds between 1 and 86400)
);

create index idx_crawl_robots_cache_expires on public.crawl_robots_cache (expires_at);

create table public.crawl_queue (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique
    check (char_length(idempotency_key) between 1 and 4096),
  job_id uuid not null,
  canonical_url text not null
    check (
      char_length(canonical_url) between 12 and 2048
      and canonical_url like 'https://%'
      and position('#' in canonical_url) = 0
      and canonical_url !~ '^https://[^/?#]*@'
    ),
  origin text not null references public.crawl_origins(origin),
  purpose text not null check (purpose in ('discover', 'refresh')),
  depth smallint not null check (depth between 0 and 2),
  place_id uuid references public.places(id) on delete set null,
  schedule_window text not null
    check (char_length(schedule_window) between 1 and 80),
  enqueued_by text not null
    check (char_length(enqueued_by) between 1 and 128),
  query_path_key text not null check (char_length(query_path_key) between 1 and 2048),
  query_variant_key text not null check (char_length(query_variant_key) <= 2048),
  budget_snapshot jsonb not null
    check (jsonb_typeof(budget_snapshot) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'in_flight', 'done', 'failed', 'dead')),
  attempt smallint not null default 0 check (attempt between 0 and 4),
  next_attempt_at timestamptz not null default now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code in (
    'no_gateway', 'bad_url', 'denylisted', 'non_public_address', 'dns_failed',
    'blocked_or_empty', 'robots_unavailable', 'robots_denied', 'redirect_loop',
    'redirect_rejected', 'network_error', 'timeout', 'http_error', 'auth_required',
    'non_html', 'body_too_large', 'mime_mismatch', 'robots_meta_denied',
    'empty_body', 'aborted', 'budget_exceeded', 'duplicate_content',
    'origin_circuit_open', 'lease_lost', 'attempt_limit', 'invalid_url'
  )),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  response_bytes integer check (response_bytes is null or response_bytes between 0 and 500000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index idx_crawl_queue_pending on public.crawl_queue
  (status, next_attempt_at, created_at);
create index idx_crawl_queue_origin_status on public.crawl_queue
  (origin, status, next_attempt_at);
create index idx_crawl_queue_job on public.crawl_queue (job_id, status);
create index idx_crawl_queue_content_hash on public.crawl_queue (content_hash)
  where status = 'done' and content_hash is not null;
-- Active canonical URLs are unique across purpose/schedule windows. Terminal rows
-- remain immutable history, so a later refresh can append a new observation.
create unique index idx_crawl_queue_active_canonical on public.crawl_queue (canonical_url)
  where status in ('pending', 'in_flight');

alter table public.crawl_budget_accounts enable row level security;
alter table public.crawl_origins enable row level security;
alter table public.crawl_robots_cache enable row level security;
alter table public.crawl_queue enable row level security;

revoke all on public.crawl_budget_accounts from public, anon, authenticated;
revoke all on public.crawl_origins from public, anon, authenticated;
revoke all on public.crawl_robots_cache from public, anon, authenticated;
revoke all on public.crawl_queue from public, anon, authenticated;
grant all on public.crawl_budget_accounts to service_role;
grant all on public.crawl_origins to service_role;
grant all on public.crawl_robots_cache to service_role;
grant all on public.crawl_queue to service_role;

-- RPCの返却shapeはEdge adapterとfixtureのqueue契約で共有する。
create or replace function public.crawl_queue_item_row(p_queue_id uuid)
returns table (
  queue_id uuid,
  idempotency_key text,
  job_id uuid,
  canonical_url text,
  origin text,
  purpose text,
  depth smallint,
  place_id uuid,
  schedule_window text,
  enqueued_by text,
  query_path_key text,
  query_variant_key text,
  budget_snapshot jsonb,
  status text,
  attempt smallint,
  next_attempt_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  content_hash text,
  response_bytes integer,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    q.id,
    q.idempotency_key,
    q.job_id,
    q.canonical_url,
    q.origin,
    q.purpose,
    q.depth,
    q.place_id,
    q.schedule_window,
    q.enqueued_by,
    q.query_path_key,
    q.query_variant_key,
    q.budget_snapshot,
    q.status,
    q.attempt,
    q.next_attempt_at,
    q.lease_owner,
    q.lease_expires_at,
    q.last_error_code,
    q.content_hash,
    q.response_bytes,
    q.created_at,
    q.updated_at,
    q.completed_at
  from public.crawl_queue q
  where q.id = p_queue_id;
$$;

revoke all on function public.crawl_queue_item_row(uuid)
  from public, anon, authenticated;
grant execute on function public.crawl_queue_item_row(uuid) to service_role;

create or replace function public.enqueue_crawl_queue_item(
  p_job_id uuid,
  p_idempotency_key text,
  p_canonical_url text,
  p_origin text,
  p_purpose text,
  p_depth integer,
  p_place_id uuid,
  p_schedule_window text,
  p_enqueued_by text,
  p_query_path_key text,
  p_query_variant_key text,
  p_budget_snapshot jsonb default '{}'::jsonb
)
returns table (
  inserted boolean,
  queue_id uuid,
  idempotency_key text,
  job_id uuid,
  canonical_url text,
  origin text,
  purpose text,
  depth smallint,
  place_id uuid,
  schedule_window text,
  enqueued_by text,
  query_path_key text,
  query_variant_key text,
  budget_snapshot jsonb,
  status text,
  attempt smallint,
  next_attempt_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  content_hash text,
  response_bytes integer,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.crawl_queue%rowtype;
  v_budget public.crawl_budget_accounts%rowtype;
  v_queue_id uuid;
  v_origin_pages integer;
  v_variants jsonb;
  v_snapshot jsonb;
begin
  if p_job_id is null
     or p_idempotency_key is null
     or char_length(p_idempotency_key) not between 1 and 4096
     or p_canonical_url is null
     or char_length(p_canonical_url) not between 12 and 2048
     or p_canonical_url not like 'https://%'
     or position('#' in p_canonical_url) > 0
     or p_origin is null
     or p_origin !~ '^https://[a-z0-9][a-z0-9.-]*$'
     or p_canonical_url not like p_origin || '/%'
     or p_canonical_url ~ '^https://[^/?#]*:'
     or p_canonical_url ~ '^https://[^/?#]*@'
     or p_purpose is null
     or p_purpose not in ('discover', 'refresh')
     or p_idempotency_key <> (p_purpose || ':' || p_schedule_window || ':' || p_canonical_url)
     or p_depth is null
     or p_depth not between 0 and 2
     or p_schedule_window is null
     or char_length(p_schedule_window) not between 1 and 80
     or p_enqueued_by is null
     or char_length(p_enqueued_by) not between 1 and 128
     or p_query_path_key is null
     or char_length(p_query_path_key) not between 1 and 2048
     or p_query_variant_key is null
     or char_length(p_query_variant_key) > 2048
     or p_budget_snapshot is null
     or jsonb_typeof(p_budget_snapshot) <> 'object'
  then
    raise exception 'invalid crawl enqueue request' using errcode = '22023';
  end if;

  -- 同一jobのbudget会計と同一idempotency keyの競合を同じtransactionで直列化する。
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_job_id::text, 117)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint-crawl-key:' || p_idempotency_key, 117)
  );
  -- The canonical URL lock spans jobs and schedule windows. It is acquired after
  -- the job/key locks in every enqueue call, preventing two active rows for one
  -- URL without removing terminal history.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint-crawl-url:' || p_canonical_url, 117)
  );

  insert into public.crawl_budget_accounts (job_id)
  values (p_job_id)
  on conflict (job_id) do nothing;

  select * into v_existing
    from public.crawl_queue
   where idempotency_key = p_idempotency_key
   for update;
  if found then
    return query
      select false, r.*
        from public.crawl_queue_item_row(v_existing.id) r;
    return;
  end if;

  select * into v_existing
    from public.crawl_queue
   where canonical_url = p_canonical_url
     and status in ('pending', 'in_flight')
   order by created_at, id
   limit 1
   for update;
  if found then
    return query
      select false, r.*
        from public.crawl_queue_item_row(v_existing.id) r;
    return;
  end if;

  select * into v_budget
    from public.crawl_budget_accounts
   where job_id = p_job_id
   for update;

  v_origin_pages := coalesce(
    (v_budget.reserved_pages_by_origin ->> p_origin)::integer,
    0
  );
  if p_depth > v_budget.max_depth
     or v_budget.reserved_pages_total >= v_budget.max_pages_total
     or v_origin_pages >= v_budget.max_pages_per_origin
  then
    raise exception 'crawl budget exceeded' using errcode = '22023';
  end if;

  v_variants := coalesce(
    v_budget.reserved_query_variants_by_path -> p_query_path_key,
    '[]'::jsonb
  );
  if jsonb_typeof(v_variants) <> 'array' then
    raise exception 'invalid crawl budget variant ledger' using errcode = '22023';
  end if;
  if not (v_variants @> to_jsonb(array[p_query_variant_key]::text[])) then
    if jsonb_array_length(v_variants) >= v_budget.max_query_variants_per_path then
      raise exception 'crawl query variant budget exceeded' using errcode = '22023';
    end if;
    v_variants := v_variants || to_jsonb(array[p_query_variant_key]::text[]);
  end if;

  v_snapshot := jsonb_build_object(
    'policy_version', 'safe-crawl-v1',
    'remaining_pages_total', greatest(
      0, v_budget.max_pages_total - v_budget.reserved_pages_total - 1
    ),
    'remaining_bytes_total', greatest(
      0, v_budget.max_bytes_total - v_budget.used_bytes_total
    ),
    'remaining_pages_for_origin', greatest(
      0, v_budget.max_pages_per_origin - v_origin_pages - 1
    ),
    'remaining_query_variants_for_path', greatest(
      0,
      v_budget.max_query_variants_per_path - jsonb_array_length(v_variants)
    )
  );

  insert into public.crawl_origins (origin)
  values (p_origin)
  on conflict (origin) do nothing;

  insert into public.crawl_queue (
    idempotency_key,
    job_id,
    canonical_url,
    origin,
    purpose,
    depth,
    place_id,
    schedule_window,
    enqueued_by,
    query_path_key,
    query_variant_key,
    budget_snapshot
  ) values (
    p_idempotency_key,
    p_job_id,
    p_canonical_url,
    p_origin,
    p_purpose,
    p_depth,
    p_place_id,
    p_schedule_window,
    p_enqueued_by,
    p_query_path_key,
    p_query_variant_key,
    v_snapshot
  ) returning id into v_queue_id;

  update public.crawl_budget_accounts
     set reserved_pages_total = reserved_pages_total + 1,
         reserved_pages_by_origin = jsonb_set(
           reserved_pages_by_origin,
           array[p_origin],
           to_jsonb(v_origin_pages + 1),
           true
         ),
         reserved_query_variants_by_path = jsonb_set(
           reserved_query_variants_by_path,
           array[p_query_path_key],
           v_variants,
           true
         ),
         updated_at = now()
   where job_id = p_job_id;

  return query
    select true, r.*
      from public.crawl_queue_item_row(v_queue_id) r;
end;
$$;

revoke all on function public.enqueue_crawl_queue_item(
  uuid, text, text, text, text, integer, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.enqueue_crawl_queue_item(
  uuid, text, text, text, text, integer, uuid, text, text, text, text, jsonb
) to service_role;

create or replace function public.lease_crawl_queue_item(
  p_worker_id uuid,
  p_lease_seconds integer default 60
)
returns table (
  queue_id uuid,
  idempotency_key text,
  job_id uuid,
  canonical_url text,
  origin text,
  purpose text,
  depth smallint,
  place_id uuid,
  schedule_window text,
  enqueued_by text,
  query_path_key text,
  query_variant_key text,
  budget_snapshot jsonb,
  status text,
  attempt smallint,
  next_attempt_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  content_hash text,
  response_bytes integer,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q public.crawl_queue%rowtype;
  v_expired record;
begin
  if p_worker_id is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid crawl lease request' using errcode = '22023';
  end if;

  -- lease切れは同一originのin_flightを解放してpendingへ戻す。
  for v_expired in
    select q.id, q.origin
      from public.crawl_queue q
     where q.status = 'in_flight'
       and q.lease_expires_at is not null
       and q.lease_expires_at <= now()
     for update skip locked
  loop
    update public.crawl_queue
       set status = 'pending', lease_owner = null, lease_expires_at = null,
           updated_at = now()
     where id = v_expired.id;
    update public.crawl_origins
       set in_flight_count = greatest(0, in_flight_count - 1), updated_at = now()
     where origin = v_expired.origin;
  end loop;

  loop
    select q.* into v_q
      from public.crawl_queue q
      join public.crawl_origins o on o.origin = q.origin
     where q.status = 'pending'
       and q.next_attempt_at <= now()
       and o.circuit_open = false
       and o.in_flight_count = 0
       and o.next_allowed_at <= now()
     order by q.next_attempt_at, q.created_at, q.id
     limit 1
     for update of q, o skip locked;

    if not found then
      return;
    end if;

    if v_q.attempt >= 4 then
      update public.crawl_queue
         set status = 'dead', last_error_code = 'attempt_limit',
             updated_at = now()
       where id = v_q.id;
      continue;
    end if;

    update public.crawl_queue
       set status = 'in_flight',
           attempt = attempt + 1,
           lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           updated_at = now()
     where id = v_q.id;

    update public.crawl_origins
       set in_flight_count = 1,
           next_allowed_at = now() + make_interval(
             secs => greatest(10, crawl_delay_seconds)
           ),
           updated_at = now()
     where origin = v_q.origin;

    return query
      select r.*
        from public.crawl_queue_item_row(v_q.id) r;
    return;
  end loop;
end;
$$;

revoke all on function public.lease_crawl_queue_item(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.lease_crawl_queue_item(uuid, integer) to service_role;

create or replace function public.renew_crawl_queue_lease(
  p_queue_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer default 60
)
returns table (renewed boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue_id is null or p_lease_owner is null
     or p_lease_seconds not between 30 and 600 then
    return query select false;
  end if;

  update public.crawl_queue
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = p_queue_id
     and status = 'in_flight'
     and lease_owner = p_lease_owner
     and lease_expires_at > now();
  return query select found;
end;
$$;

revoke all on function public.renew_crawl_queue_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_crawl_queue_lease(uuid, uuid, integer)
  to service_role;

create or replace function public.complete_crawl_queue_item(
  p_queue_id uuid,
  p_lease_owner uuid,
  p_content_hash text,
  p_response_bytes integer
)
returns table (
  completed boolean,
  duplicate_content boolean,
  budget_exceeded boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q public.crawl_queue%rowtype;
  v_budget public.crawl_budget_accounts%rowtype;
  v_duplicate boolean;
  v_budget_exceeded boolean;
begin
  if p_queue_id is null or p_lease_owner is null
     or p_content_hash is null
     or p_content_hash !~ '^[0-9a-f]{64}$'
     or p_response_bytes is null
     or p_response_bytes not between 0 and 500000 then
    raise exception 'invalid crawl completion' using errcode = '22023';
  end if;

  select * into v_q from public.crawl_queue where id = p_queue_id for update;
  if not found then
    return query select false, false, false;
    return;
  end if;
  if v_q.status = 'done' then
    return query select true,
      coalesce(v_q.last_error_code = 'duplicate_content', false),
      coalesce(v_q.last_error_code = 'budget_exceeded', false);
    return;
  end if;
  if v_q.status <> 'in_flight'
     or v_q.lease_owner <> p_lease_owner
     or v_q.lease_expires_at is null
     or v_q.lease_expires_at <= now() then
    return query select false, false, false;
    return;
  end if;

  select * into v_budget
    from public.crawl_budget_accounts
   where job_id = v_q.job_id
   for update;
  if not found then
    raise exception 'crawl budget account missing' using errcode = '22023';
  end if;

  v_budget_exceeded := v_budget.used_bytes_total >
    v_budget.max_bytes_total - p_response_bytes;
  if v_budget_exceeded then
    v_duplicate := false;
  else
    select exists (
      select 1
        from public.crawl_queue other
       where other.id <> v_q.id
         and other.status = 'done'
         and other.content_hash = p_content_hash
    ) into v_duplicate;
    update public.crawl_budget_accounts
       set used_bytes_total = used_bytes_total + p_response_bytes,
           updated_at = now()
     where job_id = v_q.job_id;
  end if;

  update public.crawl_queue
     set status = 'done',
         last_error_code = case
           when v_budget_exceeded then 'budget_exceeded'
           when v_duplicate then 'duplicate_content'
           else null
         end,
         content_hash = case when v_budget_exceeded then null else p_content_hash end,
         response_bytes = p_response_bytes,
         lease_owner = null,
         lease_expires_at = null,
         completed_at = now(),
         updated_at = now()
   where id = v_q.id;

  update public.crawl_origins
     set in_flight_count = greatest(0, in_flight_count - 1),
         consecutive_failures = 0,
         circuit_open = false,
         updated_at = now()
   where origin = v_q.origin;

  return query select true, v_duplicate, v_budget_exceeded;
end;
$$;

revoke all on function public.complete_crawl_queue_item(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.complete_crawl_queue_item(uuid, uuid, text, integer)
  to service_role;

create or replace function public.fail_crawl_queue_item(
  p_queue_id uuid,
  p_lease_owner uuid,
  p_error_code text,
  p_retryable boolean
)
returns table (
  status text,
  retry_at timestamptz,
  origin_circuit_open boolean,
  dead_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q public.crawl_queue%rowtype;
  v_origin public.crawl_origins%rowtype;
  v_retry_at timestamptz;
  v_dead_count integer := 0;
  v_retry_seconds numeric;
  v_retryable boolean;
begin
  if p_queue_id is null
     or p_lease_owner is null
     or p_error_code is null
     or p_error_code not in (
       'no_gateway', 'bad_url', 'denylisted', 'non_public_address', 'dns_failed',
       'blocked_or_empty', 'robots_unavailable', 'robots_denied', 'redirect_loop',
       'redirect_rejected', 'network_error', 'timeout', 'http_error', 'auth_required',
       'non_html', 'body_too_large', 'mime_mismatch', 'robots_meta_denied',
       'empty_body', 'aborted', 'budget_exceeded', 'duplicate_content',
       'origin_circuit_open', 'lease_lost', 'attempt_limit', 'invalid_url'
     ) then
    raise exception 'invalid crawl failure' using errcode = '22023';
  end if;
  v_retryable := p_error_code in ('network_error', 'timeout');
  if p_retryable is distinct from v_retryable then
    raise exception 'crawl retryability does not match error code'
      using errcode = '22023';
  end if;

  select * into v_q from public.crawl_queue where id = p_queue_id for update;
  if not found then
    return query select 'dead'::text, null::timestamptz, false, 0;
    return;
  end if;
  if v_q.status in ('done', 'failed', 'dead') then
    return query select v_q.status,
      case when v_q.status = 'pending' then v_q.next_attempt_at else null end,
      coalesce((select o.circuit_open from public.crawl_origins o
                 where o.origin = v_q.origin), false),
      0;
    return;
  end if;
  if v_q.status <> 'in_flight'
     or v_q.lease_owner <> p_lease_owner
     or v_q.lease_expires_at is null
     or v_q.lease_expires_at <= now() then
    return query select v_q.status, null::timestamptz, false, 0;
    return;
  end if;

  update public.crawl_origins
     set in_flight_count = greatest(0, in_flight_count - 1), updated_at = now()
   where origin = v_q.origin;

  if v_retryable and v_q.attempt < 4 then
    -- 60s * 4^(attempt-1), jitter ±25%, 1日cap。
    v_retry_seconds := least(
      86400,
      60 * power(4, greatest(v_q.attempt - 1, 0)) * (0.75 + random() * 0.5)
    );
    v_retry_at := now() + make_interval(secs => v_retry_seconds::double precision);
    update public.crawl_queue
       set status = 'pending',
           next_attempt_at = v_retry_at,
           last_error_code = p_error_code,
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = v_q.id;
  elsif v_retryable then
    update public.crawl_queue
       set status = 'dead',
           last_error_code = p_error_code,
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = v_q.id;
    v_dead_count := 1;
  else
    update public.crawl_queue
       set status = 'failed',
           last_error_code = p_error_code,
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = v_q.id;
  end if;

  -- fail-closed が同一originで5回続いたら、残りのpendingをdeadへ倒す。
  if not v_retryable then
    update public.crawl_origins
       set consecutive_failures = consecutive_failures + 1,
           updated_at = now()
     where origin = v_q.origin;
  end if;
  select * into v_origin
    from public.crawl_origins where origin = v_q.origin for update;
  if v_origin.consecutive_failures >= 5 then
    update public.crawl_origins
       set circuit_open = true, robots_status = 'unavailable', updated_at = now()
     where origin = v_q.origin;
    update public.crawl_queue
       set status = 'dead',
           last_error_code = 'origin_circuit_open',
           updated_at = now()
     where origin = v_q.origin and status = 'pending';
    get diagnostics v_dead_count = row_count;
    v_origin.circuit_open := true;
  end if;

  return query
    select q.status, case when q.status = 'pending' then q.next_attempt_at else null end,
           v_origin.circuit_open, v_dead_count
      from public.crawl_queue q where q.id = v_q.id;
end;
$$;

revoke all on function public.fail_crawl_queue_item(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_crawl_queue_item(uuid, uuid, text, boolean)
  to service_role;

create or replace function public.mark_crawl_queue_dead(
  p_queue_id uuid,
  p_lease_owner uuid,
  p_error_code text
)
returns table (marked boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q public.crawl_queue%rowtype;
begin
  if p_queue_id is null or p_error_code is null then
    return query select false;
    return;
  end if;
  select * into v_q from public.crawl_queue where id = p_queue_id for update;
  if not found or v_q.status in ('done', 'dead') then
    return query select false;
    return;
  end if;
  if v_q.status = 'in_flight'
     and (p_lease_owner is null or v_q.lease_owner <> p_lease_owner
       or v_q.lease_expires_at is null or v_q.lease_expires_at <= now()) then
    return query select false;
    return;
  end if;
  update public.crawl_queue
     set status = 'dead', last_error_code = p_error_code,
         lease_owner = null, lease_expires_at = null, updated_at = now()
   where id = v_q.id;
  if v_q.status = 'in_flight' then
    update public.crawl_origins
       set in_flight_count = greatest(0, in_flight_count - 1), updated_at = now()
     where origin = v_q.origin;
  end if;
  return query select true;
end;
$$;

revoke all on function public.mark_crawl_queue_dead(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_crawl_queue_dead(uuid, uuid, text) to service_role;

create or replace function public.record_crawl_origin_policy(
  p_origin text,
  p_crawl_delay_seconds numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delay integer;
begin
  if p_origin is null or p_origin !~ '^https://[a-z0-9][a-z0-9.-]*$' then
    raise exception 'invalid crawl origin' using errcode = '22023';
  end if;
  v_delay := greatest(10, least(86400, coalesce(p_crawl_delay_seconds, 10)))::integer;
  insert into public.crawl_origins (origin, crawl_delay_seconds, robots_checked_at, robots_status)
  values (p_origin, v_delay, now(), 'allowed')
  on conflict (origin) do update
    set crawl_delay_seconds = greatest(public.crawl_origins.crawl_delay_seconds, excluded.crawl_delay_seconds),
        next_allowed_at = greatest(
          public.crawl_origins.next_allowed_at,
          now() + make_interval(
            secs => greatest(
              public.crawl_origins.crawl_delay_seconds,
              excluded.crawl_delay_seconds
            )
          )
        ),
        robots_checked_at = now(),
        robots_status = 'allowed',
        consecutive_failures = 0,
        circuit_open = false,
        updated_at = now();
end;
$$;

revoke all on function public.record_crawl_origin_policy(text, numeric)
  from public, anon, authenticated;
grant execute on function public.record_crawl_origin_policy(text, numeric) to service_role;

comment on table public.crawl_queue is
  '短期のsafe crawler frontier。canonical URL/lease/hash/budgetのみ。raw HTML/textは保持しない。';
comment on table public.crawl_robots_cache is
  'robots.txtの解析済みrulesとcrawl-delayのみを24時間TTLで保持する運用cache。raw本文は保持しない。';
