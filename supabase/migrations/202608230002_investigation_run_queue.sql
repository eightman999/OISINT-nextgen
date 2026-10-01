-- 202608230002: investigation の受付/実行分離用 run queue (#579)
--
-- Edge Function のプロセスはいつでも終了し得るため、実行中 run の lease、
-- 現在ステップ、ステップ別の連続失敗回数を DB へ保存する。active run は
-- investigation ごとに1件だけ許可し、重複受付は同じ run へ収束させる。

create table public.investigation_runs (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'complete', 'failed', 'rejected')
  ),
  acceptance_state text not null default 'pending' check (
    acceptance_state in ('pending', 'accepted', 'rejected')
  ),
  accepted_at timestamptz,
  request_id uuid,
  requires_transient_anchor boolean not null default false,
  lease_owner uuid,
  lease_expires_at timestamptz,
  current_step text,
  attempts integer not null default 0 check (attempts >= 0),
  step_failures jsonb not null default '{}'::jsonb check (jsonb_typeof(step_failures) = 'object'),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index idx_investigation_runs_investigation_created
  on public.investigation_runs (investigation_id, created_at desc);

-- queued は retry待ち、running は lease保持中。complete/failed/rejected は履歴として残す。
create unique index idx_investigation_runs_one_active
  on public.investigation_runs (investigation_id)
  where status in ('queued', 'running');

create trigger trg_investigation_runs_updated_at
before update on public.investigation_runs
for each row execute function public.set_updated_at();

alter table public.investigation_runs enable row level security;
revoke all on public.investigation_runs from public, anon, authenticated;
grant all on public.investigation_runs to service_role;

-- provider budget reservation と run を冪等に結び付ける。既存の create / rerank
-- reservation は NULL のまま維持し、新しい run reservation だけがこの列を使う。
alter table public.provider_usage
  add column if not exists investigation_run_id uuid
  references public.investigation_runs(id) on delete set null;

create unique index idx_provider_usage_one_run_reservation
  on public.provider_usage (investigation_run_id, action)
  where investigation_run_id is not null;

alter table public.investigation_runs
  add column provider_usage_id bigint references public.provider_usage(id) on delete set null;

comment on table public.investigation_runs is
  'Durable run queue. One queued/running run per investigation; lease and step failures survive process death.';
comment on column public.investigation_runs.step_failures is
  'JSON object keyed by step. Counts consecutive failures and is never exposed to clients.';
comment on column public.investigation_runs.acceptance_state is
  '受付確定状態。pending の run は cost guard/enqueue 完了前なので重複要求へ202を返さない。';
comment on column public.investigation_runs.request_id is
  '同一runの受付からdurable drain再配送まで使う検証済み相関UUID。query/anchorは保存しない。';
comment on column public.investigation_runs.requires_transient_anchor is
  'GPS anchor自体は保存せず、search成果物確定までの一時依存だけを示す非PIIフラグ。';
comment on column public.provider_usage.investigation_run_id is
  'Idempotency key for the run cost reservation. Raw query, user ID, IP, and provider output are prohibited.';

-- active run の claim は advisory lock + partial unique index の二重防御にする。
-- stale lease は同じ run id を新しい owner が再取得し、途中成果物を再利用する。
drop function if exists public.claim_investigation_run(uuid, uuid, integer);
drop function if exists public.claim_investigation_run(uuid, uuid, integer, uuid, boolean);
create or replace function public.claim_investigation_run(
  p_investigation_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer default 180,
  p_request_id uuid default null,
  p_requires_transient_anchor boolean default false
)
returns table(
  run_id uuid,
  acquired boolean,
  status text,
  lease_expires_at timestamptz,
  accepted boolean,
  accepted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_expires timestamptz;
  v_run public.investigation_runs%rowtype;
  v_inv_status text;
begin
  if p_investigation_id is null or p_lease_owner is null
     or p_requires_transient_anchor is null
     or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid investigation run claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('oisint-run:' || p_investigation_id::text)
  );

  select i.status into v_inv_status
    from public.investigations as i
   where i.id = p_investigation_id
   for update;
  if not found then
    raise exception 'investigation not found' using errcode = 'P0002';
  end if;

  if v_inv_status = 'complete' then
    -- investigation が先に terminal 化された後に残った queued/running run を
    -- その場で rejected に収束させる。drain が409を成功扱いしても、同じ行を
    -- 次回再配送し続けない。pending/acceptedを問わず provider は実行しない。
    update public.investigation_runs as r
       set status = 'rejected',
           acceptance_state = 'rejected',
           accepted_at = null,
           lease_owner = null,
           lease_expires_at = null,
           completed_at = coalesce(r.completed_at, clock_timestamp()),
           current_step = 'terminal',
           last_error_code = 'investigation_already_complete',
           updated_at = clock_timestamp()
     where r.investigation_id = p_investigation_id
       and r.status in ('queued', 'running');
    return query select null::uuid, false, 'complete'::text, null::timestamptz,
      true, null::timestamptz;
    return;
  end if;

  select r.* into v_run
    from public.investigation_runs as r
   where r.investigation_id = p_investigation_id
     and r.status in ('queued', 'running')
   order by r.created_at desc
   limit 1
   for update;

  v_expires := v_now + make_interval(secs => p_lease_seconds);
  if found then
    if v_run.status = 'running'
       and v_run.lease_owner is distinct from p_lease_owner
       and v_run.lease_expires_at is not null
       and v_run.lease_expires_at > v_now then
      return query select v_run.id, false, v_run.status, v_run.lease_expires_at,
        v_run.acceptance_state = 'accepted', v_run.accepted_at;
      return;
    end if;

    update public.investigation_runs
       set status = 'running',
           request_id = coalesce(request_id, p_request_id),
           requires_transient_anchor = requires_transient_anchor or
             p_requires_transient_anchor,
           lease_owner = p_lease_owner,
           lease_expires_at = v_expires,
           attempts = attempts + 1,
           updated_at = v_now
     where id = v_run.id;
    return query select v_run.id, true, 'running'::text, v_expires,
      v_run.acceptance_state = 'accepted', v_run.accepted_at;
    return;
  end if;

  insert into public.investigation_runs (
    investigation_id, status, request_id, requires_transient_anchor,
    lease_owner, lease_expires_at, attempts
  ) values (
    p_investigation_id, 'running', p_request_id, p_requires_transient_anchor,
    p_lease_owner, v_expires, 1
  ) returning id into v_run.id;

  return query select v_run.id, true, 'running'::text, v_expires, false,
    null::timestamptz;
end;
$$;

revoke all on function public.claim_investigation_run(uuid, uuid, integer, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_investigation_run(uuid, uuid, integer, uuid, boolean)
  to service_role;

drop function if exists public.mark_investigation_run_enqueued(uuid, uuid);
create or replace function public.mark_investigation_run_enqueued(
  p_run_id uuid,
  p_lease_owner uuid
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
  if p_run_id is null or p_lease_owner is null then
    raise exception 'invalid investigation run acceptance' using errcode = '22023';
  end if;

  update public.investigation_runs as r
     set acceptance_state = 'accepted',
         accepted_at = coalesce(r.accepted_at, clock_timestamp()),
         updated_at = clock_timestamp()
   where r.id = p_run_id
     and r.status = 'running'
     and r.lease_owner = p_lease_owner
     and r.lease_expires_at > clock_timestamp()
  returning r.accepted_at into v_accepted_at;
  get diagnostics v_count = row_count;
  return query select v_count = 1, v_accepted_at;
end;
$$;

revoke all on function public.mark_investigation_run_enqueued(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_investigation_run_enqueued(uuid, uuid)
  to service_role;

-- search の成果物が永続化された後は、以降の step が GPS anchor を必要としない
-- ことを同じ owner/lease の検証下で確定する。座標そのものは保存しない。
create or replace function public.mark_investigation_run_anchor_consumed(
  p_run_id uuid,
  p_lease_owner uuid
)
returns table(consumed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null then
    raise exception 'invalid investigation run anchor state' using errcode = '22023';
  end if;

  update public.investigation_runs
     set requires_transient_anchor = false,
         updated_at = clock_timestamp()
   where id = p_run_id
     and status = 'running'
     and lease_owner = p_lease_owner
     and lease_expires_at > clock_timestamp();
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.mark_investigation_run_anchor_consumed(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_investigation_run_anchor_consumed(uuid, uuid)
  to service_role;

create or replace function public.renew_investigation_run(
  p_run_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer default 180,
  p_current_step text default null
)
returns table(renewed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null
     or p_lease_seconds is null or p_lease_seconds not between 30 and 600
     or p_current_step is not null and char_length(p_current_step) > 80 then
    raise exception 'invalid investigation run lease' using errcode = '22023';
  end if;

  update public.investigation_runs
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         current_step = coalesce(p_current_step, current_step),
         updated_at = clock_timestamp()
   where id = p_run_id
     and status = 'running'
     and lease_owner = p_lease_owner
     and lease_expires_at > clock_timestamp();
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.renew_investigation_run(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.renew_investigation_run(uuid, uuid, integer, text)
  to service_role;

create or replace function public.requeue_investigation_run(
  p_run_id uuid,
  p_lease_owner uuid,
  p_error_code text default null
)
returns table(requeued boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null
     or p_error_code is not null and char_length(p_error_code) > 80 then
    raise exception 'invalid investigation run requeue' using errcode = '22023';
  end if;

  update public.investigation_runs
     set status = 'queued',
         lease_owner = null,
         lease_expires_at = null,
         last_error_code = coalesce(p_error_code, last_error_code),
         updated_at = clock_timestamp()
   where id = p_run_id and status = 'running' and lease_owner = p_lease_owner
     and lease_expires_at > clock_timestamp();
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.requeue_investigation_run(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.requeue_investigation_run(uuid, uuid, text)
  to service_role;

create or replace function public.reject_investigation_run(
  p_run_id uuid,
  p_lease_owner uuid,
  p_error_code text
)
returns table(rejected boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null
     or p_error_code is null or char_length(p_error_code) > 80 then
    raise exception 'invalid investigation run rejection' using errcode = '22023';
  end if;

  update public.investigation_runs
     set status = 'rejected',
         acceptance_state = 'rejected',
         accepted_at = null,
         lease_owner = null,
         lease_expires_at = null,
         last_error_code = p_error_code,
         updated_at = clock_timestamp()
   where id = p_run_id and status = 'running' and lease_owner = p_lease_owner
     and lease_expires_at > clock_timestamp();
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.reject_investigation_run(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reject_investigation_run(uuid, uuid, text)
  to service_role;

-- anchor を持たない stale worker の再配送は、座標を捏造して検索を続けない。
-- run、investigation、location_anchor_required event を同じ transaction で終端化し、
-- 同一 run の再送だけを no-op にする。明示的な新 run は別 event を持てる。
create or replace function public.finish_investigation_run_location_anchor_required(
  p_run_id uuid,
  p_lease_owner uuid,
  p_request_id uuid default null
)
returns table(finished boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.investigation_runs%rowtype;
  v_investigation_id uuid;
begin
  if p_run_id is null or p_lease_owner is null then
    raise exception 'invalid location anchor run finish' using errcode = '22023';
  end if;

  select r.investigation_id into v_investigation_id
    from public.investigation_runs as r
   where r.id = p_run_id;
  if not found then
    return query select false;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('oisint-run:' || v_investigation_id::text)
  );
  perform 1
    from public.investigations as i
   where i.id = v_investigation_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  select * into v_run
    from public.investigation_runs as r
   where r.id = p_run_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  if v_run.status = 'rejected'
     and v_run.last_error_code = 'location_anchor_required' then
    return query select true;
    return;
  end if;
  if v_run.status <> 'running'
     or v_run.lease_owner is distinct from p_lease_owner
     or v_run.lease_expires_at <= clock_timestamp() then
    return query select false;
    return;
  end if;

  update public.investigation_runs
     set status = 'rejected',
         acceptance_state = 'rejected',
         accepted_at = null,
         lease_owner = null,
         lease_expires_at = null,
         completed_at = clock_timestamp(),
         current_step = 'searching',
         last_error_code = 'location_anchor_required',
         updated_at = clock_timestamp()
   where id = p_run_id;

  update public.investigations
     set status = 'draft'
   where id = v_investigation_id;

  insert into public.investigation_events (
    investigation_id, event_type, message, metadata
  )
  select v_investigation_id, 'location_anchor_required',
    '現在地を検索に使用できませんでした。駅名・地名を入力してください。',
    jsonb_build_object(
      'reason', 'location_anchor_required',
      'run_id', v_run.id,
      'request_id', p_request_id
    )
   where not exists (
     select 1 from public.investigation_events
      where investigation_id = v_investigation_id
        and event_type = 'location_anchor_required'
        and metadata ->> 'run_id' = v_run.id::text
   );

  return query select true;
end;
$$;

revoke all on function public.finish_investigation_run_location_anchor_required(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_investigation_run_location_anchor_required(uuid, uuid, uuid)
  to service_role;

create or replace function public.finish_investigation_run(
  p_run_id uuid,
  p_lease_owner uuid,
  p_status text,
  p_error_code text default null,
  p_request_id uuid default null
)
returns table(finished boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.investigation_runs%rowtype;
  v_investigation_id uuid;
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null
     or p_status is null or p_status not in ('complete', 'failed')
     or p_error_code is not null and char_length(p_error_code) > 80 then
    raise exception 'invalid investigation run finish' using errcode = '22023';
  end if;

  if p_status = 'complete' then
    return query
      select finished
        from public.finish_investigation_run_complete(
          p_run_id, p_lease_owner, p_request_id
        );
    return;
  end if;

  -- generic fallback も terminal RPC と同じロック順にする。通常完了は専用の
  -- finish_investigation_run_complete を通り、failed fallback は安全な固定eventを
  -- このtransaction内で残す。
  select r.investigation_id into v_investigation_id
    from public.investigation_runs as r
   where r.id = p_run_id;
  if not found then
    return query select false;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('oisint-run:' || v_investigation_id::text)
  );
  perform 1
    from public.investigations as i
   where i.id = v_investigation_id
   for update;
  if not found then
    return query select false;
    return;
  end if;
  select * into v_run
    from public.investigation_runs as r
   where r.id = p_run_id
     and r.status = 'running'
     and r.lease_owner = p_lease_owner
     and r.lease_expires_at > clock_timestamp()
   for update;
  if not found then
    return query select false;
    return;
  end if;

  update public.investigation_runs
     set status = p_status,
         lease_owner = null,
         lease_expires_at = null,
         completed_at = clock_timestamp(),
         last_error_code = coalesce(p_error_code, last_error_code),
         updated_at = clock_timestamp()
   where id = p_run_id;
  get diagnostics v_count = row_count;

  if p_status = 'failed' then
    update public.investigations
       set status = 'failed'
     where id = v_investigation_id;
    insert into public.investigation_events (
      investigation_id, event_type, message, metadata
    )
    select v_investigation_id, 'investigation_failed',
      '調査の失敗状態を保存できなかったため停止しました',
      jsonb_build_object(
        'step', coalesce(v_run.current_step, 'unknown'),
        'code', coalesce(p_error_code, 'failure_persistence_error'),
        'run_id', v_run.id,
        'request_id', p_request_id
      )
     where not exists (
       select 1 from public.investigation_events
        where investigation_id = v_investigation_id
          and event_type = 'investigation_failed'
          and metadata ->> 'run_id' = v_run.id::text
     );
  end if;
  return query select v_count = 1;
end;
$$;

revoke all on function public.finish_investigation_run(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_investigation_run(uuid, uuid, text, text, uuid)
  to service_role;

-- 通常完了は run / investigation / complete event を同一 transaction で
-- terminal 化する。run だけ先に complete になり、worker 停止で investigation が
-- searching のまま残る中間状態を作らない。event の run_id は非PIIの冪等キーで、
-- 同一 run の再送だけを抑止し、明示的な新 run の完了イベントは別に残す。
create or replace function public.finish_investigation_run_complete(
  p_run_id uuid,
  p_lease_owner uuid,
  p_request_id uuid default null
)
returns table(finished boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.investigation_runs%rowtype;
  v_investigation public.investigations%rowtype;
  v_investigation_id uuid;
begin
  if p_run_id is null or p_lease_owner is null then
    raise exception 'invalid complete investigation run' using errcode = '22023';
  end if;

  -- claim / no_candidates / technical terminal RPC と同じ順序でロックする。
  select r.investigation_id into v_investigation_id
    from public.investigation_runs as r
   where r.id = p_run_id;
  if not found then
    return query select false;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('oisint-run:' || v_investigation_id::text)
  );

  select * into v_investigation
    from public.investigations
   where id = v_investigation_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  select * into v_run
    from public.investigation_runs
   where id = p_run_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  -- 同じ terminal RPC の再呼出しは完全な no-op とする。明示的な新 run が
  -- 既に進行中でも、古い worker の再送で investigation を complete に戻さない。
  if v_run.status = 'complete' then
    return query select true;
    return;
  end if;
  if v_run.status <> 'running'
     or v_run.lease_owner is distinct from p_lease_owner
     or v_run.lease_expires_at <= clock_timestamp() then
    return query select false;
    return;
  end if;

  update public.investigation_runs
     set status = 'complete',
         lease_owner = null,
         lease_expires_at = null,
         current_step = 'complete',
         completed_at = clock_timestamp(),
         last_error_code = null,
         updated_at = clock_timestamp()
   where id = p_run_id;

  update public.investigations
     set status = 'complete'
   where id = v_investigation.id;

  insert into public.investigation_events (
    investigation_id, event_type, message, metadata
  )
  select v_investigation.id, 'step_started', '調査が完了しました',
    jsonb_build_object(
      'step', 'complete',
      'run_id', v_run.id,
      'request_id', p_request_id
    )
   where not exists (
     select 1 from public.investigation_events
      where investigation_id = v_investigation.id
        and event_type = 'step_started'
        and metadata ->> 'step' = 'complete'
        and metadata ->> 'run_id' = v_run.id::text
   );

  return query select true;
end;
$$;

revoke all on function public.finish_investigation_run_complete(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_investigation_run_complete(uuid, uuid, uuid)
  to service_role;

-- 候補0件は技術失敗の retry ではなく、investigation と run を同時に
-- terminal failed へ倒す結果。run の lease 検証から status/event の記録までを
-- 1 transaction に閉じ、worker 中断後の部分状態と同一runの重複 provider 再呼出しを防ぐ。
create or replace function public.finish_investigation_run_no_candidates(
  p_run_id uuid,
  p_lease_owner uuid,
  p_request_id uuid default null
)
returns table(finished boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.investigation_runs%rowtype;
  v_investigation public.investigations%rowtype;
  v_investigation_id uuid;
begin
  if p_run_id is null or p_lease_owner is null then
    raise exception 'invalid no-candidates run finish' using errcode = '22023';
  end if;

  -- claim_investigation_run と同じ investigation -> run の順でロックする。
  -- 逆順にすると、終端化と再claimの並行要求が相互待ちになる。
  select r.investigation_id into v_investigation_id
    from public.investigation_runs as r
   where r.id = p_run_id;
  if not found then
    return query select false;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('oisint-run:' || v_investigation_id::text)
  );

  select * into v_investigation
    from public.investigations
   where id = v_investigation_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  select * into v_run
    from public.investigation_runs
   where id = p_run_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  -- 同じ terminal RPC の再呼出しは no-op（event の重複なし）にする。
  if v_run.status <> 'running' then
    if v_run.status <> 'failed'
       or v_run.last_error_code is distinct from 'no_candidates' then
      return query select false;
      return;
    end if;
    -- 既にこの run の terminal transaction が commit 済みなら、再呼出しは
    -- 完全な no-op にする。明示的な新 run が進行中の investigation を、古い
    -- no_candidates の再送で failed に巻き戻してはならない。
    return query select true;
    return;
  else
    if v_run.lease_owner <> p_lease_owner
       or v_run.lease_expires_at <= clock_timestamp() then
      return query select false;
      return;
    end if;
    update public.investigation_runs
       set status = 'failed',
           lease_owner = null,
           lease_expires_at = null,
           completed_at = clock_timestamp(),
           last_error_code = 'no_candidates',
           updated_at = clock_timestamp()
     where id = p_run_id;
  end if;

  update public.investigations
     set status = 'failed'
   where id = v_investigation.id;

  insert into public.investigation_events (
    investigation_id, event_type, message, metadata
  )
  select v_investigation.id, 'no_candidates',
    '条件を少し緩めてください', jsonb_build_object(
      'run_id', v_run.id,
      'request_id', p_request_id
    )
   where not exists (
     select 1 from public.investigation_events
      where investigation_id = v_investigation.id
        and event_type = 'no_candidates'
        and metadata ->> 'run_id' = v_run.id::text
   );

  insert into public.investigation_events (
    investigation_id, event_type, message, metadata
  )
  select v_investigation.id, 'investigation_failed',
    '候補が 0 件のため調査を停止しました',
    jsonb_build_object(
      'step', 'searching',
      'code', 'no_candidates',
      'run_id', v_run.id,
      'request_id', p_request_id
    )
   where not exists (
     select 1 from public.investigation_events
      where investigation_id = v_investigation.id
        and event_type = 'investigation_failed'
        and metadata ->> 'code' = 'no_candidates'
        and metadata ->> 'run_id' = v_run.id::text
   );

  return query select true;
end;
$$;

revoke all on function public.finish_investigation_run_no_candidates(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_investigation_run_no_candidates(uuid, uuid, uuid)
  to service_role;

create or replace function public.record_investigation_run_failure(
  p_run_id uuid,
  p_lease_owner uuid,
  p_step text,
  p_error_code text,
  p_max_failures integer default 3,
  p_request_id uuid default null
)
returns table(failure_count integer, terminal boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.investigation_runs%rowtype;
  v_investigation_id uuid;
  v_count integer;
  v_failures jsonb;
begin
  if p_run_id is null or p_lease_owner is null
     or p_step is null or char_length(p_step) > 80
     or p_error_code is null or char_length(p_error_code) > 80
     or p_max_failures is null or p_max_failures not between 1 and 10 then
    raise exception 'invalid investigation run failure' using errcode = '22023';
  end if;

  -- claim / complete / no_candidates と同じ advisory -> investigation -> run
  -- の順でロックし、terminal failure と stale re-claim の deadlock を防ぐ。
  select r.investigation_id into v_investigation_id
    from public.investigation_runs as r
   where r.id = p_run_id;
  if not found then
    return query select 0, false;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('oisint-run:' || v_investigation_id::text)
  );
  perform 1
    from public.investigations as i
   where i.id = v_investigation_id
   for update;
  if not found then
    return query select 0, false;
    return;
  end if;
  select * into v_run
    from public.investigation_runs as r
   where r.id = p_run_id
     and r.status = 'running'
     and r.lease_owner = p_lease_owner
     and r.lease_expires_at > clock_timestamp()
   for update;
  if not found then
    return query select 0, false;
    return;
  end if;

  v_count := coalesce(nullif(v_run.step_failures ->> p_step, '')::integer, 0) + 1;
  v_failures := jsonb_set(v_run.step_failures, array[p_step], to_jsonb(v_count), true);
  update public.investigation_runs
     set status = case when v_count >= p_max_failures then 'failed' else 'queued' end,
         lease_owner = null,
         lease_expires_at = null,
         step_failures = v_failures,
         current_step = p_step,
         last_error_code = p_error_code,
         completed_at = case when v_count >= p_max_failures then clock_timestamp() else null end,
         updated_at = clock_timestamp()
   where id = p_run_id;

  if v_count >= p_max_failures then
    -- terminal failure の run/investigation/event を同一 transaction で確定する。
    -- run 更新直後に worker が停止しても、active run が消えたまま investigation
    -- が searching に残り、次回要求が provider を再実行する窓を作らない。
    update public.investigations
       set status = 'failed'
     where id = v_run.investigation_id;

    insert into public.investigation_events (
      investigation_id, event_type, message, metadata
    )
    select v_run.investigation_id, 'investigation_failed',
      'ステップが連続して失敗したため調査を停止しました',
      jsonb_build_object(
        'step', p_step,
        'code', p_error_code,
        'run_id', v_run.id,
        'request_id', p_request_id
      )
     where not exists (
       select 1 from public.investigation_events
        where investigation_id = v_run.investigation_id
          and event_type = 'investigation_failed'
          and metadata ->> 'run_id' = v_run.id::text
     );
  end if;

  return query select v_count, v_count >= p_max_failures;
end;
$$;

revoke all on function public.record_investigation_run_failure(uuid, uuid, text, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.record_investigation_run_failure(uuid, uuid, text, text, integer, uuid)
  to service_role;

create or replace function public.reset_investigation_run_failure(
  p_run_id uuid,
  p_lease_owner uuid,
  p_step text
)
returns table(reset boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null
     or p_step is null or char_length(p_step) > 80 then
    raise exception 'invalid investigation run failure reset' using errcode = '22023';
  end if;
  update public.investigation_runs
     set step_failures = jsonb_set(step_failures, array[p_step], to_jsonb(0), true),
         last_error_code = null,
         updated_at = clock_timestamp()
   where id = p_run_id and status = 'running' and lease_owner = p_lease_owner
     and lease_expires_at > clock_timestamp();
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.reset_investigation_run_failure(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reset_investigation_run_failure(uuid, uuid, text)
  to service_role;

create or replace function public.link_investigation_run_usage(
  p_run_id uuid,
  p_lease_owner uuid,
  p_usage_id bigint
)
returns table(linked boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_run_id is null or p_lease_owner is null or p_usage_id is null then
    raise exception 'invalid investigation run usage link' using errcode = '22023';
  end if;
  update public.investigation_runs as r
     set provider_usage_id = coalesce(r.provider_usage_id, p_usage_id),
         updated_at = clock_timestamp()
   where r.id = p_run_id and r.status = 'running' and r.lease_owner = p_lease_owner
     and r.lease_expires_at > clock_timestamp()
     and (r.provider_usage_id is null or r.provider_usage_id = p_usage_id)
     and exists (
       select 1
         from public.provider_usage as pu
        where pu.id = p_usage_id
          and pu.investigation_run_id = p_run_id
          and pu.investigation_id = r.investigation_id
          and pu.action = 'run'
          and pu.status = 'reserved'
     );
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.link_investigation_run_usage(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.link_investigation_run_usage(uuid, uuid, bigint)
  to service_role;

-- run_id を idempotency key として使う予約RPC。旧 reserve_provider_budget は create /
-- rerank との互換性のため残し、run だけこちらを呼ぶ。
create or replace function public.reserve_provider_budget_for_run(
  p_action text,
  p_investigation_id uuid,
  p_run_id uuid,
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
  v_now timestamptz := clock_timestamp();
  v_jst_date date := timezone('Asia/Tokyo', v_now)::date;
  v_month_start date := date_trunc('month', v_jst_date::timestamp)::date;
  v_live_enabled boolean;
  v_daily_used bigint := 0;
  v_monthly_used bigint := 0;
  v_usage_id bigint;
  v_existing_status text;
  v_existing_reason text;
  v_reason text := null;
  v_alerts smallint[] := '{}'::smallint[];
  v_threshold smallint;
  v_inserted integer;
begin
  if p_action is null or p_action <> 'run' or p_investigation_id is null
     or p_run_id is null
     or p_provider is null or char_length(p_provider) not between 2 and 80
     or p_model is not null and char_length(p_model) > 100
     or p_mode is null or p_mode not in ('live', 'mock')
     or p_estimated_cost_microusd is null
     or p_estimated_cost_microusd not between 0 and 1000000000
     or p_daily_limit_microusd is null
     or p_daily_limit_microusd not between 1 and 1000000000000
     or p_monthly_limit_microusd is null
     or p_monthly_limit_microusd not between 1 and 10000000000000
     or p_enforce is null then
    raise exception 'invalid run provider budget reservation' using errcode = '22023';
  end if;

  -- The run id is the reservation idempotency key, but the investigation id is
  -- still an untrusted caller argument. Require the pair to belong together
  -- before creating any provider_usage row; otherwise a service caller bug
  -- could charge one investigation against another run.
  if not exists (
    select 1
     from public.investigation_runs as r
     where r.id = p_run_id
       and r.investigation_id = p_investigation_id
       and r.status in ('queued', 'running')
  ) then
    raise exception 'run and investigation do not match' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('oisint-provider-budget'));

  select pu.status, pu.stop_reason, pu.id
    into v_existing_status, v_existing_reason, v_usage_id
    from public.provider_usage as pu
   where pu.investigation_run_id = p_run_id and pu.action = p_action
   for update;
  if found then
    return query select v_existing_status = 'reserved', v_existing_reason, v_usage_id,
      0::bigint, 0::bigint, v_alerts;
    return;
  end if;

  if p_enforce then
    select enabled into v_live_enabled
      from public.runtime_controls
     where key = 'provider_live'
     for update;
    if not found or not v_live_enabled then
      v_reason := 'kill_switch';
    end if;

    select coalesce(sum(estimated_cost_microusd), 0) into v_daily_used
      from public.provider_usage
     where mode = 'live' and status = 'reserved'
       and timezone('Asia/Tokyo', created_at)::date = v_jst_date;
    select coalesce(sum(estimated_cost_microusd), 0) into v_monthly_used
      from public.provider_usage
     where mode = 'live' and status = 'reserved'
       and timezone('Asia/Tokyo', created_at)::date >= v_month_start
       and timezone('Asia/Tokyo', created_at)::date < (v_month_start + interval '1 month')::date;
    if v_reason is null and v_daily_used + p_estimated_cost_microusd > p_daily_limit_microusd then
      v_reason := 'daily_budget';
    end if;
    if v_reason is null and v_monthly_used + p_estimated_cost_microusd > p_monthly_limit_microusd then
      v_reason := 'monthly_budget';
    end if;
  end if;

  insert into public.provider_usage (
    investigation_id, investigation_run_id, action, provider, model, mode, status,
    estimated_cost_microusd, stop_reason, created_at
  ) values (
    p_investigation_id, p_run_id, p_action, p_provider, p_model, p_mode,
    case when v_reason is null then 'reserved' else 'denied' end,
    p_estimated_cost_microusd, v_reason, v_now
  ) returning id into v_usage_id;

  if v_reason is not null then
    return query select false, v_reason, v_usage_id, v_daily_used, v_monthly_used, v_alerts;
    return;
  end if;

  v_daily_used := v_daily_used + p_estimated_cost_microusd;
  v_monthly_used := v_monthly_used + p_estimated_cost_microusd;
  if p_enforce then
    foreach v_threshold in array array[50, 80, 100]::smallint[] loop
      if v_daily_used * 100 >= p_daily_limit_microusd * v_threshold then
        insert into public.provider_budget_alerts (
          period, period_start, threshold_percent, usage_id, used_microusd, limit_microusd
        ) values (
          'daily', v_jst_date, v_threshold, v_usage_id, v_daily_used, p_daily_limit_microusd
        ) on conflict do nothing;
        get diagnostics v_inserted = row_count;
        if v_inserted = 1 then v_alerts := array_append(v_alerts, v_threshold); end if;
      end if;
      if v_monthly_used * 100 >= p_monthly_limit_microusd * v_threshold then
        insert into public.provider_budget_alerts (
          period, period_start, threshold_percent, usage_id, used_microusd, limit_microusd
        ) values (
          'monthly', v_month_start, v_threshold, v_usage_id, v_monthly_used, p_monthly_limit_microusd
        ) on conflict do nothing;
        get diagnostics v_inserted = row_count;
        if v_inserted = 1 then v_alerts := array_append(v_alerts, (v_threshold * -1)::smallint); end if;
      end if;
    end loop;
  end if;
  return query select true, null::text, v_usage_id, v_daily_used, v_monthly_used, v_alerts;
end;
$$;

revoke all on function public.reserve_provider_budget_for_run(
  text, uuid, uuid, text, text, text, bigint, bigint, bigint, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_provider_budget_for_run(
  text, uuid, uuid, text, text, text, bigint, bigint, bigint, boolean
) to service_role;
