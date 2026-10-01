// cache.ts のユニットテスト (spec.md §32 external_cache)
// withCache は DB クライアントを引数注入できず、モジュール内シングルトン
// (createServiceClient) を使うため、本テストでは SUPABASE_URL / SERVICE_ROLE_KEY を
// 未設定にして「キャッシュ層が使えなくても本処理を止めない」経路を検証する。
// DB ヒット/期限切れ/upsert の経路は supabase-js クライアント生成が必須のため対象外 (報告済み)。
import { assertEquals, assertRejects } from "@std/assert";
import {
  CACHE_TTL_HOURS,
  cachePayloadBytes,
  MAX_CACHE_PAYLOAD_BYTES,
  withCache,
} from "../functions/_shared/cache.ts";

// 環境変数を一時的に設定/削除し、復元関数を返す (値 null = 削除)
function withEnv(vars: Record<string, string | null>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  return () => {
    for (const [k, old] of saved) {
      if (old === undefined) Deno.env.delete(k);
      else Deno.env.set(k, old);
    }
  };
}

const NO_DB = { SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null };

Deno.test("CACHE_TTL_HOURS: serper / fetch / geoapify はいずれも 24h (§32)", () => {
  assertEquals(CACHE_TTL_HOURS.serper, 24);
  assertEquals(CACHE_TTL_HOURS.fetch, 24);
  // geoapify は規約上のキャッシュ期限が無く、24h は鮮度目的の自主設定 (#530)
  assertEquals(CACHE_TTL_HOURS.geoapify, 24);
  assertEquals(Object.keys(CACHE_TTL_HOURS).length, 3);
});

Deno.test("withCache: DB クライアント未設定でもローダーを実行し値を返す (キャッシュ層障害で本処理を止めない)", async () => {
  const restore = withEnv(NO_DB);
  try {
    let calls = 0;
    const out = await withCache("serper", { q: "焼肉 池袋" }, () => {
      calls++;
      return Promise.resolve([{
        url: "https://example.com/",
        title: "t",
        snippet: null,
      }]);
    });
    assertEquals(calls, 1);
    assertEquals(out, [{
      url: "https://example.com/",
      title: "t",
      snippet: null,
    }]);
  } finally {
    restore();
  }
});

Deno.test("withCache: DB 不在時はメモリキャッシュも無く、毎回ローダーが呼ばれる", async () => {
  const restore = withEnv(NO_DB);
  try {
    let calls = 0;
    const loader = () => Promise.resolve(++calls);
    assertEquals(
      await withCache("fetch", { url: "https://example.com/" }, loader),
      1,
    );
    assertEquals(
      await withCache("fetch", { url: "https://example.com/" }, loader),
      2,
    );
    assertEquals(calls, 2);
  } finally {
    restore();
  }
});

Deno.test("withCache: ローダーが null を返したら null をそのまま返す (失敗は保存しない §32)", async () => {
  const restore = withEnv(NO_DB);
  try {
    const out = await withCache<string>("geoapify", {
      keyword: "存在しない店",
    }, () => Promise.resolve(null));
    assertEquals(out, null);
  } finally {
    restore();
  }
});

Deno.test("cachePayloadBytes: JSON 直列化後の UTF-8 バイト数を返す (多バイト文字)", () => {
  assertEquals(cachePayloadBytes({ a: 1 }), 7); // {"a":1}
  assertEquals(cachePayloadBytes("あ"), 5); // 引用符 2B + UTF-8 3B
});

Deno.test("MAX_CACHE_PAYLOAD_BYTES: 64KB で、正当な最大の fetch payload (4,000 文字) は保存できる", () => {
  assertEquals(MAX_CACHE_PAYLOAD_BYTES, 64 * 1024);
  // fetcher の MAX_TEXT_CHARS=4,000 (全角 ≒ 12KB) + URL は上限に対し十分な余裕がある
  const legit = {
    url: "https://example.com/menu",
    text: "あ".repeat(4_000),
  };
  assertEquals(cachePayloadBytes(legit) < MAX_CACHE_PAYLOAD_BYTES, true);
});

Deno.test("withCache: 上限超の payload は保存せずスキップし、値はそのまま返す (#173)", async () => {
  const restore = withEnv(NO_DB);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    // 22,000 全角文字 ≒ 66,000B > 64KB
    const big = { url: "https://example.com/big", text: "あ".repeat(22_000) };
    const out = await withCache(
      "fetch",
      { url: "https://example.com/big" },
      () => Promise.resolve(big),
    );
    assertEquals(out, big);
    assertEquals(
      warnings.some((w) =>
        w.includes("[external-cache] skip-large kind=fetch")
      ),
      true,
    );

    // 上限内の payload では skip-large を出さない
    warnings.length = 0;
    await withCache(
      "fetch",
      { url: "https://example.com/small" },
      () => Promise.resolve({ url: "https://example.com/small", text: "小" }),
    );
    assertEquals(
      warnings.some((w) => w.includes("skip-large")),
      false,
    );
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

Deno.test("withCache: ローダーの例外は握り潰さず呼び出し元へ伝播する", async () => {
  const restore = withEnv(NO_DB);
  try {
    await assertRejects(
      () =>
        withCache(
          "serper",
          { q: "x" },
          () => Promise.reject(new Error("Serper API error: 500")),
        ),
      Error,
      "Serper API error: 500",
    );
  } finally {
    restore();
  }
});
