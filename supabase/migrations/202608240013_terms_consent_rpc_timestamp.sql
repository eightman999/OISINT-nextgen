-- 202608240013: Return the server timestamp from the terms-consent RPC (#272).
--
-- 202608230001 is already applied and is immutable.  PostgreSQL cannot change
-- a function's return type with CREATE OR REPLACE, so this forward migration
-- drops the old void-returning signature and recreates it with the explicit
-- timestamptz result consumed by the live client.

drop function if exists public.record_terms_consent(text);

create function public.record_terms_consent(p_terms_version text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_version text;
  v_accepted_at timestamptz;
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  if p_terms_version <> 'terms-v1' then
    raise exception 'unsupported terms consent version' using errcode = '22023';
  end if;

  -- Create the row before locking it so a first-consent race waits on the
  -- unique id conflict and then observes the committed timestamp.
  insert into public.profiles (id, display_name, terms_version, terms_accepted_at)
  values (auth.uid(), '', null, null)
  on conflict (id) do nothing;

  select terms_version, terms_accepted_at
    into v_existing_version, v_accepted_at
  from public.profiles
  where id = auth.uid()
  for update;

  -- A resend of the same version is idempotent: preserve both the first
  -- server timestamp and its single audit event.
  if v_existing_version = p_terms_version then
    return v_accepted_at;
  end if;

  update public.profiles
  set terms_version = p_terms_version, terms_accepted_at = now()
  where id = auth.uid()
  returning terms_accepted_at into v_accepted_at;

  insert into public.user_product_audit_events (
    actor_user_id, event_type, source, consent_version
  ) values (
    auth.uid(), 'terms_consent_accepted', 'account', p_terms_version
  );
  return v_accepted_at;
end;
$$;

revoke all on function public.record_terms_consent(text) from public;
grant execute on function public.record_terms_consent(text) to authenticated;
