/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

function replayRequest(expiresAtMs: number): Request {
  return new Request("https://egress-replay-guard/consume", {
    method: "POST",
    headers: { "x-oisint-replay-expires-at": String(expiresAtMs) },
  });
}

describe("EgressReplayGuard workerd binding", () => {
  it("同時二重実行を1件へ収束し、eviction後も重複を拒否する", async () => {
    const stub = env.EGRESS_REPLAY_GUARD.getByName(
      `workerd-${crypto.randomUUID()}`,
    );
    const expiresAtMs = Date.now() + 20_000;

    const responses = await Promise.all([
      stub.fetch(replayRequest(expiresAtMs)),
      stub.fetch(replayRequest(expiresAtMs)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    // インメモリ状態を落としても、Durable Object storageのconsumedが残る。
    await evictDurableObject(stub);
    expect((await stub.fetch(replayRequest(expiresAtMs))).status).toBe(409);
  });

  it("alarmで期限後storageを消去し、同じobjectを再利用できる", async () => {
    const stub = env.EGRESS_REPLAY_GUARD.getByName(
      `workerd-alarm-${crypto.randomUUID()}`,
    );
    const expiresAtMs = Date.now() + 20_000;

    expect((await stub.fetch(replayRequest(expiresAtMs))).status).toBe(201);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.fetch(replayRequest(Date.now() + 20_000))).status).toBe(201);
  });

  it("期限の過去・上限超過はstorageへ触れず拒否する", async () => {
    for (const expiresAtMs of [Date.now() - 1, Date.now() + 120_000]) {
      const stub = env.EGRESS_REPLAY_GUARD.getByName(
        `workerd-invalid-${crypto.randomUUID()}`,
      );
      expect((await stub.fetch(replayRequest(expiresAtMs))).status).toBe(400);
    }
  });
});
