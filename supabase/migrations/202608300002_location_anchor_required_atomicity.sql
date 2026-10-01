-- Issue #617: current-location anchor不足の受付結果を原子的に永続化する。
-- status更新とeventの冪等insertを同じtransaction/row lockへまとめる。

create or replace function public.persist_investigation_location_anchor_required(
  p_investigation_id uuid,
  p_request_id uuid default null
)
returns table(persisted boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_investigation_id is null then
    raise exception 'invalid investigation anchor requirement'
      using errcode = '22023';
  end if;

  -- 同じinvestigationへの並行受付を直列化する。lock取得後のNOT EXISTS再評価で
  -- eventは1行へ収束し、status/eventの片方だけがcommitされる状態を作らない。
  perform 1
    from public.investigations as i
   where i.id = p_investigation_id
   for update;
  if not found then
    return query select false;
    return;
  end if;

  update public.investigations
     set status = 'draft'
   where id = p_investigation_id;

  insert into public.investigation_events (
    investigation_id,
    event_type,
    message,
    metadata
  )
  select
    p_investigation_id,
    'location_anchor_required',
    '現在地を検索に使用できませんでした。駅名・地名を入力してください。',
    jsonb_build_object(
      'reason', 'location_anchor_required',
      'request_id', p_request_id
    )
  where not exists (
    select 1
      from public.investigation_events as e
     where e.investigation_id = p_investigation_id
       and e.event_type = 'location_anchor_required'
  );

  return query select true;
end;
$$;

revoke all on function public.persist_investigation_location_anchor_required(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.persist_investigation_location_anchor_required(uuid, uuid)
  to service_role;
