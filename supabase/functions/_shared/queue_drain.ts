/**
 * Queue drain response policy shared by the Edge handler and its tests.
 *
 * A drain with no eligible rows is healthy: there is nothing to dispatch.
 * Any partial dispatch is a failed handoff and must remain non-2xx so the
 * external scheduler retries on the next invocation.
 */
export function queueDrainResponseStatus(
  observed: number,
  dispatched: number,
): 202 | 503 {
  if (
    !Number.isSafeInteger(observed) || observed < 0 ||
    !Number.isSafeInteger(dispatched) || dispatched < 0 ||
    dispatched > observed
  ) {
    return 503;
  }
  return observed === 0 || dispatched === observed ? 202 : 503;
}

/**
 * A 409 is a successful drain handoff only when the handler has already run
 * the complete-investigation reconciliation RPC.  This marker is internal to
 * the service-role drain path; ordinary clients keep the public `{status:
 * "complete"}` response shape.
 */
export function isQueueDrainTerminalContract(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.status === "complete" &&
    row.queue_terminalized === true;
}

export const QUEUE_DRAIN_TERMINAL_BODY_LIMIT = 2048;
export const QUEUE_DRAIN_TERMINAL_BODY_TIMEOUT_MS = 15_000;

export interface QueueDrainBodyReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The service-role drain treats 409 as success only for the closed terminal
 * contract.  Decode the bounded response as fatal UTF-8 so replacement
 * characters can never turn an invalid internal response into a handoff.
 */
export async function isTerminalizedCompleteResponse(
  response: Response,
  bodyLimit = QUEUE_DRAIN_TERMINAL_BODY_LIMIT,
  options: QueueDrainBodyReadOptions = {},
): Promise<boolean> {
  if (response.status !== 409) return false;
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    if (!/^\d+$/.test(contentLengthHeader)) return false;
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength > bodyLimit) {
      return false;
    }
  }
  if (!response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs as number))
    : QUEUE_DRAIN_TERMINAL_BODY_TIMEOUT_MS;
  type Interrupt = { kind: "timeout" } | { kind: "aborted" };
  let interrupt!: (value: Interrupt) => void;
  let interrupted = false;
  const interruption = new Promise<Interrupt>((resolve) => {
    interrupt = (value) => {
      if (interrupted) return;
      interrupted = true;
      resolve(value);
    };
  });
  const onAbort = () => interrupt({ kind: "aborted" });
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => interrupt({ kind: "timeout" }), timeoutMs);
  const cancel = (reason: unknown) => {
    void reader.cancel(reason).catch(() => undefined);
  };
  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (part) => ({ kind: "read" as const, part }),
          () => ({ kind: "read-error" as const }),
        ),
        interruption,
      ]);
      if (outcome.kind === "timeout" || outcome.kind === "aborted") {
        cancel(
          options.signal?.reason ??
            new DOMException("terminal response timeout", "TimeoutError"),
        );
        return false;
      }
      if (outcome.kind === "read-error") {
        cancel(new DOMException("terminal response read failed", "AbortError"));
        return false;
      }
      const part = outcome.part;
      if (part.done) break;
      total += part.value.byteLength;
      if (total > bodyLimit) {
        cancel(
          new DOMException("terminal response too large", "QuotaExceededError"),
        );
        return false;
      }
      chunks.push(part.value);
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
      .decode(bytes);
    return isQueueDrainTerminalContract(JSON.parse(text));
  } catch {
    return false;
  }
}
