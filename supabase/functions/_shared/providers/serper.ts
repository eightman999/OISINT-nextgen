// SerperSearchProvider (spec.md §5.4 / 2026-08-15 改訂)
// Google SERP API。search_fetch backend の検索部。URL / title / snippet のみ返す。
import { z } from "zod";
import { withCache } from "../cache.ts";
import type { ProviderInstrumentation } from "./types.ts";

const serperResponseSchema = z.object({
  organic: z
    .array(
      z.object({
        title: z.string().optional(),
        link: z.string().url(),
        snippet: z.string().optional(),
      }),
    )
    .default([]),
});

export interface SerpResult {
  url: string;
  title: string | null;
  snippet: string | null;
}

export class SerperSearchProvider {
  constructor(private readonly instrumentation?: ProviderInstrumentation) {}

  // 同一クエリは external_cache (§32) から返し、Serper クレジットを消費しない
  async search(
    query: string,
    num = 5,
    signal?: AbortSignal,
  ): Promise<SerpResult[]> {
    const results = await withCache<SerpResult[]>(
      "serper",
      { q: query, gl: "jp", hl: "ja", num },
      () => this.request(query, num, signal),
      signal,
    );
    return results ?? [];
  }

  private async request(
    query: string,
    num: number,
    signal?: AbortSignal,
  ): Promise<SerpResult[]> {
    const started = Date.now();
    let outcome: "ok" | "error" = "ok";
    try {
      const key = Deno.env.get("SERPER_API_KEY");
      if (!key) throw new Error("SERPER_API_KEY が未設定");

      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, gl: "jp", hl: "ja", num }),
        signal,
      });
      if (!res.ok) throw new Error(`Serper API error: ${res.status}`);
      const parsed = serperResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(
          `Serper レスポンスの検証に失敗: ${parsed.error.message}`,
        );
      }

      return parsed.data.organic.map((o) => ({
        url: o.link,
        title: o.title ?? null,
        snippet: o.snippet ?? null,
      }));
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      this.instrumentation?.onMetric({
        provider: "serper",
        operation: "search_api",
        durationMs: Date.now() - started,
        retryCount: 0,
        outcome,
      });
    }
  }
}
