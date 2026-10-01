/**
 * Provider/Edge budgets for synchronous endpoints (#592).
 *
 * spec.md §25.1 requires the complete create function to return within ten
 * seconds and permits one structured-AI interaction. Keep every sub-budget
 * inside that hard ceiling; proxy and client budgets must be strictly larger.
 */
// 実Gemini応答が7秒境界を数ms越えると、解析自体は成功していても
// 同期createが422へ倒れるため、10秒の総枠内で500msをproviderへ再配分する。
export const CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS = 7_500;
// spec.md §25.1: create の requirement parse は1 provider callだけ。
// GoogleAIClient内部を含め、この外側で再試行を重ねない。
export const CREATE_PROVIDER_MAX_ATTEMPTS = 1;
export const CREATE_EMBEDDING_TIMEOUT_MS = 1_500;
export const CREATE_DATABASE_MARGIN_MS = 1_000;

export const CANDIDATE_PROVIDER_ATTEMPT_TIMEOUT_MS = 60_000;
export const CANDIDATE_PROVIDER_MAX_ATTEMPTS = 2;
export const RERANK_DATABASE_MARGIN_MS = 30_000;
export const RERANK_EDGE_TRANSPORT_MARGIN_MS = 5_000;

export const EDGE_TIMEOUT_POLICY = {
  receipt: 5_000,
  synchronousCreate:
    CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS * CREATE_PROVIDER_MAX_ATTEMPTS +
    CREATE_EMBEDDING_TIMEOUT_MS + CREATE_DATABASE_MARGIN_MS,
  synchronousRerank: CANDIDATE_PROVIDER_ATTEMPT_TIMEOUT_MS *
      CANDIDATE_PROVIDER_MAX_ATTEMPTS +
    RERANK_DATABASE_MARGIN_MS + RERANK_EDGE_TRANSPORT_MARGIN_MS,
} as const;

export class OperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`operation timeout after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/** Bound one provider attempt and abort its transport before retrying. */
export function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        parentSignal?.reason ??
          new DOMException("operation aborted", "AbortError"),
      );
    }
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new OperationTimeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    }
  });
  return Promise.race([
    Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return operation(controller.signal);
    }),
    timeout,
    aborted,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  });
}
