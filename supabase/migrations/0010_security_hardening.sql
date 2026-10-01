-- 0010: investigation 本体の直接更新を禁止する
--
-- 0003 では authenticated に investigations の全列 UPDATE を付与し、
-- editor メンバーにも inv_update policy を与えていた。これにより共有参加者が
-- created_by / raw_query / share_token / status 等を直接改変できる余地があった。
--
-- 本体の作成・状態遷移・埋め込み・再ランキングは Edge Functions (service_role)、
-- visibility は owner 専用の set_investigation_visibility() RPC を正本とする。
-- 条件追加・投票はそれぞれ requirements / votes の狭いポリシーを使うため、
-- investigations 本体への authenticated UPDATE は不要。

drop policy if exists inv_update on public.investigations;
revoke update on public.investigations from authenticated;

comment on table public.investigations is
  'Direct authenticated UPDATE is intentionally disabled; use owner RPC or Edge Functions.';
