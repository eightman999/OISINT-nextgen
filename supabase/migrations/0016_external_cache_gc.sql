-- 0016: external_cache の定期 GC (spec.md §32 / §44.3 L1、#173)
-- 書き込み時の確率的掃除 (cache.ts) だけでは、書き込みが止まると期限切れ行が残り続ける
-- (docs/legal/audit-copyright.md R6)。pg_cron の日次 GC を確定削除の主経路にし、
-- 確率的掃除は保険に格下げする (cache.ts 側で 10% → 1% に低減)。

-- Supabase (ローカル CLI スタック / hosted) は pg_cron を同梱している。
-- schema は control file 固定 (job 群は cron schema に作られる) のため指定しない。
-- ただし pg_cron は cron.database_name (Supabase では postgres) 以外の DB には作成できない。
-- RLS テストハーネス (scripts/test-rls.sh) はスクラッチ DB に全 migration を適用するため、
-- 作成できない環境では NOTICE を残してスキップする (GC 関数自体は常に作成する)。
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice '0016: pg_cron unavailable in this database (%), cron scheduling will be skipped',
    sqlerrm;
end $$;

-- GC 本体。TTL の既定値は cache.ts CACHE_TTL_HOURS / spec.md §32 と同じ「全 kind 24h」。
-- kind 別 TTL を将来変える場合は、最短 TTL をここの既定値に合わせる (長い分には行が残るだけで安全)。
-- security definer にはしない: 実行者は cron job owner (postgres = テーブル所有者) と
-- service_role (0006 で delete 権限あり) のみで足り、権限昇格の面を増やさない。
create or replace function public.gc_external_cache(p_ttl_hours integer default 24)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_total bigint;
  v_deleted integer;
begin
  select count(*) into v_total from public.external_cache;
  delete from public.external_cache
   where fetched_at < now() - make_interval(hours => p_ttl_hours);
  get diagnostics v_deleted = row_count;
  -- 実測用に削除数と残存数を Postgres ログへ残す (#165 のサイズ監視と突き合わせる)
  raise log 'gc_external_cache: deleted=% kept=% ttl_hours=%',
    v_deleted, v_total - v_deleted, p_ttl_hours;
  return v_deleted;
end;
$$;

comment on function public.gc_external_cache(integer) is
  'external_cache の期限切れ行を確定削除する日次 GC (spec.md §32 / #173)。戻り値は削除行数。';

-- クライアントからは実行不可。手動運用 (Edge Function / SQL Editor) 用に service_role のみ許可。
revoke all on function public.gc_external_cache(integer) from public, anon, authenticated;
grant execute on function public.gc_external_cache(integer) to service_role;

-- 毎日 18:10 UTC = JST 03:10 (利用の谷) に実行する。
-- 冪等性: 同名 job が既に居れば unschedule してから登録する (再適用しても二重登録しない)。
-- pg_cron が無い環境 (スクラッチ DB でのテスト適用) では登録しない。
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0016: pg_cron not installed, skipping cron.schedule (external-cache-gc-daily)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'external-cache-gc-daily') then
    perform cron.unschedule('external-cache-gc-daily');
  end if;
  perform cron.schedule(
    'external-cache-gc-daily',
    '10 18 * * *',
    'select public.gc_external_cache()'
  );
end $$;
