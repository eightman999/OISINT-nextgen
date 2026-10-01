-- 202608300010: backend-neutral archive / derived lifecycle (#516)
--
-- raw本文・vector本体はこのHot DBへ持ち込まない。archive_objects は不変blobの
-- 参照メタデータだけを持ち、storage_backend/object_key はvendor URIでなくopaque値とする。

create table public.archive_objects (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null
    check (content_hash ~ '^[0-9a-f]{64}$'),
  storage_backend text not null
    check (
      char_length(storage_backend) between 1 and 128
      and storage_backend = btrim(storage_backend)
      and position(chr(1) in storage_backend) = 0
    ),
  object_key text not null
    check (
      char_length(object_key) between 1 and 2048
      and object_key = btrim(object_key)
      and position(chr(1) in object_key) = 0
    ),
  schema_version text not null
    check (
      char_length(schema_version) between 1 and 80
      and schema_version = btrim(schema_version)
      and position(chr(1) in schema_version) = 0
    ),
  size_bytes bigint not null check (size_bytes >= 0),
  archived_at timestamptz not null default clock_timestamp(),
  -- 外部blob削除前にmetadataを消さないための二段階purge marker。
  purge_requested_at timestamptz,
  -- user/investigation/provider purgeへ戻るためのopaque provenance。raw本文は保存しない。
  source_ref text
    check (
      source_ref is null or (
        char_length(source_ref) between 1 and 512
        and source_ref = btrim(source_ref)
        and position(chr(1) in source_ref) = 0
      )
    ),
  unique (storage_backend, object_key),
  unique (storage_backend, content_hash, schema_version)
);

comment on table public.archive_objects is
  '不変archive blobの参照メタデータ。backend/vendor URI/raw本文は保持しない。';

create table public.derived_artifacts (
  id uuid primary key default gen_random_uuid(),
  source_ref text not null
    check (
      char_length(source_ref) between 1 and 512
      and source_ref = btrim(source_ref)
      and position(chr(1) in source_ref) = 0
    ),
  artifact_kind text not null
    check (
      char_length(artifact_kind) between 1 and 128
      and artifact_kind = btrim(artifact_kind)
      and position(chr(1) in artifact_kind) = 0
    ),
  source_version text not null
    check (
      char_length(source_version) between 1 and 80
      and source_version = btrim(source_version)
      and position(chr(1) in source_version) = 0
    ),
  artifact_version text not null
    check (
      char_length(artifact_version) between 1 and 80
      and artifact_version = btrim(artifact_version)
      and position(chr(1) in artifact_version) = 0
    ),
  content_hash text
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  embedding_model text
    check (
      embedding_model is null or (
        char_length(embedding_model) between 1 and 160
        and embedding_model = btrim(embedding_model)
        and position(chr(1) in embedding_model) = 0
      )
    ),
  embedding_version text
    check (
      embedding_version is null or (
        char_length(embedding_version) between 1 and 80
        and embedding_version = btrim(embedding_version)
        and position(chr(1) in embedding_version) = 0
      )
    ),
  created_at timestamptz not null default clock_timestamp(),
  unique (source_ref, artifact_kind, source_version, artifact_version)
);

comment on table public.derived_artifacts is
  '再生成可能なderived metadata。source/versionを残し、raw本文・推論過程は保持しない。';

create index idx_archive_objects_source_ref
  on public.archive_objects (source_ref)
  where source_ref is not null;
create index idx_archive_objects_purge_requested
  on public.archive_objects (purge_requested_at)
  where purge_requested_at is not null;
create index idx_derived_artifacts_source_ref
  on public.derived_artifacts (source_ref);

alter table public.archive_objects enable row level security;
alter table public.derived_artifacts enable row level security;

revoke all on public.archive_objects, public.derived_artifacts
  from public, anon, authenticated;
grant all on public.archive_objects, public.derived_artifacts to service_role;

-- user/provider purgeの第一段階。外部blobより先にmetadataを消さず、adapterが削除すべき
-- 行をmarkする。source_refを申告できない行は削除対象へ推測で含めない。
create or replace function public.request_archive_lifecycle_purge(p_source_ref text)
returns table (
  archive_marked bigint,
  derived_deleted bigint
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_derived_deleted bigint;
  v_archive_marked bigint;
begin
  if p_source_ref is null
     or char_length(p_source_ref) < 1
     or char_length(p_source_ref) > 512
     or p_source_ref <> btrim(p_source_ref)
     or position(chr(1) in p_source_ref) <> 0 then
    raise exception 'invalid archive purge source' using errcode = '22023';
  end if;

  update public.archive_objects
     set purge_requested_at = clock_timestamp()
   where source_ref = p_source_ref
     and purge_requested_at is null;
  get diagnostics v_archive_marked = row_count;

  delete from public.derived_artifacts
   where source_ref = p_source_ref;
  get diagnostics v_derived_deleted = row_count;

  return query select v_archive_marked, v_derived_deleted;
end;
$function$;

revoke all on function public.request_archive_lifecycle_purge(text)
  from public, anon, authenticated;
grant execute on function public.request_archive_lifecycle_purge(text)
  to service_role;

comment on function public.request_archive_lifecycle_purge(text) is
  'Mark archive blobs for adapter deletion and purge derived metadata by exact source_ref.';

-- 第二段階はadapterが外部blobのdelete成功を確認した後だけ呼ぶ。
create or replace function public.finalize_archive_purge(p_archive_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted bigint;
begin
  delete from public.archive_objects
   where id = p_archive_id
     and purge_requested_at is not null;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$function$;

revoke all on function public.finalize_archive_purge(uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_archive_purge(uuid)
  to service_role;

comment on function public.finalize_archive_purge(uuid) is
  'Delete marked archive metadata only after the backend adapter deleted the external blob.';
