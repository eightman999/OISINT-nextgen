-- 来店後フィードバック編集の原子的な更新経路 (#110)
--
-- place_feedback の直接 UPDATE は place_facts を再計算しないため、認証済み
-- クライアントからの UPDATE 権限を閉じ、本人確認と集計更新を同一 RPC に固定する。

revoke update on public.place_feedback from authenticated;
drop policy if exists pfb_update on public.place_feedback;

create or replace function public.refresh_place_feedback_fact(
  p_place uuid,
  p_aspect text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_total int;
  v_top_value text;
  v_top_count int;
begin
  if p_aspect is null then
    return;
  end if;

  v_key := case p_aspect
    when 'noise' then 'noise_level'
    when 'space' then 'space_comfort'
    when 'value' then 'value_for_money'
    when 'service' then 'service_quality'
    else null
  end;
  if v_key is null then
    raise exception 'invalid feedback aspect';
  end if;

  select count(*)::int
    into v_total
  from public.place_feedback f
  where f.place_id = p_place
    and f.aspect = p_aspect
    and f.aspect_value is not null;

  -- 件数がしきい値を下回った場合は、過去の集計値を残さない。
  if v_total < 3 then
    delete from public.place_facts
     where place_id = p_place
       and key = v_key;
    return;
  end if;

  select f.aspect_value, count(*)::int
    into v_top_value, v_top_count
  from public.place_feedback f
  where f.place_id = p_place
    and f.aspect = p_aspect
    and f.aspect_value is not null
  group by f.aspect_value
  order by count(*) desc, f.aspect_value asc
  limit 1;

  insert into public.place_facts
    (place_id, key, value, confidence, evidence_count, conflicting, last_verified_at)
  values (
    p_place,
    v_key,
    jsonb_build_object(
      'value', v_top_value,
      'count', v_total,
      'share', round(v_top_count::numeric / v_total, 4)
    ),
    least(1.0, v_total / 10.0),
    v_total,
    (v_top_count::numeric / v_total) < 0.6,
    now()
  )
  on conflict (place_id, key) do update set
    value = excluded.value,
    confidence = excluded.confidence,
    evidence_count = excluded.evidence_count,
    conflicting = excluded.conflicting,
    last_verified_at = excluded.last_verified_at;
end;
$$;

revoke all on function public.refresh_place_feedback_fact(uuid, text) from public;

create or replace function public.update_place_feedback(
  p_place uuid,
  p_feedback uuid,
  p_visited_at date default null,
  p_rating smallint default null,
  p_aspect text default null,
  p_aspect_value text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_place uuid;
  v_old_aspect text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if p_aspect_value is not null and p_aspect is null then
    raise exception 'aspect_value requires aspect';
  end if;

  -- place・feedback・本人を同時に固定し、別ユーザーや別 place の ID を拒否する。
  select f.place_id, f.aspect
    into v_place, v_old_aspect
  from public.place_feedback f
  where f.id = p_feedback
    and f.place_id = p_place
    and f.user_id = v_uid
  for update;

  if not found then
    raise exception 'feedback not found or not owned by current user';
  end if;

  update public.place_feedback
     set visited_at = p_visited_at,
         rating = p_rating,
         aspect = p_aspect,
         aspect_value = p_aspect_value
   where id = p_feedback
     and place_id = p_place
     and user_id = v_uid
   returning id into v_id;

  -- 旧 aspect と新 aspect の双方を再計算する。同じ場合は一度だけでよい。
  perform public.refresh_place_feedback_fact(v_place, v_old_aspect);
  if p_aspect is distinct from v_old_aspect then
    perform public.refresh_place_feedback_fact(v_place, p_aspect);
  end if;

  return v_id;
end;
$$;

revoke all on function public.update_place_feedback(uuid, uuid, date, smallint, text, text) from public;
grant execute on function public.update_place_feedback(uuid, uuid, date, smallint, text, text) to authenticated;
