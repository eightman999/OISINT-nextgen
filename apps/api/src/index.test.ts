// apps/api Worker のテストスイート (#174)。
//
// フレームワーク: vitest 4 + @cloudflare/vitest-pool-workers (workerd 上で実行)。
// Issue #174 の指名どおり pool-workers を採用した。バージョン選定の理由
// (0.15.1 exact pin = CI Node 20 対応の最終版) は vitest.config.ts 参照。
//
// 方針:
// - Hono はランタイム非依存なので app.request(path, init, env) に偽の env
//   (Bindings) を渡し、ルートごとに CORS_ORIGIN / SUPABASE_URL を制御する。
// - 外部への fetch は全て vi.stubGlobal で stub する。実ホスト
//   (supabase.co / api.oisint.com 等) へのネットワークアクセスは一切行わず、
//   SUPABASE_URL は予約済みの Supabase fixture host 固定。想定外の URL への fetch は
//   即例外にして誤爆を検出する。オフラインでも決定的に通る。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app, { EGRESS_REQUEST_BODY_TIMEOUT_MS } from "./index";

// ---------------------------------------------------------------- ヘルパ

const UPSTREAM = "https://project-ref.supabase.co";

const baseEnv = {
  SUPABASE_URL: UPSTREAM,
  SUPABASE_ANON_KEY: "test-anon-key",
  CORS_ORIGIN: "https://app.example.com,http://localhost:3000",
  RATE_LIMIT_SECRET: ["rate-limit", "contract-fixture", "000000000000"].join("-"),
  EGRESS_GATEWAY_SECRET: ["egress-gateway", "contract-fixture", "00000000"].join("-"),
  EGRESS_REPLAY_GUARD: undefined as unknown as DurableObjectNamespace,
};

const UUID = "123e4567-e89b-42d3-a456-426614174000"; // テスト用の正当な uuid
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREATE_IDEMPOTENCY_KEY = "create-test-key";

type FetchCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown; // JSON ならパース済み、それ以外は生文字列
};

// global fetch を stub し、捕捉した呼び出しの配列を返す。
// makeResponse は呼び出しごとに新しい Response を生成する (body 再読込対策)。
function stubUpstream(makeResponse: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(`${UPSTREAM}/`)) {
      throw new Error(`テストが想定しない URL への fetch: ${url}`);
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // 生文字列のまま
    }
    calls.push({
      url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    return makeResponse();
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
  });
}

beforeEach(() => {
  // stub し忘れた fetch が実ネットワークへ出るのを防ぐ安全網
  vi.stubGlobal("fetch", async (input: unknown) => {
    throw new Error(`fetch が stub されていません: ${String(input)}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- 1. health

describe("GET /v1/health", () => {
  it("200 で {status:'ok'} と UUID 形式の x-request-id を返す", async () => {
    const res = await app.request("/v1/health", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-request-id")).toMatch(UUID_RE);
  });
});

// ---------------------------------------------------------------- 2. egress本文の受信deadline

describe("egress本文の受信deadline", () => {
  it("途中で停止したbodyをdeadline内408へ収束しcancelする", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const request = new Request("https://api.example/v1/internal/egress-fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oisint-egress-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-oisint-egress-signature": "a".repeat(64),
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
    } as RequestInit & { duplex: "half" });

    const pending = app.fetch(request, baseEnv as CloudflareEnv);
    await vi.advanceTimersByTimeAsync(EGRESS_REQUEST_BODY_TIMEOUT_MS);
    const response = await pending;

    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "egress request rejected" });
    expect(cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------- 3. CORS

describe("CORS", () => {
  it("許可オリジンには Access-Control-Allow-Origin をエコーする", async () => {
    const res = await app.request(
      "/v1/health",
      { headers: { Origin: "https://app.example.com" } },
      baseEnv,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("許可外オリジンには Access-Control-Allow-Origin を付けない (200 は返す)", async () => {
    const res = await app.request(
      "/v1/health",
      { headers: { Origin: "https://evil.example.com" } },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS preflight が allow-methods / allow-headers を返す", async () => {
    const res = await app.request(
      "/v1/investigations",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
        },
      },
      baseEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    for (const m of ["POST", "GET", "PATCH", "OPTIONS"]) {
      expect(methods).toContain(m);
    }
    const headers = res.headers.get("Access-Control-Allow-Headers") ?? "";
    for (const h of ["authorization", "x-client-info", "apikey", "content-type", "idempotency-key"]) {
      expect(headers.toLowerCase()).toContain(h);
    }
  });

  it("CORS_ORIGIN が空文字なら許可リストが空になり ACAO は付かない (現状仕様の記録)", async () => {
    const res = await app.request(
      "/v1/health",
      { headers: { Origin: "https://app.example.com" } },
      { ...baseEnv, CORS_ORIGIN: "" },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("CORS_ORIGIN の空白と末尾カンマは trim/filter され、許可判定は変わらない", async () => {
    const res = await app.request(
      "/v1/health",
      { headers: { Origin: "https://app.example.com" } },
      { ...baseEnv, CORS_ORIGIN: " https://app.example.com , http://localhost:3000 ," },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  // ---- Vary ヘッダ (現状挙動のピン留め。Issue #162 Edge Function CORS allow-list 対応の前提記録) ----
  //
  // origin が動的 allow-list (配列) のとき、ACAO はリクエストの Origin によって変わる。
  // 共有キャッシュ (CDN 等) が Origin 違いの応答を混同して返す cache poisoning を防ぐには
  // 応答が Vary: Origin を持つ必要がある。hono/cors@4 (実測 4.13.2) は origin が "*" 以外なら
  // GET/OPTIONS とも Vary: Origin を必ず付ける実装で、以下はその実挙動をそのまま記録する。
  // #162 で Edge Function 側の CORS を allow-list 化する際も同じ Vary 要件を満たすこと。
  describe("Vary ヘッダ (cache poisoning 対策の現状記録)", () => {
    it("許可オリジンの単純 GET は Vary: Origin を返す", async () => {
      const res = await app.request(
        "/v1/health",
        { headers: { Origin: "https://app.example.com" } },
        baseEnv,
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("許可外オリジンの GET も Vary: Origin を返す (ACAO 無し応答のキャッシュ混同も防ぐ)", async () => {
      const res = await app.request(
        "/v1/health",
        { headers: { Origin: "https://evil.example.com" } },
        baseEnv,
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("OPTIONS preflight は Vary: Origin, Access-Control-Request-Headers を返す", async () => {
      // allowHeaders を明示設定しているため、hono/cors は Origin に加えて
      // Access-Control-Request-Headers も Vary へ append する (実測挙動のピン留め)
      const res = await app.request(
        "/v1/investigations",
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
          },
        },
        baseEnv,
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("Vary")).toBe("Origin, Access-Control-Request-Headers");
    });
  });

  it("Origin ヘッダ無しのリクエストは ACAO 無しのまま 200 で成功する (same-origin / server-to-server を壊さない)", async () => {
    const res = await app.request("/v1/health", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    // NOTE: hono/cors@4 は Origin 無しでも Vary: Origin を付ける (origin が "*" 以外のとき無条件)。
    // 害は無い (キャッシュ分割が細かくなるだけ) ため現状挙動としてピン留めする。
    expect(res.headers.get("Vary")).toBe("Origin");
  });
});

// ------------------------------------------- 3. Edge Function へのヘッダ転送

describe("Edge Function プロキシ: ヘッダ転送", () => {
  it("Authorization と apikey があれば上流へそのまま転送する", async () => {
    const calls = stubUpstream(() => jsonResponse({ id: "x" }));
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
          Authorization: "Bearer user-jwt",
          apikey: "client-apikey",
        },
        body: JSON.stringify({ query: "静かな店", displayName: "テスト" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${UPSTREAM}/functions/v1/create-investigation`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["Authorization"]).toBe("Bearer user-jwt");
    expect(calls[0].headers["apikey"]).toBe("client-apikey");
    expect(calls[0].headers["Idempotency-Key"]).toBe(CREATE_IDEMPOTENCY_KEY);
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toEqual({ query: "静かな店", displayName: "テスト" });
  });

  it("Authorization / apikey が無ければヘッダ自体を付けない", async () => {
    const calls = stubUpstream(() => jsonResponse({ id: "x" }));
    await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(Object.keys(calls[0].headers)).not.toContain("Authorization");
    expect(Object.keys(calls[0].headers)).not.toContain("apikey");
  });
});

// ------------------------------------------- 4. 上流レスポンスの中継

describe("Edge Function プロキシ: 上流レスポンス中継", () => {
  it("上流の 400 JSON をステータスごと中継する", async () => {
    stubUpstream(() => jsonResponse({ error: "invalid query" }, 400));
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("application/json (charset 付き) は再シリアライズして返す", async () => {
    stubUpstream(
      () =>
        new Response('{ "a" : 1 }', {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    );
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(await res.text()).toBe('{"a":1}'); // 再 stringify で正規化される
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("JSON を名乗る壊れた body は生テキストのまま上流ステータスで中継する", async () => {
    stubUpstream(
      () =>
        new Response("{oops", {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    );
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("{oops");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("text/plain は生のまま中継する", async () => {
    stubUpstream(
      () => new Response("plain body", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(await res.text()).toBe("plain body");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("Content-Type 無しは application/json として扱う", async () => {
    stubUpstream(() => {
      const res = new Response('{"x":1}', { status: 200 });
      res.headers.delete("Content-Type"); // 文字列 body の自動付与を除去
      return res;
    });
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ x: 1 });
  });

  it("上流responseが1MiBを超えたら本文を中継せず502にする", async () => {
    stubUpstream(() =>
      jsonResponse({ data: "x".repeat(1_048_576) }),
    );
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q", displayName: "d" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "上流サービスの応答を処理できません" });
  });
});

// ------------------------------------------- 5. Zod バリデーション (ルート別)

describe("バリデーション: POST /v1/investigations", () => {
  it("空 body は 400 で、上流は呼ばれない", async () => {
    const calls = stubUpstream(() => jsonResponse({})); // 呼ばれないはず
    const res = await app.request(
      "/v1/investigations",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
    expect(calls.length).toBe(0);
  });

  it("JSON ですらない body は catch で {} 扱いになり 400", async () => {
    const res = await app.request(
      "/v1/investigations",
      { method: "POST", body: "これはJSONではない" },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("Edge Function正本と同じquery 500文字・displayName 40文字を受理する", async () => {
    const calls = stubUpstream(() => jsonResponse({ investigationId: UUID }));
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": CREATE_IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ query: "q".repeat(500), displayName: "名".repeat(40) }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("query 501文字またはdisplayName 41文字はupstreamへ送らない", async () => {
    const calls = stubUpstream(() => jsonResponse({}));
    for (const body of [
      { query: "q".repeat(501), displayName: "名" },
      { query: "q", displayName: "名".repeat(41) },
    ]) {
      const res = await app.request(
        "/v1/investigations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        baseEnv,
      );
      expect(res.status).toBe(400);
    }
    expect(calls.length).toBe(0);
  });

  it("宣言長に依存せず4KiB超のrequestを413で止める", async () => {
    const calls = stubUpstream(() => jsonResponse({}));
    const res = await app.request(
      "/v1/investigations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "q".repeat(5_000), displayName: "名" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "リクエストが大きすぎます" });
    expect(calls.length).toBe(0);
  });
});

describe("バリデーション: POST /v1/investigations/:id/research", () => {
  it("uuid でない id は 400 で、上流は呼ばれない", async () => {
    const calls = stubUpstream(() => jsonResponse({}));
    const res = await app.request(
      "/v1/investigations/not-a-uuid/research",
      { method: "POST" },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "investigation id が不正です" });
    expect(calls.length).toBe(0);
  });

  it("正当な uuid なら run-investigation へ {investigationId} を送る", async () => {
    const calls = stubUpstream(() => jsonResponse({ ok: true }));
    const res = await app.request(`/v1/investigations/${UUID}/research`, { method: "POST" }, baseEnv);
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${UPSTREAM}/functions/v1/run-investigation`);
    expect(calls[0].body).toEqual({ investigationId: UUID });
  });

  it("上流の受付202を待機完了と取り違えず、そのまま即時中継する", async () => {
    const calls = stubUpstream(() => jsonResponse({ status: "recalling" }, 202));
    const started = performance.now();
    const res = await app.request(`/v1/investigations/${UUID}/research`, { method: "POST" }, baseEnv);
    const elapsed = performance.now() - started;

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ status: "recalling" });
    expect(calls).toHaveLength(1);
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toMatch(UUID_RE);
    expect(calls[0].headers["x-request-id"]).toBe(requestId);
    // このWorkerの責務はEdge Functionの受付応答を返すことだけ。外部pipelineの
    // 完了時間を測るテストではなく、同期チェーンへ戻らない契約を固定する。
    expect(elapsed).toBeLessThan(1_000);
  });

  it("GPS searchAnchor を検証して run-investigation へ一時中継する", async () => {
    const calls = stubUpstream(() => jsonResponse({ status: "draft" }));
    const res = await app.request(`/v1/investigations/${UUID}/research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchAnchor: { lat: 35.7295, lng: 139.7109 } }),
    }, baseEnv);
    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({
      investigationId: UUID,
      searchAnchor: { lat: 35.7295, lng: 139.7109 },
    });
  });

  it("域外・余分な searchAnchor は Edge Function へ送らず400にする", async () => {
    const calls = stubUpstream(() => jsonResponse({}));
    for (const searchAnchor of [
      { lat: 91, lng: 139.7109 },
      { lat: 35.7295, lng: 139.7109, rawQuery: "座標" },
    ]) {
      const res = await app.request(`/v1/investigations/${UUID}/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchAnchor }),
      }, baseEnv);
      expect(res.status).toBe(400);
    }
    expect(calls.length).toBe(0);
  });
});

describe("バリデーション: POST /v1/location/resolve", () => {
  it("正当なrail scopeをresolve-locationへ転送する", async () => {
    const calls = stubUpstream(() => jsonResponse({ status: "resolved" }));
    const scope = { type: "line", line: "西武池袋線" };
    const res = await app.request(
      "/v1/location/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${UPSTREAM}/functions/v1/resolve-location`);
    expect(calls[0].body).toEqual({ scope });
  });

  it("不正なrail scopeは400で、上流へ送らない", async () => {
    const calls = stubUpstream(() => jsonResponse({}));
    const res = await app.request(
      "/v1/location/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: { type: "between", from: "池袋" } }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "location scope が不正です" });
    expect(calls.length).toBe(0);
  });
});

describe("バリデーション: POST /v1/investigations/:id/rerank", () => {
  it("uuid でない id は 400", async () => {
    const res = await app.request("/v1/investigations/123/rerank", { method: "POST" }, baseEnv);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "investigation id が不正です" });
  });

  it("body 無しなら trigger は既定値 'vote' で上流へ届く", async () => {
    const calls = stubUpstream(() => jsonResponse({ ok: true }));
    const res = await app.request(`/v1/investigations/${UUID}/rerank`, { method: "POST" }, baseEnv);
    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({ investigationId: UUID, trigger: "vote" });
  });

  it("trigger 指定は転送されるが passthrough の余剰フィールドは転送されない", async () => {
    const calls = stubUpstream(() => jsonResponse({ ok: true }));
    await app.request(
      `/v1/investigations/${UUID}/rerank`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "requirement_added", extra: "dropped" }),
      },
      baseEnv,
    );
    expect(calls[0].body).toEqual({ investigationId: UUID, trigger: "requirement_added" });
  });

  it("不正な trigger は 400 で、上流は呼ばれない", async () => {
    const calls = stubUpstream(() => jsonResponse({}));
    const res = await app.request(
      `/v1/investigations/${UUID}/rerank`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "invalid_trigger" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
    expect(calls.length).toBe(0);
  });
});

describe("バリデーション: POST /v1/investigations/join", () => {
  it("displayName 欠落は 400", async () => {
    const res = await app.request(
      "/v1/investigations/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareToken: "tok" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("正当な body は join-investigation へそのまま転送される", async () => {
    const calls = stubUpstream(() => jsonResponse({ joined: true }));
    await app.request(
      "/v1/investigations/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareToken: "tok", displayName: "参加者" }),
      },
      baseEnv,
    );
    expect(calls[0].url).toBe(`${UPSTREAM}/functions/v1/join-investigation`);
    expect(calls[0].body).toEqual({ shareToken: "tok", displayName: "参加者" });
  });
});

describe("バリデーション: PATCH /v1/investigations/:id/visibility", () => {
  it("uuid でない id は 400", async () => {
    const res = await app.request(
      "/v1/investigations/xyz/visibility",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "investigation id が不正です" });
  });

  it("enum 外の visibility は 400", async () => {
    const res = await app.request(
      `/v1/investigations/${UUID}/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "hidden" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });
});

describe("バリデーション: POST /v1/places/:id/feedback", () => {
  it("uuid でない id は 400", async () => {
    const res = await app.request(
      "/v1/places/nope/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: 1 }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "place id が不正です" });
  });

  it("全項目空の body は refine で 400", async () => {
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("visitedAt の形式違反 (YYYY/MM/DD) は 400", async () => {
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitedAt: "2026/08/01" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("visitedAt の存在しない日付は 400", async () => {
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitedAt: "2026-02-30" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("未来の visitedAt は 400", async () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitedAt: future }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("JSTの日付境界では当日を許可し、翌日と実在しない日は拒否する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 2026-08-24T15:30:00Z = 2026-08-25 00:30 JST。
      vi.setSystemTime(new Date("2026-08-24T15:30:00.000Z"));
      const calls = stubUpstream(() => jsonResponse("feedback-uuid"));

      const today = await app.request(
        `/v1/places/${UUID}/feedback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitedAt: "2026-08-25" }),
        },
        baseEnv,
      );
      expect(today.status).toBe(200);

      const future = await app.request(
        `/v1/places/${UUID}/feedback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitedAt: "2026-08-26" }),
        },
        baseEnv,
      );
      expect(future.status).toBe(400);

      const impossible = await app.request(
        `/v1/places/${UUID}/feedback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitedAt: "2026-02-30" }),
        },
        baseEnv,
      );
      expect(impossible.status).toBe(400);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ p_place: UUID, p_visited_at: "2026-08-25" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aspectValue の空白・aspect 無し・非canonical値・上限超過・未知キーを拒否する", async () => {
    for (const body of [
      { aspect: "noise", aspectValue: "   " },
      { aspectValue: "quiet" },
      { aspect: "space", aspectValue: "quiet" },
      { aspect: "noise", aspectValue: "会話しやすい" },
      { aspect: "noise", aspectValue: "x".repeat(121) },
      { rating: 0, unexpected: true },
    ]) {
      const res = await app.request(
        `/v1/places/${UUID}/feedback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        baseEnv,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "リクエストが不正です" });
    }
  });

  it("文字列は trim 後に RPC へ渡す", async () => {
    const calls = stubUpstream(() => jsonResponse("feedback-uuid"));
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aspect: "noise", aspectValue: "  quiet  " }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({
      p_place: UUID,
      p_aspect: "noise",
      p_aspect_value: "quiet",
    });
  });

  it("rating:0 単独でも通り、指定した項目だけが p_* 引数になる", async () => {
    const calls = stubUpstream(() => jsonResponse("feedback-uuid"));
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: 0 }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({ p_place: UUID, p_rating: 0 }); // 他の p_* は送らない
  });

  it("全項目指定なら全て p_* 引数へマップされる", async () => {
    const calls = stubUpstream(() => jsonResponse("feedback-uuid"));
    await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          visitedAt: "2026-08-01",
          rating: -1,
          aspect: "noise",
          aspectValue: "quiet",
        }),
      },
      baseEnv,
    );
    expect(calls[0].url).toBe(`${UPSTREAM}/rest/v1/rpc/submit_place_feedback`);
    expect(calls[0].body).toEqual({
      p_place: UUID,
      p_visited_at: "2026-08-01",
      p_rating: -1,
      p_aspect: "noise",
      p_aspect_value: "quiet",
    });
  });
});

describe("バリデーション: PATCH /v1/places/:id/feedback/:feedbackId", () => {
  it("uuid でない feedback id は 400", async () => {
    const res = await app.request(
      `/v1/places/${UUID}/feedback/not-a-uuid`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: 1 }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "feedback id が不正です" });
  });

  it("空の body は 400", async () => {
    const res = await app.request(
      `/v1/places/${UUID}/feedback/${UUID}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "リクエストが不正です" });
  });

  it("POSTと同じJST基準の共通日付schemaを使う", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 2026-08-24T15:30:00Z = 2026-08-25 00:30 JST。
      vi.setSystemTime(new Date("2026-08-24T15:30:00.000Z"));
      const calls = stubUpstream(() => jsonResponse("feedback-uuid"));

      const today = await app.request(
        `/v1/places/${UUID}/feedback/${UUID}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitedAt: "2026-08-25" }),
        },
        baseEnv,
      );
      expect(today.status).toBe(200);

      const future = await app.request(
        `/v1/places/${UUID}/feedback/${UUID}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitedAt: "2026-08-26" }),
        },
        baseEnv,
      );
      expect(future.status).toBe(400);

      const impossible = await app.request(
        `/v1/places/${UUID}/feedback/${UUID}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitedAt: "2026-02-30" }),
        },
        baseEnv,
      );
      expect(impossible.status).toBe(400);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({
        p_place: UUID,
        p_feedback: UUID,
        p_visited_at: "2026-08-25",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------- 6. x-request-id は全応答に付く

describe("x-request-id", () => {
  it("400 / 404 / プロキシ応答にも UUID 形式で付与される", async () => {
    const badReq = await app.request(
      "/v1/investigations",
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
      baseEnv,
    );
    expect(badReq.status).toBe(400);
    expect(badReq.headers.get("x-request-id")).toMatch(UUID_RE);

    const notFound = await app.request("/v1/nope", {}, baseEnv);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("x-request-id")).toMatch(UUID_RE);

    stubUpstream(() => jsonResponse({ ok: true }));
    const proxied = await app.request(
      `/v1/investigations/${UUID}/research`,
      { method: "POST" },
      baseEnv,
    );
    expect(proxied.headers.get("x-request-id")).toMatch(UUID_RE);
  });
});

// ------------------------------------------- 7. PostgREST RPC プロキシ

describe("RPC プロキシ (visibility / feedback)", () => {
  it("visibility 成功: RPC へ p_* 引数を送り {visibility} を返す。apikey は anon key で補完", async () => {
    // set_investigation_visibility は void を返すため 204 No Content を模す
    const calls = stubUpstream(() => new Response(null, { status: 204 }));
    const res = await app.request(
      `/v1/investigations/${UUID}/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ visibility: "public" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${UPSTREAM}/rest/v1/rpc/set_investigation_visibility`);
    expect(calls[0].body).toEqual({ p_investigation: UUID, p_visibility: "public" });
    expect(calls[0].headers["apikey"]).toBe("test-anon-key"); // env の anon key で補完
    expect(Object.keys(calls[0].headers)).not.toContain("Authorization");
  });

  it("クライアントの apikey / Authorization があればそちらを優先して転送する", async () => {
    const calls = stubUpstream(() => jsonResponse("fb-1"));
    const res = await app.request(
      `/v1/places/${UUID}/feedback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: "client-key",
          Authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({ aspect: "value", aspectValue: "good" }),
      },
      baseEnv,
    );
    expect(calls[0].headers["apikey"]).toBe("client-key");
    expect(calls[0].headers["Authorization"]).toBe("Bearer user-jwt");
    expect(await res.json()).toEqual({ feedbackId: "fb-1" });
  });

  it("feedback 更新は place と feedback の両 IDを本人確認RPCへ転送する", async () => {
    const calls = stubUpstream(() => jsonResponse("fb-1"));
    const today = new Date().toISOString().slice(0, 10);
    const res = await app.request(
      `/v1/places/${UUID}/feedback/${UUID}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({
          visitedAt: today,
          rating: 0,
          aspect: "noise",
          aspectValue: "quiet",
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ feedbackId: "fb-1" });
    expect(calls[0].url).toBe(`${UPSTREAM}/rest/v1/rpc/update_place_feedback`);
    expect(calls[0].body).toEqual({
      p_place: UUID,
      p_feedback: UUID,
      p_visited_at: today,
      p_rating: 0,
      p_aspect: "noise",
      p_aspect_value: "quiet",
    });
  });

  it("RPC の {message} 付きエラーはステータスだけ保ち内部文言を秘匿する", async () => {
    stubUpstream(() =>
      jsonResponse({ code: "42501", message: "編集権限がありません" }, 403),
    );
    const res = await app.request(
      `/v1/investigations/${UUID}/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "この操作を行う権限がありません" });
  });

  it("JSON でないエラー bodyも生テキストを公開しない", async () => {
    stubUpstream(
      () => new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } }),
    );
    const res = await app.request(
      `/v1/investigations/${UUID}/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "上流サービスの応答を処理できません" });
  });

  it("空 body のエラーも固定public messageへフォールバックする", async () => {
    stubUpstream(() => new Response(null, { status: 500 }));
    const res = await app.request(
      `/v1/investigations/${UUID}/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "上流サービスの応答を処理できません" });
  });
});

// ------------------------------------------- 8. notFound

describe("notFound", () => {
  it("未定義ルートは 404 {error:'Not found'}", async () => {
    const res = await app.request("/v1/nope", {}, baseEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
