# RevenueCat TRANSFER UUID normalization

Related to public Issue #5. This is a partial fix for the TRANSFER item only;
rate limits, previews, deletion operations and voting are separate work.

## Scope

Apply the new forward-only migration through the normal reviewed migration
process. It replaces only `apply_revenuecat_transfer` and
`revoke_revenuecat_transfer`; the historical migration is unchanged.

Both RPCs accept upper/lower/mixed-case canonical hyphenated UUIDs consistently.
They still accept only existing, nonanonymous Auth users. Unknown/anonymous IDs,
non-UUID IDs, braces, missing hyphens and surrounding whitespace are skipped.
Known repeated subjects (including case variants) and source/destination
intersections are rejected before entitlement or ledger writes. Rejecting known
duplicates prevents ambiguous destination state arrays from choosing a winner.

All incoming arrays must be one-dimensional and one-based; destination state
arrays must match the destination length. Each verified destination keeps its
original state-array index when ineligible IDs are skipped. A null or unknown
product, or missing/expired/invalid expiry and grace proof, cannot grant Plus.

Existing sorted advisory locks, ledger deduplication and per-subject timestamp
guards are retained. A stale transfer can retain the existing success-like
result string while skipping older/equal per-subject writes. No change to that
ordering/result contract or to reconciliation policy is claimed.

The webhook already normalizes Plus destinations but passes raw origins and
revoke-only destinations to SQL. No handler change is required for this fix.
All source material used here is from this public repository.

## Verification and limits

- `node scripts/check-revenuecat-transfer-migration.mjs` checks the migration's
  source-level normalization and safety contracts. These are text/static checks,
  not SQL syntax validation or database execution.
- `supabase/tests/rls/111_revenuecat_transfer_uuid.sql` is a rollback-only synthetic
  SQL fixture for an isolated database with the public migrations applied.
  Run using `psql -X -v ON_ERROR_STOP=1 -f supabase/tests/rls/111_revenuecat_transfer_uuid.sql`
  only with an explicitly selected disposable local test database. Never point
  it at production. Identity collisions fail rather than overwrite Auth users.
- SQL cases cover nine case combinations in each Plus/no-Plus path, duplicate
  event replay, unknown/anonymous/noncanonical IDs, normalized duplicates and
  intersections, state-array positions, malformed shapes/lengths, missing or
  invalid product/expiry state, no partial writes, stale/equal timestamps and
  retained service-only EXECUTE privileges.
- In the preparation environment, PostgreSQL/PGlite and project dependencies
  were unavailable. No packages were installed. The SQL fixture was **not
  executed**; no SQL, concurrency, full-migration, RLS integration, complete
  npm test/typecheck/lint or live RevenueCat pass is claimed. Run the fixture,
  existing entitlement/concurrency tests, and full migration checks in an
  approved isolated PostgreSQL environment before deployment.
- The fixture uses expiry dates in 2099/2100. Refresh those synthetic future
  dates and the policy's accepted timestamp range before testing in 2099.
- No live accounts, production databases, billing API calls or real secrets
  were used. No deployment, migration execution, merge or release is included.

## Historical processed events require separate reconciliation

Replacing the functions changes future processing only. Previously recorded
event IDs remain in the idempotency ledger. Replaying an already processed
uppercase transfer with lowercase IDs returns `ignored_duplicate`; it does not
repair an origin that was left active.

Before any separately approved production remediation:

1. Confirm the deployed function versions and affected time window. Bound the
   investigation to TRANSFER events from that window; the redacted local ledger
   does not retain from/to arrays and cannot identify every affected subject.
2. With the owner's authorization, correlate the provider's transfer history
   and current subscriber ownership with the redacted ledger and current
   entitlement rows. Do not export raw payloads, customer identifiers or private
   billing data into public issues, logs or this repository.
3. Prepare a reviewed dry-run mapping of candidate old/new subjects, current
   ownership, ledger event IDs and current row timestamps. An uppercase event
   alone is not sufficient evidence to revoke today's entitlement: later valid
   events may have changed ownership again.
4. Reconcile only provider-verified current state under a separate approved
   procedure, preserving newer event ordering and an appropriate audit trail.
   Do not delete ledger entries, invent replacement event IDs or bypass
   idempotency to force a replay. No bulk cleanup SQL is supplied here.
5. Verify old/new access from isolated acceptance fixtures first, then perform
   any authorized production readback without disclosing private data. Keep the
   issue open until remaining scope and historical handling are separately
   accepted.
