\set ON_ERROR_STOP on
-- NOT EXECUTED during patch preparation. Standalone, rollback-only synthetic
-- PostgreSQL/pgvector regression. This is NOT the full migration/RLS suite.
-- Run only in a fresh local scratch database named oisint_recall_null_test.
-- Existing PostgreSQL and pgvector/pgcrypto installation required; no live DB.
begin;
do $$
begin
  if current_database() <> 'oisint_recall_null_test' then
    raise exception 'Run only in oisint_recall_null_test';
  end if;
  if to_regclass('public.investigations') is not null
     or to_regnamespace('auth') is not null
     or to_regnamespace('recall_fixture') is not null then
    raise exception 'A fresh isolated scratch database is required';
  end if;
end $$;

create extension if not exists vector with schema public;
create extension if not exists pgcrypto with schema public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Actual public initial table definitions and unmodified original RPCs.
\ir ../migrations/0002_tables.sql
create function public.is_investigation_member(inv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from investigation_members
                 where investigation_id = inv and user_id = auth.uid())
$$;
\ir ../migrations/0005_rpc.sql
\ir ../migrations/0008_p1_recall.sql

-- Synthetic deny-all RLS demonstrates that the definer's explicit owner/member
-- filter remains the boundary. These are not the application's full policies.
alter table public.investigations enable row level security;
alter table public.investigation_members enable row level security;
alter table public.candidates enable row level security;
alter table public.votes enable row level security;
alter table public.places enable row level security;
alter table public.requirements enable row level security;
grant select on public.investigations, public.investigation_members,
  public.candidates, public.votes, public.places, public.requirements to authenticated;

create schema recall_fixture;
grant usage on schema recall_fixture to authenticated, service_role;
create function recall_fixture.id(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function recall_fixture.vec(n real) returns vector language sql immutable as $$
  select (array[1::real, n] || array_fill(0::real, array[766]))::vector(768)
$$;
create function recall_fixture.assert(ok boolean, message text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', message; end if;
end $$;
create function recall_fixture.call_rpc(fn text, n int, omitted boolean, excluded uuid)
returns jsonb language plpgsql as $$
declare result jsonb; args text;
begin
  if fn not in ('match_investigations', 'match_investigation_places', 'match_requirement_kinds') then
    raise exception 'Unknown fixture RPC';
  end if;
  args := 'query_embedding => $1';
  if not omitted then args := args || ', match_count => $2'; end if;
  if fn <> 'match_investigations' then
    args := args || ', exclude_investigation => $3';
  end if;
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t) - ''ordinality'' order by ordinality), ''[]''::jsonb)
     from public.%I(%s) with ordinality t', fn, args)
    into result using recall_fixture.vec(0), n, excluded;
  return result;
exception when sqlstate '2201W' then
  return jsonb_build_object('sqlstate', sqlstate);
end $$;
grant execute on all functions in schema recall_fixture to authenticated, service_role;

insert into auth.users values
  (recall_fixture.id(100)), (recall_fixture.id(200)), (recall_fixture.id(300));
-- A owns 1,3..10 without membership rows. A is a member (not owner) of 2.
-- 11 is B-only and closer than every accessible vector; 12 has no embedding.
insert into public.investigations (id, created_by, title, raw_query, embedding)
select recall_fixture.id(i),
       recall_fixture.id(case when i in (2, 11) then 200 else 100 end),
       'Investigation ' || i, 'Synthetic private text ' || i,
       case when i = 12 then null else recall_fixture.vec(case when i = 11 then 0 else i end) end
from generate_series(1, 12) i;
insert into public.investigation_members (investigation_id, user_id, role)
values (recall_fixture.id(2), recall_fixture.id(100), 'viewer');
-- Two positively voted places and one negative place per investigation.
insert into public.places (id, provider, provider_place_id, name)
select recall_fixture.id(1000 + i * 10 + j), 'geoapify',
       'synthetic-recall-' || i || '-' || j, 'P ' || i || ' ' || j
from generate_series(1, 12) i cross join generate_series(1, 3) j;
insert into public.candidates (id, investigation_id, place_id)
select recall_fixture.id(2000 + i * 10 + j), recall_fixture.id(i),
       recall_fixture.id(1000 + i * 10 + j)
from generate_series(1, 12) i cross join generate_series(1, 3) j;
insert into public.votes (investigation_id, candidate_id, user_id, value, updated_at)
select recall_fixture.id(i), recall_fixture.id(2000 + i * 10 + j),
       recall_fixture.id(case when i in (2, 11) then 200 else 100 end),
       case when j = 3 then -1 else 1 end, '2026-01-01 00:00:00+00'::timestamptz
from generate_series(1, 12) i cross join generate_series(1, 3) j;
-- 12 kind/priority groups exceed the declared default 8. Distinct sort keys.
insert into public.requirements (investigation_id, created_by, text, kind, priority)
select recall_fixture.id(i), recall_fixture.id(100), 'Synthetic private requirement',
       'k' || lpad(k::text, 2, '0'), 'should'
from generate_series(1, 12) i cross join generate_series(1, 12) k;
insert into public.requirements (investigation_id, text, kind, priority) values
  (recall_fixture.id(9), 'Tail marker', 'tail', 'nice'),
  (recall_fixture.id(10), 'Tail marker', 'tail', 'nice'),
  (recall_fixture.id(11), 'Hidden marker', 'hidden', 'nice'),
  (recall_fixture.id(1), 'Null kind marker', null, 'nice'),
  (recall_fixture.id(1), 'Null priority marker', 'null-priority', null);

-- Catalog snapshot excludes only the deliberately modified function body.
create table recall_fixture.catalog_before as
select oid, proname, proowner, proacl, proconfig, provolatile, prosecdef, proisstrict,
       prorettype, proretset, proargtypes, proallargtypes, proargmodes, proargnames,
       pronargdefaults, pg_get_expr(proargdefaults, 0) as defaults, prolang,
       pg_get_function_result(oid) as result
from pg_proc where oid in (
  'public.match_investigations(vector,integer)'::regprocedure,
  'public.match_investigation_places(vector,integer,uuid)'::regprocedure,
  'public.match_requirement_kinds(vector,integer,uuid)'::regprocedure);
create table recall_fixture.baseline (
  fn text, actor int, n int, omitted boolean, excluded uuid, result jsonb
);
grant insert, select on recall_fixture.baseline to authenticated;

set local role authenticated;
do $$
declare fn text; actor int; n int; excluded uuid; omitted boolean;
begin
  foreach actor in array array[100, 200, 300, 0] loop
    perform set_config('request.jwt.claims',
      case when actor = 0 then '{"role":"authenticated"}'
           else jsonb_build_object('sub', recall_fixture.id(actor), 'role', 'authenticated')::text end, true);
    perform recall_fixture.assert((select count(*) from public.investigations) = 0,
      'synthetic deny-all RLS must hide direct table reads');
    foreach fn in array array['match_investigations', 'match_investigation_places', 'match_requirement_kinds'] loop
      foreach excluded in array array[null::uuid, recall_fixture.id(1)] loop
        if fn = 'match_investigations' and excluded is not null then continue; end if;
        insert into recall_fixture.baseline values
          (fn, actor, null, true, excluded, recall_fixture.call_rpc(fn, null, true, excluded));
        foreach n in array array[null::int, 0, 1, 3, 5, 6, 8, 9, 12, 2147483647, -1] loop
          insert into recall_fixture.baseline values
            (fn, actor, n, false, excluded, recall_fixture.call_rpc(fn, n, false, excluded));
        end loop;
      end loop;
    end loop;
  end loop;
end $$;
reset role;

-- Reproduce the original NULL behavior with more rows than each default.
do $$
declare v_fn text; expected int;
begin
  foreach v_fn in array array['match_investigations', 'match_investigation_places', 'match_requirement_kinds'] loop
    expected := case v_fn when 'match_investigations' then 10 when 'match_investigation_places' then 16 else 12 end;
    perform recall_fixture.assert(
      (select jsonb_array_length(result) from recall_fixture.baseline
       where baseline.fn = v_fn and actor = 100 and n is null and not omitted and excluded is null) = expected,
      v_fn || ': pre-migration explicit NULL must exceed default');
  end loop;
end $$;

\ir ../migrations/202610120002_recall_null_limit.sql

-- CREATE OR REPLACE must preserve identity, ownership, ACL and attributes.
select recall_fixture.assert(
  not exists (
    select 1 from recall_fixture.catalog_before b join pg_proc p on p.oid = b.oid
    where to_jsonb(b) is distinct from jsonb_build_object(
      'oid', p.oid, 'proname', p.proname, 'proowner', p.proowner, 'proacl', p.proacl,
      'proconfig', p.proconfig, 'provolatile', p.provolatile, 'prosecdef', p.prosecdef,
      'proisstrict', p.proisstrict, 'prorettype', p.prorettype, 'proretset', p.proretset,
      'proargtypes', p.proargtypes, 'proallargtypes', p.proallargtypes,
      'proargmodes', p.proargmodes, 'proargnames', p.proargnames,
      'pronargdefaults', p.pronargdefaults, 'defaults', pg_get_expr(p.proargdefaults, 0),
      'prolang', p.prolang, 'result', pg_get_function_result(p.oid))
  ) and (select count(*) from recall_fixture.catalog_before b join pg_proc p on p.oid = b.oid) = 3,
  'function identity, owner, ACL, defaults, result columns and attributes must be unchanged');
select recall_fixture.assert(
  bool_and(not has_function_privilege('anon', oid, 'EXECUTE')
           and has_function_privilege('authenticated', oid, 'EXECUTE')
           and has_function_privilege('service_role', oid, 'EXECUTE')),
  'anon denied; authenticated and service_role execution preserved')
from recall_fixture.catalog_before;

set local role authenticated;
do $$
declare b record; actual jsonb; expected jsonb;
begin
  for b in select * from recall_fixture.baseline loop
    perform set_config('request.jwt.claims',
      case when b.actor = 0 then '{"role":"authenticated"}'
           else jsonb_build_object('sub', recall_fixture.id(b.actor), 'role', 'authenticated')::text end, true);
    actual := recall_fixture.call_rpc(b.fn, b.n, b.omitted, b.excluded);
    expected := b.result;
    if b.n is null and not b.omitted then
      select result into strict expected from recall_fixture.baseline
      where fn = b.fn and actor = b.actor and omitted and excluded is not distinct from b.excluded;
    end if;
    perform recall_fixture.assert(actual = expected,
      format('%s actor=%s n=%s omitted=%s excluded=%s', b.fn, b.actor, b.n, b.omitted, b.excluded));
    if b.n = -1 then
      perform recall_fixture.assert(actual = '{"sqlstate":"2201W"}'::jsonb, 'negative limit unchanged');
    elsif b.n = 0 or b.actor in (300, 0) then
      perform recall_fixture.assert(actual = '[]'::jsonb, 'zero/nonmember/no-uid returns no rows');
    end if;
  end loop;
end $$;

-- Independent expectations prevent before/after equality from masking a broken fixture.
select set_config('request.jwt.claims',
  jsonb_build_object('sub', recall_fixture.id(100), 'role', 'authenticated')::text, true);
do $$
declare fn text; d int; rows jsonb; excluded jsonb; keys text[];
begin
  foreach fn in array array['match_investigations', 'match_investigation_places', 'match_requirement_kinds'] loop
    d := case when fn = 'match_requirement_kinds' then 8 else 5 end;
    rows := recall_fixture.call_rpc(fn, null, false, null);
    perform recall_fixture.assert(jsonb_array_length(rows) = d, fn || ': NULL count equals declared default');
    perform recall_fixture.assert(rows = recall_fixture.call_rpc(fn, null, true, null)
      and rows = recall_fixture.call_rpc(fn, d, false, null), fn || ': identical omitted/NULL/explicit default results');
    perform recall_fixture.assert(jsonb_array_length(recall_fixture.call_rpc(fn, d + 1, false, null)) = d + 1,
      fn || ': default+1 remains allowed');
    select array_agg(k order by k) into keys from jsonb_object_keys(rows->0) k;
    perform recall_fixture.assert(keys = case fn
      when 'match_investigations' then array['investigation_id','similarity','title']
      when 'match_investigation_places' then array['avg_vote','last_at','name','place_id','similarity']
      else array['count','kind','priority'] end, fn || ': exact public column set');
  end loop;
  rows := recall_fixture.call_rpc('match_investigations', 2147483647, false, null);
  perform recall_fixture.assert(jsonb_array_length(rows) = 10
    and rows->0->>'investigation_id' = recall_fixture.id(1)::text
    and rows->1->>'investigation_id' = recall_fixture.id(2)::text
    and rows->9->>'investigation_id' = recall_fixture.id(10)::text,
    'distinct cosine order, owner and membership paths, inaccessible closest and null embedding excluded');
  rows := recall_fixture.call_rpc('match_investigation_places', 2147483647, false, null);
  excluded := recall_fixture.call_rpc('match_investigation_places', 2147483647, false, recall_fixture.id(1));
  perform recall_fixture.assert(jsonb_array_length(rows) = 16 and jsonb_array_length(excluded) = 16,
    'two places per internal top 8, including after exclusion');
  perform recall_fixture.assert(
    not exists (select 1 from jsonb_array_elements(rows) r
                where r->>'name' !~ '^P [1-8] [12]$' or (r->>'avg_vote')::real <> 1)
    and not exists (select 1 from jsonb_array_elements(excluded) r
                    where r->>'name' !~ '^P [2-9] [12]$'),
    'exclude before top 8; inaccessible, negative-vote and tail places excluded');
  rows := recall_fixture.call_rpc('match_requirement_kinds', 2147483647, false, null);
  excluded := recall_fixture.call_rpc('match_requirement_kinds', 2147483647, false, recall_fixture.id(1));
  perform recall_fixture.assert(jsonb_array_length(rows) = 12
    and not exists (select 1 from jsonb_array_elements(rows) r
                    where (r->>'count')::int <> 8 or r->>'kind' !~ '^k(0[1-9]|1[0-2])$' or r->>'priority' <> 'should')
    and jsonb_array_length(excluded) = 13
    and exists (select 1 from jsonb_array_elements(excluded) r where r->>'kind' = 'tail' and r->>'count' = '1'),
    'requirement top 8, grouping, null filtering and exclusion maintained');
end $$;
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select recall_fixture.assert(
  recall_fixture.call_rpc(fn, 2147483647, false, null) = '[]'::jsonb
  and recall_fixture.call_rpc(fn, null, false, null) = '[]'::jsonb,
  fn || ': service role without uid returns no rows')
from unnest(array['match_investigations','match_investigation_places','match_requirement_kinds']) fn;
reset role;
rollback;
\echo 'recall_null_limit.sql: assertions passed; synthetic fixture rolled back'
