-- 202608230003: owner-only investigation deletion (#167)
--
-- 個別調査の削除は Edge Function 経由だけを公開する。共有 places / evidence は
-- 個人データではないため直接削除せず、既存FKの cascade / set null に任せる。

create or replace function public.delete_investigation(
  p_investigation_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint := 0;
begin
  -- service role のDB接続でも、公開Edge経路は必ずJWT subjectを検証して
  -- p_user_idへ渡す。authenticatedから直接RPCを呼べないようにする。
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_investigation_id is null or p_user_id is null then
    raise exception 'investigation id and user id are required' using errcode = '22023';
  end if;

  -- owner (created_by) 以外は対象行を返さず、Edge側で安全な404にする。
  delete from public.investigations
   where id = p_investigation_id
     and created_by = p_user_id;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('deleted', v_deleted = 1);
end;
$$;

revoke all on function public.delete_investigation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_investigation(uuid, uuid)
  to service_role;

comment on function public.delete_investigation(uuid, uuid) is
  'Owner-only investigation deletion called by the JWT-authenticated Edge Function. Preserves shared places/evidence.';
