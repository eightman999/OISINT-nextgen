-- =============================================================================
-- 080_place_provider_links.sql — canonical Place ↔ provider link の RLS 負例テスト
-- (#530 DB v2 Core / migration 202608190001 / spec.md §23 §33 §34)
--
-- 登場人物:
--   A = ...080a : 任意の認証ユーザー (メンバーシップと無関係)
--
-- 検証:
--   a. 認証ユーザーは provider link を select できる (places と同じ公開情報の扱い §33)
--   b. 認証ユーザーは insert / update / delete できない (書き込みは Edge Function の
--      service role のみ。grant 層で 42501)
--   c. anon ロール (JWT なし) は select すら通らない (§19 anon には開けない)
--   d. provider_data_inventory (provider 停止時の列挙ビュー) は
--      認証ユーザーへ開けない (運用情報。service_role のみ #297)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- フィクスチャ (postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000080a');

insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000801', 'geoapify', 'rls080-place-1', 'RLS 080 テスト店');

insert into public.place_provider_links
  (id, place_id, provider, provider_place_id, storage_policy, attribution_policy) values
  ('00000000-0000-0000-0000-000000000811', '00000000-0000-0000-0000-000000000801',
   'geoapify', 'rls080-place-1', 'persistent', 'osm_odbl_attribution');

-- HotPepper legacy 行は inventory / 表示停止 / purge の実行経路を検証する。
-- この fixture は scratch DB 内だけで使い、production のデータには触れない。
insert into public.places (id, provider, provider_place_id, name) values
  ('00000000-0000-0000-0000-000000000802', 'hotpepper', 'rls080-legacy-1', 'RLS 080 legacy 店');

insert into public.place_provider_links
  (id, place_id, provider, provider_place_id, storage_policy, expires_at, attribution_policy) values
  ('00000000-0000-0000-0000-000000000812', '00000000-0000-0000-0000-000000000802',
   'hotpepper', 'rls080-legacy-1', 'ttl', clock_timestamp() - interval '1 second',
   'hotpepper_credit_required');

insert into public.evidence
  (id, place_id, scope, source_type, source_url, source_title, excerpt, observed_at, provider_link_id)
values
  ('00000000-0000-0000-0000-000000000813', '00000000-0000-0000-0000-000000000802',
   'shared', 'major_place_provider', 'https://legacy.example/rls080', 'legacy', 'legacy',
   clock_timestamp() - interval '1 second', '00000000-0000-0000-0000-000000000812');

-- ---------------------------------------------------------------------------
-- a. 認証ユーザーは select できる
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000080a","role":"authenticated"}';

do $$
declare n int;
begin
  select count(*) into n from public.place_provider_links
    where id = '00000000-0000-0000-0000-000000000811';
  if n <> 1 then
    raise exception 'a: 認証ユーザーが provider link を読めない (n=%)', n;
  end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- b. 認証ユーザーは書き込めない (insert / update / delete いずれも 42501)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000080a","role":"authenticated"}';

do $$
begin
  begin
    insert into public.place_provider_links (place_id, provider, provider_place_id)
      values ('00000000-0000-0000-0000-000000000801', 'attacker', 'x');
    raise exception 'b: insert が通ってしまった';
  exception when insufficient_privilege then null;
  end;

  begin
    -- storage_policy を書き換えられると TTL / purge の判定を無効化できてしまう
    update public.place_provider_links set storage_policy = 'persistent'
      where id = '00000000-0000-0000-0000-000000000811';
    raise exception 'b: update が通ってしまった';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.place_provider_links
      where id = '00000000-0000-0000-0000-000000000811';
    raise exception 'b: delete が通ってしまった';
  exception when insufficient_privilege then null;
  end;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- c. anon は select も通らない (§19)
-- ---------------------------------------------------------------------------
begin;
set local role anon;

do $$
begin
  begin
    perform 1 from public.place_provider_links;
    raise exception 'c: anon の select が通ってしまった';
  exception when insufficient_privilege then null;
  end;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- d. provider_data_inventory は認証ユーザーに開けない (#297 運用情報)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000080a","role":"authenticated"}';

do $$
begin
  begin
    perform 1 from public.provider_data_inventory;
    raise exception 'd: 認証ユーザーが provider_data_inventory を読めてしまった';
  exception when insufficient_privilege then null;
  end;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- e. service_role が provider inventory と明示的 purge 経路を実行できる
--    （表示停止を先に行い、Evidence → link の順に消す。canonical places は残す）
-- ---------------------------------------------------------------------------
begin;
set local role service_role;

do $$
declare
  place_count bigint;
  link_count bigint;
  evidence_count bigint;
  expired_count bigint;
begin
  select i.place_count, i.link_count, i.evidence_count, i.expired_link_count
    into place_count, link_count, evidence_count, expired_count
    from public.provider_data_inventory i
    where i.provider = 'hotpepper';
  if place_count <> 1 or link_count <> 1 or evidence_count <> 1 or expired_count <> 1 then
    raise exception 'e: HotPepper inventory が不正 (places=% links=% evidence=% expired=%)',
      place_count, link_count, evidence_count, expired_count;
  end if;
end $$;

-- まず表示停止。UI は storage_policy / expires_at を判定し、この link を表示しない。
update public.place_provider_links
set storage_policy = 'ephemeral', expires_at = clock_timestamp()
where id = '00000000-0000-0000-0000-000000000812';

do $$
declare n bigint;
begin
  select count(*) into n from public.place_provider_links
    where id = '00000000-0000-0000-0000-000000000812'
      and storage_policy = 'ephemeral'
      and expires_at <= clock_timestamp();
  if n <> 1 then raise exception 'e: 表示停止が反映されない (n=%)', n; end if;
end $$;

-- provider 由来 Evidence を先に purge してから link を purge する。
delete from public.evidence where provider_link_id = '00000000-0000-0000-0000-000000000812';
delete from public.place_provider_links where id = '00000000-0000-0000-0000-000000000812';

do $$
declare
  n bigint;
  place_exists bigint;
begin
  select count(*) into n from public.provider_data_inventory where provider = 'hotpepper';
  select count(*) into place_exists from public.places
    where id = '00000000-0000-0000-0000-000000000802';
  if n <> 0 or place_exists <> 1 then
    raise exception 'e: purge後の状態が不正 (inventory=% canonical_place=%)', n, place_exists;
  end if;
end $$;
rollback;

select '080_place_provider_links.sql: all assertions passed' as result;
