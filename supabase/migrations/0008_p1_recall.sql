-- 0008: P1 過去グループ嗜好 recall 用 RPC (spec.md §3 P1, §16.1, §24, §33 / issue #105)
-- 0005 の match_investigations と同じ規律:
--   security definer + set search_path = public + revoke/grant。
--   検索対象は current user (auth.uid()) がアクセス可能な investigation のみ (§24:
--   vector similarity を RLS bypass にしない)。run-investigation は recalling step で
--   ユーザー JWT のクライアントからこれらを呼ぶ (service role 再呼び出し時は呼ばない)。

-- match_investigation_places: 類似の過去 Investigation から投票合計が正の place を返す。
-- 返すのは place の事実 (id / name) と集計値 (avg_vote / similarity / last_at) のみ。
-- 他人の query 本文・raw_query・title・investigation_id・user_id は返さない (§33:
-- 参照してよいのは「その調査で高評価だった place」まで)。
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
  limit match_count;
$$;

revoke all on function public.match_investigation_places(vector, int, uuid) from public;
grant execute on function public.match_investigation_places(vector, int, uuid) to authenticated;
-- Edge Function からはユーザー JWT で呼ぶのが主経路。auth.uid() 前提のため
-- service role 直呼びは空を返すが、0005 と同じ grant 規律に揃えておく
grant execute on function public.match_investigation_places(vector, int, uuid) to service_role;

-- match_requirement_kinds: 類似調査の requirement の kind / priority 分布 (集計値のみ)。
-- 文面 (text / normalized_text) は返さない (§33「Requirement の文面は共有しない。
-- kind/priority の分布は集計値のみ可」)。
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
  limit match_count;
$$;

revoke all on function public.match_requirement_kinds(vector, int, uuid) from public;
grant execute on function public.match_requirement_kinds(vector, int, uuid) to authenticated;
grant execute on function public.match_requirement_kinds(vector, int, uuid) to service_role;
