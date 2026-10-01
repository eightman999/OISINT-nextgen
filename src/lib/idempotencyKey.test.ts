import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientIdempotencyKey } from "./idempotencyKey";

describe("createClientIdempotencyKey", () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    vi.stubGlobal("crypto", originalCrypto);
    vi.restoreAllMocks();
  });

  it("randomUUID は crypto receiver 付きで呼び出す", () => {
    const randomUUID = vi.fn(function (this: Crypto) {
      if (this !== globalThis.crypto) throw new TypeError("illegal invocation");
      return "00000000-0000-4000-8000-000000000001";
    });
    vi.stubGlobal("crypto", { randomUUID });

    expect(createClientIdempotencyKey()).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("randomUUID がない環境では getRandomValues を使う", () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(createClientIdempotencyKey()).toBe(`oisint-${"ab".repeat(16)}`);
  });

  it("WebCrypto がない環境では一意な時刻/カウンタへfallbackする", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1234);

    const first = createClientIdempotencyKey();
    const second = createClientIdempotencyKey();
    expect(first).toMatch(/^oisint-[a-z0-9]+-\d+$/);
    expect(second).toMatch(/^oisint-[a-z0-9]+-\d+$/);
    expect(first).not.toBe(second);
  });
});
