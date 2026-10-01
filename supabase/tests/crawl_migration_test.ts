// migrationの安全境界をofflineで確認する。DB reset/外部接続は行わない。
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const migrationPath = new URL(
  "../migrations/202608300006_safe_crawl_queue.sql",
  import.meta.url,
);

Deno.test("safe crawl migration: queue/RPC/budget/origin/robots cacheの境界を持つ", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  for (
    const required of [
      "create table public.crawl_queue",
      "create table public.crawl_budget_accounts",
      "create table public.crawl_origins",
      "create table public.crawl_robots_cache",
      "enqueue_crawl_queue_item",
      "lease_crawl_queue_item",
      "renew_crawl_queue_lease",
      "complete_crawl_queue_item",
      "fail_crawl_queue_item",
      "mark_crawl_queue_dead",
      "record_crawl_origin_policy",
      "idempotency_key text not null unique",
      "content_hash text",
      "status in ('pending', 'in_flight', 'done', 'failed', 'dead')",
      "create unique index idx_crawl_queue_active_canonical",
      "oisint-crawl-url:",
      "grant execute on function public.enqueue_crawl_queue_item",
    ]
  ) {
    assertStringIncludes(sql, required, required);
  }
  assertEquals(sql.includes("pg_cron"), false);
  assertEquals(sql.includes("schedule("), false);
  assertEquals(/raw_html|raw_text|html_body|page_text/i.test(sql), false);
  assertEquals(sql.includes("max_depth smallint not null default 2"), true);
  assertEquals(
    sql.includes("max_pages_per_origin integer not null default 10"),
    true,
  );
  assertEquals(
    sql.includes("max_pages_total integer not null default 50"),
    true,
  );
  assertEquals(
    sql.includes("max_bytes_per_response integer not null default 500000"),
    true,
  );
  assertEquals(
    sql.includes("max_bytes_total bigint not null default 10000000"),
    true,
  );
  assertEquals(
    sql.includes("crawl_delay_seconds integer not null default 10"),
    true,
  );
  assert(sql.includes("attempt between 0 and 4"));
  assert(sql.includes("expires_at timestamptz not null"));
});
