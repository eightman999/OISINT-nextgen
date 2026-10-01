import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608250001_investigation_creation_idempotency.sql",
    import.meta.url,
  ),
);
const source = await Deno.readTextFile(
  new URL("../functions/create-investigation/index.ts", import.meta.url),
);

Deno.test("create idempotency ledger は user/key + digest を先行claimする", () => {
  assertStringIncludes(
    migration,
    "create table public.investigation_creation_requests",
  );
  assertStringIncludes(migration, "primary key (user_id, idempotency_key)");
  assertStringIncludes(migration, "request_digest text not null");
  assertStringIncludes(migration, "lease_generation bigint not null");
  assertStringIncludes(migration, "lease_token uuid not null");
  assertStringIncludes(migration, "claim_investigation_creation");
  assertStringIncludes(migration, "touch_investigation_creation");
  assertStringIncludes(migration, "reserve_provider_budget_for_creation");
  assertStringIncludes(migration, "create_investigation_for_claim");
  assertStringIncludes(migration, "complete_investigation_creation");
  assertStringIncludes(
    migration,
    "create table public.investigation_creation_usage_attempts",
  );
  assertStringIncludes(migration, "begin_investigation_creation_step");
  assertStringIncludes(
    migration,
    "save_investigation_creation_parse_checkpoint",
  );
  assertStringIncludes(
    migration,
    "save_investigation_creation_embedding_checkpoint",
  );
  assertStringIncludes(migration, "fail_investigation_creation");
  assertStringIncludes(migration, "abandon_investigation_creation");
  assertStringIncludes(migration, "release_investigation_creation");
  assertStringIncludes(migration, "auth.role(), '') <> 'service_role'");
  assertStringIncludes(migration, "lease_generation = p_lease_generation");
  assertStringIncludes(migration, "lease_token = p_lease_token");
  assertStringIncludes(
    migration,
    "from public, anon, authenticated",
  );
  const ledgerDefinition = migration.slice(
    migration.indexOf("create table public.investigation_creation_requests"),
    migration.indexOf(
      "comment on table public.investigation_creation_requests",
    ),
  );
  assertFalse(ledgerDefinition.includes("raw_query"));
  assertFalse(ledgerDefinition.includes("display_name"));
});

Deno.test("create retry は mismatch / in-flight / completed replay を契約化する", () => {
  assertStringIncludes(source, 'req.headers.get("Idempotency-Key")');
  assertStringIncludes(source, "digestCreateRequest(query, displayName)");
  assertStringIncludes(source, '"claim_investigation_creation"');
  assertStringIncludes(source, 'claim.claim_status === "mismatch"');
  assertStringIncludes(source, 'claim.claim_status === "in_flight"');
  assertStringIncludes(source, 'claim.claim_status === "complete"');
  assertStringIncludes(source, '"reclaimed"');
  assertStringIncludes(source, "claim.lease_generation");
  assertStringIncludes(source, "claim.lease_token");
  assertStringIncludes(source, '{ "Retry-After": "1" }');
  assertStringIncludes(source, '"touch_investigation_creation"');
  assertStringIncludes(source, '"create_investigation_for_claim"');
  assertStringIncludes(source, '"complete_investigation_creation"');
  assertStringIncludes(source, '"release_investigation_creation"');
  assertStringIncludes(source, '"begin_investigation_creation_step"');
  assertStringIncludes(
    source,
    '"save_investigation_creation_parse_checkpoint"',
  );
  assertFalse(source.includes("p_release_usage"));
  assertFalse(migration.includes("p_release_usage"));
  assertStringIncludes(
    migration,
    "pre-provider attempt could not be released",
  );
  assertStringIncludes(migration, "state = 'uncertain'");

  const claim = source.indexOf('"claim_investigation_creation"');
  const rateLimit = source.indexOf("checkRateLimit(");
  const costGuard = source.indexOf("checkCostGuard(");
  const provider = source.indexOf("getProviders(");
  assert(claim >= 0 && claim < rateLimit);
  assert(claim < costGuard);
  assert(claim < provider);

  const complete = source.lastIndexOf(
    "const completed = await completeCreationClaim(",
  );
  const embedding = source.indexOf("const embeddingStarted = Date.now()");
  const response = source.lastIndexOf("return jsonWithRequestId(");
  assert(complete >= 0 && embedding >= 0 && embedding < complete);
  assert(complete < response);
  assertFalse(source.includes('.from("investigations")\n    .insert'));
});
