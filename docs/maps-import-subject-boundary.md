# Google Maps import: subject-owned state and asynchronous work

Related to #4. This is a partial Web Maps-import fix. It does not close the
Apple/Android or other identity-transition findings in that issue.

## Boundary

- The import component owns its file preview, selected labels and consent in a
  keyed subject lifetime. The account screen also keys it by account generation.
- File reads and saves receive a unique operation controller. A replacement
  operation or unmount invalidates old work; every asynchronous completion is
  checked before parsing, showing status, committing locally or notifying the
  account screen. Selection changes still require fresh consent, and selection
  and consent controls are locked while a save is in progress.
- Maps saves require the expected permanent subject and an operation signal.
  The repository checks them across user/session lookups and watches auth changes
  without awaiting inside the auth callback. A tiny inert identity epoch is
  observed for the lifetime of the existing singleton client and captured before
  the save's first lazy-import await. A -> B -> A stays cancelled, including
  switches before the operation-specific listener is attached. Importing the
  epoch helper does not eagerly initialize Supabase. A save overlapping the
  first INITIAL_SESSION event fails closed and requires a retry.
- The one RPC carries the initiating session's Authorization header, rather than
  allowing the shared client's later token lookup to choose a different account.
  The header is request-local; no credentials are stored or logged. Existing
  profile revision/existence CAS arguments and error handling remain in place.
- Abort is best effort. A request already dispatched as A may still persist for
  A after switching accounts. It must not become a B write, commit old data to
  device state, invoke `onApplied`, or report old success. No rollback is claimed.

The pinned SDK version (`@supabase/supabase-js` 2.112.3) supports request-local
`setHeader` and keeps an explicit Authorization header in its fetch wrapper:

- [PostgrestBuilder](https://github.com/supabase/supabase-js/blob/v2.112.3/packages/core/postgrest-js/src/PostgrestBuilder.ts)
- [fetchWithAuth](https://github.com/supabase/supabase-js/blob/v2.112.3/packages/core/supabase-js/src/lib/fetch.ts)

## Offline regression

Run with Node 24 and already installed React, React DOM, jsdom and rolldown:

```sh
node --experimental-vm-modules scripts/test-maps-import-boundary.mjs
```

The optional `MAPS_TEST_DEPENDENCIES` points to an existing trusted node_modules
folder; the script never installs packages. `MAPS_TEST_SOURCE_ROOT` can point to
an isolated baseline source tree, with `MAPS_TEST_BASELINE=1` to assert the three
original reproductions. No real accounts, credentials, files or services are used.

The harness compiles the actual component and renders it with React DOM/JSDOM.
Native UI primitives, parsing, merge and storage are synthetic stubs. It also
executes complete extracted production save/auth function declarations and the
actual singleton observer registration/identity-epoch module with a
recording Supabase stub. It covers A -> B -> A, delayed reads, stale successes and
failures, unmount, consent reset, user/session lookup races, RPC races, request
header pinning, listener cleanup, same-subject refresh and profile CAS.

The existing `src/lib/supabase.test.ts` also checks singleton observer registration,
stable same-subject refresh, A -> B -> A and sign-out epochs.

This is focused regression evidence, not a full npm/typecheck/lint pass or a real
Supabase integration test. The production parser and local persistence functions
are stubbed; the complete account/login tree and transport are not exercised.

## Separate acceptance work

Before treating the Web path as fully accepted, run the project checks and full
login-transition tests with synthetic accounts in an authorized isolated setup.
Verify the real SDK transport, server `auth.uid()` destination, same-account
refresh, sign-out, guest -> account, account -> account, interrupted RPC and
back-navigation. Do not use production profiles to test the race.

Apple participation/history responses and native investigation screens need their
own Swift/Android regression coverage and fixes. No native-runtime result, server
migration, production verification, cleanup, deployment or Issue closure is
included here.
