import { afterEach, describe, expect, it, vi } from "vitest";

import { EgressReplayGuard } from "./replay_guard";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  async transaction<T>(
    closure: (transaction: DurableObjectTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = {
      get: async <V>(key: string) => this.values.get(key) as V | undefined,
      put: async <V>(key: string, value: V) => {
        this.values.set(key, value);
      },
      getAlarm: async () => this.alarm,
      setAlarm: async (scheduledTime: number | Date) => {
        this.alarm = Number(scheduledTime);
      },
    } as unknown as DurableObjectTransaction;
    return closure(transaction);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarm = null;
  }
}

function createGuard(storage: MemoryStorage): EgressReplayGuard {
  return new EgressReplayGuard(
    { storage } as unknown as DurableObjectState,
    {} as never,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EgressReplayGuard", () => {
  it("同じnonce objectは一度だけ受理し期限後にstorageを消す", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    const storage = new MemoryStorage();
    const guard = createGuard(storage);
    const expiresAtMs = Date.now() + 20_000;
    const request = () =>
      new Request("https://egress-replay-guard/consume", {
        method: "POST",
        headers: { "x-oisint-replay-expires-at": String(expiresAtMs) },
      });

    expect((await guard.fetch(request())).status).toBe(201);
    expect((await guard.fetch(request())).status).toBe(409);
    expect(storage.alarm).toBe(expiresAtMs);

    await guard.alarm();
    expect(storage.values.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });

  it("期限が過去または60秒超ならstorageへ触れず拒否する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    const storage = new MemoryStorage();
    const guard = createGuard(storage);

    for (const expiresAtMs of [Date.now() - 1, Date.now() + 60_001]) {
      const response = await guard.fetch(
        new Request("https://egress-replay-guard/consume", {
          method: "POST",
          headers: { "x-oisint-replay-expires-at": String(expiresAtMs) },
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(storage.values.size).toBe(0);
  });
});
