-- #438 (P0 security): 共有 TEST ユーザー（固定 UUID 00000000-0000-4000-8000-00000000e571）の無効化
--
-- 旧 202608160003_shared_test_user.sql（no-op 化済み）が本番 auth.users へ作成した
-- 共有アカウントを、公開資格情報（README 記載の TEST / TEST）でログインできない状態にする。
--
-- 方針:
--   - 行削除はしない。auth.users の削除は public.profiles ほか関連データの
--     cascade 削除を招くため、本番の既存データを保全する。
--   - encrypted_password をランダム値へ更新（誰もパスワードを知らない状態にする）。
--   - banned_until = '3000-01-01T00:00:00Z' でログインを恒久的に禁止する。
--     注意: timestamptz の 'infinity' は使わない。GoTrue が値を解析できず、
--     ログインが 400 user_banned でなく 500 unexpected_failure になるうえ、
--     /auth/v1/admin/users（Dashboard のユーザー一覧）全体が
--     "Database error finding users" の 500 で壊れることをローカルで実測済み。
--   - auth.identities の email identity は削除する（メールログイン経路の閉鎖）。
--   - 冪等: 対象行が存在しなければ何も更新・削除されない（no-op）。
--
-- 適用タイミング:
--   - 本番への適用は owner の手動 production deploy（supabase db push）時に行われる。
--   - ローカルの supabase db reset は migrations → seed.sql の順で実行され、
--     202608160003 の no-op 化により本 migration 実行時点で対象行が存在しないため
--     何も起きず、直後に seed.sql が TEST ユーザーを新規作成する（ローカル開発への影響なし）。

update auth.users
set
  encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  banned_until = '3000-01-01T00:00:00Z',
  updated_at = now()
where id = '00000000-0000-4000-8000-00000000e571';

delete from auth.identities
where user_id = '00000000-0000-4000-8000-00000000e571'
  and provider = 'email';
