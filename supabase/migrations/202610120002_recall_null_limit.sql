-- NULL-only partial repair for #8. Use each declared omitted-argument default.
-- Non-NULL integers retain their existing behavior; this is not a maximum clamp.
-- CREATE OR REPLACE preserves existing ownership and function privileges.

create or replace function public.match_investigations(
  query_embedding vector(768),
  match_count int default 5
)
returns table (
  investigation_id uuid,
  title text,
  similarity real
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id as investigation_id,
    i.title,
    (1 - (i.embedding <=> query_embedding))::real as similarity
  from investigations i
  where i.embedding is not null
    and (i.created_by = auth.uid()
         or exists (
           select 1 from investigation_members m
           where m.investigation_id = i.id
             and m.user_id = auth.uid()
         ))
  order by i.embedding <=> query_embedding
  limit coalesce(match_count, 5);
$$;

create or replace function public.match_investigation_places(
  query_embedding vector(768),
  match_count int default 5,
  exclude_investigation uuid default null
)
returns table (
  place_id uuid,
  name text,
  avg_vote real,
  similarity real,
  last_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with accessible as (
    -- アクセス可能な類似 Investigation の上位のみを対象にする (全履歴を舐めない)
    select
      i.id,
      (1 - (i.embedding <=> query_embedding))::real as similarity
    from investigations i
    where i.embedding is not null
      and (exclude_investigation is null or i.id <> exclude_investigation)
      and (i.created_by = auth.uid()
           or exists (
             select 1 from investigation_members m
             where m.investigation_id = i.id
               and m.user_id = auth.uid()
           ))
    order by i.embedding <=> query_embedding
    limit 8
  )
  select
    c.place_id,
    pl.name,
    avg(v.value)::real as avg_vote,
    max(a.similarity)::real as similarity,
    max(v.updated_at) as last_at
  from accessible a
  join candidates c on c.investigation_id = a.id
  join votes v on v.candidate_id = c.id
  join places pl on pl.id = c.place_id
  group by c.place_id, pl.name
  having sum(v.value) > 0            -- 投票合計が正の place のみ
  order by max(a.similarity) desc, avg(v.value) desc, c.place_id
  limit coalesce(match_count, 5);
$$;

create or replace function public.match_requirement_kinds(
  query_embedding vector(768),
  match_count int default 8,
  exclude_investigation uuid default null
)
returns table (
  kind text,
  priority text,
  count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with accessible as (
    select i.id
    from investigations i
    where i.embedding is not null
      and (exclude_investigation is null or i.id <> exclude_investigation)
      and (i.created_by = auth.uid()
           or exists (
             select 1 from investigation_members m
             where m.investigation_id = i.id
               and m.user_id = auth.uid()
           ))
    order by i.embedding <=> query_embedding
    limit 8
  )
  select r.kind, r.priority, count(*)::bigint as count
  from accessible a
  join requirements r on r.investigation_id = a.id
  where r.kind is not null
    and r.priority is not null
  group by r.kind, r.priority
  order by count(*) desc, r.kind, r.priority
  limit coalesce(match_count, 8);
$$;
