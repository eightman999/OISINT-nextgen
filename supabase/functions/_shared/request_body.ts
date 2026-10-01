export interface LimitedRequestBody {
  text: string;
  tooLarge: boolean;
  readError: boolean;
  timedOut: boolean;
}

export interface LimitedRequestBytes {
  bytes: Uint8Array;
  tooLarge: boolean;
  readError: boolean;
  timedOut: boolean;
}

export interface RequestBodyReadOptions {
  /** 呼び出し元の受付deadline / client disconnectをstreamへ伝播する。 */
  signal?: AbortSignal;
  /** 本文全体の受信deadline。未指定でも無期限待機にはしない。 */
  timeoutMs?: number;
}

export const REQUEST_BODY_TIMEOUT_MS = 5_000;

export interface LimitedResponseBody {
  bytes: Uint8Array;
  text: string;
  tooLarge: boolean;
  readError: boolean;
}

/**
 * 認証前の本文を上限付きで読む。content-lengthだけを信用せず、chunkごとの
 * byte数も検証して、巨大なTransfer-Encoding本文でEdgeを占有させない。
 */
export async function readRequestBodyLimited(
  req: Request,
  maxBytes: number,
  options: RequestBodyReadOptions = {},
): Promise<LimitedRequestBody> {
  const bounded = await readRequestBytesLimited(req, maxBytes, options);
  if (bounded.tooLarge || bounded.readError || bounded.timedOut) {
    return {
      text: "",
      tooLarge: bounded.tooLarge,
      readError: bounded.readError,
      timedOut: bounded.timedOut,
    };
  }
  let text: string;
  try {
    // JSON/authenticated control bodies must not accept replacement characters
    // for malformed bytes. Replacement decoding could turn an invalid body
    // into a different valid request before schema validation.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bounded.bytes,
    );
  } catch {
    return {
      text: "",
      tooLarge: false,
      readError: true,
      timedOut: false,
    };
  }
  return {
    text,
    tooLarge: false,
    readError: false,
    timedOut: false,
  };
}

/**
 * Request本文を受信bytesのまま保持する版。Webhook HMACはJSON化前のこの
 * bytes列を署名対象にし、UTF-8 decode/再encodeで内容が変わる余地をなくす。
 */
export async function readRequestBytesLimited(
  req: Request,
  maxBytes: number,
  options: RequestBodyReadOptions = {},
): Promise<LimitedRequestBytes> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return {
      bytes: new Uint8Array(),
      tooLarge: true,
      readError: false,
      timedOut: false,
    };
  }
  if (!req.body) {
    return {
      bytes: new Uint8Array(),
      tooLarge: false,
      readError: false,
      timedOut: false,
    };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs as number))
    : REQUEST_BODY_TIMEOUT_MS;
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
    // underlying sourceのcancel処理そのものが停止しても、受付処理は待たない。
    void reader.cancel(reason).catch(() => undefined);
  };
  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (result) => ({ kind: "read" as const, result }),
          () => ({ kind: "read-error" as const }),
        ),
        interruption,
      ]);
      if (outcome.kind === "timeout") {
        cancel(new DOMException("request body timeout", "TimeoutError"));
        return {
          bytes: new Uint8Array(),
          tooLarge: false,
          readError: false,
          timedOut: true,
        };
      }
      if (outcome.kind === "aborted") {
        cancel(
          options.signal?.reason ??
            new DOMException("request aborted", "AbortError"),
        );
        return {
          bytes: new Uint8Array(),
          tooLarge: false,
          readError: true,
          timedOut: false,
        };
      }
      if (outcome.kind === "read-error") {
        cancel(new DOMException("request body read failed", "AbortError"));
        return {
          bytes: new Uint8Array(),
          tooLarge: false,
          readError: true,
          timedOut: false,
        };
      }
      const { done, value } = outcome.result;
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        cancel(
          new DOMException("request body too large", "QuotaExceededError"),
        );
        return {
          bytes: new Uint8Array(),
          tooLarge: true,
          readError: false,
          timedOut: false,
        };
      }
      chunks.push(value);
    }
  } catch {
    cancel(new DOMException("request body read failed", "AbortError"));
    return {
      bytes: new Uint8Array(),
      tooLarge: false,
      readError: true,
      timedOut: false,
    };
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
  return {
    bytes,
    tooLarge: false,
    readError: false,
    timedOut: false,
  };
}

/**
 * 外部providerの応答もcontent-lengthだけを信用せず、streamを上限付きで
 * 消費する。`Response.text()`を先に呼ぶと巨大bodyが上限判定前に確保されるため、
 * RevenueCatのsecretを扱うfetchでは必ずこちらを使う。
 */
export async function readResponseBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<LimitedResponseBody> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return {
      bytes: new Uint8Array(),
      text: "",
      tooLarge: true,
      readError: false,
    };
  }
  if (!response.body) {
    return {
      bytes: new Uint8Array(),
      text: "",
      tooLarge: false,
      readError: false,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return {
          bytes: new Uint8Array(),
          text: "",
          tooLarge: true,
          readError: false,
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      bytes: new Uint8Array(),
      text: "",
      tooLarge: false,
      readError: true,
    };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return {
      bytes: new Uint8Array(),
      text: "",
      tooLarge: false,
      readError: true,
    };
  }
  return {
    bytes,
    text,
    tooLarge: false,
    readError: false,
  };
}
