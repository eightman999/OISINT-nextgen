import { DurableObject } from "cloudflare:workers";

const MAX_REPLAY_RETENTION_MS = 60_000;

/**
 * One object is addressed by one cryptographically-random egress nonce.
 * Persistent storage makes the single-use decision survive isolate eviction;
 * the alarm removes the short-lived object after the signature window closes.
 */
export class EgressReplayGuard extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/consume") {
      return new Response(null, { status: 404 });
    }

    const expiresAtMs = Number(request.headers.get("x-oisint-replay-expires-at") ?? "");
    const nowMs = Date.now();
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= nowMs ||
      expiresAtMs > nowMs + MAX_REPLAY_RETENTION_MS
    ) {
      return new Response(null, { status: 400 });
    }

    const accepted = await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get<boolean>("consumed")) return false;
      await transaction.put("consumed", true);
      if (await transaction.getAlarm() === null) {
        await transaction.setAlarm(expiresAtMs);
      }
      return true;
    });

    return new Response(null, { status: accepted ? 201 : 409 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
