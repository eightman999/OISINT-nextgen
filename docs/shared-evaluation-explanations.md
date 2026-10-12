# Shared evaluation explanations (public Issue #3, partial fix)

Evaluation rows for public investigations can be readable by authenticated
non-members. Private requirement text, normalized targets, and model prose
conditioned on that text therefore do not belong in their explanations.

## New application-generated explanations

- Time/budget matching keeps public opening hours and price ranges, but omits
  requested times, budget amounts and derived target labels.
- Known-fact evaluation keeps public capacity/walking-time facts, but omits the
  requested party size and maximum walking time.
- `guardEvaluation` never copies the model's free-text explanation. Semantic
  evaluations retain state, confidence and evidence references with a fixed
  state explanation. Verified deterministic explanations still take precedence.
- Scoring and evidence selection are unchanged. Public facts and fit status
  still convey information about the match; this is not a zero-inference claim.

## Writer audit and limits

The public snapshot's candidate writers funnel known-fact, researched, and
failure rows through `persistCandidateEvaluations`; `insertUnknownEvaluations`
writes a fixed failure message. Run/rerank entry points read evaluation coverage
but do not independently insert model explanations. The ranking path can write
new deterministic explanations through `persist_investigation_ranking` and can
also retain an old explanation when only another field changes. Updating code
does **not** sanitize all historical rows, caches or exports.

AI-generated evidence/claims have separate validation/provenance boundaries.
This patch removes free-text evaluation echoes; it does not prove the truth of
model claims, audit every public field, or establish production exposure.
Direct investigation INSERT and anonymous feedback eligibility in Issue #3 are
separate unresolved acceptance items. Do not close the issue on this patch.

## Verification

`node --experimental-vm-modules scripts/test-requirement-explanation.mjs`
runs the real matching and fact modules plus extracted pipeline guard/write
functions against synthetic fixtures and a recording database stub. Unused
external dependencies throw if called. AI cases exercise semantic and
empty-claim guard paths; they do not replace the full validation/schema suite.

To compare an unmodified public checkout:
`node --experimental-vm-modules scripts/test-requirement-explanation.mjs /path/to/baseline --baseline`

The focused regression verifies persisted explanations, venue facts, states,
confidence and evidence. It is not a database/RLS or live-provider test. Run the
repository's npm tests, typecheck/lint and Deno suite in its normal environment.

## Separate owner-approved acceptance

1. Verify deployment of all affected writers through the normal release flow.
2. In an isolated database, build and test a scoped historical-row remediation
   that removes condition-derived explanation text without changing decisions,
   scores or evidence. Verify idempotency and review affected counts privately.
3. Obtain separate approval before production cleanup; no production database
   access or mutation is included here.
4. Verify deployed grants/policies and read back synthetic public investigations
   as a non-member authenticated user. Check both new and historical rows.
5. Review existing caches/exports/backups and the other two Issue #3 subissues
   separately before deciding the issue is resolved.
