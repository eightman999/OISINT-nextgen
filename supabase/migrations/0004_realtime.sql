-- 0004: Realtime publication 登録 (spec.md §20)
-- 忘れると Postgres Changes が何も飛ばない。Realtime は RLS を尊重する。
alter publication supabase_realtime add table public.requirements;
alter publication supabase_realtime add table public.candidates;
alter publication supabase_realtime add table public.votes;
alter publication supabase_realtime add table public.investigations;
alter publication supabase_realtime add table public.investigation_events;
