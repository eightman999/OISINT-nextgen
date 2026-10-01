// provider_ttl.ts の純ユニット (#289 / spec.md §32, §44.3 L1)
// リクルート API 利用規約「キャッシュの更新頻度を24時間以内」への対応判定を検証する。
// - needsProviderRefresh: live 実行時に places 行を provider から再取得すべきか
// - isEvidenceWithinTtl: Evidence が §32 TTL 内 (再利用・knownClaims の対象) か。
//   TTL 外は insertEvidenceIfStale が再利用せず新規行を再生成する (同じ cutoff 意味論)
import { assertEquals } from "@std/assert";
import {
  isEvidenceWithinTtl,
  needsProviderRefresh,
  PROVIDER_TTL_HOURS,
  selectRefreshTargets,
} from "../functions/_shared/provider_ttl.ts";
import { GeoapifyPlaceProvider } from "../functions/_shared/providers/geoapify.ts";
import { MockPlaceProvider } from "../functions/_shared/providers/mock_place.ts";
import type { PlaceSearchProvider } from "../functions/_shared/providers/types.ts";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

// ============================================================
// needsProviderRefresh (places 行の 24h 判定)
// ============================================================

Deno.test("needsProviderRefresh: 24h 以内の TTL provider 行は再取得しない", () => {
  assertEquals(PROVIDER_TTL_HOURS, 24);
  assertEquals(
    needsProviderRefresh(
      { provider: "ttl-provider", refreshed_at: hoursAgo(23) },
      NOW,
    ),
    false,
  );
  assertEquals(
    needsProviderRefresh(
      { provider: "ttl-provider", refreshed_at: hoursAgo(0) },
      NOW,
    ),
    false,
  );
});

Deno.test("needsProviderRefresh: 24h 超の TTL provider 行は再取得する", () => {
  assertEquals(
    needsProviderRefresh(
      { provider: "ttl-provider", refreshed_at: hoursAgo(25) },
      NOW,
    ),
    true,
  );
});

Deno.test("needsProviderRefresh: ちょうど 24h は安全側 = 再取得する", () => {
  assertEquals(
    needsProviderRefresh(
      { provider: "ttl-provider", refreshed_at: hoursAgo(24) },
      NOW,
    ),
    true,
  );
});

Deno.test("needsProviderRefresh: mock 行は経過時間に関わらず再取得しない (§5.4 Fallback 不変)", () => {
  assertEquals(
    needsProviderRefresh(
      { provider: "mock", refreshed_at: hoursAgo(100) },
      NOW,
    ),
    false,
  );
  assertEquals(
    needsProviderRefresh({ provider: "mock", refreshed_at: null }, NOW),
    false,
  );
});

Deno.test("needsProviderRefresh: refreshed_at が null / 不正なら安全側 = 再取得する", () => {
  assertEquals(
    needsProviderRefresh({ provider: "ttl-provider", refreshed_at: null }, NOW),
    true,
  );
  assertEquals(
    needsProviderRefresh(
      { provider: "ttl-provider", refreshed_at: "not-a-date" },
      NOW,
    ),
    true,
  );
});

Deno.test("needsProviderRefresh: persistent provider は古くても自動再取得しない", () => {
  const row = { provider: "geoapify", refreshed_at: hoursAgo(999) };
  assertEquals(needsProviderRefresh(row, NOW, null), false);
  assertEquals(
    selectRefreshTargets([row], "geoapify", NOW, null),
    { targets: [], skipped: 0 },
  );
});

// ============================================================
// isEvidenceWithinTtl (Evidence の §32 TTL 判定)
// ============================================================

Deno.test("isEvidenceWithinTtl: 24h 以内の provider 由来 Evidence は表示・再利用の対象", () => {
  assertEquals(
    isEvidenceWithinTtl(
      { source_type: "major_place_provider", observed_at: hoursAgo(23) },
      NOW,
    ),
    true,
  );
});

Deno.test("isEvidenceWithinTtl: 24h 超の provider 由来 Evidence は対象から外れる (再生成される)", () => {
  assertEquals(
    isEvidenceWithinTtl(
      { source_type: "major_place_provider", observed_at: hoursAgo(25) },
      NOW,
    ),
    false,
  );
  // ちょうど 24h も期限切れ (insertEvidenceIfStale の gt cutoff と同じ境界)
  assertEquals(
    isEvidenceWithinTtl(
      { source_type: "major_place_provider", observed_at: hoursAgo(24) },
      NOW,
    ),
    false,
  );
});

Deno.test("isEvidenceWithinTtl: other_public_page は §32 の 72h TTL", () => {
  assertEquals(
    isEvidenceWithinTtl(
      { source_type: "other_public_page", observed_at: hoursAgo(71) },
      NOW,
    ),
    true,
  );
  assertEquals(
    isEvidenceWithinTtl(
      { source_type: "other_public_page", observed_at: hoursAgo(73) },
      NOW,
    ),
    false,
  );
});

Deno.test("isEvidenceWithinTtl: observed_at が不正なら安全側 = 期限切れ扱い", () => {
  assertEquals(
    isEvidenceWithinTtl(
      { source_type: "major_place_provider", observed_at: "broken" },
      NOW,
    ),
    false,
  );
});

// ============================================================
// provider ごとの fetchByIds 実装有無 (mock 挙動不変の担保)
// ============================================================

Deno.test("MockPlaceProvider は fetchByIds を実装しない (mock モードで再取得が走らない)", () => {
  const mock: PlaceSearchProvider = new MockPlaceProvider();
  assertEquals(typeof mock.fetchByIds, "undefined");
});

Deno.test("GeoapifyPlaceProvider は明示的な個別取得経路を実装する", () => {
  const live: PlaceSearchProvider = new GeoapifyPlaceProvider();
  assertEquals(typeof live.fetchByIds, "function");
});

// #530: provider 切替後に legacy 行を巻き込むと再取得が全滅する回帰テスト。
// 旧 provider の provider_place_id を Geoapify の place-details へ
// 渡すと HTTP 400 Invalid Place ID になり、fetchByIds が最初の 1 件で throw するため
// 同じ調査内の geoapify 由来 places の再取得も失われた。
Deno.test("selectRefreshTargets: 現 provider 由来の stale 行だけを対象にする", () => {
  const rows = [
    {
      provider: "geoapify",
      provider_place_id: "51f0a1",
      refreshed_at: hoursAgo(30),
    },
    {
      provider: "geoapify",
      provider_place_id: "51f0a2",
      refreshed_at: hoursAgo(1),
    },
    {
      provider: "legacy-provider",
      provider_place_id: "legacy-place-001",
      refreshed_at: hoursAgo(99),
    },
  ];

  const { targets, skipped } = selectRefreshTargets(rows, "geoapify", NOW, 24);

  // legacy provider 行は、どれだけ古くても現 provider へは渡さない
  assertEquals(targets.map((r) => r.provider_place_id), ["51f0a1"]);
  assertEquals(skipped, 1);
});

Deno.test("selectRefreshTargets: 対象ゼロでも skipped 件数を返す (可視化のため)", () => {
  const rows = [
    {
      provider: "legacy-provider",
      provider_place_id: "legacy-place-001",
      refreshed_at: hoursAgo(99),
    },
  ];

  const { targets, skipped } = selectRefreshTargets(rows, "geoapify", NOW);

  assertEquals(targets, []);
  assertEquals(skipped, 1);
});

Deno.test("selectRefreshTargets: mock 行は現 provider でも再取得しない (§5.4 Fallback 不変)", () => {
  const rows = [
    {
      provider: "mock",
      provider_place_id: "mock-001",
      refreshed_at: hoursAgo(99),
    },
  ];

  assertEquals(selectRefreshTargets(rows, "mock", NOW).targets, []);
});
