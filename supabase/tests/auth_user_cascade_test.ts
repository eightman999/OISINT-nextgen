import { assertStringIncludes } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608240008_auth_user_cascade_guards.sql",
    import.meta.url,
  ),
);
const entitlementMigration = await Deno.readTextFile(
  new URL(
    "../migrations/202608240007_research_entitlement_policy.sql",
    import.meta.url,
  ),
);

Deno.test("#167 account-owned tables have NOT VALID auth cascade guards", () => {
  for (
    const table of [
      "investigations",
      "investigation_members",
      "requirements",
      "votes",
      "place_feedback",
    ]
  ) {
    assertStringIncludes(migration, `alter table public.${table}`);
    assertStringIncludes(migration, "references auth.users(id)");
    assertStringIncludes(migration, "on delete cascade not valid");
  }
});

Deno.test("#167 migration does not purge historical orphan rows", () => {
  assertStringIncludes(migration, "historical");
  assertStringIncludes(migration, "NOT VALID");
});

Deno.test("#554 resolver delegates Plus access to the fail-closed RevenueCat gate", () => {
  assertStringIncludes(
    entitlementMigration,
    "public.revenuecat_entitlement_access_allowed(",
  );
  assertStringIncludes(entitlementMigration, "e.app_user_id");
  assertStringIncludes(entitlementMigration, "e.product_id");
  assertStringIncludes(entitlementMigration, "e.expires_at");
  assertStringIncludes(
    entitlementMigration,
    "coalesce(u.is_anonymous, false) = false",
  );
});
