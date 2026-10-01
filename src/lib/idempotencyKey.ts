let fallbackIdempotencyKeyCounter = 0;

/**
 * Create one client key per logical create operation.
 * WebCrypto methods must be called with crypto as their receiver; detaching
 * randomUUID causes a brand-check failure in browsers and some WebViews.
 */
export function createClientIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `oisint-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  fallbackIdempotencyKeyCounter += 1;
  return `oisint-${Date.now().toString(36)}-${fallbackIdempotencyKeyCounter.toString(36)}`;
}
