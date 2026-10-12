# Shared place distance: deployment and existing data

Related to public Issue #1. The application change removes `distanceM` from
new canonical `places.metadata` writes in investigation and refresh paths.
Discovery results retain the distance in memory for pre-ranking.

This patch does **not** remove values already stored in a database. No production
database was accessed, and production exposure or deployment state is unknown.
Do not close the issue on the application change alone.

## Separate, owner-approved remediation

1. Deploy the sanitized investigation and refresh writers through the normal
   reviewed release process. Confirm no older writer can repopulate the field.
2. In an isolated database with synthetic rows, prepare and verify a narrowly
   scoped cleanup that removes only the top-level `distanceM` key from object
   metadata. Preserve every other key and unrelated rows. Verify idempotency.
3. Review production scope, row counts, operational impact, and backup/retention
   requirements with the owner before approving any production mutation. Do not
   copy location-derived values into public logs, tickets, or test fixtures.
4. Apply the separately approved cleanup. Using a second authenticated synthetic
   principal that is not an investigation member, verify that permitted reads
   of `places.metadata` contain no distance key. Check the relevant deployed
   grants and policies rather than assuming migrations are applied.
5. Review retained exports/caches/backups under their existing retention policy
   and record any residual exposure or limitations privately.

## Offline regression checks

- `node scripts/test-place-metadata.mjs` (Node.js 22.13+): executes the real
  provider conversion, pre-rank conversion, and both write functions extracted
  from source, with recording database stubs. No live API or database access.
- `deno test --config supabase/deno.json supabase/tests/place_metadata_test.ts`:
  direct helper tests, when Deno and the project's dependencies are available.

These focused checks do not replace the repository's full test, typecheck,
and lint suite or the separate database-policy/cleanup verification above.
