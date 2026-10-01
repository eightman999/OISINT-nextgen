-- 0005: RPC (spec.md §16.1, §23, §24 / contracts/rpc.md)

-- match_investigations: 類似 Investigation 検索。
-- current user がアクセス可能な investigation のみを対象にする (§24: vector を RLS bypass にしない)。
-- 返すのは id / title / similarity のみ。他人の query 本文は返さない (§33)。
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
  limit match_count;
$$;

revoke all on function public.match_investigations(vector, int) from public;
grant execute on function public.match_investigations(vector, int) to authenticated;
-- Edge Function (service role) からも呼ぶ
grant execute on function public.match_investigations(vector, int) to service_role;

-- get_investigation_members: メンバー一覧。
-- investigation_members の select ポリシーを user_id = auth.uid() に絞った代償 (§23 推奨安全形)。
create or replace function public.get_investigation_members(inv uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, p.display_name, m.role, m.joined_at
  from investigation_members m
  join profiles p on p.id = m.user_id
  where m.investigation_id = inv
    and public.is_investigation_member(inv);  -- member 本人のみ取得可
$$;

revoke all on function public.get_investigation_members(uuid) from public;
grant execute on function public.get_investigation_members(uuid) to authenticated;
