import { assertFalse, assertStringIncludes } from "@std/assert";

const joinSource = await Deno.readTextFile(
  new URL("../functions/join-investigation/index.ts", import.meta.url),
);
const atomicMigration = await Deno.readTextFile(
  new URL(
    "../migrations/202608260001_join_investigation_atomicity.sql",
    import.meta.url,
  ),
);

Deno.test("join endpoint は rate limit とbounded bodyをRPCより先に適用する", () => {
  assertStringIncludes(joinSource, "checkRateLimit(");
  assertStringIncludes(joinSource, '"join"');
  assertStringIncludes(joinSource, "readRequestBodyLimited");
  assertStringIncludes(joinSource, 'db.rpc("join_investigation"');
  assertStringIncludes(
    joinSource,
    'return json({ error: "リクエストが大きすぎます" }, 413',
  );
});

Deno.test("join RPC はinvestigation行ロックと20人上限を持ちservice_role限定", () => {
  assertStringIncludes(atomicMigration, "for update;");
  assertStringIncludes(
    atomicMigration,
    "v_max_members constant integer := 20;",
  );
  assertStringIncludes(atomicMigration, "v_member_count >= v_max_members");
  assertStringIncludes(atomicMigration, "'full'::text");
  assertStringIncludes(atomicMigration, "'already_member'::text");
  assertStringIncludes(
    atomicMigration,
    "revoke all on function public.join_investigation(text, uuid, text)",
  );
  assertStringIncludes(
    atomicMigration,
    "grant execute on function public.join_investigation(text, uuid, text)",
  );
});

Deno.test("直EdgeのJSON入口5本がraw req.jsonを使わない", () => {
  const paths = [
    "../functions/create-investigation/index.ts",
    "../functions/rerank-investigation/index.ts",
    "../functions/join-investigation/index.ts",
    "../functions/resolve-location/index.ts",
    "../functions/delete-investigation/index.ts",
  ];
  for (const path of paths) {
    const source = Deno.readTextFileSync(new URL(path, import.meta.url));
    assertStringIncludes(source, "readRequestBodyLimited");
    assertFalse(source.includes("await req.json().catch(() => null)"), path);
  }
});
