import { assertFalse, assertStringIncludes } from "@std/assert";

const joinSource = await Deno.readTextFile(
  new URL("../functions/join-investigation/index.ts", import.meta.url),
);
const latestJoinMigration = await Deno.readTextFile(
  new URL(
    "../migrations/202608300001_join_investigation_atomicity_hardening.sql",
    import.meta.url,
  ),
);
const concurrencyFixture = await Deno.readTextFile(
  new URL(
    "./rls/104_join_investigation_concurrency.sql",
    import.meta.url,
  ),
);

Deno.test("join Edgeはatomic RPCのfull結果を409へ変換する", () => {
  assertStringIncludes(joinSource, 'db.rpc("join_investigation"');
  assertStringIncludes(joinSource, 'row.status === "full"');
  assertStringIncludes(
    joinSource,
    'return json({ error: "参加人数が上限に達しています" }, 409',
  );
  assertFalse(joinSource.includes('from("investigations")'));
});

Deno.test("join RPCは行lock・20人上限・最小権限search_pathを持つ", () => {
  assertStringIncludes(latestJoinMigration, "security definer");
  assertStringIncludes(
    latestJoinMigration,
    "set search_path = pg_catalog, public, pg_temp",
  );
  assertStringIncludes(latestJoinMigration, "for update;");
  assertStringIncludes(
    latestJoinMigration,
    "v_max_members constant integer := 20;",
  );
  assertStringIncludes(
    latestJoinMigration,
    "if v_member_count >= v_max_members then",
  );
  assertStringIncludes(
    latestJoinMigration,
    "values (v_investigation_id, p_user_id, 'editor');",
  );
  assertStringIncludes(
    latestJoinMigration,
    "revoke all on function public.join_investigation(text, uuid, text)",
  );
  assertStringIncludes(
    latestJoinMigration,
    "from public, anon, authenticated;",
  );
  assertStringIncludes(
    latestJoinMigration,
    "grant execute on function public.join_investigation(text, uuid, text)",
  );
  assertStringIncludes(latestJoinMigration, "to service_role;");
});

Deno.test("join RLS fixtureは正常・再join・満員・並行joinと不整合を検証する", () => {
  assertStringIncludes(concurrencyFixture, "dblink_send_query");
  assertStringIncludes(concurrencyFixture, "dblink_is_busy");
  assertStringIncludes(concurrencyFixture, "'full'");
  assertStringIncludes(concurrencyFixture, "'full-does-not-upsert-profile'");
  assertStringIncludes(concurrencyFixture, "'full-does-not-insert-member'");
  assertStringIncludes(concurrencyFixture, "'full-does-not-insert-event'");
  assertStringIncludes(concurrencyFixture, "'successful-join-role'");
  assertStringIncludes(concurrencyFixture, "'rejoin-does-not-insert-event'");
});
