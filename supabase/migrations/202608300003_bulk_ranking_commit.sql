-- 202608300003: rankInvestigation の一括永続化 (#608)
--
-- Edge Function は候補単位の読み書きを行わず、候補/evidence/evaluation/voteを
-- bulk readした計算結果をこのRPCへ渡す。investigation行をロックしたまま、評価、
-- score/rank、Top 3削除、ランキングイベントを同一transactionで確定する。
-- 引数と戻り値にURL、query、user等のPIIは含めず、運用メトリクスだけを返す。

create or replace function public.persist_investigation_ranking(
  p_investigation_id uuid,
  p_requirement_embeddings jsonb,
  p_evaluations jsonb,
  p_candidates jsonb,
  p_discarded_candidate_ids uuid[],
  p_final_count integer,
  p_research_pool_count integer,
  p_db_query_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started_at timestamptz := pg_catalog.clock_timestamp();
  v_candidate_count integer;
  v_payload_candidate_count integer;
  v_payload_candidate_distinct integer;
  v_embedding_rows integer := 0;
  v_evaluation_rows integer := 0;
  v_candidate_rows integer := 0;
  v_discarded_present integer := 0;
  v_deleted_rows integer := 0;
  v_updated_rows integer := 0;
  v_latency_ms numeric;
begin
  if p_investigation_id is null
     or p_requirement_embeddings is null
     or p_evaluations is null
     or p_candidates is null
     or p_discarded_candidate_ids is null
     or p_final_count is null
     or p_research_pool_count is null
     or p_db_query_count is null then
    raise exception 'invalid ranking commit request' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_requirement_embeddings) <> 'array'
     or pg_catalog.jsonb_typeof(p_evaluations) <> 'array'
     or pg_catalog.jsonb_typeof(p_candidates) <> 'array'
     or p_final_count < 0
     or p_research_pool_count < 0
     or p_db_query_count not between 1 and 9 then
    raise exception 'invalid ranking commit payload' using errcode = '22023';
  end if;

  -- 同じinvestigationのcommitを直列化する。候補の追加/削除もこの親行の
  -- FK lockと競合するため、古いbulk snapshotで上書きしない。
  perform 1
    from public.investigations as i
   where i.id = p_investigation_id
   for update;
  if not found then
    raise exception 'investigation not found' using errcode = 'P0002';
  end if;

  perform 1
    from public.candidates as c
   where c.investigation_id = p_investigation_id
   for update;

  select count(*)::integer
    into v_candidate_count
    from public.candidates as c
   where c.investigation_id = p_investigation_id;

  select count(*)::integer, count(distinct payload.id)::integer
    into v_payload_candidate_count, v_payload_candidate_distinct
    from pg_catalog.jsonb_to_recordset(p_candidates) as payload(
      id uuid,
      score real,
      rank integer,
      cons jsonb,
      pros jsonb,
      conflict_count integer
    );

  if v_payload_candidate_count < v_candidate_count
     or v_payload_candidate_distinct <> v_payload_candidate_count then
    raise exception 'ranking candidate payload is not a complete snapshot'
      using errcode = '40001';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_to_recordset(p_candidates) as payload(
        id uuid,
        score real,
        rank integer,
        cons jsonb,
        pros jsonb,
        conflict_count integer
      )
     where payload.id is null
        or payload.score is null
        or payload.score < 0
        or payload.score > 1
        or payload.rank is null
        or payload.rank < 1
        or payload.cons is null
        or pg_catalog.jsonb_typeof(payload.cons) <> 'array'
        or payload.pros is null
        or pg_catalog.jsonb_typeof(payload.pros) <> 'array'
        or payload.conflict_count is null
        or payload.conflict_count < 0
  ) then
    raise exception 'invalid ranking candidate row' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.candidates as c
     where c.investigation_id = p_investigation_id
       and not exists (
         select 1
           from pg_catalog.jsonb_to_recordset(p_candidates) as payload(id uuid)
          where payload.id = c.id
       )
  ) or exists (
    select 1
      from pg_catalog.jsonb_to_recordset(p_candidates) as payload(id uuid)
     where not exists (
       select 1
         from public.candidates as c
        where c.investigation_id = p_investigation_id
          and c.id = payload.id
     )
       and not exists (
         select 1
           from pg_catalog.unnest(p_discarded_candidate_ids) as discarded(discarded_id)
          where discarded.discarded_id = payload.id
       )
  ) then
    raise exception 'ranking candidate payload contains an unexpected current id'
      using errcode = '40001';
  end if;

  if p_research_pool_count <> v_payload_candidate_count
     or p_final_count > v_payload_candidate_count
     or p_final_count + pg_catalog.cardinality(p_discarded_candidate_ids)
          <> v_payload_candidate_count then
    raise exception 'ranking candidate counts are inconsistent'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from (
        select discarded_id, count(*) as occurrences
          from pg_catalog.unnest(p_discarded_candidate_ids) as discarded(discarded_id)
         group by discarded_id
        having count(*) > 1
      ) as duplicate_ids
  ) or exists (
    select 1
      from pg_catalog.unnest(p_discarded_candidate_ids) as discarded(discarded_id)
     where exists (
       select 1
         from public.candidates as c
        where c.investigation_id = p_investigation_id
          and c.id = discarded.discarded_id
     ) and not exists (
       select 1
         from pg_catalog.jsonb_to_recordset(p_candidates) as payload(id uuid)
        where payload.id = discarded.discarded_id
     )
  ) or exists (
    select 1
      from pg_catalog.unnest(p_discarded_candidate_ids) as discarded(discarded_id)
     where not exists (
       select 1
         from pg_catalog.jsonb_to_recordset(p_candidates) as payload(
           id uuid,
           rank integer
         )
        where payload.id = discarded.discarded_id
          and payload.rank > p_final_count
     )
  ) then
    raise exception 'invalid discarded candidate ids' using errcode = '22023';
  end if;

  -- 直前のcommitが同じpayloadでTop 3を確定済みなら、欠落したdiscarded行は
  -- 正常な再送として扱う。別の現在候補が欠落する場合は上のstale検知で拒否する。
  if v_candidate_count <> v_payload_candidate_count
     and v_candidate_count <> p_final_count then
    raise exception 'ranking candidate snapshot changed before commit'
      using errcode = '40001';
  end if;

  select count(*)::integer
    into v_discarded_present
    from public.candidates as c
   where c.investigation_id = p_investigation_id
     and c.id = any(p_discarded_candidate_ids);

  -- requirement.embedding の補完も同じtransactionへ束ねる。vector castの失敗は
  -- RPC全体をrollbackさせるため、embeddingだけ半端に保存されない。
  if exists (
    select 1
      from pg_catalog.jsonb_to_recordset(p_requirement_embeddings) as payload(
        id uuid,
        embedding jsonb
      )
     where payload.id is null
        or payload.embedding is null
        or pg_catalog.jsonb_typeof(payload.embedding) <> 'array'
        or pg_catalog.jsonb_array_length(payload.embedding) <> 768
        or case
          when pg_catalog.jsonb_typeof(payload.embedding) = 'array' then exists (
            select 1
              from pg_catalog.jsonb_array_elements(payload.embedding) as element(value)
             where pg_catalog.jsonb_typeof(element.value) <> 'number'
          )
          else true
        end
        or not exists (
          select 1
            from public.requirements as r
           where r.id = payload.id
             and r.investigation_id = p_investigation_id
        )
  ) then
    raise exception 'invalid requirement embedding payload'
      using errcode = '22023';
  end if;

  if exists (
    select payload.id
      from pg_catalog.jsonb_to_recordset(p_requirement_embeddings) as payload(
        id uuid,
        embedding jsonb
      )
     group by payload.id
    having count(*) > 1
  ) then
    raise exception 'duplicate requirement embedding payload'
      using errcode = '22023';
  end if;

  update public.requirements as r
     set embedding = (payload.embedding::text)::public.vector
    from pg_catalog.jsonb_to_recordset(p_requirement_embeddings) as payload(
      id uuid,
      embedding jsonb
    )
   where r.id = payload.id
     and r.investigation_id = p_investigation_id;
  get diagnostics v_embedding_rows = row_count;

  if exists (
    select 1
      from pg_catalog.jsonb_to_recordset(p_evaluations) as payload(
        id uuid,
        candidate_id uuid,
        requirement_id uuid,
        state text,
        confidence real,
        explanation text,
        evidence_ids jsonb
      )
     where payload.id is null
        or payload.candidate_id is null
        or payload.requirement_id is null
        or payload.state not in ('match', 'partial', 'mismatch', 'unknown')
        or payload.confidence is not null
          and (payload.confidence < 0 or payload.confidence > 1)
        or payload.evidence_ids is null
        or pg_catalog.jsonb_typeof(payload.evidence_ids) <> 'array'
        or case
          when pg_catalog.jsonb_typeof(payload.evidence_ids) = 'array' then exists (
            select 1
              from pg_catalog.jsonb_array_elements(payload.evidence_ids) as element(value)
             where pg_catalog.jsonb_typeof(element.value) <> 'string'
          ) or (
            -- 初回commitでは候補のplace/scopeまで照合する。正常な同一payload再送では
            -- discarded候補が既に削除済みのため、その候補は後段でも更新対象外になる。
            exists (
              select 1
                from public.candidates as candidate
               where candidate.id = payload.candidate_id
                 and candidate.investigation_id = p_investigation_id
            )
            and exists (
              select 1
                from pg_catalog.jsonb_array_elements_text(payload.evidence_ids)
                  as evidence_id(value)
               where not exists (
                 select 1
                   from public.candidates as candidate
                   join public.evidence as evidence
                     on evidence.place_id = candidate.place_id
                  where candidate.id = payload.candidate_id
                    and candidate.investigation_id = p_investigation_id
                    and evidence.id::text = evidence_id.value
                    and (
                      (evidence.scope = 'shared' and evidence.investigation_id is null)
                      or (
                        evidence.scope = 'investigation'
                        and evidence.investigation_id = p_investigation_id
                      )
                    )
               )
            )
          ) or pg_catalog.jsonb_array_length(payload.evidence_ids) <> (
            select count(distinct evidence_id.value)
              from pg_catalog.jsonb_array_elements_text(payload.evidence_ids)
                as evidence_id(value)
          )
          else true
        end
        or not exists (
          select 1
            from public.requirement_evaluations as e
           where e.id = payload.id
             and e.investigation_id = p_investigation_id
             and e.candidate_id = payload.candidate_id
             and e.requirement_id = payload.requirement_id
        )
        and not (
          payload.candidate_id = any(p_discarded_candidate_ids)
          and not exists (
            select 1
              from public.candidates as c
             where c.investigation_id = p_investigation_id
               and c.id = payload.candidate_id
          )
        )
  ) then
    raise exception 'invalid requirement evaluation payload'
      using errcode = '22023';
  end if;

  if exists (
    select payload.id
      from pg_catalog.jsonb_to_recordset(p_evaluations) as payload(
        id uuid,
        candidate_id uuid,
        requirement_id uuid,
        state text,
        confidence real,
        explanation text,
        evidence_ids jsonb
      )
     group by payload.id
    having count(*) > 1
  ) then
    raise exception 'duplicate requirement evaluation payload'
      using errcode = '22023';
  end if;

  update public.requirement_evaluations as e
     set state = payload.state,
         confidence = payload.confidence,
         explanation = payload.explanation,
         evidence_ids = coalesce(
           (
             select pg_catalog.array_agg(value::uuid order by ordinal)
               from pg_catalog.jsonb_array_elements_text(payload.evidence_ids)
                 with ordinality as evidence(value, ordinal)
           ),
           '{}'::uuid[]
         )
    from pg_catalog.jsonb_to_recordset(p_evaluations) as payload(
      id uuid,
      candidate_id uuid,
      requirement_id uuid,
      state text,
      confidence real,
      explanation text,
      evidence_ids jsonb
    )
   where e.id = payload.id
     and e.investigation_id = p_investigation_id
     and e.candidate_id = payload.candidate_id
     and e.requirement_id = payload.requirement_id;
  get diagnostics v_evaluation_rows = row_count;

  update public.candidates as c
     set score = payload.score,
         rank = payload.rank,
         cons = payload.cons,
         pros = payload.pros
    from pg_catalog.jsonb_to_recordset(p_candidates) as payload(
      id uuid,
      score real,
      rank integer,
      cons jsonb,
      pros jsonb,
      conflict_count integer
    )
   where c.id = payload.id
     and c.investigation_id = p_investigation_id;
  get diagnostics v_candidate_rows = row_count;

  if v_candidate_rows <> v_candidate_count then
    raise exception 'ranking candidate update was incomplete'
      using errcode = '40001';
  end if;

  delete from public.candidates as c
   where c.investigation_id = p_investigation_id
     and c.id = any(p_discarded_candidate_ids);
  get diagnostics v_deleted_rows = row_count;

  if v_deleted_rows <> v_discarded_present then
    raise exception 'ranking candidate delete was incomplete'
      using errcode = '40001';
  end if;

  -- contradiction_foundは候補ごとの計算結果から同じtransactionで発行する。
  -- candidateId/conflictCount以外を格納せず、URL・原文・user情報を含めない。
  insert into public.investigation_events (
    investigation_id,
    event_type,
    message,
    metadata
  )
  select
    p_investigation_id,
    'contradiction_found',
    '情報源によって食い違う情報があります',
    pg_catalog.jsonb_build_object(
      'candidateId', payload.id,
      'conflictCount', payload.conflict_count
    )
    from pg_catalog.jsonb_to_recordset(p_candidates) as payload(
      id uuid,
      score real,
      rank integer,
      cons jsonb,
      pros jsonb,
      conflict_count integer
    )
   where payload.conflict_count > 0;

  v_latency_ms := pg_catalog.round(
    extract(
      epoch from (pg_catalog.clock_timestamp() - v_started_at)
    ) * 1000,
    3
  );
  v_updated_rows := v_embedding_rows + v_evaluation_rows
    + v_candidate_rows + v_deleted_rows;

  insert into public.investigation_events (
    investigation_id,
    event_type,
    message,
    metadata
  ) values (
    p_investigation_id,
    'ranking_completed',
    'ランキングを更新しました',
    pg_catalog.jsonb_build_object(
      'count', p_final_count,
      'researchPoolCount', p_research_pool_count,
      'queryCount', p_db_query_count,
      'updatedRows', v_updated_rows,
      'evaluationRows', v_evaluation_rows,
      'candidateRows', v_candidate_rows,
      'deletedRows', v_deleted_rows,
      'latencyMs', v_latency_ms
    )
  );

  return pg_catalog.jsonb_build_object(
    'queryCount', p_db_query_count,
    'updatedRows', v_updated_rows,
    'evaluationRows', v_evaluation_rows,
    'candidateRows', v_candidate_rows,
    'deletedRows', v_deleted_rows,
    'latencyMs', v_latency_ms
  );
end;
$$;

revoke all on function public.persist_investigation_ranking(
  uuid, jsonb, jsonb, jsonb, uuid[], integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.persist_investigation_ranking(
  uuid, jsonb, jsonb, jsonb, uuid[], integer, integer, integer
) to service_role;

comment on function public.persist_investigation_ranking(
  uuid, jsonb, jsonb, jsonb, uuid[], integer, integer, integer
) is
  'Atomically persists deterministic bulk ranking results; service_role only. Metrics are PII-free.';
