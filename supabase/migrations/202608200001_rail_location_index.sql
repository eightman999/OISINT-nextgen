-- N02 railway canonical serving layer.
-- Raw archives remain local-only; this migration stores normalized source
-- provenance and graph/sequence outputs only.

create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

-- Installing PostGIS in public under Supabase's supabase_admin defaults can
-- grant client roles write/TRUNCATE privileges on spatial_ref_sys.  Existing
-- installations are accepted only when already secured by the extension
-- owner; otherwise fail closed instead of shipping an RLS bypass.
do $$
declare
  spatial_ref_table regclass := to_regclass('public.spatial_ref_sys');
begin
  if spatial_ref_table is not null and (
    has_table_privilege('anon', spatial_ref_table, 'INSERT')
    or has_table_privilege('anon', spatial_ref_table, 'UPDATE')
    or has_table_privilege('anon', spatial_ref_table, 'DELETE')
    or has_table_privilege('anon', spatial_ref_table, 'TRUNCATE')
    or has_table_privilege('authenticated', spatial_ref_table, 'INSERT')
    or has_table_privilege('authenticated', spatial_ref_table, 'UPDATE')
    or has_table_privilege('authenticated', spatial_ref_table, 'DELETE')
    or has_table_privilege('authenticated', spatial_ref_table, 'TRUNCATE')
  ) then
    raise exception 'public.spatial_ref_sys exposes client write privileges'
      using hint = 'Install PostGIS in extensions schema or revoke client writes as the extension owner before applying this migration';
  end if;
end;
$$;

-- Candidate provenance is additive and keeps the existing discovery contract.
alter table public.candidates add column if not exists discovery_context jsonb not null default '{}'::jsonb;

create schema if not exists rail_staging;

create table public.rail_dataset_versions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'mlit_n02'),
  dataset_id text not null,
  dataset_year integer not null check (dataset_year between 2000 and 2100),
  data_as_of date not null,
  retrieved_at timestamptz not null,
  source_url text not null,
  license text not null default 'CC-BY-4.0',
  license_url text,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text not null,
  normalizer_version text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (provider, dataset_id),
  unique (provider, content_sha256)
);

create unique index rail_dataset_versions_one_active
  on public.rail_dataset_versions (provider) where is_active;

create table public.rail_lines (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null references public.rail_dataset_versions(id) on delete cascade,
  operator_name text not null,
  operator_key text not null,
  line_name text not null,
  line_key text not null,
  railway_type text,
  operator_type text,
  geometry geometry(MultiLineString, 4326) not null,
  bbox geometry(Polygon, 4326),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dataset_version_id, operator_key, line_key)
);

create index rail_lines_geometry_gist on public.rail_lines using gist (geometry);
create index rail_lines_name_key_idx on public.rail_lines (line_key, operator_key);

create table public.rail_line_components (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.rail_lines(id) on delete cascade,
  component_index integer not null check (component_index >= 0),
  geometry geometry(MultiLineString, 4326) not null,
  length_m double precision not null check (length_m >= 0),
  is_loop boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  unique (line_id, component_index)
);

create index rail_line_components_geometry_gist on public.rail_line_components using gist (geometry);

create table public.rail_station_records (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null references public.rail_dataset_versions(id) on delete cascade,
  source_station_code text not null,
  source_group_code text,
  station_name text not null,
  station_name_key text not null,
  operator_name text not null,
  operator_key text not null,
  line_name text not null,
  line_key text not null,
  railway_type text,
  operator_type text,
  geometry geometry(Geometry, 4326) not null,
  representative_point geometry(Point, 4326) not null,
  raw_properties jsonb not null default '{}'::jsonb
);

create index rail_station_records_geometry_gist on public.rail_station_records using gist (geometry);
create index rail_station_records_name_key_idx on public.rail_station_records (station_name_key, operator_key);
-- N02 may contain several geometry parts for one source station code on the
-- same operator/line. Preserve every source record; the UUID primary key is
-- the identity and this index is lookup-only, not a uniqueness constraint.
create index rail_station_records_source_key_idx
  on public.rail_station_records (dataset_version_id, source_station_code, operator_key, line_key);

create table public.rail_station_groups (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null references public.rail_dataset_versions(id) on delete cascade,
  source_group_code text,
  canonical_name text not null,
  name_key text not null,
  representative_point geometry(Point, 4326) not null,
  geometry geometry(Geometry, 4326) not null,
  metadata jsonb not null default '{}'::jsonb
);

create index rail_station_groups_point_gist on public.rail_station_groups using gist (representative_point);
create index rail_station_groups_name_key_idx on public.rail_station_groups (name_key);

create table public.rail_station_aliases (
  station_group_id uuid not null references public.rail_station_groups(id) on delete cascade,
  alias text not null,
  alias_key text not null,
  alias_type text not null,
  source text not null default 'mlit_n02',
  primary key (station_group_id, alias_key)
);
create index rail_station_aliases_key_idx on public.rail_station_aliases (alias_key);

create table public.rail_line_aliases (
  line_id uuid not null references public.rail_lines(id) on delete cascade,
  alias text not null,
  alias_key text not null,
  alias_type text not null,
  primary key (line_id, alias_key)
);
create index rail_line_aliases_key_idx on public.rail_line_aliases (alias_key);

create table public.rail_line_stations (
  line_id uuid not null references public.rail_lines(id) on delete cascade,
  component_id uuid not null references public.rail_line_components(id) on delete cascade,
  station_group_id uuid not null references public.rail_station_groups(id) on delete cascade,
  station_record_id uuid not null references public.rail_station_records(id) on delete cascade,
  path_key text not null default 'main',
  -- Branch/loop components do not have one semantic sequence. Their station
  -- adjacency is stored in rail_station_links; sequence is nullable rather
  -- than a fabricated walk.
  sequence integer check (sequence >= 0),
  distance_along_m double precision check (distance_along_m >= 0),
  geometry_position geometry(Point, 4326) not null,
  is_terminal boolean not null default false,
  is_branch_point boolean not null default false,
  -- One logical station may retain several N02 source records.  They share a
  -- group/sequence in simple components, so sequence cannot be a standalone
  -- unique key; ETL validation enforces dense group-level sequence instead.
  primary key (line_id, component_id, path_key, station_group_id, station_record_id)
);

create index rail_line_stations_line_seq_idx on public.rail_line_stations (line_id, component_id, path_key, sequence);
create index rail_line_stations_point_gist on public.rail_line_stations using gist (geometry_position);

create table public.rail_station_links (
  id uuid primary key,
  line_id uuid not null references public.rail_lines(id) on delete cascade,
  component_id uuid not null references public.rail_line_components(id) on delete cascade,
  from_station_group_id uuid not null references public.rail_station_groups(id) on delete cascade,
  to_station_group_id uuid not null references public.rail_station_groups(id) on delete cascade,
  from_station_record_id uuid not null references public.rail_station_records(id) on delete cascade,
  to_station_record_id uuid not null references public.rail_station_records(id) on delete cascade,
  path_key text not null,
  distance_m double precision not null check (distance_m >= 0),
  metadata jsonb not null default '{}'::jsonb,
  check (from_station_group_id <> to_station_group_id),
  unique (line_id, component_id, path_key, from_station_group_id, to_station_group_id)
);

create index rail_station_links_from_idx on public.rail_station_links (line_id, component_id, path_key, from_station_group_id);
create index rail_station_links_to_idx on public.rail_station_links (line_id, component_id, path_key, to_station_group_id);

-- Import audit rows make staging -> validation -> promote observable without
-- retaining raw data in Postgres.
create table rail_staging.import_runs (
  id uuid primary key default gen_random_uuid(),
  -- Version metadata is itself one of the staged payload rows, so the FK is
  -- checked during validate/promote rather than at staging insert time.
  dataset_version_id uuid not null,
  status text not null check (status in ('staging', 'validated', 'promoted', 'rejected', 'rolled_back')),
  source_manifest jsonb not null,
  row_counts jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table rail_staging.payload_rows (
  import_run_id uuid not null references rail_staging.import_runs(id) on delete cascade,
  entity text not null check (entity in ('dataset_version', 'rail_lines', 'rail_line_components', 'rail_station_records', 'rail_station_groups', 'rail_station_aliases', 'rail_line_aliases', 'rail_line_stations', 'rail_station_links')),
  row_number integer not null check (row_number > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (import_run_id, entity, row_number)
);

-- Validation joins parent rows by their JSON identity.  Keep the import-run
-- and entity predicates in the index so every canonical reference check can
-- use one bounded lookup instead of rescanning all payload rows.
create index rail_staging_payload_rows_entity_id_idx
  on rail_staging.payload_rows (import_run_id, entity, ((payload ->> 'id')));

grant all on rail_staging.payload_rows to service_role;

create or replace function rail_staging.validate_rail_import(p_import_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, rail_staging
as $$
declare
  counts jsonb;
  expected_counts jsonb;
  errors jsonb := '[]'::jsonb;
  missing_entity text;
begin
  if not exists (select 1 from rail_staging.import_runs where id = p_import_run and status = 'staging') then
    raise exception 'rail import run is missing or not staging';
  end if;
  select jsonb_object_agg(entity, row_count) into counts
  from (select entity, count(*)::integer as row_count from rail_staging.payload_rows where import_run_id = p_import_run group by entity) grouped;
  select source_manifest -> 'expectedRowCounts' into expected_counts
  from rail_staging.import_runs where id = p_import_run;
  if coalesce((counts ->> 'dataset_version')::integer, 0) <> 1 then
    errors := errors || to_jsonb('dataset_version payload count must be exactly 1');
  end if;
  foreach missing_entity in array array['dataset_version','rail_lines','rail_line_components','rail_station_records','rail_station_groups','rail_station_aliases','rail_line_aliases','rail_line_stations','rail_station_links'] loop
    if coalesce((counts ->> missing_entity)::integer, 0) = 0 then
      errors := errors || to_jsonb(format('%s payload is empty', missing_entity));
    end if;
  end loop;
  foreach missing_entity in array array['rail_lines','rail_station_records','rail_station_groups','rail_station_aliases','rail_line_aliases','rail_line_components','rail_line_stations','rail_station_links'] loop
    if coalesce((expected_counts ->> missing_entity)::integer, -1) <> coalesce((counts ->> missing_entity)::integer, 0) then
      errors := errors || to_jsonb(format('%s row count does not match manifest', missing_entity));
    end if;
  end loop;
  if exists (select 1 from rail_staging.payload_rows where import_run_id = p_import_run and payload ? 'id' and not ((payload ->> 'id') ~* '^[0-9a-f-]{36}$')) then
    errors := errors || to_jsonb('payload id is not UUID');
  end if;
  if exists (
    select 1 from rail_staging.payload_rows
    where import_run_id = p_import_run and entity = 'dataset_version'
      and (
        coalesce(payload ->> 'contentSha256', '') !~ '^[0-9a-f]{64}$' or
        payload ->> 'contentSha256' = repeat('0', 64)
      )
  ) then
    errors := errors || to_jsonb('dataset_version contentSha256 is missing or invalid');
  end if;
  if exists (select 1 from rail_staging.payload_rows where import_run_id = p_import_run and entity in ('rail_lines','rail_station_records','rail_station_groups') and jsonb_typeof(payload -> 'geometry') <> 'object') then
    errors := errors || to_jsonb('canonical geometry payload must be GeoJSON object');
  end if;
  if exists (
    select 1 from rail_staging.payload_rows
    where import_run_id = p_import_run and entity in ('rail_lines','rail_line_components','rail_station_records','rail_station_groups')
      and not st_isvalid(st_setsrid(st_geomfromgeojson(payload -> 'geometry'), 4326))
  ) then errors := errors || to_jsonb('one or more geometry payloads are invalid'); end if;
  if exists (
    select 1 from rail_staging.payload_rows child
    where child.import_run_id = p_import_run and child.entity = 'rail_line_components'
      and not exists (
        select 1 from rail_staging.payload_rows parent
        where parent.import_run_id = p_import_run and parent.entity = 'rail_lines'
          and parent.payload ->> 'id' = child.payload ->> 'lineId'
      )
  ) then errors := errors || to_jsonb('component references missing line'); end if;
  if exists (
    select 1 from rail_staging.payload_rows child
    where child.import_run_id = p_import_run and child.entity = 'rail_line_stations'
      and (not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_line_components' and parent.payload ->> 'id' = child.payload ->> 'componentId')
        or not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_station_groups' and parent.payload ->> 'id' = child.payload ->> 'stationGroupId')
        or not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_station_records' and parent.payload ->> 'id' = child.payload ->> 'stationRecordId'))
  ) then errors := errors || to_jsonb('line station references missing canonical row'); end if;
  if exists (
    select 1 from rail_staging.payload_rows child
    where child.import_run_id = p_import_run and child.entity = 'rail_station_links'
      and (not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_line_components' and parent.payload ->> 'id' = child.payload ->> 'componentId')
        or not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_station_groups' and parent.payload ->> 'id' = child.payload ->> 'fromStationGroupId')
        or not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_station_groups' and parent.payload ->> 'id' = child.payload ->> 'toStationGroupId')
        or not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_station_records' and parent.payload ->> 'id' = child.payload ->> 'fromStationRecordId')
        or not exists (select 1 from rail_staging.payload_rows parent where parent.import_run_id = p_import_run and parent.entity = 'rail_station_records' and parent.payload ->> 'id' = child.payload ->> 'toStationRecordId'))
  ) then errors := errors || to_jsonb('station link references missing canonical row'); end if;
  if exists (
    with
      link_payload as materialized (
        select payload ->> 'lineId' as line_id,
               payload ->> 'componentId' as component_id
        from rail_staging.payload_rows
        where import_run_id = p_import_run
          and entity = 'rail_station_links'
      ),
      line_payload as materialized (
        select payload ->> 'id' as line_id
        from rail_staging.payload_rows
        where import_run_id = p_import_run
          and entity = 'rail_lines'
      ),
      component_line_payload as materialized (
        select component.payload ->> 'id' as component_id,
               component.payload ->> 'lineId' as line_id
        from rail_staging.payload_rows component
        join line_payload line
          on line.line_id = component.payload ->> 'lineId'
        where component.import_run_id = p_import_run
          and component.entity = 'rail_line_components'
      )
    select 1
    from link_payload child
    left join component_line_payload component
      on component.component_id = child.component_id
     and component.line_id = child.line_id
    where component.component_id is null
  ) then errors := errors || to_jsonb('station link line/component mismatch'); end if;
  update rail_staging.import_runs set row_counts = coalesce(counts, '{}'::jsonb), validation_errors = errors,
    status = case when jsonb_array_length(errors) = 0 then 'validated' else 'rejected' end, completed_at = now()
  where id = p_import_run;
  return jsonb_build_object('runId', p_import_run, 'rowCounts', coalesce(counts, '{}'::jsonb), 'errors', errors, 'status', case when jsonb_array_length(errors) = 0 then 'validated' else 'rejected' end);
end;
$$;
revoke all on function rail_staging.validate_rail_import(uuid) from public, authenticated;
grant execute on function rail_staging.validate_rail_import(uuid) to service_role;

create or replace function rail_staging.promote_rail_import(p_import_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, rail_staging
as $$
declare
  version_id uuid;
  version_payload jsonb;
begin
  if not exists (select 1 from rail_staging.import_runs where id = p_import_run and status = 'validated') then
    raise exception 'rail import must pass validation before promote';
  end if;
  select payload into version_payload from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'dataset_version' order by row_number limit 1;
  if version_payload is null then raise exception 'dataset_version payload is missing'; end if;
  version_id := (version_payload ->> 'id')::uuid;
  insert into public.rail_dataset_versions (id, provider, dataset_id, dataset_year, data_as_of, retrieved_at, source_url, license, license_url, content_sha256, parser_version, normalizer_version, is_active)
  values (version_id, 'mlit_n02', version_payload ->> 'datasetId', (version_payload ->> 'datasetYear')::integer, (version_payload ->> 'dataAsOf')::date, coalesce((version_payload ->> 'retrievedAt')::timestamptz, now()), version_payload ->> 'sourceUrl', coalesce(version_payload ->> 'license', 'CC-BY-4.0'), version_payload ->> 'licenseUrl', version_payload ->> 'contentSha256', version_payload ->> 'parserVersion', version_payload ->> 'normalizerVersion', false)
  on conflict (id) do update set retrieved_at = excluded.retrieved_at, content_sha256 = excluded.content_sha256, parser_version = excluded.parser_version, normalizer_version = excluded.normalizer_version;
  -- Re-importing the same pinned dataset must replace its serving rows as one
  -- transaction. This keeps a corrected graph/alias artifact from being
  -- masked by the earlier on-conflict row.
  delete from public.rail_station_links where line_id in (select id from public.rail_lines where dataset_version_id = version_id);
  delete from public.rail_line_stations where line_id in (select id from public.rail_lines where dataset_version_id = version_id);
  delete from public.rail_line_aliases where line_id in (select id from public.rail_lines where dataset_version_id = version_id);
  delete from public.rail_station_aliases where station_group_id in (select id from public.rail_station_groups where dataset_version_id = version_id);
  delete from public.rail_line_components where line_id in (select id from public.rail_lines where dataset_version_id = version_id);
  delete from public.rail_lines where dataset_version_id = version_id;
  delete from public.rail_station_groups where dataset_version_id = version_id;
  delete from public.rail_station_records where dataset_version_id = version_id;
  insert into public.rail_lines (id, dataset_version_id, operator_name, operator_key, line_name, line_key, railway_type, operator_type, geometry, metadata)
  select (payload ->> 'id')::uuid, version_id, payload ->> 'operatorName', payload ->> 'operatorKey', payload ->> 'lineName', payload ->> 'lineKey', payload ->> 'railwayType', payload ->> 'operatorType', st_setsrid(st_geomfromgeojson(payload -> 'geometry'), 4326), coalesce(payload -> 'metadata', '{}'::jsonb)
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_lines'
  on conflict (id) do nothing;
  insert into public.rail_line_components (id, line_id, component_index, geometry, length_m, is_loop, metadata)
  select (payload ->> 'id')::uuid, (payload ->> 'lineId')::uuid, (payload ->> 'componentIndex')::integer, st_setsrid(st_geomfromgeojson(payload -> 'geometry'), 4326), (payload ->> 'lengthM')::double precision, coalesce((payload ->> 'isLoop')::boolean, false), coalesce(payload -> 'metadata', '{}'::jsonb)
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_line_components'
  on conflict (id) do nothing;
  insert into public.rail_station_records (id, dataset_version_id, source_station_code, source_group_code, station_name, station_name_key, operator_name, operator_key, line_name, line_key, railway_type, operator_type, geometry, representative_point, raw_properties)
  select (payload ->> 'id')::uuid, version_id, payload ->> 'sourceStationCode', payload ->> 'sourceGroupCode', payload ->> 'stationName', payload ->> 'stationNameKey', payload ->> 'operatorName', payload ->> 'operatorKey', payload ->> 'lineName', payload ->> 'lineKey', payload ->> 'railwayType', payload ->> 'operatorType', st_setsrid(st_geomfromgeojson(payload -> 'geometry'), 4326), st_setsrid(st_geomfromgeojson(payload -> 'representativePoint'), 4326), coalesce(payload -> 'rawProperties', '{}'::jsonb)
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_station_records'
  on conflict (id) do nothing;
  insert into public.rail_station_groups (id, dataset_version_id, source_group_code, canonical_name, name_key, representative_point, geometry, metadata)
  select (payload ->> 'id')::uuid, version_id, payload ->> 'sourceGroupCode', payload ->> 'canonicalName', payload ->> 'nameKey', st_setsrid(st_geomfromgeojson(payload -> 'representativePoint'), 4326), st_setsrid(st_geomfromgeojson(payload -> 'geometry'), 4326), coalesce(payload -> 'metadata', '{}'::jsonb) || jsonb_build_object('recordIds', payload -> 'recordIds')
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_station_groups'
  on conflict (id) do nothing;
  insert into public.rail_station_aliases (station_group_id, alias, alias_key, alias_type, source)
  select (payload ->> 'stationGroupId')::uuid, payload ->> 'alias', payload ->> 'aliasKey', payload ->> 'aliasType', coalesce(payload ->> 'source', 'mlit_n02')
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_station_aliases'
  on conflict do nothing;
  insert into public.rail_line_aliases (line_id, alias, alias_key, alias_type)
  select (payload ->> 'lineId')::uuid, payload ->> 'alias', payload ->> 'aliasKey', payload ->> 'aliasType'
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_line_aliases'
  on conflict do nothing;
  insert into public.rail_line_stations (line_id, component_id, station_group_id, station_record_id, path_key, sequence, distance_along_m, geometry_position, is_terminal, is_branch_point)
  select (payload ->> 'lineId')::uuid, (payload ->> 'componentId')::uuid, (payload ->> 'stationGroupId')::uuid, (payload ->> 'stationRecordId')::uuid, coalesce(payload ->> 'pathKey', 'main'), (payload ->> 'sequence')::integer, (payload ->> 'distanceAlongM')::double precision, st_setsrid(st_geomfromgeojson(payload -> 'geometryPosition'), 4326), coalesce((payload ->> 'isTerminal')::boolean, false), coalesce((payload ->> 'isBranchPoint')::boolean, false)
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_line_stations'
  on conflict do nothing;
  insert into public.rail_station_links (id, line_id, component_id, from_station_group_id, to_station_group_id, from_station_record_id, to_station_record_id, path_key, distance_m, metadata)
  select (payload ->> 'id')::uuid, (payload ->> 'lineId')::uuid, (payload ->> 'componentId')::uuid, (payload ->> 'fromStationGroupId')::uuid, (payload ->> 'toStationGroupId')::uuid, (payload ->> 'fromStationRecordId')::uuid, (payload ->> 'toStationRecordId')::uuid, coalesce(payload ->> 'pathKey', 'station-graph'), (payload ->> 'distanceM')::double precision, coalesce(payload -> 'metadata', '{}'::jsonb)
  from rail_staging.payload_rows where import_run_id = p_import_run and entity = 'rail_station_links'
  on conflict (id) do nothing;
  perform public.activate_rail_dataset_version(version_id);
  update rail_staging.import_runs set status = 'promoted', completed_at = now() where id = p_import_run;
  -- Keep the manifest and validation result as the audit record, but do not
  -- retain the large normalized payload after a successful promote.
  delete from rail_staging.payload_rows where import_run_id = p_import_run;
  return jsonb_build_object('runId', p_import_run, 'datasetVersionId', version_id, 'status', 'promoted');
end;
$$;
revoke all on function rail_staging.promote_rail_import(uuid) from public, authenticated;
grant execute on function rail_staging.promote_rail_import(uuid) to service_role;

create or replace function public.activate_rail_dataset_version(p_dataset_version uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.rail_dataset_versions where id = p_dataset_version) then
    raise exception 'rail dataset version does not exist';
  end if;
  update public.rail_dataset_versions set is_active = false where provider = 'mlit_n02';
  update public.rail_dataset_versions set is_active = true where id = p_dataset_version;
end;
$$;
revoke all on function public.activate_rail_dataset_version(uuid) from public, authenticated;
grant execute on function public.activate_rail_dataset_version(uuid) to service_role;

grant usage on schema public, rail_staging to authenticated, service_role;
grant select on public.rail_dataset_versions, public.rail_lines, public.rail_line_components,
  public.rail_station_records, public.rail_station_groups, public.rail_station_aliases,
  public.rail_line_aliases, public.rail_line_stations, public.rail_station_links to authenticated;
grant all on public.rail_dataset_versions, public.rail_lines, public.rail_line_components,
  public.rail_station_records, public.rail_station_groups, public.rail_station_aliases,
  public.rail_line_aliases, public.rail_line_stations, public.rail_station_links to service_role;
grant all on rail_staging.import_runs to service_role;

alter table public.rail_dataset_versions enable row level security;
alter table public.rail_lines enable row level security;
alter table public.rail_line_components enable row level security;
alter table public.rail_station_records enable row level security;
alter table public.rail_station_groups enable row level security;
alter table public.rail_station_aliases enable row level security;
alter table public.rail_line_aliases enable row level security;
alter table public.rail_line_stations enable row level security;
alter table public.rail_station_links enable row level security;

create policy rail_dataset_version_select on public.rail_dataset_versions for select to authenticated using (true);
create policy rail_lines_select on public.rail_lines for select to authenticated using (true);
create policy rail_line_components_select on public.rail_line_components for select to authenticated using (true);
create policy rail_station_records_select on public.rail_station_records for select to authenticated using (true);
create policy rail_station_groups_select on public.rail_station_groups for select to authenticated using (true);
create policy rail_station_aliases_select on public.rail_station_aliases for select to authenticated using (true);
create policy rail_line_aliases_select on public.rail_line_aliases for select to authenticated using (true);
create policy rail_line_stations_select on public.rail_line_stations for select to authenticated using (true);
create policy rail_station_links_select on public.rail_station_links for select to authenticated using (true);
