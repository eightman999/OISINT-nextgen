-- 0019: share_token の owner 再発行 (rotate) (issue #177 / spec.md §8, §18, §25.4, §33)
--
-- share_token は作成時に 1 度だけ生成され (0002 L28)、変更経路が無かった。
-- URL が意図せず拡散した場合に owner が旧トークンを即時失効できるようにする。
--
-- 経路の整理:
--   * 0010 で authenticated の investigations 直接 UPDATE は全面禁止済み。
--     share_token を変更できる正規経路は本 RPC (owner) と service_role のみ。
--   * join-investigation (§25.4) は share_token の完全一致検索のため、
--     UPDATE のコミット時点で旧トークンは即時無効になる (失効リスト不要)。
--   * 参加済み investigation_members には触れない (メンバーシップは維持)。
--
-- 規律は 0005 / 0007 の owner RPC と同じ:
-- security definer + set search_path + created_by = auth.uid() 検証 + revoke/grant。

create or replace function public.rotate_share_token(p_investigation uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_token text;
begin
  -- owner 検証は UPDATE の where 句に含める (0007 set_investigation_visibility と同じ流儀)。
  -- 非 owner と存在しない id を区別せず、調査の存在を非メンバーへ漏らさない。
  update investigations
     set share_token = encode(gen_random_bytes(16), 'hex')
   where id = p_investigation
     and created_by = auth.uid()
  returning share_token into v_new_token;

  if not found then
    raise exception 'investigation not found or not owned by current user';
  end if;

  -- 監査イベント (§10)。event_type は member_joined 等と同じ過去形 snake_case。
  -- トークン値は秘密 (§33) のため message / metadata へは残さない。
  insert into investigation_events (investigation_id, event_type, message, metadata)
  values (
    p_investigation,
    'share_token_rotated',
    '共有リンクが再発行されました。以前の共有リンクは使えません。',
    jsonb_build_object('userId', auth.uid())
  );

  return v_new_token;
end;
$$;

revoke all on function public.rotate_share_token(uuid) from public, anon;
grant execute on function public.rotate_share_token(uuid) to authenticated;
