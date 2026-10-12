# Worker upstream error boundary

Related to public issue #8, **non-2xx `callFunction` response bodies only**.

The Worker now returns its fixed public error vocabulary for bounded upstream
error responses. It preserves HTTP status and the locally generated request ID,
so clients retain status-based authentication, conflict and retry handling.
Upstream `error`, `message`, `details`, `hint`, extra JSON fields, malformed JSON,
HTML and text are neither reflected nor copied into Worker logs. Diagnostics
should be correlated using the existing request ID, not by exposing the body.

Only a syntactically valid `Retry-After` is retained on these errors: ASCII
delay-seconds (up to 128 characters) or an exact canonical IMF-fixdate. Invalid,
oversized and arbitrary-text values are dropped. Other upstream headers,
including debug headers, are not forwarded. Existing redirect and bounded-body
failures still return 502 rather than the upstream status.

Successful responses are unchanged. Endpoint-specific success-schema
allowlisting is separate work; this change is not a claim that all successful
upstream payloads are safe. The existing direct PostgREST `callRpc` boundary is
unchanged; `callFunction` reuses its fixed status-to-message vocabulary.

## Validation

`apps/api/src/index.error-boundary.test.ts` exercises the real Hono app with a
synthetic fetch stub. It covers all five public Function routes, error statuses
400/401/403/404/408/409/413/422/429/500/502/503/504, JSON/invalid JSON/HTML/text/empty
bodies, extra fields, body-free logs, request IDs, allowed and rejected
Retry-After values, redirects, oversize rejection and successful responses.
Existing tests that required raw error reflection now require fixed messages.

The public baseline fails 82 of the 87 new cases; five existing success/guard
cases pass. The fixed code passes all 187 cases in the new test file plus
`index.test.ts` and `index.security.test.ts` under Node 24/Vitest 4.1.10, using
already installed Hono 4.13.13 and Zod 4.6.5. No dependencies were installed.
Zod differs from the repository's pinned 4.4.3; this isolated test run is not a
lockfile-matched or Cloudflare workerd acceptance run. No full application tests,
project typecheck/lint, deployment or live upstream verification was performed.

## Remaining issue scope

Keep #8 open. This does not change SQL `match_count`, table privileges/RLS,
retention, Realtime, Worker rate limits, configuration oracles or secret scans.
The SQL maximum/NULL/zero/negative-input contract needs an explicit decision and
an isolated database regression before a separate migration. No SQL runtime was
used, no production data was read or changed, and no real credentials or tokens
were used in these tests.
