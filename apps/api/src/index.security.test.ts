import { afterEach, describe, expect, it, vi } from "vitest";

import app, {
  buildTrustedSupabaseEndpoint,
  EDGE_TIMEOUT_CONTRACT,
  EGRESS_REQUEST_BODY_TIMEOUT_MS,
  PUBLIC_REQUEST_BODY_TIMEOUT_MS,
  UPSTREAM_TIMEOUT_POLICY,
  readEgressJson,
} from "./index";
import {
  createEgressSignature,
  EGRESS_MAX_BYTES,
  handleEgressHop,
} from "./egress";
import { isPublicIpAddress } from "./ip";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
const TEST_RATE_LIMIT_SECRET = [
  "rate-limit",
  "test-fixture",
  "000000000000",
].join("-");
const TEST_EGRESS_GATEWAY_SECRET = [
  "egress-gateway",
  "test-fixture",
  "00000000",
].join("-");
const CREATE_IDEMPOTENCY_KEY = "security-create-test-key";
const replayedNonces = new Set<string>();

const replayGuard = {
  getByName(nonce: string) {
    return {
      fetch: async () => {
        if (replayedNonces.has(nonce)) return new Response(null, { status: 409 });
        replayedNonces.add(nonce);
        return new Response(null, { status: 201 });
      },
    };
  },
} as unknown as DurableObjectNamespace;

const env = {
  SUPABASE_URL: "https://project-ref.supabase.co",
  SUPABASE_ANON_KEY: "public-anon-key",
  CORS_ORIGIN: "https://oisint.com,http://localhost:8081",
  RATE_LIMIT_SECRET: TEST_RATE_LIMIT_SECRET,
  EGRESS_GATEWAY_SECRET: TEST_EGRESS_GATEWAY_SECRET,
  EGRESS_REPLAY_GUARD: replayGuard,
};

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function egressNetworkFetch(
  targetFetch: FetchHandler,
  dns: { A?: string[]; AAAA?: string[] } = { A: [PUBLIC_V4], AAAA: [PUBLIC_V6] },
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
      const type = url.searchParams.get("type") as "A" | "AAAA";
      const recordType = type === "A" ? 1 : 28;
      const answers = (dns[type] ?? []).map((address) => ({
        name: "public.example.",
        type: recordType,
        TTL: 60,
        data: address,
      }));
      return new Response(JSON.stringify({ Status: 0, TC: false, Answer: answers }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    return targetFetch(input, init);
  });
}

// 新しい nonce で署名した egress request を送る (#193 の負例テスト用)
async function signedEgressRequest(
  target: string,
  addresses: string[] = [PUBLIC_V4],
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const signature = await createEgressSignature(
    env.EGRESS_GATEWAY_SECRET,
    timestamp,
    nonce,
    target,
    addresses,
  );
  return app.request(
    "/v1/internal/egress-fetch",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oisint-egress-timestamp": timestamp,
        "x-oisint-egress-signature": signature,
      },
      body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
    },
    env,
  );
}

afterEach(() => {
  replayedNonces.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("API Worker gateway", () => {
  it.each(["nonce", "dns", "upstream"] as const)("egress %s失敗のログにURL・DNS・署名・生例外を残さない", async (failure) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = "https://private-query.public.example/menu?query=fixture-sensitive-value";
    const addresses = [PUBLIC_V4];
    const nonce = crypto.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await createEgressSignature(env.EGRESS_GATEWAY_SECRET, timestamp, nonce, target, addresses);
    const privateError = new Error(`${target} ${PUBLIC_V4} ${signature} ${env.EGRESS_GATEWAY_SECRET}`);
    const targetFetch = vi.fn(async (): Promise<Response> => { throw privateError; });
    vi.stubGlobal("fetch", egressNetworkFetch(targetFetch, failure === "dns" ? { A: ["127.0.0.1"] } : undefined));
    try {
      const response = await handleEgressHop(
        env.EGRESS_GATEWAY_SECRET,
        { url: target, nonce, validatedAddresses: addresses },
        { timestamp, signature },
        {
          consumeNonce: async () => {
            if (failure === "nonce") throw privateError;
            return true;
          },
          fetchImpl: targetFetch,
        },
      );
      expect(response.status).toBe(failure === "dns" ? 403 : 502);
      expect(await response.json()).toEqual({ error: "egress request rejected" });
      expect(logged.mock.calls).toEqual([[
        failure === "nonce" ? "[egress] replay_guard_failed" : failure === "dns" ? "[egress] dns_rejected" : "[egress] upstream_failed",
      ]]);
      expect(targetFetch).toHaveBeenCalledTimes(failure === "upstream" ? 1 : 0);
    } finally {
      logged.mockRestore();
    }
  });

  it("Supabase endpointは固定host/originだけを受理し、redirect用pathやuserinfoを拒否する", () => {
    expect(buildTrustedSupabaseEndpoint(
      "https://project-ref.supabase.co/",
      "/functions/v1/create-investigation",
    )).toBe("https://project-ref.supabase.co/functions/v1/create-investigation");
    for (const rejected of [
      "https://project-ref.supabase.co/redirect?to=https://evil.example",
      "https://user:pass@project-ref.supabase.co",
      "http://project-ref.supabase.co",
      "https://evil.example",
      "https://project-ref.supabase.co:8443",
    ]) {
      expect(buildTrustedSupabaseEndpoint(rejected, "/functions/v1/run-investigation"))
        .toBeNull();
    }
    expect(buildTrustedSupabaseEndpoint(
      "http://127.0.0.1:54321",
      "/functions/v1/run-investigation",
    )).toBeNull();
    expect(buildTrustedSupabaseEndpoint(
      "http://127.0.0.1:54321",
      "/functions/v1/run-investigation",
      true,
    )).toBe("http://127.0.0.1:54321/functions/v1/run-investigation");
    expect(buildTrustedSupabaseEndpoint(
      "http://10.0.0.1:54321",
      "/functions/v1/run-investigation",
      true,
    )).toBeNull();
  });

  it("通常proxyはredirect:manualとAbortSignalを付け、untrusted originでは送信しない", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "safe", displayName: "Safe" }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);

    const rejected = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "safe", displayName: "Safe" }),
      },
      { ...env, SUPABASE_URL: "https://project-ref.supabase.co/redirect" },
    );
    expect(rejected.status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("上流redirectを追跡せず安全な502へ収束する", async () => {
    const cancel = vi.fn(async () => undefined);
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const response = new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/collect" },
      });
      Object.defineProperty(response, "body", {
        value: { cancel },
        configurable: true,
      });
      return response;
    });
    vi.stubGlobal("fetch", upstream);

    const response = await app.request(
      "/v1/investigations/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareToken: "token", displayName: "参加者" }),
      },
      env,
    );

    expect(response.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("researchの受付fetchは短いreceipt timeoutで安全な502へ収束する", async () => {
    vi.useFakeTimers();
    const upstream = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
      }));
    vi.stubGlobal("fetch", upstream);
    const responsePromise = app.request(
      "/v1/investigations/123e4567-e89b-42d3-a456-426614174000/research",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_POLICY.receipt);
    const response = await responsePromise;
    expect(response.status).toBe(502);
  });

  it("同期createは5秒を超えてもWorkerのcreate budget内なら完了を待つ", async () => {
    vi.useFakeTimers();
    const upstream = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    investigationId: "123e4567-e89b-42d3-a456-426614174000",
                    shareToken: "0123456789abcdef0123456789abcdef",
                  }),
                  {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  },
                ),
              ),
            6_000,
          );
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const responsePromise = app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "safe", displayName: "Safe" }),
      },
      env,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("upstreamはheader受信後もbody読了までcreate timeoutを保持する", async () => {
    vi.useFakeTimers();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        markStarted?.();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("aborted")),
            );
          },
        }), { headers: { "content-type": "application/json" } });
      }),
    );
    const pending = app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "safe", displayName: "Safe" }),
      },
      env,
    );
    await started;
    await vi.advanceTimersByTimeAsync(
      UPSTREAM_TIMEOUT_POLICY.synchronousCreate,
    );
    expect((await pending).status).toBe(502);
  });

  it("public request bodyの途中停止をpreflight timeoutで408にする", async () => {
    vi.useFakeTimers();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const request = new Request("https://api.example/v1/investigations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"query":"slow'));
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = app.fetch(request, env as CloudflareEnv);
    await vi.advanceTimersByTimeAsync(PUBLIC_REQUEST_BODY_TIMEOUT_MS);
    expect((await pending).status).toBe(408);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("egress署名付きrequest bodyの途中停止をdeadline内408へ収束しorigin/Replay Guardへ進めない", async () => {
    vi.useFakeTimers();
    const metric = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = "https://public.example/slow-request";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    let cancelled = false;
    const upstream = vi.fn();
    const replayGetByName = vi.fn();
    const request = new Request(
      "https://api.example/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"url":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    vi.stubGlobal("fetch", upstream);
    const pending = app.fetch(
      request,
      {
        ...env,
        EGRESS_REPLAY_GUARD: {
          getByName: replayGetByName,
        } as unknown as DurableObjectNamespace,
      } as CloudflareEnv,
    );

    await vi.advanceTimersByTimeAsync(EGRESS_REQUEST_BODY_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toEqual({ error: "egress request rejected" });
    expect(cancelled).toBe(true);
    expect(metric).toHaveBeenCalledWith(expect.stringContaining('"kind":"timeout"'));
    expect(upstream).not.toHaveBeenCalled();
    expect(replayGetByName).not.toHaveBeenCalled();
  });

  it("egress本文はtoo-large/invalid encoding/malformed JSONを内部分類し外部本文をgenericにする", async () => {
    const tooLarge = await readEgressJson(
      new Request("https://api.example/v1/internal/egress-fetch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "4097",
        },
        body: "{}",
      }),
    );
    expect(tooLarge).toEqual({ ok: false, kind: "too_large" });

    const invalidEncoding = await readEgressJson(
      new Request("https://api.example/v1/internal/egress-fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0xc3, 0x28]),
      }),
    );
    expect(invalidEncoding).toEqual({ ok: false, kind: "invalid_encoding" });

    const malformed = await readEgressJson(
      new Request("https://api.example/v1/internal/egress-fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"url":',
      }),
    );
    expect(malformed).toEqual({ ok: false, kind: "malformed_json" });

    const metric = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      "https://public.example/menu",
      [PUBLIC_V4],
    );
    const response = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: "not-json",
      },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "egress request rejected" });
    expect(metric).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"egress_request_body_rejected"'),
    );
    expect(metric).toHaveBeenCalledWith(expect.stringContaining('"kind":"malformed_json"'));
    metric.mockRestore();
  });

  it("egress本文のcontent-length超過も共通readerがbodyをcancelする", async () => {
    let cancelled = false;
    const request = new Request("https://api.example/v1/internal/egress-fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "4097",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readEgressJson(request)).resolves.toEqual({
      ok: false,
      kind: "too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("requirement_added rerankは5秒を超えても長い同期budgetで完了を待つ", async () => {
    vi.useFakeTimers();
    const upstream = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ reranked: true }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            20_000,
          );
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const responsePromise = app.request(
      "/v1/investigations/123e4567-e89b-42d3-a456-426614174000/rerank",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "requirement_added" }),
      },
      env,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await responsePromise).status).toBe(200);
  });

  it("timeout順序はEdge hard deadlineよりWorker upstreamを長く保つ", () => {
    for (const policy of [
      "receipt",
      "synchronousCreate",
      "synchronousRerank",
    ] as const) {
      expect(EDGE_TIMEOUT_CONTRACT[policy]).toBeLessThan(
        UPSTREAM_TIMEOUT_POLICY[policy],
      );
    }
    expect(UPSTREAM_TIMEOUT_POLICY.synchronousCreate).toBeGreaterThan(
      UPSTREAM_TIMEOUT_POLICY.receipt,
    );
    expect(UPSTREAM_TIMEOUT_POLICY.synchronousRerank).toBeGreaterThan(
      UPSTREAM_TIMEOUT_POLICY.receipt,
    );
  });

  it("gateway側のpublic IP分類もprivate/mapped/NAT64を拒否する", () => {
    for (const rejected of [
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::1",
    ]) {
      expect(isPublicIpAddress(rejected), rejected).toBe(false);
    }
    expect(isPublicIpAddress(PUBLIC_V4)).toBe(true);
    expect(isPublicIpAddress(PUBLIC_V6)).toBe(true);
  });

  it("healthへrequest-idと許可originのCORSを付与する", async () => {
    const response = await app.request(
      "/v1/health",
      { headers: { Origin: "https://oisint.com" } },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://oisint.com");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("未許可originへCORS許可headerを返さない", async () => {
    const response = await app.request(
      "/v1/health",
      { headers: { Origin: "https://attacker.example" } },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("許可originのpreflightだけを応答する", async () => {
    const allowed = await app.request(
      "/v1/investigations",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://oisint.com",
          "Access-Control-Request-Method": "POST",
        },
      },
      env,
    );
    const denied = await app.request(
      "/v1/investigations",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
        },
      },
      env,
    );

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://oisint.com");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("不正入力はupstreamへ送らず400にする", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "", displayName: "" }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("ユーザー認証とapikeyをEdge Functionへそのまま転送する", async () => {
    const upstream = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ investigationId: "inv-1" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
          Authorization: "Bearer user-jwt",
          apikey: "client-anon-key",
        },
        body: JSON.stringify({ query: "池袋で静かな店", displayName: "幹事" }),
      },
      env,
    );

    expect(response.status).toBe(202);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://project-ref.supabase.co/functions/v1/create-investigation");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer user-jwt",
      apikey: "client-anon-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "池袋で静かな店",
      displayName: "幹事",
    });
  });

  it("Cloudflare確定IPを平文で転送せず署名済みkeyにする", async () => {
    const upstream = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ investigationId: "inv-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", upstream);

    await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({ query: "池袋で静かな店", displayName: "幹事" }),
      },
      env,
    );

    const [, init] = upstream.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-OISINT-Client-Key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["X-OISINT-Proxy-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(headers)).not.toContain("203.0.113.10");
  });

  it("上流429のRetry-Afterをクライアントへ保つ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "しばらく待ってください" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "120" },
      })
    ));

    const response = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "池袋で静かな店", displayName: "幹事" }),
      },
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
  });

  it("上流の非2xx JSONをstatusと本文を保って返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "provider unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      ),
    );

    const response = await app.request(
      "/v1/investigations/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareToken: "token", displayName: "参加者" }),
      },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "provider unavailable" });
  });

  it("RPC失敗は元statusを保ちつつ内部messageを秘匿する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "not an investigation owner" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      ),
    );

    const response = await app.request(
      "/v1/investigations/11111111-1111-4111-8111-111111111111/visibility",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      },
      env,
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({
      error: "この操作を行う権限がありません",
    });
    expect(JSON.stringify(body)).not.toContain("not an investigation owner");
  });

  it("存在しないrouteを404にする", async () => {
    const response = await app.request("/v1/unknown", {}, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("署名済みegressだけをmanual fetchし内部secretをoriginへ渡さない", async () => {
    const target = "https://public.example/menu";
    const addresses = [PUBLIC_V4, PUBLIC_V6];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    const upstream = egressNetworkFetch(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("<html>menu</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<html>menu</html>");
    const targetCall = upstream.mock.calls.find(([input]) => String(input) === target);
    expect(targetCall).toBeDefined();
    const [url, init] = targetCall!;
    expect(url).toBe(target);
    expect(init?.redirect).toBe("manual");
    expect(JSON.stringify(init?.headers)).not.toContain(env.EGRESS_GATEWAY_SECRET);

    const callsBeforeReplay = upstream.mock.calls.length;
    const replay = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
      },
      env,
    );
    expect(replay.status).toBe(403);
    expect(upstream.mock.calls).toHaveLength(callsBeforeReplay);
  });

  it("egressの欠落・期限切れ署名とIP/userinfo/custom portを拒否する", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const addresses = ["93.184.216.34"];
    const expired = String(Math.floor(Date.now() / 1000) - 16);
    const expiredNonce = crypto.randomUUID();
    const expiredSignature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      expired,
      expiredNonce,
      "https://public.example/menu",
      addresses,
    );

    const unsigned = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://public.example/menu",
          nonce: crypto.randomUUID(),
          validatedAddresses: addresses,
        }),
      },
      env,
    );
    const expiredResponse = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": expired,
          "x-oisint-egress-signature": expiredSignature,
        },
        body: JSON.stringify({
          url: "https://public.example/menu",
          nonce: expiredNonce,
          validatedAddresses: addresses,
        }),
      },
      env,
    );
    expect(unsigned.status).toBe(403);
    expect(expiredResponse.status).toBe(403);

    for (const target of [
      "http://127.0.0.1/latest",
      "http://public.example/menu",
      "https://user:pass@public.example/menu",
      "https://public.example:8443/menu",
      "https://oisint.com/",
      "https://api.oisint.com/v1/health",
    ]) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID();
      const signature = await createEgressSignature(
        env.EGRESS_GATEWAY_SECRET,
        timestamp,
        nonce,
        target,
        addresses,
      );
      const response = await app.request(
        "/v1/internal/egress-fetch",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-oisint-egress-timestamp": timestamp,
            "x-oisint-egress-signature": signature,
          },
          body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
        },
        env,
      );
      expect(response.status).toBe(400);
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const target = "https://public.example/menu";
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    const oversized = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: JSON.stringify({
          url: target,
          nonce,
          validatedAddresses: addresses,
          padding: "x".repeat(5_000),
        }),
      },
      env,
    );
    expect(oversized.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("Replay Guard binding欠落時はoriginへ進まずfail-closedにする", async () => {
    const target = "https://public.example/menu";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
      },
      {
        ...env,
        EGRESS_REPLAY_GUARD: undefined as unknown as DurableObjectNamespace,
      },
    );

    expect(response.status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("egressはredirect Locationを保ち本文を500KBで打ち切る", async () => {
    const addresses = [PUBLIC_V4];
    const request = async (target: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID();
      const signature = await createEgressSignature(
        env.EGRESS_GATEWAY_SECRET,
        timestamp,
        nonce,
        target,
        addresses,
      );
      return app.request(
        "/v1/internal/egress-fetch",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-oisint-egress-timestamp": timestamp,
            "x-oisint-egress-signature": signature,
          },
          body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
        },
        env,
      );
    };

    // same-origin の相対 Location は canonical な絶対 URL へ正規化して返す
    vi.stubGlobal("fetch", egressNetworkFetch(async () =>
      new Response(null, { status: 302, headers: { location: "/next" } })
    ));
    const redirect = await request("https://public.example/start");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://public.example/next");

    vi.stubGlobal("fetch", egressNetworkFetch(async () =>
      new Response(new Uint8Array(EGRESS_MAX_BYTES + 100), {
        headers: { "content-type": "text/plain" },
      })
    ));
    const large = await request("https://public.example/large");
    expect((await large.arrayBuffer()).byteLength).toBe(EGRESS_MAX_BYTES);
    expect(large.headers.get("x-oisint-truncated")).toBe("1");
  });

  it("content-lengthなしのchunked巨大DoH応答は上限超過時にcancelして拒否する", async () => {
    const target = "https://public.example/large-dns-response";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    let offeredBytes = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1_024);
    const dohBody = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        offeredBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const targetFetch = vi.fn(async () => new Response("must not run"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get("type");
      if (type === "A") {
        return new Response(dohBody(), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        });
      }
      return new Response(JSON.stringify({ Status: 0, TC: false, Answer: [] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      });
    }));
    const response = await handleEgressHop(
      env.EGRESS_GATEWAY_SECRET,
      { url: target, nonce, validatedAddresses: addresses },
      { timestamp, signature },
      {
        nowMs: Number(timestamp) * 1000,
        consumeNonce: async () => true,
        fetchImpl: targetFetch,
      },
    );
    expect(response.status).toBe(403);
    expect(cancelled).toBe(true);
    expect(offeredBytes).toBeGreaterThan(65_536);
    expect(offeredBytes).toBeLessThanOrEqual(65_536 + chunk.byteLength * 2);
    expect(targetFetch).not.toHaveBeenCalled();
  });

  it("DoHのcontent-length超過は本文readerをcancelして拒否する", async () => {
    const target = "https://public.example/declared-large-dns-response";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    let cancelled = false;
    const targetFetch = vi.fn(async () => new Response("must not run"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get("type");
      if (type === "A") {
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/dns-json",
            "content-length": "65537",
          },
        });
      }
      return new Response(JSON.stringify({ Status: 0, TC: false, Answer: [] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      });
    }));
    const response = await handleEgressHop(
      env.EGRESS_GATEWAY_SECRET,
      { url: target, nonce, validatedAddresses: addresses },
      { timestamp, signature },
      {
        nowMs: Number(timestamp) * 1000,
        consumeNonce: async () => true,
        fetchImpl: targetFetch,
      },
    );
    expect(response.status).toBe(403);
    expect(cancelled).toBe(true);
    expect(targetFetch).not.toHaveBeenCalled();
  });

  it("DoH本文がちょうど65,536 bytesならJSON検証へ進める", async () => {
    const target = "https://public.example/exact-dns-response";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    const exactDohJson = (type: number, data: string): string => {
      const base = { Status: 0, TC: false, Answer: [{ type, data }], padding: "" };
      const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
      const body = JSON.stringify({ ...base, padding: "x".repeat(65_536 - baseBytes) });
      expect(new TextEncoder().encode(body).byteLength).toBe(65_536);
      return body;
    };
    const targetFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get("type");
      return new Response(
        exactDohJson(type === "A" ? 1 : 28, type === "A" ? PUBLIC_V4 : PUBLIC_V6),
        { status: 200, headers: { "content-type": "application/dns-json" } },
      );
    }));
    const response = await handleEgressHop(
      env.EGRESS_GATEWAY_SECRET,
      { url: target, nonce, validatedAddresses: addresses },
      { timestamp, signature },
      {
        nowMs: Number(timestamp) * 1000,
        consumeNonce: async () => true,
        fetchImpl: targetFetch,
      },
    );
    expect(response.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(1);
  });

  it("DoH本文は上限内でもfatal UTF-8またはJSON検証に失敗すれば拒否する", async () => {
    for (const invalidBody of [
      new Uint8Array([0xc3, 0x28]),
      '{"Status":',
    ]) {
      const target = "https://public.example/invalid-dns-response";
      const addresses = [PUBLIC_V4];
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID();
      const signature = await createEgressSignature(
        env.EGRESS_GATEWAY_SECRET,
        timestamp,
        nonce,
        target,
        addresses,
      );
      const targetFetch = vi.fn(async () => new Response("must not run"));
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const type = new URL(String(input)).searchParams.get("type");
        if (type === "A") {
          return new Response(invalidBody, {
            status: 200,
            headers: { "content-type": "application/dns-json" },
          });
        }
        return new Response(JSON.stringify({ Status: 0, TC: false, Answer: [] }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        });
      }));
      const response = await handleEgressHop(
        env.EGRESS_GATEWAY_SECRET,
        { url: target, nonce, validatedAddresses: addresses },
        { timestamp, signature },
        {
          nowMs: Number(timestamp) * 1000,
          consumeNonce: async () => true,
          fetchImpl: targetFetch,
        },
      );
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ error: "egress request rejected" });
      expect(targetFetch).not.toHaveBeenCalled();
    }
  });

  it("DoH stalled bodyはabort時にcancelしてtargetへ進めない", async () => {
    vi.useFakeTimers();
    const target = "https://public.example/stalled-dns-response";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    let cancelled = false;
    let signalAborted = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const targetFetch = vi.fn(async () => new Response("must not run"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const type = new URL(String(input)).searchParams.get("type");
      if (type === "A") {
        init?.signal?.addEventListener("abort", () => {
          signalAborted = true;
        });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"Status":0'));
            markStarted?.();
          },
          cancel() {
            cancelled = true;
          },
        }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        });
      }
      return new Response(JSON.stringify({ Status: 0, TC: false, Answer: [] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      });
    }));
    const pending = handleEgressHop(
      env.EGRESS_GATEWAY_SECRET,
      { url: target, nonce, validatedAddresses: addresses },
      { timestamp, signature },
      {
        nowMs: Number(timestamp) * 1000,
        consumeNonce: async () => true,
        fetchImpl: targetFetch,
      },
    );
    await started;
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await pending;
    expect(response.status).toBe(403);
    expect(cancelled).toBe(true);
    expect(signalAborted).toBe(true);
    expect(targetFetch).not.toHaveBeenCalled();
  });

  it("egressはredirectで内部IP・別origin・userinfoへ向かうLocationを破棄する", async () => {
    for (const location of [
      "https://other.example/next", // cross-origin
      "//other.example/next", // protocol-relative → cross-origin
      "http://public.example/next", // https からの downgrade
      "https://user:pass@public.example/next", // userinfo
      "https://public.example:8443/next", // custom port
      "https://127.0.0.1/latest", // loopback literal
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6
      "https://[64:ff9b::a9fe:a9fe]/", // NAT64 well-known → metadata
      "https://10.0.0.8/admin", // RFC1918
    ]) {
      vi.stubGlobal("fetch", egressNetworkFetch(async () =>
        new Response(null, { status: 302, headers: { location } })
      ));
      const response = await signedEgressRequest("https://public.example/start");
      expect(response.status, location).toBe(302);
      expect(response.headers.get("location"), location).toBeNull();
    }
  });

  it("署名済みでもliteral IP・protocol-relative URLへのegressを400で遮断する", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const target of [
      "https://127.0.0.1/latest", // loopback
      "https://10.0.0.8/menu", // RFC1918
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6
      "https://[64:ff9b::a9fe:a9fe]/", // NAT64 well-known
      "https://[fe80::1]/", // IPv6 link-local
      "https://[fc00::1]/", // ULA
      "https://0x7f000001/", // hex 表記 (URL parser が 127.0.0.1 へ正規化)
      "//public.example/menu", // protocol-relative
    ]) {
      const response = await signedEgressRequest(target);
      expect(response.status, target).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("DoH応答にmapped/NAT64/privateが混じれば403で接続しない", async () => {
    for (const dns of [
      { A: [PUBLIC_V4], AAAA: ["::ffff:127.0.0.1"] }, // IPv4-mapped IPv6
      { A: [PUBLIC_V4], AAAA: ["64:ff9b::a9fe:a9fe"] }, // NAT64 → metadata
      { A: ["10.0.0.8"], AAAA: [] }, // RFC1918
    ]) {
      const targetFetch = vi.fn(async () => new Response("must not run"));
      vi.stubGlobal("fetch", egressNetworkFetch(targetFetch, dns));
      const response = await signedEgressRequest("https://public.example/menu");
      expect(response.status, JSON.stringify(dns)).toBe(403);
      expect(targetFetch).not.toHaveBeenCalled();
    }
  });

  it("egress gateway自身のDNS再検証でprivate応答を拒否する", async () => {
    const target = "https://public.example/menu";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    const targetFetch = vi.fn(async () => new Response("must not run"));
    vi.stubGlobal(
      "fetch",
      egressNetworkFetch(targetFetch, { A: ["169.254.169.254"], AAAA: [] }),
    );
    const response = await app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(targetFetch).not.toHaveBeenCalled();
  });

  it("egressはheader後に本文が停止しても8秒で中断する", async () => {
    vi.useFakeTimers();
    const target = "https://public.example/slow";
    const addresses = [PUBLIC_V4];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const signature = await createEgressSignature(
      env.EGRESS_GATEWAY_SECRET,
      timestamp,
      nonce,
      target,
      addresses,
    );
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      egressNetworkFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
        markStarted?.();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("aborted")),
            );
          },
        }), { headers: { "content-type": "text/plain" } });
      }),
    );

    const pending = app.request(
      "/v1/internal/egress-fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oisint-egress-timestamp": timestamp,
          "x-oisint-egress-signature": signature,
        },
        body: JSON.stringify({ url: target, nonce, validatedAddresses: addresses }),
      },
      env,
    );
    await started;
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await pending;
    expect(response.status).toBe(502);
  });
});
