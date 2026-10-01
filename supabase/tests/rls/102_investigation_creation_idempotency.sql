-- =============================================================================
-- 102_investigation_creation_idempotency.sql — Issue #592
-- =============================================================================
-- Executable scratch-DB coverage for service-only access, concurrent claims,
-- request mismatch, durable provider checkpoints, lease fencing, conservative
-- usage-attempt accounting, guarded finalization, cleanup and completed replay.

create extension if not exists dblink;

create function pg_temp.assert_102(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'FAIL(102/%): assertion failed', p_message;
  end if;
end;
$$;

create function pg_temp.checkpoint_102(p_title text, p_normalized text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'title', p_title,
    'normalizedQuery', p_normalized,
    'area', '池袋',
    'locationScope', null,
    'requirements', jsonb_build_array(jsonb_build_object(
      'text', '静か',
      'normalizedText', '静か',
      'kind', 'atmosphere',
      'priority', 'must',
      'weight', 1
    )),
    'budgetMax', null
  )
$$;

insert into auth.users (id, is_anonymous)
values
  ('00000000-0000-4000-8000-000000001021', false),
  ('00000000-0000-4000-8000-000000001022', false);

-- PUBLIC/anon/authenticated have neither table access nor RPC execution.
set role authenticated;
set request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001021","role":"authenticated"}';
do $$
begin
  perform pg_temp.assert_102(
    not has_table_privilege(
      'authenticated',
      'public.investigation_creation_requests',
      'SELECT'
    ),
    'ledger-table-revoke'
  );
  perform pg_temp.assert_102(
    not has_table_privilege(
      'authenticated',
      'public.investigation_creation_usage_attempts',
      'SELECT'
    ),
    'attempt-table-revoke'
  );
  perform pg_temp.assert_102(
    not has_function_privilege(
      'authenticated',
      'public.claim_investigation_creation(uuid,text,text)',
      'EXECUTE'
    ),
    'claim-rpc-revoke'
  );
  perform pg_temp.assert_102(
    not has_function_privilege(
      'authenticated',
      'public.begin_investigation_creation_step(uuid,text,text,bigint,uuid,text)',
      'EXECUTE'
    ),
    'step-rpc-revoke'
  );
  begin
    perform public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'authenticated-denied', repeat('a', 64)
    );
    raise exception 'authenticated claim unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;

set role service_role;
set request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001021","role":"service_role"}';

-- One logical key has one owner. Same input is in-flight; another digest is a
-- mismatch and cannot reserve cost or create an investigation.
do $$
declare
  v_status text;
begin
  select c.claim_status into v_status
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'sequential', repeat('b', 64)
    ) c;
  perform pg_temp.assert_102(v_status = 'claimed', 'first-claim');
  select c.claim_status into v_status
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'sequential', repeat('b', 64)
    ) c;
  perform pg_temp.assert_102(v_status = 'in_flight', 'same-input-in-flight');
  select c.claim_status into v_status
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'sequential', repeat('c', 64)
    ) c;
  perform pg_temp.assert_102(v_status = 'mismatch', 'digest-mismatch');
end;
$$;

-- Independent connections race for the same new key. The second waits for the
-- row lock and observes in_flight after the first transaction commits.
select dblink_connect(
  'create_102_a',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_connect(
  'create_102_b',
  format(
    'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
    current_database()
  )
);
select dblink_exec('create_102_a', 'set role service_role');
select dblink_exec('create_102_b', 'set role service_role');
select dblink_exec(
  'create_102_a',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000001022","role":"service_role"}'$$
);
select dblink_exec(
  'create_102_b',
  $$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000001022","role":"service_role"}'$$
);
select dblink_send_query(
  'create_102_a',
  $query$do $proc$
  begin
    perform public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001022',
      'concurrent', repeat('d', 64)
    );
    perform pg_sleep(1);
  end;
  $proc$;$query$
);
select pg_sleep(0.1);
select dblink_send_query(
  'create_102_b',
  $$select c.claim_status, c.investigation_id, c.share_token, c.usage_id,
           c.lease_generation, c.lease_token, c.parse_checkpoint,
           c.parse_completed_at, c.embedding_checkpoint,
           c.embedding_completed_at, c.failure_code
      from public.claim_investigation_creation(
        '00000000-0000-4000-8000-000000001022',
        'concurrent', repeat('d', 64)
      ) c$$
);
select pg_temp.assert_102(dblink_is_busy('create_102_b') = 1, 'concurrent-wait');
do $$
begin
  for attempt in 1..200 loop
    exit when dblink_is_busy('create_102_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  perform pg_temp.assert_102(
    dblink_is_busy('create_102_b') = 0,
    'concurrent-finished'
  );
end;
$$;
create temporary table create_102_concurrent_result (
  claim_status text,
  investigation_id uuid,
  share_token text,
  usage_id bigint,
  lease_generation bigint,
  lease_token uuid,
  parse_checkpoint jsonb,
  parse_completed_at timestamptz,
  embedding_checkpoint real[],
  embedding_completed_at timestamptz,
  failure_code text
);
insert into create_102_concurrent_result
select * from dblink_get_result('create_102_b', false) as result(
  claim_status text,
  investigation_id uuid,
  share_token text,
  usage_id bigint,
  lease_generation bigint,
  lease_token uuid,
  parse_checkpoint jsonb,
  parse_completed_at timestamptz,
  embedding_checkpoint real[],
  embedding_completed_at timestamptz,
  failure_code text
);
select pg_temp.assert_102(
  (select claim_status = 'in_flight' from create_102_concurrent_result),
  'concurrent-result'
);
select * from dblink_get_result('create_102_a', false) as result(message text);
select dblink_disconnect('create_102_a');
select dblink_disconnect('create_102_b');

-- Normal execution checkpoints each provider step, completes all seven DB
-- responsibilities atomically, and replays the identical ID/token.
do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_usage bigint;
  v_id uuid;
  v_token text;
  v_status text;
  v_replay_id uuid;
  v_replay_token text;
begin
  select c.lease_generation, c.lease_token
    into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64)
    ) c;
  select r.usage_id into v_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock',
      0, 5000000, 50000000, false
    ) r;
  perform pg_temp.assert_102(
    public.begin_investigation_creation_step(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease, 'parse'
    ) = 'started',
    'parse-start'
  );
  perform pg_temp.assert_102(
    public.save_investigation_creation_parse_checkpoint(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease,
      pg_temp.checkpoint_102('同期作成', '池袋 静か')
    ),
    'parse-save'
  );
  select i.investigation_id, i.share_token into v_id, v_token
    from public.create_investigation_for_claim(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease,
      '同期作成', '池袋で静かな店', '池袋 静か'
    ) i;
  perform pg_temp.assert_102(v_id is not null and v_token is not null, 'create');
  perform pg_temp.assert_102(
    public.begin_investigation_creation_step(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease, 'embedding'
    ) = 'started',
    'embedding-start'
  );
  perform pg_temp.assert_102(
    public.save_investigation_creation_embedding_checkpoint(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease, null
    ),
    'embedding-save-null'
  );
  begin
    perform public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease, v_id, null
    );
    raise exception 'completion unexpectedly accepted a null usage';
  exception when sqlstate '22023' then
    null;
  end;
  perform pg_temp.assert_102(
    public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease, v_id, v_usage
    ),
    'complete-rpc'
  );
  perform pg_temp.assert_102(
    public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64), v_generation, v_lease, v_id, v_usage
    ),
    'complete-idempotent'
  );
  select c.claim_status, c.investigation_id, c.share_token
    into v_status, v_replay_id, v_replay_token
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete', repeat('e', 64)
    ) c;
  perform pg_temp.assert_102(
    v_status = 'complete' and v_replay_id = v_id and v_replay_token = v_token,
    'complete-replay'
  );
  perform pg_temp.assert_102(
    (select count(*) from public.investigations where id = v_id) = 1
      and (select count(*) from public.requirements where investigation_id = v_id) = 1
      and (select count(*) from public.investigation_members where investigation_id = v_id) = 1
      and (select count(*) from public.investigation_events
            where investigation_id = v_id and event_type = 'parse_completed') = 1
      and (select status from public.investigations where id = v_id) = 'recalling'
      and (select investigation_id from public.provider_usage where id = v_usage) = v_id,
    'seven-responsibilities'
  );
end;
$$;

-- A pre-provider release removes the attempt, usage and ledger in one
-- transaction. Reclaiming and reserving again leaves exactly one usage row.
do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_first bigint;
  v_retry bigint;
begin
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'release', repeat('1', 64)
    ) c;
  select r.usage_id into v_first
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'release', repeat('1', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  perform pg_temp.assert_102(
    public.release_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'release', repeat('1', 64), v_generation, v_lease
    ),
    'release'
  );
  perform pg_temp.assert_102(
    not exists (select 1 from public.provider_usage where id = v_first)
      and not exists (select 1 from public.investigation_creation_usage_attempts where usage_id = v_first)
      and not exists (select 1 from public.investigation_creation_requests
        where user_id = '00000000-0000-4000-8000-000000001021'
          and idempotency_key = 'release'),
    'release-cleanup'
  );
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'release', repeat('1', 64)
    ) c;
  select r.usage_id into v_retry
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'release', repeat('1', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  perform pg_temp.assert_102(
    v_retry is not null and
      (select count(*) from public.provider_usage where id in (v_first, v_retry)) = 1,
    'release-re-reserve-one'
  );
  perform public.release_investigation_creation(
    '00000000-0000-4000-8000-000000001021',
    'release', repeat('1', 64), v_generation, v_lease
  );
end;
$$;

-- Abandon has the same pre-provider cleanup guarantee for a partial row. The
-- direct insert models a DB failure boundary before any provider step starts.
do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_usage bigint;
  v_id uuid;
  v_token text;
begin
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'abandon', repeat('2', 64)
    ) c;
  select r.usage_id into v_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'abandon', repeat('2', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  insert into public.investigations(created_by, title, raw_query, normalized_query, status)
  values ('00000000-0000-4000-8000-000000001021', 'partial', 'partial', 'partial', 'parsing')
  returning id, share_token into v_id, v_token;
  update public.investigation_creation_requests
     set investigation_id = v_id, share_token = v_token
   where user_id = '00000000-0000-4000-8000-000000001021'
     and idempotency_key = 'abandon';
  perform pg_temp.assert_102(
    public.abandon_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'abandon', repeat('2', 64), v_generation, v_lease, v_id, v_usage
    ),
    'abandon'
  );
  perform pg_temp.assert_102(
    not exists (select 1 from public.investigations where id = v_id)
      and not exists (select 1 from public.provider_usage where id = v_usage)
      and not exists (select 1 from public.investigation_creation_usage_attempts where usage_id = v_usage)
      and not exists (select 1 from public.investigation_creation_requests
        where user_id = '00000000-0000-4000-8000-000000001021'
          and idempotency_key = 'abandon'),
    'abandon-cleanup'
  );
end;
$$;

-- If release cannot delete the exact expected usage, the attempted child-row
-- deletion is rolled back too; neither ledger nor usage becomes orphaned.
do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_usage bigint;
begin
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'release-rollback', repeat('3', 64)
    ) c;
  select r.usage_id into v_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'release-rollback', repeat('3', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  update public.provider_usage set action = 'rerank' where id = v_usage;
  begin
    perform public.release_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'release-rollback', repeat('3', 64), v_generation, v_lease
    );
    raise exception 'release unexpectedly accepted a mismatched usage';
  exception when sqlstate '40001' then null;
  end;
  perform pg_temp.assert_102(
    exists (select 1 from public.provider_usage where id = v_usage)
      and exists (select 1 from public.investigation_creation_usage_attempts where usage_id = v_usage)
      and exists (select 1 from public.investigation_creation_requests
        where user_id = '00000000-0000-4000-8000-000000001021'
          and idempotency_key = 'release-rollback'),
    'release-rollback'
  );
  update public.provider_usage set action = 'create' where id = v_usage;
  perform public.release_investigation_creation(
    '00000000-0000-4000-8000-000000001021',
    'release-rollback', repeat('3', 64), v_generation, v_lease
  );
end;
$$;

-- Once provider work starts, release is forbidden. A known failure keeps one
-- usage linked to the durable failed creation and replays the terminal result.
do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_usage bigint;
  v_status text;
begin
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'provider-failed', repeat('4', 64)
    ) c;
  select r.usage_id into v_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'provider-failed', repeat('4', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'provider-failed', repeat('4', 64), v_generation, v_lease, 'parse'
  );
  perform pg_temp.assert_102(
    not public.release_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'provider-failed', repeat('4', 64), v_generation, v_lease
    ),
    'started-release-denied'
  );
  perform pg_temp.assert_102(
    public.fail_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'provider-failed', repeat('4', 64), v_generation, v_lease,
      null, v_usage, 'parse_provider_error'
    ),
    'provider-failure-recorded'
  );
  select c.claim_status into v_status
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'provider-failed', repeat('4', 64)
    ) c;
  perform pg_temp.assert_102(
    v_status = 'failed'
      and (select count(*) from public.provider_usage where id = v_usage) = 1
      and (select count(*) from public.investigation_creation_usage_attempts
            where usage_id = v_usage and state = 'failed') = 1,
    'provider-failure-audited'
  );
end;
$$;

-- A hard kill after parse starts creates an uncertain audited attempt. Reclaim
-- rotates the lease, an old worker cannot mutate any step, and a real retry
-- reserves a distinct usage. Both actual attempts remain linked; only one
-- investigation is ever created.
do $$
declare
  v_old_generation bigint;
  v_new_generation bigint;
  v_old_lease uuid;
  v_new_lease uuid;
  v_old_usage bigint;
  v_new_usage bigint;
  v_status text;
  v_id uuid;
begin
  select c.lease_generation, c.lease_token into v_old_generation, v_old_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64)
    ) c;
  select r.usage_id into v_old_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_old_generation, v_old_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'stale', repeat('5', 64), v_old_generation, v_old_lease, 'parse'
  );
  update public.investigation_creation_requests
     set updated_at = clock_timestamp() - interval '6 minutes'
   where user_id = '00000000-0000-4000-8000-000000001021'
     and idempotency_key = 'stale';
  select c.claim_status, c.lease_generation, c.lease_token
    into v_status, v_new_generation, v_new_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64)
    ) c;
  perform pg_temp.assert_102(
    v_status = 'reclaimed'
      and v_new_generation = v_old_generation + 1
      and v_new_lease <> v_old_lease,
    'stale-reclaim'
  );
  perform pg_temp.assert_102(
    not public.touch_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_old_generation, v_old_lease, v_old_usage
    )
      and public.begin_investigation_creation_step(
        '00000000-0000-4000-8000-000000001021',
        'stale', repeat('5', 64), v_old_generation, v_old_lease, 'parse'
      ) = 'lost'
      and not public.save_investigation_creation_parse_checkpoint(
        '00000000-0000-4000-8000-000000001021',
        'stale', repeat('5', 64), v_old_generation, v_old_lease,
        pg_temp.checkpoint_102('old', 'old')
      ),
    'old-lease-provider-fenced'
  );
  select r.usage_id into v_new_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_new_generation, v_new_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  perform pg_temp.assert_102(
    v_new_usage <> v_old_usage
      and (select count(*) from public.provider_usage
            where id in (v_old_usage, v_new_usage)) = 2
      and (select count(*) from public.investigation_creation_usage_attempts
            where usage_id in (v_old_usage, v_new_usage)) = 2
      and (select state from public.investigation_creation_usage_attempts
            where usage_id = v_old_usage) = 'uncertain',
    'uncertain-attempt-accounting'
  );
  perform pg_temp.assert_102(
    public.begin_investigation_creation_step(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_new_generation, v_new_lease, 'parse'
    ) = 'started',
    'reclaimed-parse-start'
  );
  perform public.save_investigation_creation_parse_checkpoint(
    '00000000-0000-4000-8000-000000001021',
    'stale', repeat('5', 64), v_new_generation, v_new_lease,
    pg_temp.checkpoint_102('recovered', '池袋 復旧')
  );
  select i.investigation_id into v_id
    from public.create_investigation_for_claim(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_new_generation, v_new_lease,
      'recovered', '池袋で復旧', '池袋 復旧'
    ) i;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'stale', repeat('5', 64), v_new_generation, v_new_lease, 'embedding'
  );
  perform public.save_investigation_creation_embedding_checkpoint(
    '00000000-0000-4000-8000-000000001021',
    'stale', repeat('5', 64), v_new_generation, v_new_lease, null
  );
  perform pg_temp.assert_102(
    not public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_old_generation, v_old_lease, v_id, v_old_usage
    ),
    'old-complete-fenced'
  );
  perform pg_temp.assert_102(
    public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'stale', repeat('5', 64), v_new_generation, v_new_lease, v_id, v_new_usage
    ),
    'reclaimed-complete'
  );
  perform pg_temp.assert_102(
    (select count(*) from public.investigations where id = v_id) = 1
      and (select count(*) from public.provider_usage
            where id in (v_old_usage, v_new_usage)
              and investigation_id = v_id) = 2,
    'reclaimed-one-investigation-no-orphan-usage'
  );
end;
$$;

-- A denied/manipulated usage and a live kill-switch transition both fail
-- closed at complete; no requirement/member/event/status mutation is applied.
do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_usage bigint;
  v_id uuid;
begin
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-denied', repeat('6', 64)
    ) c;
  select r.usage_id into v_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-denied', repeat('6', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'mock', 0, 5000000, 50000000, false
    ) r;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'complete-denied', repeat('6', 64), v_generation, v_lease, 'parse'
  );
  perform public.save_investigation_creation_parse_checkpoint(
    '00000000-0000-4000-8000-000000001021',
    'complete-denied', repeat('6', 64), v_generation, v_lease,
    pg_temp.checkpoint_102('denied', 'denied')
  );
  select i.investigation_id into v_id
    from public.create_investigation_for_claim(
      '00000000-0000-4000-8000-000000001021',
      'complete-denied', repeat('6', 64), v_generation, v_lease,
      'denied', 'denied', 'denied'
    ) i;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'complete-denied', repeat('6', 64), v_generation, v_lease, 'embedding'
  );
  perform public.save_investigation_creation_embedding_checkpoint(
    '00000000-0000-4000-8000-000000001021',
    'complete-denied', repeat('6', 64), v_generation, v_lease, null
  );
  update public.provider_usage
     set status = 'denied', stop_reason = 'kill_switch'
   where id = v_usage;
  perform pg_temp.assert_102(
    not public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-denied', repeat('6', 64), v_generation, v_lease, v_id, v_usage
    )
      and (select status from public.investigations where id = v_id) = 'parsing'
      and (select count(*) from public.requirements where investigation_id = v_id) = 0,
    'denied-complete-rejected'
  );
  update public.provider_usage
     set status = 'reserved', stop_reason = null
   where id = v_usage;
  perform public.complete_investigation_creation(
    '00000000-0000-4000-8000-000000001021',
    'complete-denied', repeat('6', 64), v_generation, v_lease, v_id, v_usage
  );
end;
$$;

do $$
declare
  v_generation bigint;
  v_lease uuid;
  v_usage bigint;
  v_id uuid;
begin
  select c.lease_generation, c.lease_token into v_generation, v_lease
    from public.claim_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-kill', repeat('7', 64)
    ) c;
  select r.usage_id into v_usage
    from public.reserve_provider_budget_for_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-kill', repeat('7', 64), v_generation, v_lease,
      'create', null, 'gemini', 'test-model', 'live', 1, 5000000, 50000000, true
    ) r;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'complete-kill', repeat('7', 64), v_generation, v_lease, 'parse'
  );
  perform public.save_investigation_creation_parse_checkpoint(
    '00000000-0000-4000-8000-000000001021',
    'complete-kill', repeat('7', 64), v_generation, v_lease,
    pg_temp.checkpoint_102('kill', 'kill')
  );
  select i.investigation_id into v_id
    from public.create_investigation_for_claim(
      '00000000-0000-4000-8000-000000001021',
      'complete-kill', repeat('7', 64), v_generation, v_lease,
      'kill', 'kill', 'kill'
    ) i;
  perform public.begin_investigation_creation_step(
    '00000000-0000-4000-8000-000000001021',
    'complete-kill', repeat('7', 64), v_generation, v_lease, 'embedding'
  );
  perform public.save_investigation_creation_embedding_checkpoint(
    '00000000-0000-4000-8000-000000001021',
    'complete-kill', repeat('7', 64), v_generation, v_lease, null
  );
  update public.runtime_controls set enabled = false where key = 'provider_live';
  perform pg_temp.assert_102(
    not public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-kill', repeat('7', 64), v_generation, v_lease, v_id, v_usage
    )
      and (select status from public.investigations where id = v_id) = 'parsing',
    'kill-switch-complete-rejected'
  );
  update public.runtime_controls set enabled = true where key = 'provider_live';
  perform pg_temp.assert_102(
    public.complete_investigation_creation(
      '00000000-0000-4000-8000-000000001021',
      'complete-kill', repeat('7', 64), v_generation, v_lease, v_id, v_usage
    ),
    'kill-switch-recovery'
  );
end;
$$;

-- Deleting a completed investigation cascades its personal retry ledger and
-- attempt mapping, but retains the non-PII provider_usage operational row.
-- Its investigation FK is detached and the daily/monthly budget SUM therefore
-- cannot be reduced by an owner deletion.
do $$
declare
  v_id uuid;
  v_usage bigint;
  v_budget_before bigint;
  v_budget_after bigint;
begin
  select r.investigation_id, r.usage_id into v_id, v_usage
    from public.investigation_creation_requests r
   where r.user_id = '00000000-0000-4000-8000-000000001021'
     and r.idempotency_key = 'complete'
     and r.state = 'complete';
  perform pg_temp.assert_102(
    v_id is not null and v_usage is not null,
    'cascade-fixture'
  );
  select coalesce(sum(u.estimated_cost_microusd), 0)
    into v_budget_before
    from public.provider_usage u
   where u.status = 'reserved';
  delete from public.investigations where id = v_id;
  select coalesce(sum(u.estimated_cost_microusd), 0)
    into v_budget_after
    from public.provider_usage u
   where u.status = 'reserved';
  perform pg_temp.assert_102(
    not exists (
      select 1 from public.investigation_creation_requests
       where user_id = '00000000-0000-4000-8000-000000001021'
         and idempotency_key = 'complete'
    )
      and not exists (
        select 1 from public.investigation_creation_usage_attempts
         where user_id = '00000000-0000-4000-8000-000000001021'
           and idempotency_key = 'complete'
      )
      and exists (
        select 1 from public.provider_usage
         where id = v_usage
           and investigation_id is null
           and action = 'create'
           and status = 'reserved'
      )
      and v_budget_after = v_budget_before,
    'cascade-detaches-usage-and-preserves-budget-sum'
  );
end;
$$;

-- Auth deletion removes the user/key retry state and its attempt mapping for
-- privacy, while every already-started operational usage remains available to
-- the budget guard. The temporary ID set is test-only and proves the rows and
-- their total estimate survive the cascade without retaining a user link.
create temporary table create_102_account_usages as
select a.usage_id, u.estimated_cost_microusd
  from public.investigation_creation_usage_attempts a
  join public.provider_usage u on u.id = a.usage_id
 where a.user_id = '00000000-0000-4000-8000-000000001021';

select pg_temp.assert_102(
  (select count(*) from create_102_account_usages) > 0,
  'account-cascade-fixture'
);

reset role;
delete from auth.users
 where id = '00000000-0000-4000-8000-000000001021';
set role service_role;
set request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000001021","role":"service_role"}';

select pg_temp.assert_102(
  not exists (
    select 1 from public.investigation_creation_requests
     where user_id = '00000000-0000-4000-8000-000000001021'
  )
    and not exists (
      select 1 from public.investigation_creation_usage_attempts
       where user_id = '00000000-0000-4000-8000-000000001021'
    )
    and (
      select count(*)
        from public.provider_usage u
        join create_102_account_usages expected on expected.usage_id = u.id
    ) = (select count(*) from create_102_account_usages)
    and (
      select coalesce(sum(u.estimated_cost_microusd), 0)
        from public.provider_usage u
        join create_102_account_usages expected on expected.usage_id = u.id
    ) = (
      select coalesce(sum(expected.estimated_cost_microusd), 0)
        from create_102_account_usages expected
    )
    and not exists (
      select 1
        from public.provider_usage u
        join create_102_account_usages expected on expected.usage_id = u.id
       where u.investigation_id is not null
    ),
  'account-cascade-removes-personal-links-and-preserves-cost'
);

reset role;
reset request.jwt.claims;

select 'investigation creation idempotency scratch tests passed' as result;
