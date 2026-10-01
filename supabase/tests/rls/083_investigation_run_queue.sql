-- =============================================================================
-- 083_investigation_run_queue.sql — #579 受付/実行分離の実DB契約
--
-- 文字列の静的検査ではなく、scratch DB に適用した migration の service_role
-- RPC を実際に呼び出す。全ての fixture は transaction rollback される。
-- =============================================================================

begin;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000831', false),
  ('00000000-0000-0000-0000-000000000832', false),
  ('00000000-0000-0000-0000-000000000833', false),
  ('00000000-0000-0000-0000-000000000834', false),
  ('00000000-0000-0000-0000-000000000835', false),
  ('00000000-0000-0000-0000-000000000836', false),
  ('00000000-0000-0000-0000-000000000837', false),
  ('00000000-0000-0000-0000-000000000838', false),
  ('00000000-0000-0000-0000-000000000841', false),
  ('00000000-0000-0000-0000-000000000842', false),
  ('00000000-0000-0000-0000-000000000843', false),
  ('00000000-0000-0000-0000-000000000844', false),
  ('00000000-0000-0000-0000-000000000845', false),
  ('00000000-0000-0000-0000-000000000846', false);

insert into public.investigations (
  id, created_by, title, raw_query
) values (
  '00000000-0000-0000-0000-000000000083',
  '00000000-0000-0000-0000-000000000831',
  'Run queue fixture 083',
  'queue contract fixture 083'
);

-- 認証済みクライアントから run queue RPC を直接実行できないことを固定する。
set local role authenticated;
do $$
begin
  begin
    perform public.claim_investigation_run(
      '00000000-0000-0000-0000-000000000083',
      '00000000-0000-0000-0000-000000000831',
      180
    );
    raise exception 'FAIL(083/acl): authenticated executed claim RPC';
  exception when insufficient_privilege then
    null;
  end;
end $$;

set local role service_role;

do $$
declare
  v_investigation uuid := '00000000-0000-0000-0000-000000000083';
  v_owner_a uuid := '00000000-0000-0000-0000-000000000831';
  v_owner_b uuid := '00000000-0000-0000-0000-000000000832';
  v_run uuid;
  v_accepted_at timestamptz;
  v_usage_id bigint;
  v_claim record;
  v_reservation record;
  v_reservation_again record;
  v_no_candidates_investigation uuid := '00000000-0000-0000-0000-000000000834';
  v_no_candidates_owner uuid := '00000000-0000-0000-0000-000000000833';
  v_no_candidates_run uuid;
  v_no_candidates_usage_id bigint;
  v_no_candidates_retry_run uuid;
  v_no_candidates_retry_usage_id bigint;
  v_no_candidates_finished boolean;
  v_no_candidates_event_count integer;
  v_no_candidates_failed_event_count integer;
  v_request_id uuid := '00000000-0000-0000-0000-000000000839';
begin
  -- 初回 claim は run を1件だけ作り、受付確定前は pending と返す。
  select * into v_claim
    from public.claim_investigation_run(
      v_investigation, v_owner_a, 180, v_request_id, false
    );
  if not v_claim.acquired or v_claim.status <> 'running' or v_claim.accepted then
    raise exception 'FAIL(083/initial): expected acquired running pending claim';
  end if;
  v_run := v_claim.run_id;
  if (select request_id from public.investigation_runs where id = v_run) <> v_request_id
     or (select requires_transient_anchor from public.investigation_runs where id = v_run) then
    raise exception 'FAIL(083/request-id): claim correlation or anchor flag was not persisted safely';
  end if;

  -- A が cost/enqueue を確定する前の B は、成功扱いの 202 へ進めてはいけない。
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_b, 180);
  if v_claim.acquired or v_claim.status <> 'running' or v_claim.accepted then
    raise exception 'FAIL(083/pending-duplicate): pending duplicate was accepted';
  end if;

  if not (select marked from public.mark_investigation_run_enqueued(v_run, v_owner_a, 'mock_bypassed')) then
    raise exception 'FAIL(083/accept): run acceptance was not persisted';
  end if;
  select accepted_at into v_accepted_at
    from public.investigation_runs
   where id = v_run;
  if v_accepted_at is null then
    raise exception 'FAIL(083/accepted-at): acceptance timestamp was not persisted';
  end if;

  -- 受付確定後の duplicate は同じ run を参照し、二重 run を作らない。
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_b, 180);
  if v_claim.acquired or v_claim.run_id <> v_run or not v_claim.accepted then
    raise exception 'FAIL(083/accepted-duplicate): duplicate did not converge to accepted run';
  end if;
  if (select count(*) from public.investigation_runs
      where investigation_id = v_investigation) <> 1 then
    raise exception 'FAIL(083/duplicate-run): more than one run was created';
  end if;

  -- lease を期限切れにして、同一 run id を別 owner が再 claim できることを確認する。
  update public.investigation_runs
     set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = v_run;
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_b, 180);
  if not v_claim.acquired or v_claim.run_id <> v_run or v_claim.status <> 'running' then
    raise exception 'FAIL(083/stale-lease): stale run was not reclaimed';
  end if;
  if (select accepted_at from public.investigation_runs where id = v_run) <> v_accepted_at then
    raise exception 'FAIL(083/accepted-at-reclaim): reclaim reset the original acceptance timestamp';
  end if;

  -- run id を idempotency key とした cost reservation は provider_usage を1行だけ作る。
  select * into v_reservation
    from public.reserve_provider_budget_for_run(
      'run', v_investigation, v_run, 'fixture', 'fixture-model', 'mock',
      0, 1000000, 10000000, false
    );
  if not v_reservation.is_allowed or v_reservation.usage_id is null then
    raise exception 'FAIL(083/reservation): first reservation was denied';
  end if;
  v_usage_id := v_reservation.usage_id;

  select * into v_reservation_again
    from public.reserve_provider_budget_for_run(
      'run', v_investigation, v_run, 'fixture', 'fixture-model', 'mock',
      0, 1000000, 10000000, false
    );
  if v_reservation_again.usage_id <> v_usage_id
     or (select count(*) from public.provider_usage
         where investigation_run_id = v_run and action = 'run') <> 1 then
    raise exception 'FAIL(083/reservation-idempotency): reservation was duplicated';
  end if;

  -- 同一 step の失敗は 1, 2 回目は queued、3 回目で terminal failed になる。
  select * into v_reservation
    from public.record_investigation_run_failure(v_run, v_owner_b, 'searching', 'provider_error', 3);
  if v_reservation.failure_count <> 1 or v_reservation.terminal then
    raise exception 'FAIL(083/failure-1): first failure was not retryable';
  end if;
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_a, 180);
  if not v_claim.acquired then
    raise exception 'FAIL(083/failure-1-reclaim): queued run was not claimable';
  end if;

  select * into v_reservation
    from public.record_investigation_run_failure(v_run, v_owner_a, 'searching', 'provider_error', 3);
  if v_reservation.failure_count <> 2 or v_reservation.terminal then
    raise exception 'FAIL(083/failure-2): second failure was not retryable';
  end if;
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_b, 180);
  if not v_claim.acquired then
    raise exception 'FAIL(083/failure-2-reclaim): queued run was not claimable';
  end if;

  select * into v_reservation
    from public.record_investigation_run_failure(v_run, v_owner_b, 'searching', 'provider_error', 3);
  if v_reservation.failure_count <> 3 or not v_reservation.terminal then
    raise exception 'FAIL(083/failure-3): third failure did not become terminal';
  end if;
  if (select status from public.investigation_runs where id = v_run) <> 'failed'
     or (select step_failures ->> 'searching' from public.investigation_runs where id = v_run) <> '3' then
    raise exception 'FAIL(083/failure-persist): terminal failure was not persisted';
  end if;
  if (select status from public.investigations where id = v_investigation) <> 'failed'
     or (select count(*) from public.investigation_events
         where investigation_id = v_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'run_id' = v_run::text) <> 1 then
    raise exception 'FAIL(083/failure-atomic): investigation/event terminal state was not persisted atomically';
  end if;

  -- 候補0件は受付時に確定した provider 予約を1件だけ保持し、汎用 failure
  -- counter / retry は使わず、run・investigation・eventを1 RPC/1 transactionで
  -- terminal failedへ確定する。
  insert into public.investigations (
    id, created_by, title, raw_query
  ) values (
    v_no_candidates_investigation,
    v_no_candidates_owner,
    'No candidates fixture 083',
    'no candidates fixture 083'
  );
  select * into v_claim
    from public.claim_investigation_run(
      v_no_candidates_investigation, v_no_candidates_owner, 180, v_request_id, false
    );
  if not v_claim.acquired then
    raise exception 'FAIL(083/no-candidates-claim): run was not acquired';
  end if;
  v_no_candidates_run := v_claim.run_id;

  select * into v_reservation
    from public.reserve_provider_budget_for_run(
      'run', v_no_candidates_investigation, v_no_candidates_run,
      'fixture', 'fixture-model', 'mock', 0, 1000000, 10000000, false
    );
  if not v_reservation.is_allowed or v_reservation.usage_id is null then
    raise exception 'FAIL(083/no-candidates-reservation): reservation was not created';
  end if;
  v_no_candidates_usage_id := v_reservation.usage_id;

  select finished into v_no_candidates_finished
    from public.finish_investigation_run_no_candidates(
      v_no_candidates_run, v_no_candidates_owner, v_request_id
    );
  if not v_no_candidates_finished then
    raise exception 'FAIL(083/no-candidates-finish): atomic terminal RPC failed';
  end if;
  if (select status from public.investigations
      where id = v_no_candidates_investigation) <> 'failed'
     or (select status from public.investigation_runs where id = v_no_candidates_run) <> 'failed'
     or (select last_error_code from public.investigation_runs where id = v_no_candidates_run) <> 'no_candidates'
     or (select step_failures from public.investigation_runs where id = v_no_candidates_run) <> '{}'::jsonb then
    raise exception 'FAIL(083/no-candidates-state): terminal state was not persisted atomically';
  end if;
  select count(*) into v_no_candidates_event_count
    from public.investigation_events
   where investigation_id = v_no_candidates_investigation
     and event_type = 'no_candidates';
  select count(*) into v_no_candidates_failed_event_count
    from public.investigation_events
   where investigation_id = v_no_candidates_investigation
     and event_type = 'investigation_failed'
     and metadata ->> 'code' = 'no_candidates';
  if v_no_candidates_event_count <> 1 or v_no_candidates_failed_event_count <> 1 then
    raise exception 'FAIL(083/no-candidates-events): expected one safe event pair';
  end if;
  if (select count(*) from public.investigation_events
      where investigation_id = v_no_candidates_investigation
        and event_type = 'no_candidates'
        and metadata ->> 'run_id' = v_no_candidates_run::text) <> 1
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'code' = 'no_candidates'
           and metadata ->> 'run_id' = v_no_candidates_run::text) <> 1 then
    raise exception 'FAIL(083/no-candidates-event-key): first event pair has no run key';
  end if;
  if (select metadata ->> 'request_id' from public.investigation_events
      where investigation_id = v_no_candidates_investigation
        and event_type = 'no_candidates'
        and metadata ->> 'run_id' = v_no_candidates_run::text) <> v_request_id::text
     or (select metadata ->> 'request_id' from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'code' = 'no_candidates'
           and metadata ->> 'run_id' = v_no_candidates_run::text) <> v_request_id::text then
    raise exception 'FAIL(083/no-candidates-request-id): safe request id was not propagated';
  end if;
  if (select count(*) from public.provider_usage
      where investigation_id = v_no_candidates_investigation
        and investigation_run_id = v_no_candidates_run
        and action = 'run') <> 1
     or (select id from public.provider_usage
         where investigation_id = v_no_candidates_investigation
           and investigation_run_id = v_no_candidates_run
           and action = 'run') <> v_no_candidates_usage_id then
    raise exception 'FAIL(083/no-candidates-provider): reservation was not retained exactly once';
  end if;

  -- 終端化完了後の利用者による明示的な再実行は、新しいrunとして受け付ける。
  -- （同じactive runのduplicateだけが既存runへ収束する。）
  select * into v_claim
    from public.claim_investigation_run(
      v_no_candidates_investigation, v_no_candidates_owner, 180
    );
  if not v_claim.acquired or v_claim.run_id is null
     or v_claim.run_id = v_no_candidates_run or v_claim.status <> 'running'
     or (select count(*) from public.investigation_runs
         where investigation_id = v_no_candidates_investigation) <> 2 then
    raise exception 'FAIL(083/no-candidates-retry): explicit retry did not create a new run';
  end if;
  v_no_candidates_retry_run := v_claim.run_id;

  select * into v_reservation
    from public.reserve_provider_budget_for_run(
      'run', v_no_candidates_investigation, v_no_candidates_retry_run,
      'fixture', 'fixture-model', 'mock', 0, 1000000, 10000000, false
    );
  if not v_reservation.is_allowed or v_reservation.usage_id is null then
    raise exception 'FAIL(083/no-candidates-retry-reservation): reservation was not created';
  end if;
  v_no_candidates_retry_usage_id := v_reservation.usage_id;

  -- 明示 retry が進行中に旧 terminal run の RPC が再送されても、retry 状態を
  -- failed へ巻き戻さない（terminal run の再入は no-op）。
  update public.investigations
     set status = 'searching'
   where id = v_no_candidates_investigation;

  -- 同じ RPC の再呼出しは no-op で、event/run を増やさない。
  select finished into v_no_candidates_finished
    from public.finish_investigation_run_no_candidates(
      v_no_candidates_run, v_no_candidates_owner, v_request_id
    );
  if not v_no_candidates_finished
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'no_candidates') <> 1
     or (select count(*) from public.investigation_runs
         where investigation_id = v_no_candidates_investigation) <> 2 then
    raise exception 'FAIL(083/no-candidates-idempotency): repeated terminal RPC duplicated state';
  end if;
  if (select status from public.investigations
      where id = v_no_candidates_investigation) <> 'searching' then
    raise exception 'FAIL(083/no-candidates-idempotency): old terminal retry regressed investigation';
  end if;
  if (select step_failures from public.investigation_runs where id = v_no_candidates_run)
       <> '{}'::jsonb
     or (select count(*) from public.provider_usage
         where investigation_id = v_no_candidates_investigation
           and investigation_run_id = v_no_candidates_run
           and action = 'run') <> 1
     or (select id from public.provider_usage
         where investigation_id = v_no_candidates_investigation
           and investigation_run_id = v_no_candidates_run
           and action = 'run') <> v_no_candidates_usage_id then
    raise exception 'FAIL(083/no-candidates-idempotency): retry changed failure or reservation state';
  end if;

  -- 明示 retry の新runでも候補0件になった場合は、run単位の別eventを残す。
  select finished into v_no_candidates_finished
    from public.finish_investigation_run_no_candidates(
      v_no_candidates_retry_run, v_no_candidates_owner, v_request_id
    );
  if not v_no_candidates_finished
     or (select status from public.investigations
         where id = v_no_candidates_investigation) <> 'failed'
     or (select status from public.investigation_runs
         where id = v_no_candidates_retry_run) <> 'failed'
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'no_candidates') <> 2
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'code' = 'no_candidates') <> 2
     or (select count(*) from public.provider_usage
         where investigation_id = v_no_candidates_investigation
           and action = 'run') <> 2 then
    raise exception 'FAIL(083/no-candidates-second-run): retry terminal state/events were not isolated by run';
  end if;
  if (select count(*) from public.provider_usage
      where investigation_id = v_no_candidates_investigation
        and investigation_run_id = v_no_candidates_retry_run
        and action = 'run') <> 1
     or (select id from public.provider_usage
         where investigation_id = v_no_candidates_investigation
           and investigation_run_id = v_no_candidates_retry_run
           and action = 'run') <> v_no_candidates_retry_usage_id then
    raise exception 'FAIL(083/no-candidates-second-run): retry reservation was duplicated';
  end if;

  -- 同じ新runを再送しても、そのrunのeventだけが各1件のままになる。
  select finished into v_no_candidates_finished
    from public.finish_investigation_run_no_candidates(
      v_no_candidates_retry_run, v_no_candidates_owner, v_request_id
    );
  if not v_no_candidates_finished
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'no_candidates') <> 2
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'no_candidates'
           and metadata ->> 'run_id' = v_no_candidates_run::text) <> 1
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'no_candidates'
           and metadata ->> 'run_id' = v_no_candidates_retry_run::text) <> 1
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'code' = 'no_candidates') <> 2
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'code' = 'no_candidates'
           and metadata ->> 'run_id' = v_no_candidates_run::text) <> 1
     or (select count(*) from public.investigation_events
         where investigation_id = v_no_candidates_investigation
           and event_type = 'investigation_failed'
           and metadata ->> 'code' = 'no_candidates'
           and metadata ->> 'run_id' = v_no_candidates_retry_run::text) <> 1
     or (select count(*) from public.provider_usage
         where investigation_id = v_no_candidates_investigation
           and action = 'run') <> 2 then
    raise exception 'FAIL(083/no-candidates-second-idempotency): retry duplicated events/reservation';
  end if;
end $$;

-- transient anchor run は stale lease 後も同じ run を再claimできるが、座標無しで
-- provider を推測して続行しない。検索成果物が揃った経路は anchor flag を解除し、
-- 成果物が無い経路は run/investigation/event を原子的に終端化する。
do $$
declare
  v_investigation uuid := '00000000-0000-0000-0000-000000000841';
  v_owner_a uuid := '00000000-0000-0000-0000-000000000842';
  v_owner_b uuid := '00000000-0000-0000-0000-000000000843';
  v_run uuid;
  v_claim record;
  v_consumed boolean;
  v_anchor_investigation uuid := '00000000-0000-0000-0000-000000000844';
  v_anchor_owner uuid := '00000000-0000-0000-0000-000000000845';
  v_anchor_reclaimer uuid := '00000000-0000-0000-0000-000000000846';
  v_anchor_run uuid;
  v_finished boolean;
  v_request_id uuid := '00000000-0000-0000-0000-000000000847';
begin
  insert into public.investigations (id, created_by, title, raw_query)
  values (v_investigation, v_owner_a, 'Anchor consumed fixture 083', '現在地 083');
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_a, 180, v_request_id, true);
  if not v_claim.acquired then
    raise exception 'FAIL(083/anchor-claim): anchor run was not acquired';
  end if;
  v_run := v_claim.run_id;
  if not (select requires_transient_anchor from public.investigation_runs where id = v_run) then
    raise exception 'FAIL(083/anchor-flag): anchor dependency was not retained';
  end if;
  if not (select marked from public.mark_investigation_run_enqueued(v_run, v_owner_a, 'mock_bypassed')) then
    raise exception 'FAIL(083/anchor-accept): anchor run was not accepted';
  end if;
  update public.investigation_runs
     set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = v_run;
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_owner_b, 180, v_request_id, false);
  if not v_claim.acquired or v_claim.run_id <> v_run then
    raise exception 'FAIL(083/anchor-reclaim): stale anchor run was not reclaimed';
  end if;
  if not (select requires_transient_anchor from public.investigation_runs where id = v_run) then
    raise exception 'FAIL(083/anchor-reclaim-flag): reclaim incorrectly dropped anchor dependency';
  end if;
  select consumed into v_consumed
    from public.mark_investigation_run_anchor_consumed(v_run, v_owner_b);
  if not v_consumed
     or (select requires_transient_anchor from public.investigation_runs where id = v_run) then
    raise exception 'FAIL(083/anchor-consume): search completion did not clear anchor dependency';
  end if;

  insert into public.investigations (id, created_by, title, raw_query)
  values (v_anchor_investigation, v_anchor_owner, 'Anchor required fixture 083', '現在地 083');
  select * into v_claim
    from public.claim_investigation_run(
      v_anchor_investigation, v_anchor_owner, 180, v_request_id, true
    );
  if not v_claim.acquired then
    raise exception 'FAIL(083/anchor-required-claim): run was not acquired';
  end if;
  v_anchor_run := v_claim.run_id;
  if not (select marked from public.mark_investigation_run_enqueued(v_anchor_run, v_anchor_owner, 'mock_bypassed')) then
    raise exception 'FAIL(083/anchor-required-accept): run was not accepted';
  end if;
  update public.investigation_runs
     set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = v_anchor_run;
  select * into v_claim
    from public.claim_investigation_run(v_anchor_investigation, v_anchor_reclaimer, 180);
  if not v_claim.acquired then
    raise exception 'FAIL(083/anchor-required-reclaim): stale run was not reclaimed';
  end if;
  select finished into v_finished
    from public.finish_investigation_run_location_anchor_required(
      v_anchor_run, v_anchor_reclaimer, v_request_id
    );
  if not v_finished
     or (select status from public.investigation_runs where id = v_anchor_run) <> 'rejected'
     or (select status from public.investigations where id = v_anchor_investigation) <> 'draft'
     or (select count(*) from public.investigation_events
         where investigation_id = v_anchor_investigation
           and event_type = 'location_anchor_required'
           and metadata ->> 'run_id' = v_anchor_run::text) <> 1 then
    raise exception 'FAIL(083/anchor-required-terminal): stale anchor did not terminalize atomically';
  end if;
  select finished into v_finished
    from public.finish_investigation_run_location_anchor_required(
      v_anchor_run, v_anchor_reclaimer, v_request_id
    );
  if not v_finished
     or (select count(*) from public.investigation_events
         where investigation_id = v_anchor_investigation
           and event_type = 'location_anchor_required') <> 1 then
    raise exception 'FAIL(083/anchor-required-idempotency): repeated terminal RPC duplicated event';
  end if;
end $$;

-- 通常完了も run / investigation / event の同一 transaction とし、完了直前の
-- duplicate と完了直後の duplicate のどちらも同じ最終状態へ収束させる。
do $$
declare
  v_investigation uuid := '00000000-0000-0000-0000-000000000835';
  v_owner uuid := '00000000-0000-0000-0000-000000000835';
  v_duplicate_owner uuid := '00000000-0000-0000-0000-000000000836';
  v_run uuid;
  v_claim record;
  v_finished boolean;
  v_request_id uuid := '00000000-0000-0000-0000-000000000840';
begin
  insert into public.investigations (
    id, created_by, title, raw_query
  ) values (
    v_investigation,
    v_owner,
    'Complete fixture 083',
    'complete fixture 083'
  );

  select * into v_claim
    from public.claim_investigation_run(
      v_investigation, v_owner, 180, v_request_id, false
    );
  if not v_claim.acquired or v_claim.run_id is null then
    raise exception 'FAIL(083/complete-claim): run was not acquired';
  end if;
  v_run := v_claim.run_id;
  if not (select marked from public.mark_investigation_run_enqueued(v_run, v_owner, 'mock_bypassed')) then
    raise exception 'FAIL(083/complete-accept): run acceptance was not persisted';
  end if;

  -- 完了RPC前の duplicate は同じ active run へ収束する。
  select * into v_claim
    from public.claim_investigation_run(
      v_investigation, v_duplicate_owner, 180
    );
  if v_claim.acquired or v_claim.run_id <> v_run or not v_claim.accepted then
    raise exception 'FAIL(083/complete-before-duplicate): duplicate diverged before finish';
  end if;

  select finished into v_finished
    from public.finish_investigation_run_complete(v_run, v_owner, v_request_id);
  if not v_finished then
    raise exception 'FAIL(083/complete-finish): atomic complete RPC failed';
  end if;
  if (select metadata ->> 'request_id' from public.investigation_events
      where investigation_id = v_investigation
        and event_type = 'step_started'
        and metadata ->> 'step' = 'complete'
        and metadata ->> 'run_id' = v_run::text) <> v_request_id::text then
    raise exception 'FAIL(083/complete-request-id): safe request id was not propagated';
  end if;
  if (select status from public.investigation_runs where id = v_run) <> 'complete'
     or (select status from public.investigations where id = v_investigation) <> 'complete'
     or (select count(*) from public.investigation_events
         where investigation_id = v_investigation
           and event_type = 'step_started'
           and metadata ->> 'step' = 'complete'
           and metadata ->> 'run_id' = v_run::text) <> 1 then
    raise exception 'FAIL(083/complete-atomic): terminal state/event was not committed together';
  end if;

  -- 完了RPCの再送は no-op、event は run 単位で1件だけ。
  select finished into v_finished
    from public.finish_investigation_run_complete(v_run, v_owner, v_request_id);
  if not v_finished
     or (select count(*) from public.investigation_events
         where investigation_id = v_investigation
           and event_type = 'step_started'
           and metadata ->> 'step' = 'complete'
           and metadata ->> 'run_id' = v_run::text) <> 1
     or (select count(*) from public.investigation_runs
         where investigation_id = v_investigation) <> 1 then
    raise exception 'FAIL(083/complete-idempotency): repeated complete duplicated state';
  end if;

  -- 完了後の duplicate は新しい run を作らず、complete を返す。
  select * into v_claim
    from public.claim_investigation_run(
      v_investigation, v_duplicate_owner, 180
    );
  if v_claim.acquired or v_claim.run_id is not null or v_claim.status <> 'complete'
     or v_claim.accepted is not true then
    raise exception 'FAIL(083/complete-after-duplicate): completed investigation reopened';
  end if;
end $$;

-- stale worker が新 owner の claim 後に terminal/failure を上書きできないことを
-- 固定する。全RPCは同じ advisory -> investigation -> run 順なので、この経路を
-- 並行実行しても lock 順の逆転を起こさない。
do $$
declare
  v_investigation uuid := '00000000-0000-0000-0000-000000000837';
  v_old_owner uuid := '00000000-0000-0000-0000-000000000837';
  v_new_owner uuid := '00000000-0000-0000-0000-000000000838';
  v_run uuid;
  v_claim record;
  v_failure record;
  v_finished boolean;
begin
  insert into public.investigations (id, created_by, title, raw_query)
  values (v_investigation, v_old_owner, 'Stale terminal fixture 083', 'stale fixture 083');
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_old_owner, 180);
  if not v_claim.acquired then
    raise exception 'FAIL(083/stale-terminal-claim): old owner was not acquired';
  end if;
  v_run := v_claim.run_id;
  if not (select marked from public.mark_investigation_run_enqueued(v_run, v_old_owner, 'mock_bypassed')) then
    raise exception 'FAIL(083/stale-terminal-accept): acceptance was not persisted';
  end if;
  update public.investigation_runs
     set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = v_run;
  select * into v_claim
    from public.claim_investigation_run(v_investigation, v_new_owner, 180);
  if not v_claim.acquired or v_claim.run_id <> v_run then
    raise exception 'FAIL(083/stale-terminal-reclaim): new owner did not reclaim run';
  end if;

  select * into v_failure
    from public.record_investigation_run_failure(
      v_run, v_old_owner, 'searching', 'stale_worker', 3
    );
  if v_failure.failure_count <> 0 or v_failure.terminal then
    raise exception 'FAIL(083/stale-terminal-failure): stale worker recorded failure';
  end if;
  select finished into v_finished
    from public.finish_investigation_run_complete(v_run, v_old_owner);
  if v_finished then
    raise exception 'FAIL(083/stale-terminal-complete): stale worker completed run';
  end if;
  select finished into v_finished
    from public.finish_investigation_run_no_candidates(v_run, v_old_owner);
  if v_finished then
    raise exception 'FAIL(083/stale-terminal-no-candidates): stale worker terminalized run';
  end if;
  if (select status from public.investigation_runs where id = v_run) <> 'running'
     or (select lease_owner from public.investigation_runs where id = v_run) <> v_new_owner
     or (select status from public.investigations where id = v_investigation) <> 'draft' then
    raise exception 'FAIL(083/stale-terminal-state): new owner state was overwritten';
  end if;
end $$;

rollback;

\echo == 083_investigation_run_queue.sql: all assertions passed
