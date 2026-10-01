-- 202608220001: discovery index / RPC から anon 権限を除去する (#559)
--
-- 202608210001 の欠陥修正。本番適用後の実スキーマ (supabase db dump) で検出した。
--
-- 何が起きたか:
--   Supabase のホストプロジェクトは public schema の default privileges で
--   新規オブジェクトへ anon / authenticated へ自動 GRANT する。
--   202608210001 は `revoke all on function ... from public` しか書いていなかったが、
--   PostgreSQL の PUBLIC 疑似ロールと anon ロールは別物なので、
--   default privileges 由来の anon への GRANT が残った。
--
--   結果、本番では
--     - public.search_place_discovery_index に anon が EXECUTE を持つ
--     - public.place_discovery_index に anon が INSERT/UPDATE/DELETE 等を持つ
--   状態になっていた。
--
-- なぜ重大か:
--   search_place_discovery_index は security definer なので RLS を迂回する。
--   EXECUTE が anon にあると、匿名クライアントが PostgREST 経由で discovery index を
--   全件読み出せてしまう (§19 / §34「anon には開けない」に反する)。
--   検出時点で index は 0 件だったため実データの露出は発生していないが、
--   promote で投入する前にここで塞ぐ。
--
-- 既存の書式に合わせる (0013_request_rate_limits.sql の
-- `revoke all on function ... from public, anon, authenticated` と同じ規律)。

-- ============================================================
-- 1. discovery RPC — anon から EXECUTE を剥がす
-- ============================================================
-- authenticated は 202608210001 の意図どおり残す (店舗の公開情報 §33)。
revoke all on function public.search_place_discovery_index(
  double precision, double precision, double precision, integer, text
) from public, anon;

grant execute on function public.search_place_discovery_index(
  double precision, double precision, double precision, integer, text
) to service_role, authenticated;

-- ============================================================
-- 2. discovery index テーブル — 書き込みをクライアントロールから剥がす
-- ============================================================
-- このテーブルへ書いてよいのは promote step (service_role) だけ。
-- RLS は既に有効で anon 向けポリシーも無いため実アクセスは塞がっているが、
-- GRANT 側も意図に合わせて落としておく (RLS 単独に依存しない。0012 と同じ考え方)。
revoke all on table public.place_discovery_index from anon;

revoke insert, update, delete, truncate, references, trigger
  on table public.place_discovery_index from authenticated;

-- authenticated の読み取りは 202608210001 の意図どおり維持する。
grant select on table public.place_discovery_index to authenticated;
grant all on table public.place_discovery_index to service_role;

-- ============================================================
-- 3. 事後検証 — 意図した状態でなければ migration を失敗させる
-- ============================================================
-- 「revoke したつもり」で終わらせない。default privileges の挙動は
-- ホストプロジェクト側の設定に依存するため、適用結果を実測して fail-closed にする。
do $$
begin
  if has_function_privilege('anon',
       'public.search_place_discovery_index(double precision, double precision, double precision, integer, text)',
       'EXECUTE') then
    raise exception 'anon still holds EXECUTE on public.search_place_discovery_index';
  end if;

  if has_table_privilege('anon', 'public.place_discovery_index', 'SELECT')
     or has_table_privilege('anon', 'public.place_discovery_index', 'INSERT')
     or has_table_privilege('anon', 'public.place_discovery_index', 'UPDATE')
     or has_table_privilege('anon', 'public.place_discovery_index', 'DELETE') then
    raise exception 'anon still holds privileges on public.place_discovery_index';
  end if;

  if has_table_privilege('authenticated', 'public.place_discovery_index', 'INSERT')
     or has_table_privilege('authenticated', 'public.place_discovery_index', 'UPDATE')
     or has_table_privilege('authenticated', 'public.place_discovery_index', 'DELETE') then
    raise exception 'authenticated still holds write privileges on public.place_discovery_index';
  end if;

  -- 意図した権限まで消していないことも確認する (revoke のやりすぎ検知)
  if not has_table_privilege('authenticated', 'public.place_discovery_index', 'SELECT') then
    raise exception 'authenticated lost SELECT on public.place_discovery_index';
  end if;

  if not has_function_privilege('service_role',
       'public.search_place_discovery_index(double precision, double precision, double precision, integer, text)',
       'EXECUTE') then
    raise exception 'service_role lost EXECUTE on public.search_place_discovery_index';
  end if;
end $$;
