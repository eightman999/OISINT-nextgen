-- 109_push_notifications.sql — #540 Push preference/outbox/identity boundary
-- scripts/test-rls.sh の専用scratch DBで実行する。

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-00000000540a', false),
  ('00000000-0000-4000-8000-00000000540b', false),
  ('00000000-0000-4000-8000-00000000540c', true);

-- 匿名subjectはDB境界でも永続account用設定を作れない。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000540c","role":"authenticated","is_anonymous":true}';
do $$
begin
  begin
    perform public.set_push_notification_preferences(true, true, 'granted');
    raise exception 'FAIL(109/anonymous): anonymous push preference was accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000540a","role":"authenticated","is_anonymous":false}';

do $$
declare
  v_default jsonb;
  v_saved jsonb;
begin
  v_default := public.get_push_notification_preferences();
  if v_default <> '{"notifications_enabled":false,"group_updates_enabled":true,"permission_status":"not_requested"}'::jsonb then
    raise exception 'FAIL(109/default): unexpected default %', v_default;
  end if;
  v_saved := public.set_push_notification_preferences(true, true, 'granted');
  if v_saved ->> 'notifications_enabled' <> 'true'
     or v_saved ->> 'group_updates_enabled' <> 'true'
     or v_saved ->> 'permission_status' <> 'granted' then
    raise exception 'FAIL(109/save-a): unexpected settings %', v_saved;
  end if;
  begin
    perform public.set_push_notification_preferences(true, true, 'denied');
    raise exception 'FAIL(109/invalid): enabled+denied was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
commit;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000540b","role":"authenticated","is_anonymous":false}';
select public.set_push_notification_preferences(true, true, 'granted');
commit;

insert into public.investigations (
  id, created_by, title, raw_query, status
)
values (
  '00000000-0000-4000-8000-000000005401',
  '00000000-0000-4000-8000-00000000540a',
  'push fixture',
  'must never enter push',
  'draft'
);

insert into public.investigation_members (investigation_id, user_id, role)
values
  ('00000000-0000-4000-8000-000000005401', '00000000-0000-4000-8000-00000000540a', 'owner'),
  ('00000000-0000-4000-8000-000000005401', '00000000-0000-4000-8000-00000000540b', 'editor');

-- fixture joinで作られたinviteを除き、各triggerを独立検査する。
delete from public.push_notification_outbox;

insert into public.requirements (
  id, investigation_id, created_by, text, normalized_text, kind, priority, weight
)
values (
  '00000000-0000-4000-8000-000000005402',
  '00000000-0000-4000-8000-000000005401',
  '00000000-0000-4000-8000-00000000540a',
  '条件本文はpushへ入れない',
  '条件本文はpushへ入れない',
  'other',
  'should',
  1
);

do $$
begin
  if (select count(*) from public.push_notification_outbox) <> 1
     or not exists (
       select 1 from public.push_notification_outbox
        where recipient_user_id = '00000000-0000-4000-8000-00000000540b'
          and event_type = 'group_update'
     ) then
    raise exception 'FAIL(109/group): actor exclusion or group enqueue failed';
  end if;
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'push_notification_outbox'
       and column_name in (
         'raw_query', 'display_name', 'restaurant_name', 'taste_profile',
         'auth_token', 'push_token', 'onesignal_id'
       )
  ) then
    raise exception 'FAIL(109/privacy): unsafe outbox column exists';
  end if;
end;
$$;

-- 5分bucket内の同種更新は同じrecipientへ重複させない。
update public.requirements
   set normalized_text = '更新しても本文はpushへ入れない'
 where id = '00000000-0000-4000-8000-000000005402';

do $$
begin
  if (select count(*) from public.push_notification_outbox) <> 1 then
    raise exception 'FAIL(109/collapse): group update was not aggregated';
  end if;
end;
$$;

-- parser由来created_by=nullは共同更新通知にしない。
insert into public.requirements (
  id, investigation_id, created_by, text, normalized_text, kind, priority, weight
)
values (
  '00000000-0000-4000-8000-000000005403',
  '00000000-0000-4000-8000-000000005401',
  null, 'parser fixture', 'parser fixture', 'other', 'should', 1
);

do $$
begin
  if (select count(*) from public.push_notification_outbox) <> 1 then
    raise exception 'FAIL(109/parser): automated requirement generated a group notification';
  end if;
end;
$$;

update public.investigations
   set status = 'complete'
 where id = '00000000-0000-4000-8000-000000005401';

do $$
begin
  if (
    select count(*) from public.push_notification_outbox
     where event_type = 'investigation_completed'
  ) <> 2 then
    raise exception 'FAIL(109/complete): completion did not target both opted-in members';
  end if;
end;
$$;

insert into public.push_notification_outbox (
  id, recipient_user_id, investigation_id, event_type, dedupe_key,
  idempotency_key, state
)
values (
  '00000000-0000-4000-8000-000000005406',
  '00000000-0000-4000-8000-00000000540b',
  '00000000-0000-4000-8000-000000005401',
  'investigation_completed',
  'investigation_completed:00000000-0000-4000-8000-000000005401:00000000-0000-4000-8000-00000000540b:cross_test',
  '00000000-0000-4000-8000-000000005407',
  'sent'
);

-- direct table access is unavailable to clients; recipient本人だけRPCで開封できる。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000540a","role":"authenticated","is_anonymous":false}';

do $$
begin
  if has_table_privilege('authenticated', 'public.push_notification_outbox', 'select')
     or has_table_privilege('authenticated', 'public.push_notification_preferences', 'select') then
    raise exception 'FAIL(109/rls): authenticated has direct push table access';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.run_push_notification_retention()',
    'execute'
  ) then
    raise exception 'FAIL(109/retention): authenticated can execute push retention';
  end if;
  if public.record_push_notification_open(
    '00000000-0000-4000-8000-000000005406',
    'notification_opened'
  ) then
    raise exception 'FAIL(109/open): cross-user notification was updated';
  end if;
end;
$$;
rollback;

-- service worker lease excludes a user immediately after opt-out.
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000540b","role":"authenticated","is_anonymous":false}';
select public.set_push_notification_preferences(false, false, 'granted');
commit;

begin;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
declare
  v_worker uuid := '00000000-0000-4000-8000-000000005404';
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select * from public.lease_push_notification_outbox(v_worker, 25, 30)
  loop
    v_count := v_count + 1;
    if v_row.recipient_user_id = '00000000-0000-4000-8000-00000000540b' then
      raise exception 'FAIL(109/optout): opted-out recipient was leased';
    end if;
    if not public.finish_push_notification_outbox(
      v_row.id, v_worker, 'sent',
      '00000000-0000-4000-8000-000000005405', null, null
    ) then
      raise exception 'FAIL(109/finish): leased row could not finish';
    end if;
    if v_row.recipient_user_id = '00000000-0000-4000-8000-00000000540a' then
      perform set_config('oisint.test.own_push_id', v_row.id::text, false);
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'FAIL(109/lease): no opted-in row was leased';
  end if;
end;
$$;
commit;

-- A本人だけが送信済みoutboxのopen/deep-link timestampを更新できる。
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000540a","role":"authenticated","is_anonymous":false}';

do $$
declare
  v_own_notification uuid := current_setting('oisint.test.own_push_id')::uuid;
begin
  if not public.record_push_notification_open(v_own_notification, 'notification_opened')
     or not public.record_push_notification_open(v_own_notification, 'deep_link_opened') then
    raise exception 'FAIL(109/open-own): own sent notification was not updated';
  end if;
end;
$$;
commit;

do $$
begin
  if exists (
    select 1 from public.push_notification_outbox
     where deep_link_opened_at is not null and opened_at is null
  ) then
    raise exception 'FAIL(109/open-order): deep link timestamp exists without open timestamp';
  end if;
end;
$$;
