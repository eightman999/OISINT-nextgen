// 外部 API / フェッチ結果のサービス側キャッシュ (spec.md §32 external_cache)
// - service role 専用テーブル。TTL は読み出し時判定
// - 成功レスポンスのみ保存 (失敗を TTL 期間固定化しない)
// - 期限切れ行の確定削除は pg_cron 日次 GC (migration 0016) が主経路。
//   書き込み時の確率的掃除は §32「書き込み時に掃除する」の保険として低頻度で残す (§44.3 L1)
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "./db.ts";

// TTL は spec.md §32 の external_cache 節と一致させる (serper 24h / fetch 24h / geoapify 24h)。
// 値を変える場合は migration 0016 の gc_external_cache() 既定値も合わせる。
export const CACHE_TTL_HOURS: Record<string, number> = {
  serper: 24,
  fetch: 24,
  // Geoapify / OSM は provider 側にキャッシュ期限の制限が無い (#530)。
  // 24h は鮮度目的の自主設定であり規約要件ではない
  geoapify: 24,
};

// 1 行の payload 上限 (#173)。正当な最大は fetch の FetchedPage で、本文は fetcher の
// MAX_TEXT_CHARS=4,000 文字 ≒ 12KB (UTF-8 日本語 3B/文字) + URL に収まる。serper (5 件) /
// geoapify (数件) はさらに小さい。64KB は正当系の約 4 倍の余裕を持ちつつ、想定外に
// 大きい payload による行肥大 (TOAST 肥大・転送コスト) を防ぐ。超過時は保存せずスキップする。
export const MAX_CACHE_PAYLOAD_BYTES = 64 * 1024;

// 書き込み時に期限切れ行を掃除する確率。主経路が pg_cron 日次 GC (0016) になったため、
// 残存は最大でも約 1 日分となり、保険としては 1% で十分 (削除クエリのコスト削減)。
const WRITE_GC_PROBABILITY = 0.01;

// payload の保存サイズ見積もり (JSON 直列化後の UTF-8 バイト数)
export function cachePayloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

let cachedClient: SupabaseClient | null = null;
function db(): SupabaseClient {
  cachedClient ??= createServiceClient();
  return cachedClient;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// kind + 入力からキャッシュを引き、miss なら fn() を実行して保存する。
// fn() が null / undefined を返した場合は「失敗」とみなし保存しない。
export async function withCache<T>(
  kind: keyof typeof CACHE_TTL_HOURS & string,
  request: Record<string, unknown>,
  fn: () => Promise<T | null>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }
  const ttlHours = CACHE_TTL_HOURS[kind] ?? 24;
  const key = `${kind}:v1:` + (await sha256Hex(JSON.stringify(request)));
  const cutoff = new Date(Date.now() - ttlHours * 3600_000).toISOString();

  try {
    const { data: hit } = await db()
      .from("external_cache")
      .select("payload")
      .eq("cache_key", key)
      .gt("fetched_at", cutoff)
      .maybeSingle();
    if (hit) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
      // ヒット率の実測用 (#164 のコスト判断材料)。request 内容は出さない (§34)
      console.log(`[external-cache] hit kind=${kind}`);
      return hit.payload as T;
    }
    console.log(`[external-cache] miss kind=${kind}`);
  } catch {
    // キャッシュ層の障害で本処理を止めない
    console.warn(`[external-cache] unavailable kind=${kind}`);
  }

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }
  const value = await fn();
  if (value === null || value === undefined) return value;

  // 大きすぎる payload は保存しない (#173。行肥大の防止。読み出し側は単に毎回 miss になる)
  const payloadBytes = cachePayloadBytes(value);
  if (payloadBytes > MAX_CACHE_PAYLOAD_BYTES) {
    console.warn(
      `[external-cache] skip-large kind=${kind} bytes=${payloadBytes}`,
    );
    return value;
  }

  try {
    await db().from("external_cache").upsert({
      cache_key: key,
      kind,
      request,
      payload: value as unknown as Record<string, unknown>,
      fetched_at: new Date().toISOString(),
    });
    // 期限切れ行の掃除 (保険。確定削除は 0016 の pg_cron 日次 GC が行う)
    if (Math.random() < WRITE_GC_PROBABILITY) {
      await db().from("external_cache").delete().eq("kind", kind).lt(
        "fetched_at",
        cutoff,
      );
    }
  } catch {
    // 保存失敗は無視 (次回また外部を叩くだけ)
  }
  return value;
}
