import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608200001_rail_location_index.sql",
    import.meta.url,
  ),
);

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(`create or replace function ${name}`);
  const end = migration.indexOf(nextMarker, start);
  assert(start >= 0, `${name} must exist in the rail migration`);
  assert(end > start, `${name} must have a following migration marker`);
  return migration.slice(start, end);
}

Deno.test("PostGIS stays outside public and unsafe existing ACL fails closed", () => {
  assertStringIncludes(
    migration,
    "create extension if not exists postgis with schema extensions",
  );
  assertStringIncludes(
    migration,
    "to_regclass('public.spatial_ref_sys')",
  );
  assertStringIncludes(
    migration,
    "has_table_privilege('anon', spatial_ref_table, 'TRUNCATE')",
  );
  assertStringIncludes(
    migration,
    "has_table_privilege('authenticated', spatial_ref_table, 'TRUNCATE')",
  );
  assertStringIncludes(
    migration,
    "raise exception 'public.spatial_ref_sys exposes client write privileges'",
  );
});

Deno.test("rail staging validation has an indexed JSON identity lookup", () => {
  assertStringIncludes(
    migration,
    "create index rail_staging_payload_rows_entity_id_idx",
  );
  assertStringIncludes(
    migration,
    "on rail_staging.payload_rows (import_run_id, entity, ((payload ->> 'id')))",
  );

  const validation = functionBody(
    "rail_staging.validate_rail_import",
    "create or replace function rail_staging.promote_rail_import",
  );
  assertStringIncludes(validation, "link_payload as materialized");
  assertStringIncludes(validation, "component_line_payload as materialized");
  assertStringIncludes(validation, "station link line/component mismatch");
});

Deno.test("successful promote removes payload while retaining the audit row", () => {
  const promote = functionBody(
    "rail_staging.promote_rail_import",
    "create or replace function public.activate_rail_dataset_version",
  );
  const statusUpdate = promote.indexOf(
    "update rail_staging.import_runs set status = 'promoted'",
  );
  const payloadDelete = promote.indexOf(
    "delete from rail_staging.payload_rows where import_run_id = p_import_run",
  );
  assert(
    statusUpdate >= 0,
    "promote must preserve its import_runs audit update",
  );
  assert(
    payloadDelete > statusUpdate,
    "payload cleanup must happen after promote",
  );
  assertFalse(
    /delete\s+from\s+rail_staging\.import_runs/i.test(promote),
    "promote must retain the import_runs audit row",
  );
});
