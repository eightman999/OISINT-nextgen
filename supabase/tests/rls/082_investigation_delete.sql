-- =============================================================================
-- 082_investigation_delete.sql — #167 調査単位削除の所有者境界
--
-- owner の調査だけを削除し、他人の調査・共有 places/evidence・運用台帳は壊さない。
-- 認証済みクライアントからservice-role専用RPCを直接呼べないことも確認する。
-- =============================================================================

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000821'),
  ('00000000-0000-0000-0000-000000000822');

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-000000000821', 'Owner 082'),
  ('00000000-0000-0000-0000-000000000822', 'Other 082');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000820', 'fixture', '082-shared', 'Shared place 082');

insert into public.investigations (
  id, created_by, title, raw_query, share_token
) values
  ('00000000-0000-0000-0000-000000000821',
   '00000000-0000-0000-0000-000000000821', 'Owner investigation 082', 'private query 082', 'r082a'),
  ('00000000-0000-0000-0000-000000000822',
   '00000000-0000-0000-0000-000000000822', 'Other investigation 082', 'other query 082', 'r082b');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000821', 'owner'),
  ('00000000-0000-0000-0000-000000000822', '00000000-0000-0000-0000-000000000822', 'owner'),
  ('00000000-0000-0000-0000-000000000822', '00000000-0000-0000-0000-000000000821', 'editor');

insert into public.requirements (id, investigation_id, created_by, text) values
  ('00000000-0000-0000-0000-000000000831',
   '00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000821', 'private requirement 082'),
  ('00000000-0000-0000-0000-000000000832',
   '00000000-0000-0000-0000-000000000822', '00000000-0000-0000-0000-000000000821', 'shared requirement 082');

insert into public.candidates (id, investigation_id, place_id, rank) values
  ('00000000-0000-0000-0000-000000000841',
   '00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000820', 1);

insert into public.evidence (
  id, investigation_id, place_id, scope, source_type, source_url,
  source_title, excerpt, observed_at
) values (
  '00000000-0000-0000-0000-000000000851',
  '00000000-0000-0000-0000-000000000821',
  '00000000-0000-0000-0000-000000000820',
  'investigation', 'official_site', 'https://example.com/082',
  'Shared evidence 082', 'Derived evidence 082', now()
);

insert into public.investigation_events (id, investigation_id, event_type, message)
values (
  '00000000-0000-0000-0000-000000000861',
  '00000000-0000-0000-0000-000000000821',
  'step_started', 'Private event 082'
);

insert into public.investigation_runs (id, investigation_id, status)
values (
  '00000000-0000-0000-0000-000000000871',
  '00000000-0000-0000-0000-000000000821',
  'complete'
);

insert into public.provider_usage (
  investigation_id, action, provider, mode, status, estimated_cost_microusd
) values (
  '00000000-0000-0000-0000-000000000821', 'create', 'fixture', 'mock', 'reserved', 0
);

-- authenticated の直接RPCは、本人が所有者でも拒否する。
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-000000000821","role":"authenticated","is_anonymous":true}';

do $$
begin
  begin
    perform public.delete_investigation(
      '00000000-0000-0000-0000-000000000821',
      '00000000-0000-0000-0000-000000000821'
    );
    raise exception 'FAIL(082/acl): authenticated executed investigation deletion RPC';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Edge Functionを模したservice_role呼び出しでも、JWT subjectと異なる所有者は削除できない。
set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-000000000821","role":"service_role","is_anonymous":true}';

do $$
declare result jsonb;
begin
  result := public.delete_investigation(
    '00000000-0000-0000-0000-000000000822',
    '00000000-0000-0000-0000-000000000821'
  );
  if result ->> 'deleted' <> 'false' then
    raise exception 'FAIL(082/owner): non-owner deletion returned success';
  end if;
  if not exists (
    select 1 from public.investigations
     where id = '00000000-0000-0000-0000-000000000822'
  ) then
    raise exception 'FAIL(082/owner): another user investigation was deleted';
  end if;
end $$;

select public.delete_investigation(
  '00000000-0000-0000-0000-000000000821',
  '00000000-0000-0000-0000-000000000821'
);

do $$
begin
  if exists (select 1 from public.investigations where id = '00000000-0000-0000-0000-000000000821')
    or exists (select 1 from public.investigation_members where investigation_id = '00000000-0000-0000-0000-000000000821')
    or exists (select 1 from public.requirements where investigation_id = '00000000-0000-0000-0000-000000000821')
    or exists (select 1 from public.candidates where investigation_id = '00000000-0000-0000-0000-000000000821')
    or exists (select 1 from public.investigation_events where investigation_id = '00000000-0000-0000-0000-000000000821')
    or exists (select 1 from public.investigation_runs where investigation_id = '00000000-0000-0000-0000-000000000821')
  then
    raise exception 'FAIL(082/delete): investigation-owned rows remain';
  end if;
  if not exists (
    select 1 from public.requirements
     where id = '00000000-0000-0000-0000-000000000832'
  ) then
    raise exception 'FAIL(082/delete): user row in another investigation was deleted';
  end if;
  if not exists (select 1 from public.investigations where id = '00000000-0000-0000-0000-000000000822') then
    raise exception 'FAIL(082/delete): another investigation was changed';
  end if;
  if not exists (select 1 from public.places where id = '00000000-0000-0000-0000-000000000820') then
    raise exception 'FAIL(082/shared): shared place was deleted';
  end if;
  if not exists (
    select 1 from public.evidence
     where id = '00000000-0000-0000-0000-000000000851'
       and investigation_id is null
  ) then
    raise exception 'FAIL(082/shared): evidence was deleted instead of detached';
  end if;
  if not exists (
    select 1 from public.provider_usage
     where investigation_id is null
       and provider = 'fixture'
       and action = 'create'
  ) then
    raise exception 'FAIL(082/ops): provider usage was not retained safely';
  end if;
end $$;

rollback;

\echo == 082_investigation_delete.sql: all assertions passed
