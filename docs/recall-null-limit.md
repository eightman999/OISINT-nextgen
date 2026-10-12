# Recall count NULL fallback (partial issue #8)

This forward-only migration changes only the final LIMIT in three public RPCs:

| RPC | Declared omitted-argument default | New explicit NULL fallback |
| --- | --- | --- |
| match_investigations | 5 | 5 |
| match_investigation_places | 5 | 5 |
| match_requirement_kinds | 8 | 8 |

The existing SQL uses LIMIT match_count: omitted arguments use the declared
default, but explicit NULL removes the final row limit. Choosing the already
declared defaults for NULL is a narrow bug-fix assumption, not a claim that an
explicit-NULL contract previously existed.

All non-NULL integers keep their behavior. In particular, zero returns no rows;
negative limits retain PostgreSQL's 2201W error; default+1, ordinary caller
values and 2147483647 are not clamped. An agreed maximum count and any new
zero/negative policy remain separate work. This is not a general resource
limit, does not bound query work, and does not resolve all of issue #8.

CREATE OR REPLACE is used without DROP, grants, revokes or ownership changes.
Signatures, defaults, output columns, SQL/STABLE/SECURITY DEFINER attributes,
search_path, explicit owner/member filters, embedding checks, exclusion,
positive-vote aggregation, requirement grouping, ordering and both internal
top-8 limits remain identical to the public original definitions. The retained
search_path and other issue #8 findings are outside this patch.

## Evidence and checks

Sources are only the public OISINT-nextgen base
76cb7ec440d3d28dd09978f3957a994259d9db8f and its public issue #8 review.
No private repository material, actual account data, production endpoints or
credentials are used. Historical migrations are unchanged.

Run the dependency-free source check:

```sh
node scripts/check-recall-null-limit.mjs
node --check scripts/check-recall-null-limit.mjs
```

It checks exact source equivalence: the new migration contains precisely three
function replacements, each differing from its original only by the terminal
LIMIT substitution. It does not parse or execute SQL, validate PostgreSQL
catalog behavior, or establish database/RLS acceptance.

## Rollback-only isolated SQL regression

**NOT EXECUTED during preparation.** PostgreSQL/psql, Docker and checked
PGlite locations were unavailable. No package or runtime was installed.
This draft needs approved isolated database execution before release.

The standalone fixture requires an already installed PostgreSQL/pgvector/
pgcrypto environment and a privileged session in a fresh, disposable local
database named exactly oisint_recall_null_test. Never point it at a production
or shared database. Do not supply production connection credentials.

```sh
psql -X --set ON_ERROR_STOP=1 --dbname oisint_recall_null_test \
  --file supabase/tests/recall_null_limit.sql
```

The fixture starts a transaction, refuses an existing application/auth
namespace, creates synthetic identities/data, loads the public initial table
definitions and original RPCs, snapshots behavior/catalog attributes, applies
the new migration inside that transaction, asserts, then rolls back. With
ON_ERROR_STOP a failure terminates the psql script/session and the transaction
does not commit. Do not run it piecemeal in a long-lived session.

Coverage designed into the fixture:

- Distinct cosine distances, more results than defaults, and positive
  reproduction of the original explicit-NULL unlimited result.
- Exact ordered results for omitted, NULL and explicit default counts;
  non-NULL 0, 1, 3, 5, 6, 8, 9, 12, maximum int and -1 compared before/after.
- Owner-only and membership-only access, inaccessible nearest investigation,
  nonmember and missing uid, null embedding, service role without uid.
- Both exclude_investigation values, internal top 8 before aggregation,
  positive-vote filtering, requirement grouping and null kind/priority checks.
- Exact output columns and preserved function OID, owner, ACL, argument
  defaults, volatility, definer flag, search_path and return/argument metadata.
- Effective anon denial and authenticated/service_role EXECUTE grants.

The auth.uid function and deny-all table RLS are synthetic. They test the
definer functions' explicit filtering and prevent unprivileged direct reads;
they do not substitute for the application's complete migrations/policies,
Supabase/PostgREST, full RLS suite, concurrency or load tests. The public
snapshot references a scripts/test-rls.sh runner that is not included in this
base; this fixture therefore has its own explicit, guarded invocation.

Full migration application, existing application tests/typecheck/lint and
live/deployed behavior are unverified. No deployment, live migration, merge,
release, Issue closure, settings changes or CI rerun is part of this work.
