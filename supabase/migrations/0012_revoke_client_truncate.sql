-- 0012: RLSを迂回するTRUNCATEをbrowser client rolesから除去する (#189)
-- 0011は並行開発中のuser personalization migration用に予約済み。

revoke truncate on all tables in schema public from anon, authenticated;

-- 今後postgres roleがpublic schemaへ作るtableにも同じ制約を継承する。
alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;
