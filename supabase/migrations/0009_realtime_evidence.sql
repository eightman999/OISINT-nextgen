-- 0009: live candidate detail refreshes when Evidence/evaluations are written.
-- The client also listens to investigation_events as a fallback for pipeline progress.
alter publication supabase_realtime add table public.evidence;
alter publication supabase_realtime add table public.requirement_evaluations;
