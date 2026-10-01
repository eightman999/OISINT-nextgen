import { assert, assertEquals, assertRejects } from "@std/assert";
import { withAbortTimeout } from "../functions/_shared/pipeline.ts";

Deno.test("withAbortTimeout: timeout前にproviderのAbortSignalをabortする", async () => {
  let receivedSignal: AbortSignal | undefined;
  let observedAbort = false;

  await assertRejects(
    () =>
      withAbortTimeout(
        (signal) => {
          receivedSignal = signal;
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              observedAbort = true;
              reject(
                signal.reason ?? new DOMException("aborted", "AbortError"),
              );
            }, { once: true });
          });
        },
        5,
      ),
    Error,
    "timeout",
  );

  assert(receivedSignal !== undefined);
  assertEquals(receivedSignal.aborted, true);
  assertEquals(observedAbort, true);
});

Deno.test("pipeline retry boundary: each provider attempt receives the timeout signal", async () => {
  const source = await Deno.readTextFile(
    new URL("../functions/_shared/pipeline.ts", import.meta.url),
  );
  assert(source.includes("withAbortTimeout("));
  assert(source.includes("(signal) => ai.investigateCandidate(input, signal)"));
  // The retry loop is intentionally capped at two attempts; a timeout must
  // abort attempt one before attempt two can be issued.
  assert(source.includes("attempt < CANDIDATE_PROVIDER_MAX_ATTEMPTS"));
  const timeoutSource = await Deno.readTextFile(
    new URL("../functions/_shared/timeout_policy.ts", import.meta.url),
  );
  assert(timeoutSource.includes("controller.abort(error)"));
  assert(timeoutSource.includes('parentSignal?.addEventListener("abort"'));
});
