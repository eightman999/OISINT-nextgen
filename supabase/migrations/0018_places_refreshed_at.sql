-- 0018: places.refreshed_at — HotPepper 由来データの 24 時間更新管理 (#289)
-- リクルート API 利用規約 (確認日 2026-08-15) は「キャッシュの更新頻度を24時間以内」と
-- 定めるが、provider 由来の places 行には「provider から最後に取得した時刻」を表す列が
-- 無かった。updated_at は set_updated_at トリガーにより embedding 補完などの内部 UPDATE
-- でも進むため流用できない。専用列 refreshed_at を追加する。
-- evidence は INSERT 追記型 (§32 / §44.4) で行の取得時刻 = observed_at のため列を追加しない。

alter table public.places
  add column refreshed_at timestamptz;

-- 既存行は updated_at (provider 由来 upsert のたびに進む最も近い近似値) を引き継ぐ
update public.places
  set refreshed_at = coalesce(updated_at, created_at, now());

alter table public.places
  alter column refreshed_at set not null,
  alter column refreshed_at set default now();

comment on column public.places.refreshed_at is
  'Provider (HotPepper) から店舗データを最後に取得した時刻。リクルート API 利用規約の 24 時間キャッシュ更新判定に使う (#289)。updated_at は内部 UPDATE でも進むため区別する';
