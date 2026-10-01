-- 0006: 外部 API / フェッチ結果のサービス側キャッシュ (spec.md §32 / 2026-08-15 追加)
-- service role 専用。RLS 有効・ポリシーなし・authenticated への grant なし = クライアント不可視。
create table public.external_cache (
  cache_key text primary key,      -- '<kind>:v1:' || sha256(正規化した入力)
  kind text not null,              -- 'serper' | 'fetch' | 'hotpepper'
  request jsonb not null,          -- 入力 (デバッグ用)
  payload jsonb not null,          -- 正規化済みレスポンス
  fetched_at timestamptz not null default now()
);

create index idx_external_cache_kind_fetched on public.external_cache (kind, fetched_at desc);

alter table public.external_cache enable row level security;
-- ポリシーは意図的に作らない (service role は RLS を bypass する)

grant all on public.external_cache to service_role;
-- authenticated / anon には一切 grant しない (§32: クライアント不可視)
