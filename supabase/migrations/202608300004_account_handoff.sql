-- 202608300004: 匿名アカウントのGoogle連携引き継ぎ (#166)
--
-- カスタムの復旧トークンやowner移譲は導入しない。匿名ユーザーが同じUUIDを
-- Google identityへlinkする既存方式だけを正規経路とし、link前に短命な操作行を
-- 予約、link後にEdgeが検証済み恒久JWTで完了させる。
-- operation_idは認証情報ではないため、単独で所有権を得られない。

create table public.account_handoff_operations (
  operation_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  method text not null check (method = 'google_identity_link'),
  status text not null default 'pending'
    check (status in ('pending', 'completed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  completed_at timestamptz
);

create unique index account_handoff_one_pending_per_user
  on public.account_handoff_operations (user_id)
  where status = 'pending';

create index account_handoff_operations_user_created
  on public.account_handoff_operations (user_id, created_at desc);

alter table public.account_handoff_operations enable row level security;

-- operation行はclientへ直接公開しない。Edge/RPCの戻り値は固定形だけにする。
revoke all on public.account_handoff_operations from public, anon, authenticated;
grant all on public.account_handoff_operations to service_role;

create or replace function public.prepare_account_handoff()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_operation_id uuid;
begin
  -- 匿名JWTの本人だけが予約できる。user_id/provider/methodを引数にしない。
  if v_user_id is null
     or auth.role() <> 'authenticated'
     or coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true' then
    raise exception 'anonymous handoff required' using errcode = '42501';
  end if;

  -- 同一匿名ユーザーの並行予約を直列化する。期限切れ行の削除と再利用を
  -- 一つのtransactionへ束ね、partial unique indexの競合をクライアントへ漏らさない。
  perform 1
    from auth.users as u
   where u.id = v_user_id
     and u.is_anonymous is true
   for update;
  if not found then
    raise exception 'anonymous handoff required' using errcode = '42501';
  end if;

  delete from public.account_handoff_operations
   where user_id = v_user_id
     and status = 'pending'
     and expires_at <= pg_catalog.now();

  select operation_id
    into v_operation_id
    from public.account_handoff_operations
   where user_id = v_user_id
     and method = 'google_identity_link'
     and status = 'pending'
     and expires_at > pg_catalog.now()
   order by created_at desc
   limit 1;

  if v_operation_id is not null then
    return v_operation_id;
  end if;

  insert into public.account_handoff_operations (user_id, method)
  values (v_user_id, 'google_identity_link')
  returning operation_id into v_operation_id;

  return v_operation_id;
end;
$$;

revoke all on function public.prepare_account_handoff() from public, anon;
grant execute on function public.prepare_account_handoff() to authenticated;

comment on function public.prepare_account_handoff() is
  'Reserves a short-lived, anonymous-subject-bound Google identity handoff operation.';

create or replace function public.complete_account_handoff(
  p_operation_id uuid,
  p_user_id uuid
)
returns table (
  status text,
  event_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_user_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_event_count integer := 0;
begin
  -- この関数はEdgeのservice_roleだけが呼ぶ。Edgeはp_user_idをbodyから取らず、
  -- authenticate()済みJWT subjectから渡す。authenticatedへ直接公開しない。
  if auth.role() <> 'service_role'
     or p_operation_id is null
     or p_user_id is null then
    raise exception 'invalid account handoff' using errcode = '42501';
  end if;

  -- service roleの誤用・別ユーザー指定もDB側で閉じる。Google identityの存在は
  -- Auth本体のidentity行を正本とし、client metadataを証拠にしない。
  if not exists (
    select 1
      from auth.users as u
     where u.id = p_user_id
       and u.is_anonymous is false
  ) or not exists (
    select 1
      from auth.identities as identity
     where identity.user_id = p_user_id
       and identity.provider = 'google'
  ) then
    raise exception 'permanent Google identity required' using errcode = '42501';
  end if;

  select operation_id_user.user_id,
         operation_id_user.status,
         operation_id_user.expires_at
    into v_operation_user_id, v_status, v_expires_at
    from public.account_handoff_operations as operation_id_user
   where operation_id_user.operation_id = p_operation_id
   for update;

  -- 存在しないoperationと他人のoperationを同じ失敗へ収束させる。
  if not found or v_operation_user_id <> p_user_id then
    raise exception 'account handoff not found' using errcode = '42501';
  end if;

  -- 同じoperationの再送はイベントを追加せず、固定の成功結果へ収束させる。
  if v_status = 'completed' then
    return query select 'already_completed'::text, 0;
    return;
  end if;

  if v_status <> 'pending' or v_expires_at <= pg_catalog.now() then
    raise exception 'account handoff expired' using errcode = '42501';
  end if;

  update public.account_handoff_operations
     set status = 'completed',
         completed_at = pg_catalog.now()
   where operation_id = p_operation_id;

  -- created_byを正本としつつ、owner roleの将来移譲にも対応する。ただし他人へ
  -- owner/editor/viewerを追加・変更する処理は一切しない。
  with owner_investigations as (
    select i.id as investigation_id
      from public.investigations as i
     where i.created_by = p_user_id
    union
    select m.investigation_id
      from public.investigation_members as m
     where m.user_id = p_user_id
       and m.role = 'owner'
  ), inserted_events as (
    insert into public.investigation_events (
      investigation_id,
      event_type,
      message,
      metadata
    )
    select owner_investigations.investigation_id,
           'account_handoff_completed',
           '匿名アカウントをGoogleアカウントへ引き継ぎました。',
           jsonb_build_object('method', 'google_identity_link')
      from owner_investigations
    returning id
  )
  select count(*)::integer into v_event_count from inserted_events;

  return query select 'completed'::text, v_event_count;
end;
$$;

revoke all on function public.complete_account_handoff(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_account_handoff(uuid, uuid)
  to service_role;

comment on function public.complete_account_handoff(uuid, uuid) is
  'Completes a Google identity handoff only for the Edge-verified subject and records owner audit events idempotently.';
