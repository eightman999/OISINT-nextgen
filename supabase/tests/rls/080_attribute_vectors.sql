-- =============================================================================
-- 080_attribute_vectors.sql — #544 個人/集計ベクトル境界
--
-- A/B/C の個人行、母数境界、health除外、アカウント削除掃除を同一トランザクション
-- で検証する。全データはファイル末尾の ROLLBACK で破棄する。
-- =============================================================================

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000080a'),
  ('00000000-0000-0000-0000-00000000080b'),
  ('00000000-0000-0000-0000-00000000080c');

insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000080a', 'Alice 080'),
  ('00000000-0000-0000-0000-00000000080b', 'Bob 080'),
  ('00000000-0000-0000-0000-00000000080c', 'Carol 080');

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'attribute_vector_aggregates'
       and column_name in (
         'user_id', 'personal_vector_id', 'investigation_id', 'place_id',
         'event_id', 'raw_text', 'source_text'
       )
  ) then
    raise exception 'FAIL(080/schema): aggregate table exposes a reverse-mapping column';
  end if;
end $$;

do $$
begin
  if has_table_privilege('authenticated', 'public.attribute_vector_aggregates', 'select') then
    raise exception 'FAIL(080/acl): authenticated can SELECT aggregate table';
  end if;
  if not has_table_privilege('authenticated', 'public.user_attribute_vectors', 'select') then
    raise exception 'FAIL(080/acl): authenticated cannot SELECT personal vector table';
  end if;
end $$;

-- A はRPCで個人行を保存できる。healthは個人行としては許可する。
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000080a","role":"authenticated","is_anonymous":false}';

select public.save_user_attribute_vector(
  'quiet', array_fill(0.25::real, array[768]), 'taste-vector-v1', 'profile-v1',
  'personalization-v2', 'restaurant_recommendations'
);
select public.save_user_attribute_vector(
  'health', array_fill(0.5::real, array[768]), 'taste-vector-v1', 'profile-v1',
  'personalization-v2', 'restaurant_recommendations'
);
select public.save_user_attribute_vector(
  'quiet', array_fill(0.75::real, array[768]), 'taste-vector-v1', 'profile-v2',
  'personalization-v2', 'restaurant_recommendations'
);

do $$
begin
  if (select count(*) from public.user_attribute_vectors
      where user_id = '00000000-0000-0000-0000-00000000080a') <> 2
    or (select source_version from public.user_attribute_vectors
        where user_id = '00000000-0000-0000-0000-00000000080a'
          and attribute_key = 'quiet' and model_version = 'taste-vector-v1') <> 'profile-v2'
  then
    raise exception 'FAIL(080/update): saving the same user/attribute/model did not upsert';
  end if;
end $$;

do $$
begin
  begin
    insert into public.user_attribute_vectors (
      user_id, attribute_key, embedding, model_version, source_version,
      consent_version, consent_purpose
    ) values (
      '00000000-0000-0000-0000-00000000080a', 'value',
      format('[%s]', array_to_string(array_fill(0.1::real, array[768]), ','))::vector,
      'taste-vector-v1', 'direct-write', 'personalization-v2', 'restaurant_recommendations'
    );
    raise exception 'FAIL(080/write): authenticated inserted a personal vector directly';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.user_attribute_vectors
       set source_version = 'direct-update'
     where user_id = '00000000-0000-0000-0000-00000000080a';
    raise exception 'FAIL(080/write): authenticated updated a personal vector directly';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.user_attribute_vectors
     where user_id = '00000000-0000-0000-0000-00000000080a';
    raise exception 'FAIL(080/write): authenticated deleted a personal vector directly';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.save_user_attribute_vector(
      'allergy', array_fill(0.5::real, array[768]), 'taste-vector-v1', 'profile-v1',
      'personalization-v2', 'restaurant_recommendations'
    );
    raise exception 'FAIL(080/hard): allergy key entered personal vector path';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform public.save_user_attribute_vector(
      'quiet', array_fill(0.5::real, array[768]), 'taste-vector-v1', 'raw query',
      'personalization-v2', 'restaurant_recommendations'
    );
    raise exception 'FAIL(080/source): raw text was accepted as source version';
  exception when sqlstate '22023' then null;
  end;
end $$;

do $$
begin
  if (select count(*) from public.user_attribute_vectors
      where user_id = '00000000-0000-0000-0000-00000000080a') <> 2 then
    raise exception 'FAIL(080/own): A cannot read both own individual vectors';
  end if;
end $$;

-- B は A の個人行を読めない。B 自身の行は service-role fixture で作る。
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000080b","role":"authenticated","is_anonymous":false}';
do $$
begin
  if (select count(*) from public.user_attribute_vectors
      where user_id = '00000000-0000-0000-0000-00000000080a') <> 0 then
    raise exception 'FAIL(080/rls): B can read A''s individual vectors';
  end if;
end $$;

-- service roleだけが個人行を書き、母数境界を観測する。
set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000080b","role":"service_role","is_anonymous":false}';

insert into public.user_attribute_vectors (
  user_id, attribute_key, embedding, model_version, source_version,
  consent_version, consent_purpose
) values
  ('00000000-0000-0000-0000-00000000080b', 'quiet',
   format('[%s]', array_to_string(array_fill(0.25::real, array[768]), ','))::vector,
   'taste-vector-v1', 'profile-v1', 'personalization-v2', 'restaurant_recommendations'),
  ('00000000-0000-0000-0000-00000000080c', 'quiet',
   format('[%s]', array_to_string(array_fill(0.25::real, array[768]), ','))::vector,
   'taste-vector-v1', 'profile-v1', 'personalization-v2', 'restaurant_recommendations');

insert into public.user_attribute_vectors (
  user_id, attribute_key, embedding, model_version, source_version,
  consent_version, consent_purpose
) values
  ('00000000-0000-0000-0000-00000000080b', 'quiet',
   format('[%s]', array_to_string(array_fill(0.25::real, array[768]), ','))::vector,
   'sparse-vector-v1', 'profile-v1', 'personalization-v2', 'restaurant_recommendations'),
  ('00000000-0000-0000-0000-00000000080c', 'quiet',
   format('[%s]', array_to_string(array_fill(0.25::real, array[768]), ','))::vector,
   'sparse-vector-v1', 'profile-v1', 'personalization-v2', 'restaurant_recommendations');

do $$
declare result jsonb;
begin
  result := public.refresh_attribute_vector_aggregate('quiet', 'sparse-vector-v1', 2);
  if result ->> 'status' <> 'held_below_minimum'
    or (result ->> 'min_sample_count')::int <> 3
  then
    raise exception 'FAIL(080/min): minimum sample floor was not enforced (%)', result;
  end if;
  if (select count(*) from public.attribute_vector_aggregates
      where attribute_key = 'quiet' and model_version = 'sparse-vector-v1') <> 0 then
    raise exception 'FAIL(080/min): aggregate row exists below minimum';
  end if;
end $$;

do $$
declare result jsonb; status text; n int;
begin
  result := public.refresh_attribute_vector_aggregate('quiet', 'taste-vector-v1', 3);
  select privacy_status, sample_count into status, n
    from public.attribute_vector_aggregates
   where attribute_key = 'quiet' and model_version = 'taste-vector-v1';
  if result ->> 'status' <> 'pending_privacy_review'
    or status <> 'pending_privacy_review'
    or n <> 3
  then
    raise exception 'FAIL(080/pending): aggregate was published before privacy review';
  end if;

  begin
    perform public.approve_attribute_vector_aggregate(
      'quiet', 'taste-vector-v1', 'exact_sum_is_anonymous'
    );
    raise exception 'FAIL(080/exact): exact sum was approved as anonymous';
  exception when sqlstate '22023' then null;
  end;

  perform public.approve_attribute_vector_aggregate(
    'quiet', 'taste-vector-v1', 'dp_noise_v1_reidentification_reviewed'
  );
  if (select privacy_status from public.attribute_vector_aggregates
      where attribute_key = 'quiet' and model_version = 'taste-vector-v1') <> 'approved' then
    raise exception 'FAIL(080/approve): reviewed aggregate was not approved';
  end if;

  begin
    perform public.refresh_attribute_vector_aggregate('health', 'taste-vector-v1', 3);
    raise exception 'FAIL(080/health): health was accepted by aggregate refresh';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- 削除掃除のfixture。個人所有調査、他人調査への条件/投票/参加イベントを混在させる。
insert into public.user_preference_profiles (
  user_id, axis_scores, model_version, source_kinds, consent_version
) values (
  '00000000-0000-0000-0000-00000000080a',
  '{"evidence":50,"health":50,"quiet":50,"value":50,"novelty":50,"groupFit":50}',
  'adaptive-preference-v4', array['behavior_signals'], 'personalization-v2'
);

insert into public.investigations (
  id, created_by, title, raw_query, share_token
) values
  ('00000000-0000-0000-0000-000000000801',
   '00000000-0000-0000-0000-00000000080a', 'A private investigation', 'A raw query', 'r080a'),
  ('00000000-0000-0000-0000-000000000802',
   '00000000-0000-0000-0000-00000000080b', 'B shared investigation', 'B raw query', 'r080b');

insert into public.investigation_members (investigation_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-00000000080a', 'owner'),
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-00000000080b', 'owner'),
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-00000000080a', 'editor');

insert into public.requirements (id, investigation_id, created_by, text) values
  ('00000000-0000-0000-0000-000000000811', '00000000-0000-0000-0000-000000000801',
   '00000000-0000-0000-0000-00000000080a', 'A private requirement'),
  ('00000000-0000-0000-0000-000000000812', '00000000-0000-0000-0000-000000000802',
   '00000000-0000-0000-0000-00000000080a', 'A shared requirement');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000820', 'fixture', '080', 'Shared place 080');
insert into public.candidates (id, investigation_id, place_id) values
  ('00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000802',
   '00000000-0000-0000-0000-000000000820');
insert into public.votes (investigation_id, candidate_id, user_id, value) values
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000821',
   '00000000-0000-0000-0000-00000000080a', 1);
insert into public.place_feedback (place_id, user_id, rating) values
  ('00000000-0000-0000-0000-000000000820', '00000000-0000-0000-0000-00000000080a', 1);
insert into public.investigation_events (investigation_id, event_type, message, metadata) values
  ('00000000-0000-0000-0000-000000000802', 'member_joined', 'Alice 080 が参加しました',
   '{"userId":"00000000-0000-0000-0000-00000000080a"}');
insert into public.user_product_audit_events (actor_user_id, event_type, source)
values ('00000000-0000-0000-0000-00000000080a', 'preference_profile_saved', 'account');

-- アカウント掃除RPCは authenticated から直接呼べない。対象 user id を
-- 引数へ渡せても、Edge Function の本人JWT検証を迂回できないことを固定する。
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000080a","role":"authenticated","is_anonymous":false}';
do $$
begin
  begin
    perform public.delete_user_account_data(
      '00000000-0000-0000-0000-00000000080a'
    );
    raise exception 'FAIL(080/account-acl): authenticated executed account purge RPC';
  exception when insufficient_privilege then null;
  end;
end $$;

set local role service_role;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-00000000080a","role":"service_role","is_anonymous":false}';
select public.delete_user_account_data('00000000-0000-0000-0000-00000000080a');

do $$
begin
  if exists (select 1 from public.user_attribute_vectors where user_id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.user_preference_profiles where user_id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.investigations where created_by = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.requirements where created_by = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.votes where user_id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.place_feedback where user_id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.investigation_members where user_id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.investigation_events where metadata ->> 'userId' = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.user_product_audit_events where actor_user_id = '00000000-0000-0000-0000-00000000080a')
    or exists (select 1 from public.attribute_vector_aggregates)
  then
    raise exception 'FAIL(080/delete): personal or derived rows remain after account purge';
  end if;
  if not exists (select 1 from public.places where id = '00000000-0000-0000-0000-000000000820') then
    raise exception 'FAIL(080/delete): shared place was deleted';
  end if;
  if (select message from public.investigation_events
      where investigation_id = '00000000-0000-0000-0000-000000000802') <> '[匿名化済み]' then
    raise exception 'FAIL(080/delete): participation event display name was not redacted';
  end if;
end $$;

rollback;

\echo == 080_attribute_vectors.sql: all assertions passed
