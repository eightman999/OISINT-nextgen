-- 202608240006: 調査本文・精密店舗座標の列境界 (#151 / spec.md §33)
--
-- RLS の行境界だけでは、調査に参加した authenticated user が
-- investigations.raw_query や places.lat/lng を直接 PostgREST で選べる。
-- これらは joined member/public の安全な表示列ではないため、列権限で
-- authenticated/anon から剥奪し、owner 判定を含む security-definer RPC だけを
-- owner の取得経路にする。Edge Function/service_role の内部処理は従来どおり動く。

-- 明示的な safe-column select は維持する。table-level SELECT は列 revoke で
-- 上書きできない PostgreSQL の権限モデルなので、table grant を一度剥がしてから
-- safe columns だけを再 grant する。SELECT * や sensitive column select は
-- permission denied となり、UI の非表示だけに依存しない。
revoke select on public.investigations from anon, authenticated;
grant select (
  id, title, status, share_token, visibility, created_at, updated_at
) on public.investigations to authenticated;

revoke select on public.places from anon, authenticated;
grant select (
  id, provider, provider_place_id, name, address, metadata,
  created_at, updated_at, refreshed_at, fallback_image_key
) on public.places to authenticated;

comment on column public.investigations.raw_query is
  'Owner-only through get_investigation_owner_raw_query(); never a member/public column.';
comment on column public.places.lat is
  'Owner-only through get_investigation_owner_place_coordinates(); not a member/public column.';
comment on column public.places.lng is
  'Owner-only through get_investigation_owner_place_coordinates(); not a member/public column.';

-- owner の自由文だけを返す。member/non-member は 0 行で、null や placeholder で
-- 存在・権限を推測できる詳細を返さない。auth.uid() は JWT subject のみを正本とする。
create or replace function public.get_investigation_owner_raw_query(
  p_investigation uuid
)
returns table (raw_query text)
language sql
stable
security definer
set search_path = public
as $$
  select i.raw_query
  from public.investigations i
  where i.id = p_investigation
    and i.created_by = auth.uid();
$$;

revoke all on function public.get_investigation_owner_raw_query(uuid) from public;
grant execute on function public.get_investigation_owner_raw_query(uuid) to authenticated;
grant execute on function public.get_investigation_owner_raw_query(uuid) to service_role;

-- owner の調査に紐づく候補店舗の精密座標だけを返す。
-- shared places 自体を削除・複製せず、調査 owner の read boundary だけを判定する。
create or replace function public.get_investigation_owner_place_coordinates(
  p_investigation uuid
)
returns table (
  place_id uuid,
  lat double precision,
  lng double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select c.place_id, p.lat, p.lng
  from public.investigations i
  join public.candidates c on c.investigation_id = i.id
  join public.places p on p.id = c.place_id
  where i.id = p_investigation
    and i.created_by = auth.uid();
$$;

revoke all on function public.get_investigation_owner_place_coordinates(uuid) from public;
grant execute on function public.get_investigation_owner_place_coordinates(uuid) to authenticated;
grant execute on function public.get_investigation_owner_place_coordinates(uuid) to service_role;
