import { assertStringIncludes } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608200002_rail_postgis_search_path.sql",
    import.meta.url,
  ),
);

Deno.test("N02 import functions resolve managed PostGIS schema", () => {
  assertStringIncludes(
    migration,
    "alter function rail_staging.validate_rail_import(uuid)",
  );
  assertStringIncludes(
    migration,
    "alter function rail_staging.promote_rail_import(uuid)",
  );
  assertStringIncludes(
    migration,
    "set search_path = extensions, public, rail_staging",
  );
});
