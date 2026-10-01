-- 202608240012: public feedback facts use a closed canonical vocabulary
--
-- Legacy place_feedback rows are retained for audit/owner history.  They are
-- never copied into shared place_facts/summary output, while all new RPC writes
-- accept only the fixed aspect/value pairs below.

create or replace function public.is_canonical_place_feedback_value(
  p_aspect text,
  p_value text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_aspect
    when 'noise' then p_value in ('quiet', 'loud')
    when 'space' then p_value in ('comfortable', 'cramped')
    when 'value' then p_value in ('good', 'bad')
    when 'service' then p_value in ('good', 'bad')
    else false
  end;
$$;

revoke all on function public.is_canonical_place_feedback_value(text, text)
  from public, anon, authenticated;
grant execute on function public.is_canonical_place_feedback_value(text, text)
  to service_role;

-- A legacy/free-text value must not remain visible through an old derived fact.
delete from public.place_facts as f
 where f.key in ('noise_level', 'space_comfort', 'value_for_money', 'service_quality')
   and not public.is_canonical_place_feedback_value(
     case f.key
       when 'noise_level' then 'noise'
       when 'space_comfort' then 'space'
       when 'value_for_money' then 'value'
       when 'service_quality' then 'service'
     end,
     coalesce(f.value ->> 'value', '')
   );

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
  if p_aspect is null then return; end if;
  v_key := case p_aspect
    when 'noise' then 'noise_level'
    when 'space' then 'space_comfort'
    when 'value' then 'value_for_money'
    when 'service' then 'service_quality'
    else null
  end;
  if v_key is null then raise exception 'invalid feedback aspect'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oisint-feedback:' || p_place::text || ':' || p_aspect, 0
    )
  );

  -- Pick the latest row per user first.  If that row is legacy/free text, do
  -- not fall back to an older canonical row for shared publication.
  with latest as (
    select distinct on (f.user_id) f.user_id, f.aspect_value
      from public.place_feedback as f
     where f.place_id = p_place
       and f.aspect = p_aspect
     order by f.user_id, f.updated_at desc, f.created_at desc nulls last, f.id desc
  )
  select count(*)::int into v_total
    from latest
   where public.is_canonical_place_feedback_value(p_aspect, latest.aspect_value);

  with latest as (
    select distinct on (f.user_id) f.user_id, f.aspect_value
      from public.place_feedback as f
     where f.place_id = p_place
       and f.aspect = p_aspect
     order by f.user_id, f.updated_at desc, f.created_at desc nulls last, f.id desc
  )
  select latest.aspect_value, count(*)::int into v_top_value, v_top_count
    from latest
   where public.is_canonical_place_feedback_value(p_aspect, latest.aspect_value)
   group by latest.aspect_value
   order by count(*) desc, latest.aspect_value asc
   limit 1;

  if v_total < 3 or coalesce(v_top_count, 0) < 3 then
    delete from public.place_facts where place_id = p_place and key = v_key;
    return;
  end if;

  insert into public.place_facts
    (place_id, key, value, confidence, evidence_count, conflicting, last_verified_at)
  values (
    p_place, v_key,
    jsonb_build_object(
      'value', v_top_value,
      'count', v_total,
      'share', round(v_top_count::numeric / v_total, 4)
    ),
    least(1.0, v_total / 10.0), v_total,
    (v_top_count::numeric / v_total) < 0.6,
    clock_timestamp()
  )
  on conflict (place_id, key) do update set
    value = excluded.value,
    confidence = excluded.confidence,
    evidence_count = excluded.evidence_count,
    conflicting = excluded.conflicting,
    last_verified_at = excluded.last_verified_at;
end;
$$;

revoke all on function public.refresh_place_feedback_fact(uuid, text)
  from public, anon, authenticated;
grant execute on function public.refresh_place_feedback_fact(uuid, text)
  to service_role;

create or replace function public.submit_place_feedback(
  p_place uuid,
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
  v_id uuid;
  v_aspect text := nullif(btrim(p_aspect), '');
  v_aspect_value text := nullif(btrim(p_aspect_value), '');
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.places p where p.id = p_place) then
    raise exception 'place not found';
  end if;
  if p_visited_at is null and p_rating is null and v_aspect is null
     and v_aspect_value is null then
    raise exception 'at least one feedback field is required';
  end if;
  if p_visited_at > current_date then
    raise exception 'visited_at cannot be in the future';
  end if;
  if p_aspect is not null and v_aspect is null then
    raise exception 'feedback aspect cannot be blank';
  end if;
  if p_aspect_value is not null and v_aspect_value is null then
    raise exception 'feedback aspect_value cannot be blank';
  end if;
  if p_rating is not null and p_rating not in (-1, 0, 1) then
    raise exception 'invalid feedback rating';
  end if;
  if v_aspect is not null and v_aspect not in ('noise', 'space', 'value', 'service') then
    raise exception 'invalid feedback aspect';
  end if;
  if v_aspect_value is not null and v_aspect is null then
    raise exception 'aspect_value requires aspect';
  end if;
  if v_aspect_value is not null
     and not public.is_canonical_place_feedback_value(v_aspect, v_aspect_value) then
    raise exception 'feedback aspect_value is not canonical';
  end if;

  if v_aspect is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oisint-feedback:' || p_place::text || ':' || v_aspect, 0
      )
    );
  end if;

  insert into public.place_feedback
    (place_id, user_id, visited_at, rating, aspect, aspect_value)
  values (p_place, v_uid, p_visited_at, p_rating, v_aspect, v_aspect_value)
  returning id into v_id;

  if v_aspect is not null then
    perform public.refresh_place_feedback_fact(p_place, v_aspect);
  end if;
  return v_id;
end;
$$;

revoke all on function public.submit_place_feedback(uuid, date, smallint, text, text)
  from public, anon;
grant execute on function public.submit_place_feedback(uuid, date, smallint, text, text)
  to authenticated;

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
  v_aspect text := nullif(btrim(p_aspect), '');
  v_aspect_value text := nullif(btrim(p_aspect_value), '');
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_visited_at is null and p_rating is null and v_aspect is null
     and v_aspect_value is null then
    raise exception 'at least one feedback field is required';
  end if;
  if p_visited_at > current_date then
    raise exception 'visited_at cannot be in the future';
  end if;
  if p_aspect is not null and v_aspect is null then
    raise exception 'feedback aspect cannot be blank';
  end if;
  if p_aspect_value is not null and v_aspect_value is null then
    raise exception 'feedback aspect_value cannot be blank';
  end if;
  if p_rating is not null and p_rating not in (-1, 0, 1) then
    raise exception 'invalid feedback rating';
  end if;
  if v_aspect is not null and v_aspect not in ('noise', 'space', 'value', 'service') then
    raise exception 'invalid feedback aspect';
  end if;
  if v_aspect_value is not null and v_aspect is null then
    raise exception 'aspect_value requires aspect';
  end if;
  if v_aspect_value is not null
     and not public.is_canonical_place_feedback_value(v_aspect, v_aspect_value) then
    raise exception 'feedback aspect_value is not canonical';
  end if;

  select f.place_id, f.aspect into v_place, v_old_aspect
    from public.place_feedback as f
   where f.id = p_feedback and f.place_id = p_place and f.user_id = v_uid
   for update;
  if not found then raise exception 'feedback not found or not owned by current user'; end if;

  -- Acquire both scopes in lexical order when an update moves an aspect.
  if v_old_aspect is not null and v_aspect is not null
     and v_old_aspect <> v_aspect then
    if v_old_aspect < v_aspect then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'oisint-feedback:' || v_place::text || ':' || v_old_aspect, 0));
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'oisint-feedback:' || v_place::text || ':' || v_aspect, 0));
    else
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'oisint-feedback:' || v_place::text || ':' || v_aspect, 0));
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'oisint-feedback:' || v_place::text || ':' || v_old_aspect, 0));
    end if;
  elsif v_old_aspect is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'oisint-feedback:' || v_place::text || ':' || v_old_aspect, 0));
  elsif v_aspect is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'oisint-feedback:' || v_place::text || ':' || v_aspect, 0));
  end if;

  update public.place_feedback
     set visited_at = p_visited_at, rating = p_rating,
         aspect = v_aspect, aspect_value = v_aspect_value,
         updated_at = clock_timestamp()
   where id = p_feedback and place_id = p_place and user_id = v_uid
   returning id into v_id;
  perform public.refresh_place_feedback_fact(v_place, v_old_aspect);
  if v_aspect is distinct from v_old_aspect then
    perform public.refresh_place_feedback_fact(v_place, v_aspect);
  end if;
  return v_id;
end;
$$;

revoke all on function public.update_place_feedback(uuid, uuid, date, smallint, text, text)
  from public, anon;
grant execute on function public.update_place_feedback(uuid, uuid, date, smallint, text, text)
  to authenticated;

create or replace function public.get_place_feedback_summary(p_place_ids uuid[])
returns table (
  place_id uuid,
  visited_count integer,
  rating_count integer,
  rating_avg real,
  aspects jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
    case when (select count(distinct f.user_id) from public.place_feedback f
      where f.place_id = p.id and f.visited_at is not null) >= 3
      then (select count(distinct f.user_id)::int from public.place_feedback f
        where f.place_id = p.id and f.visited_at is not null) else 0 end,
    case when (select count(distinct f.user_id) from public.place_feedback f
      where f.place_id = p.id and f.rating is not null) >= 3
      then (select count(distinct f.user_id)::int from public.place_feedback f
        where f.place_id = p.id and f.rating is not null) else 0 end,
    case when (select count(distinct f.user_id) from public.place_feedback f where f.place_id = p.id and f.rating is not null) >= 3
      then (select avg(latest.rating)::real from (
        select distinct on (f.user_id) f.user_id, f.rating
          from public.place_feedback f
         where f.place_id = p.id and f.rating is not null
         order by f.user_id, f.updated_at desc, f.created_at desc nulls last, f.id desc
      ) latest) else null end,
    coalesce((select jsonb_agg(jsonb_build_object(
      'aspect', a.aspect, 'aspect_value', a.aspect_value, 'count', a.cnt)
      order by a.aspect, a.cnt desc, a.aspect_value)
        from (
          with latest as (
            select distinct on (f.user_id, f.aspect) f.aspect, f.aspect_value, f.user_id
              from public.place_feedback f
             where f.place_id = p.id and f.aspect is not null
             order by f.user_id, f.aspect, f.updated_at desc,
               f.created_at desc nulls last, f.id desc
          )
          select latest.aspect, latest.aspect_value, count(*)::int cnt
            from latest
           where public.is_canonical_place_feedback_value(latest.aspect, latest.aspect_value)
           group by latest.aspect, latest.aspect_value
          having count(*) >= 3
        ) a), '[]'::jsonb)
  from public.places p
  where p_place_ids is not null
    and cardinality(p_place_ids) between 1 and 100
    and p.id = any (p_place_ids);
$$;

revoke all on function public.get_place_feedback_summary(uuid[])
  from public, anon;
grant execute on function public.get_place_feedback_summary(uuid[])
  to authenticated;
