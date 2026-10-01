-- 087_revenuecat_entitlements.sql — RevenueCat Plus entitlement secure boundary (#571)
--
-- service_role webhook RPCだけが更新でき、authenticatedは本人行だけを読める。
-- 匿名subject、偽装claim、他人UUID、未知商品、重複/逆順イベントをgrantしない。

create or replace function public.test_assert(ok boolean, message text)
returns void language plpgsql as $$
begin
  if not ok then raise exception '%', message; end if;
end $$;
grant execute on function public.test_assert(boolean, text) to service_role, authenticated;

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-4000-8000-000000000571', false),
  ('00000000-0000-4000-8000-000000000572', false),
  ('00000000-0000-4000-8000-000000000573', true),
  ('00000000-0000-4000-8000-000000000574', false),
  ('00000000-0000-4000-8000-000000000575', false),
  ('00000000-0000-4000-8000-000000000576', true),
  ('00000000-0000-4000-8000-000000000577', false),
  ('00000000-0000-4000-8000-000000000578', false),
  ('00000000-0000-4000-8000-000000000601', false),
  ('00000000-0000-4000-8000-000000000602', false),
  ('00000000-0000-4000-8000-000000000603', false),
  ('00000000-0000-4000-8000-000000000604', false),
  ('00000000-0000-4000-8000-000000000606', false),
  ('abcdefab-cdef-1abc-8def-abcdefabcdef', false);

begin;
set local role service_role;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000571","role":"service_role"}';

select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-1', 'INITIAL_PURCHASE', 1000,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'applied',
  'FAIL(087/a): initial Plus event was not applied'
);
select test_assert(
  public.is_plus_for_user('00000000-0000-4000-8000-000000000571'),
  'FAIL(087/b): active Plus was not resolved for service-role gate'
);
select test_assert(
  position('pg_advisory_xact_lock' in pg_get_functiondef(
    'public.apply_revenuecat_webhook_event(text,text,bigint,text,text,text[],text,text,text,text,bigint,bigint,boolean,text)'::regprocedure
  )) > 0,
  'FAIL(087/b2): webhook RPC has no subject concurrency lock'
);
select test_assert(
  not public.is_plus_for_user('00000000-0000-4000-8000-000000000572'),
  'FAIL(087/c): another user received Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-test', 'TEST', 1001,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'ignored_test_event',
  'FAIL(087/c2): dashboard TEST event granted Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-billing', 'BILLING_ISSUE', 1002,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, false
  ) = 'applied'
  and public.is_plus_for_user('00000000-0000-4000-8000-000000000571'),
  'FAIL(087/c3): known billing issue before expiry did not follow the expiry contract'
);

-- 同一event_idは二重適用しない。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-1', 'INITIAL_PURCHASE', 1000,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'ignored_duplicate',
  'FAIL(087/d): duplicate event was applied'
);

-- 新しいevent_idでも時系列が戻る通知は無視する。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-old', 'EXPIRATION', 999,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    null, 'default', 'TEST_STORE', 'SANDBOX', 999, null, false
  ) = 'ignored_stale',
  'FAIL(087/e): out-of-order event overwrote the current state'
);

-- unknown product / anonymous customer / unknown customer は grant しない。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-unknown-product', 'INITIAL_PURCHASE', 2000,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    'oisint_plus_pro', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'ignored_unknown_product',
  'FAIL(087/f): unknown product was accepted'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-anonymous', 'INITIAL_PURCHASE', 2001,
    '00000000-0000-4000-8000-000000000573', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'ignored_unknown_user',
  'FAIL(087/g): anonymous customer received Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-unknown-user', 'INITIAL_PURCHASE', 2002,
    '00000000-0000-4000-8000-000000000579', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'ignored_unknown_user',
  'FAIL(087/h): unknown customer was fabricated'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-redeemed', 'PURCHASE_REDEEMED', 2100,
    '00000000-0000-4000-8000-000000000572', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'ignored_unknown_event',
  'FAIL(087/h2): PURCHASE_REDEEMED inferred a Plus grant'
);

-- 照合済み状態を渡すtransferは、旧revokeと新grantを同一transactionで適用する。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-574-1', 'INITIAL_PURCHASE', 100,
    '00000000-0000-4000-8000-000000000574', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'applied',
  'FAIL(087/h2b): transfer fixture old Plus was not applied'
);
select test_assert(
  public.apply_revenuecat_transfer(
    'evt-574-transfer', 3000, 'app-oisint', 'SANDBOX',
    array['$RCAnonymousID:old', '00000000-0000-4000-8000-000000000574'],
    array['00000000-0000-4000-8000-000000000575', '$RCAnonymousID:new'],
    array['oisint_plus_annual', 'oisint_plus_monthly'],
    array[4102444800000::bigint, 4102444800000::bigint],
    array[null::bigint, null::bigint],
    array[true, true]
  ) = 'applied_transfer',
  'FAIL(087/h2c): atomic transfer was not applied'
);
select test_assert(
  not public.is_plus_for_user('00000000-0000-4000-8000-000000000574')
  and public.is_plus_for_user('00000000-0000-4000-8000-000000000575'),
  'FAIL(087/h2d): atomic transfer did not revoke old and grant verified new state'
);
select test_assert(
  public.apply_revenuecat_transfer(
    'evt-574-transfer', 3000, 'app-oisint', 'SANDBOX',
    array['00000000-0000-4000-8000-000000000574'],
    array['00000000-0000-4000-8000-000000000575'],
    array['oisint_plus_annual'], array[4102444800000::bigint],
    array[null::bigint], array[true]
  ) = 'ignored_duplicate',
  'FAIL(087/h2e): transfer retry was not idempotent'
);

-- destination照合の途中で不正状態があっても、旧subject revokeだけをcommitしない。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-577-1', 'INITIAL_PURCHASE', 100,
    '00000000-0000-4000-8000-000000000577', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'applied',
  'FAIL(087/h2f): invalid-transfer fixture was not applied'
);
select test_assert(
  public.apply_revenuecat_transfer(
    'evt-577-invalid-transfer', 2000, 'app-oisint', 'SANDBOX',
    array['00000000-0000-4000-8000-000000000577'],
    array['00000000-0000-4000-8000-000000000578'],
    array['oisint_plus_unknown'], array[4102444800000::bigint],
    array[null::bigint], array[true]
  ) = 'ignored_invalid_transfer'
  and public.is_plus_for_user('00000000-0000-4000-8000-000000000577')
  and not public.is_plus_for_user('00000000-0000-4000-8000-000000000578'),
  'FAIL(087/h2g): invalid transfer partially revoked the old subject'
);

-- TRANSFERは旧subjectを先に無効化し、新subjectはSubscriber API照合成功までFreeのまま。
select test_assert(
  public.revoke_revenuecat_transfer(
    'evt-571-transfer', 3000,
    array['00000000-0000-4000-8000-000000000571'],
    array['00000000-0000-4000-8000-000000000572']
  ) = 'transfer_revoked_old_requires_reconciliation',
  'FAIL(087/h3): transfer was not accepted for safe reconciliation'
);
select test_assert(
  not public.is_plus_for_user('00000000-0000-4000-8000-000000000571')
  and not public.is_plus_for_user('00000000-0000-4000-8000-000000000572'),
  'FAIL(087/h4): transfer left old Plus or fabricated new Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-571-transfer-old', 'RENEWAL', 2500,
    '00000000-0000-4000-8000-000000000571', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
  ) = 'ignored_stale',
  'FAIL(087/h5): reverse-order renewal resurrected transferred ownership'
);

-- lifecycle通知が購入通知より先に届いても、署名済みの将来期限/猶予を維持する。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-601-cancel-first', 'CANCELLATION', 4000,
    '00000000-0000-4000-8000-000000000601', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, false
  ) = 'applied',
  'FAIL(087/h6): cancellation-first future expiry incorrectly became Free'
);
select test_assert(
  public.is_plus_for_user('00000000-0000-4000-8000-000000000601'),
  'FAIL(087/h6b): cancellation-first future expiry did not preserve Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-602-grace-first', 'BILLING_ISSUE', 4001,
    '00000000-0000-4000-8000-000000000602', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    1, 4102444800000, false
  ) = 'applied',
  'FAIL(087/h7): billing grace-first did not preserve access'
);
select test_assert(
  public.is_plus_for_user('00000000-0000-4000-8000-000000000602')
  and (select lifecycle_state = 'grace' from public.user_entitlements
       where user_id = '00000000-0000-4000-8000-000000000602'),
  'FAIL(087/h7b): billing grace-first did not preserve access'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-603-paused-first', 'SUBSCRIPTION_PAUSED', 4002,
    '00000000-0000-4000-8000-000000000603', 'plus', array['plus'],
    'oisint_plus_annual', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, false
  ) = 'applied',
  'FAIL(087/h8): paused subscription before expiry became Free'
);
select test_assert(
  public.is_plus_for_user('00000000-0000-4000-8000-000000000603'),
  'FAIL(087/h8b): paused subscription before expiry did not preserve Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-606-initial', 'INITIAL_PURCHASE', 6000,
    '00000000-0000-4000-8000-000000000606', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'applied',
  'FAIL(087/h8c): purchase proof fixture was not applied'
);
-- 更新系RPCとstableな読取関数を同じBoolean式に置くと、PostgreSQLの
-- 評価順序により読取が更新前に実行され得るため、適用後のアクセス判定を分離する。
select test_assert(
  public.is_plus_for_user('00000000-0000-4000-8000-000000000606'),
  'FAIL(087/h8c2): purchase proof did not resolve to Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-606-renewal-without-proof', 'RENEWAL', 6001,
    '00000000-0000-4000-8000-000000000606', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    null, null, true
  ) = 'ignored_missing_expiration'
  and public.is_plus_for_user('00000000-0000-4000-8000-000000000606')
  and (select last_event_id = 'evt-606-initial'
         from public.user_entitlements
        where user_id = '00000000-0000-4000-8000-000000000606'),
  'FAIL(087/h8d): renewal without event expiry changed the verified state'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-604-insufficient-state', 'CANCELLATION', 4003,
    '00000000-0000-4000-8000-000000000604', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    null, null, false
  ) = 'applied',
  'FAIL(087/h9): lifecycle event without verified access granted Plus'
);
select test_assert(
  not public.is_plus_for_user('00000000-0000-4000-8000-000000000604'),
  'FAIL(087/h9b): lifecycle event without verified access granted Plus'
);
-- Subscriber APIがPRODUCT_CHANGEの現在状態を「Plusなし」と確定した場合、
-- 既存の将来期限を温存せず、明示的な過去窓でFreeへ収束する。
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-604-proof', 'INITIAL_PURCHASE', 4010,
    '00000000-0000-4000-8000-000000000604', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'applied',
  'FAIL(087/h9c): product-change Free reconciliation fixture was not granted'
);
select test_assert(
  public.is_plus_for_user('00000000-0000-4000-8000-000000000604'),
  'FAIL(087/h9c2): product-change Free reconciliation fixture was not granted'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-604-product-free', 'PRODUCT_CHANGE', 4011,
    '00000000-0000-4000-8000-000000000604', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    0, 0, false
  ) = 'applied',
  'FAIL(087/h9d): confirmed Product Change Free state preserved old Plus'
);
select test_assert(
  not public.is_plus_for_user('00000000-0000-4000-8000-000000000604'),
  'FAIL(087/h9d2): confirmed Product Change Free state preserved old Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-605-uppercase-subject', 'INITIAL_PURCHASE', 4004,
    'ABCDEFAB-CDEF-1ABC-8DEF-ABCDEFABCDEF'::text, 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'applied',
  'FAIL(087/h9c): canonical UUID subject was rejected'
);
select test_assert(
  public.is_plus_for_user('abcdefab-cdef-1abc-8def-abcdefabcdef'),
  'FAIL(087/h9d): canonical UUID subject did not receive verified Plus'
);

-- 異常fixtureとして匿名subjectに将来期限の行が残っていても、公開resolver/
-- service gateはFreeへ倒す。行自体は監査用に削除しない。
insert into public.user_entitlements (
  user_id, entitlement_id, offering_id, product_id, app_user_id,
  store, environment, is_active, lifecycle_state, expires_at,
  will_renew, grace_period_expires_at, last_event_id,
  last_event_timestamp_ms
) values (
  '00000000-0000-4000-8000-000000000573', 'plus', 'default',
  'oisint_plus_monthly', '00000000-0000-4000-8000-000000000573',
  'TEST_STORE', 'SANDBOX', true, 'active', '2099-01-01T00:00:00Z',
  true, null, 'anonymous-fixture', 5000
);
select test_assert(
  not public.is_plus_for_user('00000000-0000-4000-8000-000000000573'),
  'FAIL(087/h9e): anonymous entitlement fixture granted Plus'
);
select test_assert(
  public.apply_revenuecat_webhook_event(
    'evt-601-older-purchase', 'INITIAL_PURCHASE', 3999,
    '00000000-0000-4000-8000-000000000601', 'plus', array['plus'],
    'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX',
    4102444800000, null, true
  ) = 'ignored_stale',
  'FAIL(087/h10): older purchase resurrected cancellation-first state'
);

-- アカウント削除の外部customer消去は恒久userだけ。匿名userは従来の
-- purge/Auth削除へ進み、外部secret欠落で匿名削除を壊さない。
select test_assert(
  public.enqueue_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000573'
  ) = 'ignored_unknown_user',
  'FAIL(087/h6): anonymous user was queued for a RevenueCat customer delete'
);
select test_assert(
  public.enqueue_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000571'
  ) = 'pending'
  and public.record_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000571', 'failed', 'provider_retryable'
  ) = 'recorded'
  and public.record_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000571', 'succeeded', null
  ) = 'recorded',
  'FAIL(087/h7): deletion outbox status was not recorded'
);
select test_assert(
  (select status = 'succeeded' and attempts = 2 and last_error_code is null
     from public.revenuecat_customer_deletion_requests
    where user_id = '00000000-0000-4000-8000-000000000571'),
  'FAIL(087/h8): deletion outbox attempt/error audit is incorrect'
);
select test_assert(
  public.enqueue_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000571'
  ) = 'succeeded'
  and (select external_deleted from public.revenuecat_customer_deletion_requests
       where user_id = '00000000-0000-4000-8000-000000000571'),
  'FAIL(087/h8b): externally deleted customer was scheduled for a duplicate delete'
);
insert into public.revenuecat_customer_deletion_requests (
  user_id, app_user_id, status, external_deleted
) values (
  '00000000-0000-4000-8000-000000000578',
  '00000000-0000-4000-8000-000000000578', 'succeeded', true
);
select test_assert(
  public.finalize_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000578'
  ) = 'finalized',
  'FAIL(087/h9a): finalize incorrectly waited for Auth deletion'
);
select test_assert(
  not exists (
    select 1 from public.revenuecat_customer_deletion_requests
     where user_id = '00000000-0000-4000-8000-000000000578'
  ),
  'FAIL(087/h9a2): finalized deletion request was retained'
);
insert into public.revenuecat_customer_deletion_requests (
  user_id, app_user_id, status, external_deleted
) values (
  '00000000-0000-4000-8000-000000000580',
  '00000000-0000-4000-8000-000000000580', 'succeeded', true
);
select test_assert(
  public.finalize_revenuecat_customer_deletion(
    '00000000-0000-4000-8000-000000000580'
  ) = 'finalized',
  'FAIL(087/h9): successful external deletion retained canonical subject'
);
select test_assert(
  not exists (
    select 1 from public.revenuecat_customer_deletion_requests
     where user_id = '00000000-0000-4000-8000-000000000580'
  ),
  'FAIL(087/h9b): successful external deletion retained canonical subject'
);
commit;

-- 自分の行だけが見える。書き込みとserver-only RPCはclientから不可。
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000571","role":"authenticated","is_anonymous":false}';
select test_assert(
  (select count(*) from public.user_entitlements) = 1,
  'FAIL(087/i): authenticated user could not read own entitlement'
);
select test_assert(
  (select count(*) from public.user_entitlements where user_id = '00000000-0000-4000-8000-000000000572') = 0,
  'FAIL(087/j): authenticated user read another entitlement'
);
select test_assert(
  (select (public.resolve_current_entitlement()->>'tier') = 'free'),
  'FAIL(087/k): transferred owner resolver did not fail closed to Free'
);
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000573","role":"authenticated","is_anonymous":true}';
select test_assert(
  (select (public.resolve_current_entitlement()->>'tier') = 'free'),
  'FAIL(087/k2): anonymous entitlement row escaped public resolver'
);
select test_assert(
  (select count(*) = 1 and bool_and(is_active = false and lifecycle_state = 'free')
     from public.get_my_entitlement()),
  'FAIL(087/k3): anonymous entitlement RPC did not return one explicit Free row'
);

do $$
begin
  begin
    insert into public.user_entitlements (
      user_id, app_user_id, last_event_id, last_event_timestamp_ms
    ) values (
      '00000000-0000-4000-8000-000000000572',
      '00000000-0000-4000-8000-000000000572', 'forged', 999
    );
    raise exception 'FAIL(087/l): authenticated insert succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.is_plus_for_user('00000000-0000-4000-8000-000000000572');
    raise exception 'FAIL(087/m): authenticated called service-only resolver';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_revenuecat_customer_deletion(
      '00000000-0000-4000-8000-000000000571', 'succeeded', null
    );
    raise exception 'FAIL(087/m2): authenticated recorded deletion outbox';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- JWTのrole claimだけをservice_roleへ偽装しても、DB roleの権限は増えない。
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000572","role":"service_role","is_anonymous":false}';
do $$
begin
  begin
    perform public.apply_revenuecat_webhook_event(
      'evt-forged-role', 'INITIAL_PURCHASE', 3000,
      '00000000-0000-4000-8000-000000000572', 'plus', array['plus'],
      'oisint_plus_monthly', 'default', 'TEST_STORE', 'SANDBOX', 4102444800000, null, true
    );
    raise exception 'FAIL(087/n): forged role invoked webhook RPC';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
