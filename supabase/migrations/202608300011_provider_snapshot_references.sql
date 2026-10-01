-- 202608300011: #562 provider snapshot の DB外参照
--
-- provider_sources は取得元の台帳であり、snapshot 本体を保持しない。
-- object storage の vendor/API はこの migration では選択しない。snapshot_uri は
-- opaque reference とし、実体の hash は ingest 側で読み戻して検証する。
-- 実際の bucket lock / retention の設定が無い状態を成功扱いにしないため、
-- snapshot の3項目は全て揃うか全て NULL のみ許可する。

alter table benchmark.provider_sources
  add column if not exists snapshot_uri text,
  add column if not exists snapshot_sha256 text,
  add column if not exists snapshot_stored_at timestamptz;

alter table benchmark.provider_sources
  add constraint provider_sources_snapshot_sha256_format
    check (snapshot_sha256 is null or snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint provider_sources_snapshot_reference_complete
    check (
      (snapshot_uri is null and snapshot_sha256 is null and snapshot_stored_at is null)
      or (snapshot_uri is not null and snapshot_sha256 is not null and snapshot_stored_at is not null)
    ),
  add constraint provider_sources_snapshot_hash_matches_content
    check (
      snapshot_sha256 is null
      or (content_sha256 is not null and snapshot_sha256 = lower(content_sha256))
    );

comment on column benchmark.provider_sources.snapshot_uri is
  'DB外 immutable snapshot の opaque URI。実体はこのDBへ保存しない (#562)';
comment on column benchmark.provider_sources.snapshot_sha256 is
  'snapshot bytes の実測 SHA-256（lowercase 64 hex）。content_sha256 と一致しない参照は拒否する (#562)';
comment on column benchmark.provider_sources.snapshot_stored_at is
  'snapshot object を保存した時刻。参照の3項目が揃う場合のみ設定する (#562)';
