-- =============================================================================
-- 000_bootstrap.sql — RLS 負例テスト用スクラッチ DB の Supabase 互換ベースライン
--
-- scripts/test-rls.sh が空のスクラッチ DB (oisint_rls_test) に対して
-- migrations 適用「前」に 1 回だけ流す。migrations (0001〜) が前提にしている
-- Supabase ローカル環境の最低限を再現する。
--
-- 再現内容はローカル実機 (supabase_db_OISINT, PostgreSQL 17.6, supabase CLI 起動)
-- のカタログを実測した結果を正としている:
--   * ロール anon / authenticated / service_role はクラスタ共通 (存在確認のみ)
--   * schema public: PUBLIC に USAGE (=U) + anon/authenticated/service_role に USAGE
--   * postgres が作るオブジェクトの default privileges (pg_default_acl 実測):
--       tables    → anon/authenticated/service_role に TRUNCATE,REFERENCES,TRIGGER,MAINTAIN のみ
--                   (旧 Supabase 既定の GRANT ALL とは異なり SELECT/INSERT/UPDATE/DELETE は付かない)
--       sequences → anon/authenticated/service_role に UPDATE のみ
--       functions → PUBLIC の暗黙 EXECUTE を剥奪 (postgres=X のみ)
--   * auth.uid() / auth.role() は実機の pg_get_functiondef() をそのまま転記
--
-- ここは「テスト用エミュレーション」であり本番スキーマではない。
-- このファイルは scripts/test-rls.sh 専用。supabase db push の対象にしないこと。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. 安全ガード: スクラッチ DB 以外では絶対に実行しない
-- ---------------------------------------------------------------------------
do $$
begin
  if current_database() <> 'oisint_rls_test' then
    raise exception 'bootstrap must run on oisint_rls_test, not %', current_database();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. 拡張 (0001 は vector のみだが、0002 の share_token default が
--    gen_random_bytes() = pgcrypto を要求する)
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;
create extension if not exists vector;

-- 実機では pgcrypto は extensions スキーマに入り、202608160003 (TEST ユーザー #421) が
-- extensions.crypt() / extensions.gen_salt() を修飾呼び出しする。スクラッチ DB では
-- pgcrypto を public に置いたまま (0002/0019 の非修飾 gen_random_bytes() 互換)、
-- 修飾呼び出し互換のための薄い委譲関数だけを extensions スキーマへ置く。
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create or replace function extensions.crypt(text, text)
 returns text
 language sql
as $$ select public.crypt($1, $2) $$;

create or replace function extensions.gen_salt(text)
 returns text
 language sql
as $$ select public.gen_salt($1) $$;

-- ---------------------------------------------------------------------------
-- 2. ロール確認 (クラスタ共通。supabase イメージには必ず存在する。
--    万一素の Postgres で動かした場合のみ NOLOGIN で作成し、実行ユーザーに
--    メンバーシップを付与して SET ROLE を可能にする)
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
      execute format('grant %I to current_user', r);
      raise notice 'bootstrap: created missing role %', r;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Realtime publication (0004 / 0009 が alter publication ... add table する)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. schema public の権限 + default privileges (実測ミラー)
--    migrations より前に設定することで、migrations が作るテーブル/関数の
--    ACL が実機と同じ形になる。
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- 実測: postgres|public|r|{postgres=arwdDxtm,anon=Dxtm,authenticated=Dxtm,service_role=Dxtm}
-- MAINTAIN は PG17 の権限。supabase local / CI (supabase db start) は PG17。
alter default privileges in schema public
  grant truncate, references, trigger, maintain on tables
  to anon, authenticated, service_role;

-- 実測: postgres|public|S|{postgres=rwU,anon=w,authenticated=w,service_role=w}
alter default privileges in schema public
  grant update on sequences
  to anon, authenticated, service_role;

-- 実測: postgres|public|f|{postgres=X} — PUBLIC の暗黙 EXECUTE が無い。
-- これにより 0003/0005/0007/0008 の revoke/grant 規律と同じ土台になる。
alter default privileges in schema public
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 5. auth スキーマの最小エミュレーション
--    (GoTrue の実テーブルは不要。migrations が参照するのは auth.users(id) への
--     FK と auth.uid() に加え、202608160900 (#438) が UPDATE / DELETE する
--     GoTrue 互換列と auth.identities。auth.role() は未使用だが実機互換のため定義。
--     旧 202608160003 (TEST ユーザー #421) の upsert は #438 で no-op 化済み)
-- ---------------------------------------------------------------------------
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

-- 列は GoTrue 実テーブルのうち migrations が実際に触るものだけを持つ
create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  confirmation_token text,
  recovery_token text,
  email_change_token_new text,
  email_change text,
  email_change_token_current text,
  reauthentication_token text,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- 202608160900_disable_shared_test_user.sql (#438) が UPDATE で触る
  banned_until timestamptz,
  is_anonymous boolean not null default false
);

-- 202608160003 が on conflict (provider_id, provider) で upsert する
create table auth.identities (
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  id uuid primary key,
  unique (provider_id, provider)
);

-- 実機 (supabase_db_OISINT) の pg_get_functiondef() 転記。
-- request.jwt.claim.sub (旧形式) → request.jwt.claims JSON の 'sub' の順に見る。
-- 未設定/空なら NULL (= 未認証)。
create or replace function auth.uid()
 returns uuid
 language sql
 stable
as $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

create or replace function auth.role()
 returns text
 language sql
 stable
as $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

-- migration 0011 以降が is_anonymous 判定に使う (実機 pg_get_functiondef() 転記)
create or replace function auth.jwt()
 returns jsonb
 language sql
 stable
as $function$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

-- 実機 ACL: {=X/...} = PUBLIC が実行可能 (RLS ポリシー式は呼び出しロール権限で実行される)
grant execute on function auth.uid() to public;
grant execute on function auth.role() to public;
grant execute on function auth.jwt() to public;
