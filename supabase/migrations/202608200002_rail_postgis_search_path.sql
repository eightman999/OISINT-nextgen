-- 202608200002: resolve managed Supabase PostGIS functions during N02 import.
-- The managed project installs PostGIS in the extensions schema, while local
-- databases may retain an older public-schema installation.  Keep the
-- service-definer import functions explicit and environment-independent.
alter function rail_staging.validate_rail_import(uuid)
  set search_path = extensions, public, rail_staging;

alter function rail_staging.promote_rail_import(uuid)
  set search_path = extensions, public, rail_staging;
