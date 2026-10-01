-- 0020: 共有リンクの参加前プレビュー RPC (issue #335 / spec.md §33)
--
-- share_token を知っている参加前ユーザーへ「安全な最小集合」だけを返す。
-- share_token の所持が join の唯一の条件 (§25.4 / join-investigation) なので、
-- 同じ token 所持者へタイトル程度のメタ情報を先に見せても参加権限を越えない。
-- visibility は絞り込みに使わない: デフォルト private の調査こそ共有リンクで
-- 招待されるため、join と同じく token 一致のみを条件にする。
--
-- 返す列 (§33 の公開/非公開表と突合):
--   title        … 30字要約。raw_query そのものではない (§33: raw_query は非公開)
--   status       … 進行状況。個人に紐づかないメタ情報
--   member_count … 参加人数の集計値のみ (§33: 集計値は可。名前・user_id は返さない)
-- 返さない列: id / share_token / raw_query / normalized_query / embedding /
--   requirements 文面 / votes / candidates / メンバー個人情報 (§33)。
-- 存在しない token は 0 行を返すだけでエラー詳細を出さない
-- (token の有効性確認・列挙攻撃に使わせない)。

create or replace function public.get_investigation_preview(p_share_token text)
returns table (
  title text,
  status text,
  member_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.title,
    i.status,
    coalesce((
      select count(*)::int
      from investigation_members m
      where m.investigation_id = i.id
    ), 0) as member_count
  from investigations i
  where i.share_token = p_share_token;
$$;

-- anon には開けない (0003 と同じ規律 §19: 匿名サインイン後は authenticated)。
-- 共有ページ (/i/[token]) は AuthProvider が匿名セッションを自動作成し、
-- live provider も呼び出し前に ensureUserId() で認証を確立する。
revoke all on function public.get_investigation_preview(text) from public;
grant execute on function public.get_investigation_preview(text) to authenticated;
