import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";

const env = {
  SUPABASE_URL: "https://project-ref.supabase.co",
  CORS_ORIGIN: "https://app.example.com",
};
const id = "123e4567-e89b-42d3-a456-426614174000";
const marker = "synthetic-upstream-diagnostic-marker";
const routes = [
  ["/v1/investigations", { query: "q", displayName: "d" }],
  ["/v1/location/resolve", { scope: { type: "current_location" } }],
  [`/v1/investigations/${id}/research`, {}],
  [`/v1/investigations/${id}/rerank`, {}],
  ["/v1/investigations/join", { shareToken: "synthetic-share", displayName: "d" }],
] as const;

function request(route: (typeof routes)[number] = routes[1]) {
  return app.request(route[0], {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "synthetic-create-id",
    },
    body: JSON.stringify(route[1]),
  }, env);
}

function upstream(body: string, status: number, headers: Record<string, string> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toMatch(/^https:\/\/project-ref\.supabase\.co\/functions\/v1\//);
    return new Response(body, { status, headers });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Edge Function public error boundary", () => {
  const statuses = [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504];
  for (const status of statuses) {
    for (const [label, body, contentType] of [
      ["JSON", JSON.stringify({ error: marker, message: marker, details: marker, hint: marker, extra: { marker } }), "application/json"],
      ["malformed JSON", `{${marker}`, "application/json; charset=utf-8"],
      ["HTML", `<html>${marker}</html>`, "text/html"],
      ["text", marker, "text/plain"],
      ["empty", "", "application/json"],
    ]) {
      it(`${status} ${label}: keeps status without reflecting diagnostics`, async () => {
        const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
        upstream(body, status, { "content-type": contentType, "x-debug": marker });
        const response = await request();
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(response.headers.get("x-debug")).toBeNull();
        expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
        const payload = await response.json();
        expect(Object.keys(payload)).toEqual(["error"]);
        expect(typeof payload.error).toBe("string");
        expect(JSON.stringify(payload)).not.toContain(marker);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      });
    }
  }

  for (const route of routes) {
    it(`${route[0]} uses the common boundary`, async () => {
      upstream(JSON.stringify({ error: marker }), 403);
      const response = await request(route);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "この操作を行う権限がありません" });
    });
  }

  for (const value of ["0", "1", "60", "00060", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
    it(`keeps valid Retry-After: ${value}`, async () => {
      upstream(marker, 429, { "Retry-After": value });
      const response = await request();
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(value);
      expect(await response.json()).toEqual({ error: "しばらく待ってからもう一度お試しください" });
    });
  }
  for (const value of [marker, "-1", "1.5", "60 seconds", "9".repeat(129), "Wed, 31 Feb 2015 07:28:00 GMT", "Thu, 21 Oct 2015 07:28:00 GMT"]) {
    it(`drops invalid Retry-After: ${value.slice(0, 40)}`, async () => {
      upstream(marker, 503, { "Retry-After": value });
      const response = await request();
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(await response.text()).not.toContain(marker);
    });
  }

  for (const [status, payload] of [
    [200, { investigationId: id, shareToken: "synthetic-share" }],
    [201, { joined: true }],
    [202, { status: "queued" }],
  ] as const) {
    it(`preserves successful ${status} JSON`, async () => {
      upstream(JSON.stringify(payload), status, { "content-type": "application/json", "Retry-After": "1" });
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(payload);
      expect(response.headers.get("Retry-After")).toBe("1");
    });
  }

  it("keeps the existing oversized-body 502 guard", async () => {
    upstream(marker, 400, { "content-length": "1048577" });
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "上流サービスの応答を処理できません" });
  });

  it("keeps the redirect rejection and does not expose Location", async () => {
    upstream(marker, 302, { Location: "https://example.invalid/diagnostic" });
    const response = await request();
    expect(response.status).toBe(502);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toEqual({ error: "上流サービスに接続できません" });
  });
});
