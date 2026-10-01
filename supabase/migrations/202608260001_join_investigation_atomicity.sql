-- 202608260001: join-investigation の上限判定と参加処理を原子的にする (#598)
--
-- service role だけが呼ぶRPCに処理を集約し、investigation行をロックしてから
-- 既存member確認・20人上限判定・profile/member/event書き込みを同一transactionで行う。

create or replace function public.join_investigation(
  p_share_token text,
  p_user_id uuid,
  p_display_name text
)
returns table (
  investigation_id uuid,
  title text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_investigation_id uuid;
  v_title text;
  v_existing boolean;
  v_member_count integer;
  v_max_members constant integer := 20;
begin
  if p_user_id is null
     or p_display_name is null
     or char_length(p_display_name) < 1
     or char_length(p_display_name) > 40 then
    raise exception 'invalid join request' using errcode = '22023';
  end if;

  -- 全joinを同じ investigation 行で直列化する。未参加memberのcountと
  -- insertの間に別joinが割り込めないため、20人上限をすり抜けない。
  select i.id, i.title
    into v_investigation_id, v_title
    from public.investigations as i
   where i.share_token = p_share_token
   for update;

  if not found then
    return;
  end if;

  select exists (
    select 1
      from public.investigation_members as m
     where m.investigation_id = v_investigation_id
       and m.user_id = p_user_id
  ) into v_existing;

  -- 既参加は冪等成功。display_nameの更新は従来のupsert契約を維持する。
  if v_existing then
    insert into public.profiles (id, display_name)
    values (p_user_id, p_display_name)
    on conflict (id) do update
      set display_name = excluded.display_name;

    return query
      select v_investigation_id, v_title, 'already_member'::text;
    return;
  end if;

  select count(*)::integer
    into v_member_count
    from public.investigation_members as m
   where m.investigation_id = v_investigation_id;

  if v_member_count >= v_max_members then
    return query
      select v_investigation_id, v_title, 'full'::text;
    return;
  end if;

  insert into public.profiles (id, display_name)
  values (p_user_id, p_display_name)
  on conflict (id) do update
    set display_name = excluded.display_name;

  insert into public.investigation_members (investigation_id, user_id, role)
  values (v_investigation_id, p_user_id, 'editor');

  insert into public.investigation_events (
    investigation_id,
    event_type,
    message,
    metadata
  ) values (
    v_investigation_id,
    'member_joined',
    'メンバーが参加しました',
    '{}'::jsonb
  );

  return query
    select v_investigation_id, v_title, 'joined'::text;
end;
$$;

revoke all on function public.join_investigation(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.join_investigation(text, uuid, text)
  to service_role;

comment on function public.join_investigation(text, uuid, text) is
  'Atomically joins a user by share token, enforcing the 20-member cap; service_role only.';
