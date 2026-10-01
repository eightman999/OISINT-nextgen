-- 0014: live providerの概算コスト台帳・日次/月次上限・即時kill switch (#164)

create table public.runtime_controls (
  key text primary key,
  enabled boolean not null,
  reason text check (reason is null or char_length(reason) <= 200),
  updated_at timestamptz not null default now()
);

insert into public.runtime_controls (key, enabled, reason)
values ('provider_live', true, null);

create table public.provider_usage (
  id bigint generated always as identity primary key,
  investigation_id uuid references public.investigations(id) on delete set null,
  action text not null check (action in ('create', 'run', 'rerank')),
  provider text not null check (char_length(provider) between 2 and 80),
  model text check (model is null or char_length(model) <= 100),
  mode text not null check (mode in ('live', 'mock')),
  status text not null check (status in ('reserved', 'denied')),
  estimated_cost_microusd bigint not null check (estimated_cost_microusd >= 0),
  stop_reason text check (stop_reason is null or stop_reason in (
    'kill_switch', 'daily_budget', 'monthly_budget'
  )),
  created_at timestamptz not null default now()
);

create index idx_provider_usage_budget_window
  on public.provider_usage (mode, status, created_at);
create index idx_provider_usage_investigation
  on public.provider_usage (investigation_id, created_at);

create table public.provider_budget_alerts (
  period text not null check (period in ('daily', 'monthly')),
  period_start date not null,
  threshold_percent smallint not null check (threshold_percent in (50, 80, 100)),
  usage_id bigint not null references public.provider_usage(id) on delete cascade,
  used_microusd bigint not null check (used_microusd >= 0),
  limit_microusd bigint not null check (limit_microusd > 0),
  created_at timestamptz not null default now(),
  primary key (period, period_start, threshold_percent)
);

alter table public.runtime_controls enable row level security;
alter table public.provider_usage enable row level security;
alter table public.provider_budget_alerts enable row level security;
revoke all on public.runtime_controls, public.provider_usage, public.provider_budget_alerts
  from public, anon, authenticated;
grant select, update on public.runtime_controls to service_role;
grant select, insert, update on public.provider_usage to service_role;
grant select, insert on public.provider_budget_alerts to service_role;
grant usage, select on sequence public.provider_usage_id_seq to service_role;

comment on table public.provider_usage is
  'Conservative cost reservations only. Raw queries, user IDs, IPs, API keys, and model output are prohibited.';
comment on table public.runtime_controls is
  'Emergency operational controls. Set provider_live.enabled=false to stop new live cost reservations immediately.';

create or replace function public.reserve_provider_budget(
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
  v_now timestamptz := clock_timestamp();
  v_jst_date date := timezone('Asia/Tokyo', v_now)::date;
  v_month_start date := date_trunc('month', v_jst_date::timestamp)::date;
  v_live_enabled boolean;
  v_daily_used bigint := 0;
  v_monthly_used bigint := 0;
  v_usage_id bigint;
  v_reason text := null;
  v_alerts smallint[] := '{}'::smallint[];
  v_threshold smallint;
  v_inserted integer;
begin
  if p_action not in ('create', 'run', 'rerank')
     or p_provider is null or char_length(p_provider) not between 2 and 80
     or p_model is not null and char_length(p_model) > 100
     or p_mode not in ('live', 'mock')
     or p_estimated_cost_microusd not between 0 and 1000000000
     or p_daily_limit_microusd not between 1 and 1000000000000
     or p_monthly_limit_microusd not between 1 and 10000000000000 then
    raise exception 'invalid provider budget reservation' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('oisint-provider-budget'));

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
     where mode = 'live'
       and status = 'reserved'
       and timezone('Asia/Tokyo', created_at)::date = v_jst_date;

    select coalesce(sum(estimated_cost_microusd), 0) into v_monthly_used
      from public.provider_usage
     where mode = 'live'
       and status = 'reserved'
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
    investigation_id, action, provider, model, mode, status,
    estimated_cost_microusd, stop_reason, created_at
  ) values (
    p_investigation_id, p_action, p_provider, p_model, p_mode,
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
    foreach v_threshold in array array[50, 80, 100]::smallint[]
    loop
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

revoke all on function public.reserve_provider_budget(
  text, uuid, text, text, text, bigint, bigint, bigint, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_provider_budget(
  text, uuid, text, text, text, bigint, bigint, bigint, boolean
) to service_role;

comment on function public.reserve_provider_budget(
  text, uuid, text, text, text, bigint, bigint, bigint, boolean
) is 'Atomically applies kill switch and JST daily/monthly estimated-cost budgets.';
