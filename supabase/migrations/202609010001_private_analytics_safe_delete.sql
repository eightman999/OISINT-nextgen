-- 202609010001: make analytics snapshot invalidation compatible with pg_safeupdate
--
-- PostgREST connections reject DELETE statements without an explicit WHERE
-- clause.  Snapshot invalidation intentionally removes every aggregate row,
-- so preserve that behavior while making the all-row scope explicit.

create or replace function public._invalidate_private_analytics_snapshots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oisint:private-analytics-snapshot', 0)
  );
  delete from public.private_analytics_snapshots where true;
  return null;
end;
$function$;

revoke all on function public._invalidate_private_analytics_snapshots()
  from public, anon, authenticated, service_role;

create or replace function public.set_private_analytics_opt_out(p_opted_out boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(current_setting('role', true), '');
begin
  if v_role not in ('authenticated', 'service_role')
     or auth.uid() is null
     or not public.current_user_is_permanent()
     or p_opted_out is null then
    raise exception 'permanent authenticated user and boolean setting required' using errcode = '42501';
  end if;

  if p_opted_out then
    insert into public.private_analytics_opt_outs (user_id)
    values (auth.uid())
    on conflict (user_id) do update set opted_out_at = excluded.opted_out_at;
  else
    delete from public.private_analytics_opt_outs
     where user_id = auth.uid();
  end if;

  delete from public.private_analytics_snapshots where true;
  return p_opted_out;
end;
$function$;

revoke all on function public.set_private_analytics_opt_out(boolean)
  from public, anon, authenticated;
grant execute on function public.set_private_analytics_opt_out(boolean)
  to authenticated, service_role;
