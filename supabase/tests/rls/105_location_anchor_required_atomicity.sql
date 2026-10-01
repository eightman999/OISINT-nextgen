-- =============================================================================
-- 105_location_anchor_required_atomicity.sql — Issue #617
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values ('00000000-0000-4000-8000-000000001051', false);

insert into public.investigations (id, created_by, title, raw_query, status)
values (
  '00000000-0000-4000-8000-000000001050',
  '00000000-0000-4000-8000-000000001051',
  'Anchor atomicity fixture 105',
  '現在地で昼食',
  'searching'
);

set local role authenticated;
do $$
begin
  begin
    perform public.persist_investigation_location_anchor_required(
      '00000000-0000-4000-8000-000000001050',
      '00000000-0000-4000-8000-000000001052'
    );
    raise exception 'FAIL(105/acl): authenticated executed service RPC';
  exception when insufficient_privilege then
    null;
  end;
end $$;

set local role service_role;
do $$
declare
  v_persisted boolean;
begin
  select persisted into v_persisted
    from public.persist_investigation_location_anchor_required(
      '00000000-0000-4000-8000-000000001050',
      '00000000-0000-4000-8000-000000001052'
    );
  if not v_persisted then
    raise exception 'FAIL(105/first): atomic persistence rejected';
  end if;

  -- 別request idで再送してもrow lock後のNOT EXISTSによりeventは増えない。
  select persisted into v_persisted
    from public.persist_investigation_location_anchor_required(
      '00000000-0000-4000-8000-000000001050',
      '00000000-0000-4000-8000-000000001053'
    );
  if not v_persisted then
    raise exception 'FAIL(105/retry): idempotent retry rejected';
  end if;

  if (select status from public.investigations
       where id = '00000000-0000-4000-8000-000000001050') <> 'draft' then
    raise exception 'FAIL(105/status): investigation not returned to draft';
  end if;
  if (select count(*) from public.investigation_events
       where investigation_id = '00000000-0000-4000-8000-000000001050'
         and event_type = 'location_anchor_required') <> 1 then
    raise exception 'FAIL(105/event): retries produced duplicate events';
  end if;
  if (select metadata ->> 'request_id' from public.investigation_events
       where investigation_id = '00000000-0000-4000-8000-000000001050'
         and event_type = 'location_anchor_required') <>
      '00000000-0000-4000-8000-000000001052' then
    raise exception 'FAIL(105/metadata): first safe request id was not retained';
  end if;

  select persisted into v_persisted
    from public.persist_investigation_location_anchor_required(
      '00000000-0000-4000-8000-000000001059',
      null
    );
  if v_persisted then
    raise exception 'FAIL(105/missing): missing investigation was accepted';
  end if;
end $$;

rollback;
