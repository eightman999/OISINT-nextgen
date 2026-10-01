import { describe, expect, it, vi } from "vitest";
import {
  dispatchInvestigationQueue,
  dispatchInvestigationQueueOrThrow,
  isValidSupabaseAnonKey,
  isValidQueueDrainKey,
} from "./worker";
import worker from "./worker";

describe("durable investigation queue consumer", () => {
  const TEST_DRAIN_KEY = "test-only-drain-secret-0123456789ab";
  const TEST_ANON_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6InByb2plY3QtcmVmIn0.test-signature";
  const jwtWithPayload = (payload: Record<string, string>): string => {
    const encodedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${TEST_ANON_JWT.split(".")[0]}.${encodedPayload}.test-signature`;
  };

  it("設定不足では fail-closed し、Edge Function を呼ばない", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await dispatchInvestigationQueue({
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      RUN_QUEUE_DRAIN_KEY: "",
    }, fetchImpl);

    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      schema: "oisint.api.queue.v1",
      stage: "queue_drain",
      code: "config_unavailable",
    });
    log.mockRestore();
  });

  it("新しい service invocation へ秘密付き drain request を送る", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "drained" }), { status: 202 }),
    );

    const result = await dispatchInvestigationQueue({
      SUPABASE_URL: "https://project-ref.supabase.co/",
      SUPABASE_ANON_KEY: TEST_ANON_JWT,
      RUN_QUEUE_DRAIN_KEY: TEST_DRAIN_KEY,
    }, fetchImpl);

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://project-ref.supabase.co/functions/v1/run-investigation");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBe("{}");
    expect(new Headers(init?.headers).get("x-queue-drain-key")).toBe(
      TEST_DRAIN_KEY,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${TEST_ANON_JWT}`,
    );
  });

  it("Edge の拒否・停止を成功扱いにしない", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("", { status: 503 }),
    );

    const result = await dispatchInvestigationQueue({
      SUPABASE_URL: "https://project-ref.supabase.co/",
      SUPABASE_ANON_KEY: TEST_ANON_JWT,
      RUN_QUEUE_DRAIN_KEY: TEST_DRAIN_KEY,
    }, fetchImpl);

    expect(result).toBe(false);
    await expect(
      dispatchInvestigationQueueOrThrow({
        SUPABASE_URL: "https://project-ref.supabase.co/",
        SUPABASE_ANON_KEY: TEST_ANON_JWT,
        RUN_QUEUE_DRAIN_KEY: TEST_DRAIN_KEY,
      }, fetchImpl),
    ).rejects.toThrow("queue drain dispatch failed");
  });

  it("CronのwaitUntilにも失敗を伝播し、設定不足をgreenにしない", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      dispatchInvestigationQueueOrThrow({
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        RUN_QUEUE_DRAIN_KEY: "",
      }, fetchImpl),
    ).rejects.toThrow("queue drain dispatch failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("scheduledは失敗するwaitUntil promiseを登録する", async () => {
    const promises: Promise<unknown>[] = [];
    worker.scheduled(
      {} as ScheduledController,
      { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" } as never,
      { waitUntil: (promise: Promise<unknown>) => promises.push(promise) } as never,
    );
    expect(promises).toHaveLength(1);
    await expect(promises[0]).rejects.toThrow("queue drain dispatch failed");
  });

  it("設定URLの任意path/queryへ秘密を送らず、固定Edge pathへ導出する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("", { status: 202 }),
    );

    await dispatchInvestigationQueue({
      SUPABASE_URL: "https://project-ref.supabase.co/untrusted?redirect=https://evil.test",
      SUPABASE_ANON_KEY: TEST_ANON_JWT,
      RUN_QUEUE_DRAIN_KEY: TEST_DRAIN_KEY,
    }, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drain secret は双方 runtime で32文字以上の印字可能値だけを受理する", () => {
    expect(isValidQueueDrainKey(TEST_DRAIN_KEY)).toBe(true);
    expect(isValidQueueDrainKey("short-secret")).toBe(false);
    expect(isValidQueueDrainKey("x".repeat(32) + "\n")).toBe(false);
    expect(isValidSupabaseAnonKey(TEST_ANON_JWT)).toBe(true);
    expect(isValidSupabaseAnonKey(TEST_ANON_JWT, "https://project-ref.supabase.co")).toBe(true);
    expect(isValidSupabaseAnonKey(
      jwtWithPayload({ role: ["service", "role"].join("_"), ref: "project-ref" }),
    )).toBe(false);
    expect(isValidSupabaseAnonKey(
      TEST_ANON_JWT,
      "https://other-project.supabase.co",
    )).toBe(false);
    expect(isValidSupabaseAnonKey(
      jwtWithPayload({ ref: "project-ref" }),
      "https://project-ref.supabase.co",
    )).toBe(false);
    expect(isValidSupabaseAnonKey("test-anon-jwt")).toBe(false);
    expect(isValidSupabaseAnonKey("x".repeat(5000))).toBe(false);
  });

  it("異常なSupabase URL・巨大anon JWT・redirect/timeoutをfail-closedする", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await dispatchInvestigationQueue({
      SUPABASE_URL: "https://user:pass@project-ref.supabase.co/",
      SUPABASE_ANON_KEY: TEST_ANON_JWT,
      RUN_QUEUE_DRAIN_KEY: TEST_DRAIN_KEY,
    }, fetchImpl)).toBe(false);
    expect(await dispatchInvestigationQueue({
      SUPABASE_URL: "https://project-ref.supabase.co:444/",
      SUPABASE_ANON_KEY: TEST_ANON_JWT,
      RUN_QUEUE_DRAIN_KEY: TEST_DRAIN_KEY,
    }, fetchImpl)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
