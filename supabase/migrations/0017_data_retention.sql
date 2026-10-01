-- 0017: データ保持期間ポリシーと古い調査の自動匿名化・削除 (spec.md §33/§44 / issue #180)
--
-- 保持期間 (根拠は docs/operations/data-retention.md):
--   - status='complete' の調査: 最終更新 (updated_at) から 6 か月で匿名化
--   - status<>'complete' の調査 (draft/failed/途中放置): 3 か月で放棄とみなし同じ匿名化へ
--   - investigation_events: 作成から 4 週間 (28 日) で削除 (デバッグ用途の寿命)
--
-- 匿名化 = 個人文脈を持つ列だけを落とし、行は残す (§33 の表と対応):
--   - investigations: raw_query / title を固定文字列化、normalized_query / embedding を null 化。
--     title は raw_query 先頭 20 文字フォールバック (§22) があるため対象に含める。
--   - requirements: text を固定文字列化、normalized_text / embedding を null 化。
--     kind / priority / weight は集計値として保持してよい (§33「分布は集計値のみ可」)。
--   - votes: 削除 (§33「投票/コメントは共有資産化しない」。ランキング結果は
--     candidates.score / rank に保存済みで原本は不要)。
--   - 残すもの: places / evidence (店舗そのものの事実 = 共有資産)、candidates の集計値、
--     place_facts / place_feedback (place 単位で investigation_id を持たない)。
-- embedding を null 化した調査は 0005/0008 の recall RPC (embedding is not null 条件) から
-- 自然に外れるため、他ユーザーへの露出経路も同時に閉じる。

-- ============================================================
-- 1. pg_cron 有効化 (#173 と重複するが if not exists なので衝突しない)
--    pg_cron は cron.database_name (Supabase では postgres) 以外の DB には作成できない。
--    RLS テストハーネス (scripts/test-rls.sh) はスクラッチ DB に全 migration を適用する
--    ため、作成できない環境では NOTICE を残してスキップする (関数・列は常に作成する)。
-- ============================================================

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice '0017: pg_cron unavailable in this database (%), cron scheduling will be skipped',
    sqlerrm;
end $$;

-- ============================================================
-- 2. 匿名化済みマーカー列 (冪等性と可観測性のため)
-- ============================================================

alter table public.investigations add column anonymized_at timestamptz;

comment on column public.investigations.anonymized_at is
  'Retention job (run_data_retention) anonymized this row at this time. null = active.';

-- created_at での期限判定を索引化 (0013 の cleanup 索引と同じ流儀)
create index idx_events_created on public.investigation_events (created_at);

-- ============================================================
-- 3. 保持期間の適用関数
--    security definer + set search_path = '' (0013 と同じ規律)。
--    owner は migration 実行 role (= テーブル owner) なので RLS の影響を受けない。
-- ============================================================

create or replace function public.run_data_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_ids uuid[];
  v_events_total_before bigint;
  v_events_deleted bigint := 0;
  v_events_total_after bigint;
  v_inv_targets bigint;
  v_inv_anonymized bigint := 0;
  v_req_anonymized bigint := 0;
  v_votes_deleted bigint := 0;
begin
  -- 1) investigation_events: 4 週間経過で削除
  select count(*) into v_events_total_before from public.investigation_events;

  delete from public.investigation_events
   where created_at < now() - interval '28 days';
  get diagnostics v_events_deleted = row_count;

  select count(*) into v_events_total_after from public.investigation_events;

  raise log '[data_retention] investigation_events: before=% deleted=% after=%',
    v_events_total_before, v_events_deleted, v_events_total_after;

  -- 2) 匿名化対象を一度だけ確定する (途中で updated_at が動いても対象集合が揺れないように)
  select coalesce(array_agg(id), '{}') into v_target_ids
    from public.investigations
   where anonymized_at is null
     and (
       (status = 'complete' and updated_at < now() - interval '6 months')
       or (status <> 'complete' and updated_at < now() - interval '3 months')
     );

  v_inv_targets := coalesce(array_length(v_target_ids, 1), 0);

  if v_inv_targets > 0 then
    -- requirements 本文の匿名化 (kind / priority / weight は集計値として残す)
    update public.requirements
       set text = '[匿名化済み]',
           normalized_text = null,
           embedding = null
     where investigation_id = any (v_target_ids);
    get diagnostics v_req_anonymized = row_count;

    -- votes の削除 (集計結果は candidates.score / rank に保存済み)
    delete from public.votes
     where investigation_id = any (v_target_ids);
    get diagnostics v_votes_deleted = row_count;

    -- investigations 本体の匿名化。visibility は変更しないため trg_guard_visibility (0007)
    -- の raise 条件には入らない (cron 実行は auth.uid() も null)。
    update public.investigations
       set raw_query = '[匿名化済み]',
           title = '[匿名化済み]',
           normalized_query = null,
           embedding = null,
           anonymized_at = now()
     where id = any (v_target_ids);
    get diagnostics v_inv_anonymized = row_count;
  end if;

  raise log '[data_retention] investigations: targets=% anonymized=% requirements=% votes_deleted=%',
    v_inv_targets, v_inv_anonymized, v_req_anonymized, v_votes_deleted;

  return jsonb_build_object(
    'events_total_before', v_events_total_before,
    'events_deleted', v_events_deleted,
    'events_total_after', v_events_total_after,
    'investigations_targets', v_inv_targets,
    'investigations_anonymized', v_inv_anonymized,
    'requirements_anonymized', v_req_anonymized,
    'votes_deleted', v_votes_deleted
  );
end;
$$;

-- クライアント (anon / authenticated) からは実行不能にする (0013 と同じ regrant 規律)
revoke all on function public.run_data_retention() from public, anon, authenticated;
grant execute on function public.run_data_retention() to service_role;

comment on function public.run_data_retention() is
  'Applies the data retention policy (#180): anonymize expired investigations, delete old events.';

-- ============================================================
-- 4. 日次スケジュール
--    jobname 指定の cron.schedule は同名 job を上書きするため冪等。
--    18:00 UTC = 03:00 JST (トラフィックの谷)。
--    pg_cron が無い環境 (スクラッチ DB でのテスト適用) では登録しない。
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0017: pg_cron not installed, skipping cron.schedule (oisint_data_retention_daily)';
    return;
  end if;
  perform cron.schedule(
    'oisint_data_retention_daily',
    '0 18 * * *',
    'select public.run_data_retention();'
  );
end $$;
