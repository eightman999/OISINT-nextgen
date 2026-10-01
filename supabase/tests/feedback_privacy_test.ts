import { assertFalse, assertStringIncludes } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608240009_feedback_privacy_guards.sql",
    import.meta.url,
  ),
);
const concurrencyTest = await Deno.readTextFile(
  new URL("./rls/095_feedback_concurrency.sql", import.meta.url),
);

Deno.test("#110/#157 feedback migration closes direct writes and preserves owner reads", () => {
  assertStringIncludes(
    migration,
    "revoke insert, update, delete on public.place_feedback from authenticated",
  );
  assertStringIncludes(
    migration,
    "grant select on public.place_feedback to authenticated",
  );
  assertStringIncludes(migration, "drop policy if exists pfb_insert");
  assertStringIncludes(migration, "drop policy if exists pfb_update");
});

Deno.test("#110/#157 feedback aggregation is closed at three identical values", () => {
  assertStringIncludes(migration, "coalesce(v_top_count, 0) < 3");
  assertStringIncludes(migration, "count(distinct f.user_id)");
  assertStringIncludes(migration, "else null end");
  assertStringIncludes(
    migration,
    "char_length(v_aspect_value) not between 1 and 120",
  );
  assertFalse(
    migration.includes(
      "grant insert on public.place_feedback to authenticated",
    ),
  );
});

Deno.test("#110/#157 feedback uses distinct users, bounded arrays, and transaction locks", () => {
  assertStringIncludes(migration, "pg_advisory_xact_lock");
  assertStringIncludes(migration, "hashtextextended");
  assertStringIncludes(
    migration,
    "select distinct on (f.user_id) f.user_id, f.aspect_value",
  );
  assertStringIncludes(
    migration,
    "select distinct on (f.user_id, f.aspect) f.aspect, f.aspect_value",
  );
  assertStringIncludes(migration, "updated_at = clock_timestamp()");
  assertStringIncludes(migration, "having count(*) >= 3");
  assertStringIncludes(migration, "cardinality(p_place_ids) between 1 and 100");
  assertStringIncludes(concurrencyTest, "dblink_send_query");
  assertStringIncludes(concurrencyTest, "FAIL(095/submit-lock)");
  assertStringIncludes(concurrencyTest, "FAIL(095/update-fact)");
});
