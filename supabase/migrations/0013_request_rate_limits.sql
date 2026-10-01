-- 0013: 外部API呼び出し前のuser/IP二重レート制限 (#161)
-- subject_hashにはHMAC-SHA256だけを保存し、user_idやIPの平文は保持しない。

create table public.request_rate_limits (
  scope text not null check (char_length(scope) between 3 and 80),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds between 60 and 86400),
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (scope, subject_hash, window_start)
);

create index idx_request_rate_limits_cleanup
  on public.request_rate_limits (window_start);

alter table public.request_rate_limits enable row level security;
revoke all on public.request_rate_limits from public, anon, authenticated;
grant all on public.request_rate_limits to service_role;

comment on table public.request_rate_limits is
  'Atomic rate counters. Subjects are HMAC-SHA256 values; raw user IDs and IP addresses are prohibited.';

create or replace function public.consume_request_rate_limits(p_limits jsonb)
returns table(is_allowed boolean, retry_after_seconds integer, exceeded_scope text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  v_scope text;
  v_subject_hash text;
  v_window_seconds integer;
  v_limit integer;
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_count integer;
  v_retry integer;
  v_allowed boolean := true;
  v_retry_after integer := 0;
  v_exceeded_scope text := null;
begin
  if jsonb_typeof(p_limits) <> 'array'
     or jsonb_array_length(p_limits) < 1
     or jsonb_array_length(p_limits) > 6 then
    raise exception 'invalid rate limit rules' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_limits)
  loop
    v_scope := item ->> 'scope';
    v_subject_hash := item ->> 'subject_hash';
    v_window_seconds := (item ->> 'window_seconds')::integer;
    v_limit := (item ->> 'limit')::integer;

    if v_scope is null or char_length(v_scope) not between 3 and 80
       or v_subject_hash is null or v_subject_hash !~ '^[0-9a-f]{64}$'
       or v_window_seconds not between 60 and 86400
       or v_limit not between 1 and 100000 then
      raise exception 'invalid rate limit rule' using errcode = '22023';
    end if;

    v_window_start := to_timestamp(
      floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds
    );

    insert into public.request_rate_limits (
      scope, subject_hash, window_start, window_seconds, request_count, updated_at
    ) values (
      v_scope, v_subject_hash, v_window_start, v_window_seconds, 1, v_now
    )
    on conflict (scope, subject_hash, window_start) do update set
      request_count = public.request_rate_limits.request_count + 1,
      updated_at = excluded.updated_at
    returning request_count into v_count;

    if v_count > v_limit then
      v_allowed := false;
      v_retry := greatest(
        1,
        ceil(extract(epoch from (
          v_window_start + make_interval(secs => v_window_seconds) - v_now
        )))::integer
      );
      if v_retry > v_retry_after then
        v_retry_after := v_retry;
        v_exceeded_scope := v_scope;
      end if;
    end if;
  end loop;

  return query select v_allowed, v_retry_after, v_exceeded_scope;
end;
$$;

revoke all on function public.consume_request_rate_limits(jsonb) from public, anon, authenticated;
grant execute on function public.consume_request_rate_limits(jsonb) to service_role;

comment on function public.consume_request_rate_limits(jsonb) is
  'Atomically consumes up to six user/IP windows in one DB round trip.';
