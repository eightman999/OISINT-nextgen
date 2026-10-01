-- =============================================================================
-- 091_privacy_boundary.sql — raw query / precise coordinate column boundary
-- (#151 / spec.md §33)
--
-- A = owner, B = joined member, C = non-member.  Direct sensitive-column
-- selection is denied for authenticated (including anonymous-auth sessions),
-- while owner-only RPCs return the minimum sensitive data only to A.
-- =============================================================================

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000091a', false),
  ('00000000-0000-0000-0000-00000000091b', true),
  ('00000000-0000-0000-0000-00000000091c', true);

insert into public.investigations (
  id, created_by, title, raw_query, share_token, visibility
) values (
  '00000000-0000-0000-0000-000000000911',
  '00000000-0000-0000-0000-00000000091a',
  '091 privacy fixture',
  'アレルギー情報と秘密の依頼文 091',
  'rls091secret_token_0000000000001',
  'public'
);

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-00000000091a', 'owner'),
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-00000000091b', 'viewer');

insert into public.places (
  id, provider, provider_place_id, name, address, lat, lng
) values (
  '00000000-0000-0000-0000-000000000912',
  'fixture', 'rls091-place', '091 shared place', '東京都 091',
  35.123456789, 139.987654321
);

insert into public.candidates (id, investigation_id, place_id, rank, score)
values (
  '00000000-0000-0000-0000-000000000913',
  '00000000-0000-0000-0000-000000000911',
  '00000000-0000-0000-0000-000000000912',
  1, 0.9
);

do $$
begin
  if has_column_privilege('authenticated', 'public.investigations', 'raw_query', 'SELECT') then
    raise exception 'FAIL(091/privilege): authenticated still has investigations.raw_query SELECT';
  end if;
  if has_column_privilege('authenticated', 'public.places', 'lat', 'SELECT')
     or has_column_privilege('authenticated', 'public.places', 'lng', 'SELECT') then
    raise exception 'FAIL(091/privilege): authenticated still has places lat/lng SELECT';
  end if;
end $$;

-- owner RPC は生の依頼文を正確に一行だけ返す。
begin;
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000091a","role":"authenticated"}';

do $$
declare
  v text;
  n int;
begin
  select count(*), max(raw_query) into n, v
  from public.get_investigation_owner_raw_query(
    '00000000-0000-0000-0000-000000000911'
  );
  if n <> 1 or v <> 'アレルギー情報と秘密の依頼文 091' then
    raise exception 'FAIL(091/owner-query): owner RPC returned unexpected row count/value (% / %)', n, v;
  end if;

  select count(*) into n
  from public.get_investigation_owner_place_coordinates(
    '00000000-0000-0000-0000-000000000911'
  );
  if n <> 1 then
    raise exception 'FAIL(091/owner-coordinates): owner RPC returned % rows (expected 1)', n;
  end if;
end $$;
rollback;

-- joined member: owner RPC は常に空。直接 sensitive column は permission denied。
begin;
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000091b","role":"authenticated"}';

do $$
declare
  n int;
begin
  select count(*) into n
  from public.get_investigation_owner_raw_query(
    '00000000-0000-0000-0000-000000000911'
  );
  if n <> 0 then
    raise exception 'FAIL(091/member-query): joined member received % owner query rows', n;
  end if;

  select count(*) into n
  from public.get_investigation_owner_place_coordinates(
    '00000000-0000-0000-0000-000000000911'
  );
  if n <> 0 then
    raise exception 'FAIL(091/member-coordinates): joined member received % coordinate rows', n;
  end if;

  begin
    execute 'select raw_query from public.investigations where id = $1'
      using '00000000-0000-0000-0000-000000000911'::uuid;
    raise exception 'FAIL(091/member-direct-query): raw_query direct select succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    execute 'select lat, lng from public.places where id = $1'
      using '00000000-0000-0000-0000-000000000912'::uuid;
    raise exception 'FAIL(091/member-direct-coordinates): lat/lng direct select succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;
rollback;

-- non-member/public-view caller: no owner RPC rows and no direct precise coordinates.
begin;
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000091c","role":"authenticated"}';

do $$
declare
  n int;
  j jsonb;
begin
  select count(*) into n
  from public.get_investigation_owner_raw_query(
    '00000000-0000-0000-0000-000000000911'
  );
  if n <> 0 then
    raise exception 'FAIL(091/public-query): non-member received % owner query rows', n;
  end if;

  select count(*) into n
  from public.get_investigation_owner_place_coordinates(
    '00000000-0000-0000-0000-000000000911'
  );
  if n <> 0 then
    raise exception 'FAIL(091/public-coordinates): non-member received % coordinate rows', n;
  end if;

  select to_jsonb(t) into j
  from public.get_public_investigation(
    '00000000-0000-0000-0000-000000000911'
  ) t;
  if j ? 'raw_query' or j ? 'lat' or j ? 'lng' or j ? 'share_token' then
    raise exception 'FAIL(091/public-rpc): public metadata leaks sensitive fields: %', j;
  end if;
end $$;
rollback;


\echo == 091_privacy_boundary.sql: all assertions passed
