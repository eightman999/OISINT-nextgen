// #123 refresh の決定論・fail-closed・mock fixture テスト。
// provider fixture は MockPlaceProvider の固定データだけを使い、外部 API を呼ばない。
import { assertEquals, assertThrows } from "@std/assert";
import {
  addObservationMetric,
  type DemandRefreshConfig,
  emptyDemandRefreshMetrics,
  factSourceVersionChanged,
  parseDemandRefreshConfig,
  type RefreshTargetCandidate,
  resolveRefreshObservation,
  selectRefreshTargets,
} from "../functions/_shared/demand_refresh.ts";
import { MockPlaceProvider } from "../functions/_shared/providers/mock_place.ts";
import type { PlaceSearchResult } from "../functions/_shared/providers/types.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z");

const CONFIG_ROW = {
  config_version: "fixture-v1",
  provider: "mock",
  provider_domain: "mock.oisint.example",
  provider_ttl_hours: 24,
  fact_ttl_hours: 48,
  recent_usage_window_hours: 168,
  batch_size: 3,
  lease_seconds: 60,
  provider_cooldown_seconds: 30,
  usage_weight: 1,
  freshness_weight: 2,
  fact_importance_weight: 3,
  enabled: true,
};

const config = (): DemandRefreshConfig => parseDemandRefreshConfig(CONFIG_ROW);

function candidate(
  placeId: string,
  overrides: Partial<RefreshTargetCandidate> = {},
): RefreshTargetCandidate {
  return {
    placeId,
    provider: "mock",
    providerPlaceId: `mock-${placeId}`,
    sourceUrl: "https://mock.oisint.example/place/mock-001",
    lastUsedAt: "2026-08-30T10:00:00.000Z",
    lastVerifiedAt: "2026-08-28T10:00:00.000Z",
    refreshedAt: "2026-08-29T10:00:00.000Z",
    factImportance: 0.5,
    leaseExpiresAt: null,
    lastAttemptedAt: null,
    vectorSourceVersion: null,
    ...overrides,
  };
}

async function mockFixtureResult(
  mode: "unchanged" | "changed" | "provider_error" | "closure",
): Promise<PlaceSearchResult[] | Error> {
  const [base] = await new MockPlaceProvider().search({
    area: "池袋",
    limit: 1,
  });
  if (!base) throw new Error("mock fixture is empty");
  switch (mode) {
    case "unchanged":
      return [base];
    case "changed":
      return [{
        ...base,
        structuredClaims: base.structuredClaims.map((claim) =>
          claim.key === "capacity"
            ? { ...claim, value: 40, rawText: "総席数40席" }
            : claim
        ),
      }];
    case "provider_error":
      return new Error("fixture provider failure");
    case "closure":
      return [];
  }
}

Deno.test("config は TTL/重みを補完せず、欠落・disabled を停止側へ倒す", () => {
  assertEquals(parseDemandRefreshConfig(CONFIG_ROW).batchSize, 3);
  assertThrows(
    () =>
      parseDemandRefreshConfig({ ...CONFIG_ROW, fact_ttl_hours: undefined }),
  );
  assertThrows(
    () => parseDemandRefreshConfig({ ...CONFIG_ROW, enabled: false }),
  );
  assertThrows(
    () =>
      parseDemandRefreshConfig({
        ...CONFIG_ROW,
        usage_weight: 0,
        freshness_weight: 0,
        fact_importance_weight: 0,
      }),
  );
});

Deno.test("selectRefreshTargets は需要・鮮度・importance順を固定し、対象外を除く", () => {
  const rows = [
    candidate("place-a", { factImportance: 0.5 }),
    candidate("place-b", {
      lastUsedAt: "2026-08-30T11:00:00.000Z",
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
      refreshedAt: "2026-08-25T08:00:00.000Z",
      factImportance: 0.9,
    }),
    // recent usage window 外
    candidate("place-c", { lastUsedAt: "2026-08-20T00:00:00.000Z" }),
    // provider が異なる
    candidate("place-d", { provider: "other" }),
    // provider TTL 内
    candidate("place-e", { refreshedAt: "2026-08-30T11:00:00.000Z" }),
    // fact TTL 内
    candidate("place-f", { lastVerifiedAt: "2026-08-30T11:00:00.000Z" }),
  ];
  assertEquals(
    selectRefreshTargets(rows, 2, config(), NOW).map((row) => row.placeId),
    ["place-b", "place-a"],
  );
});

Deno.test("selectRefreshTargets は score 同点を place_id で決定する", () => {
  const rows = [candidate("place-z"), candidate("place-y")];
  assertEquals(
    selectRefreshTargets(rows, 2, config(), NOW).map((row) => row.placeId),
    ["place-y", "place-z"],
  );
});

Deno.test("mock fixture の unchanged/changed/provider error/closure を分離する", async () => {
  const target = {
    provider: "mock",
    providerPlaceId: "mock-001",
  };
  const unchanged = await mockFixtureResult("unchanged");
  const changed = await mockFixtureResult("changed");
  const providerError = await mockFixtureResult("provider_error");
  const closure = await mockFixtureResult("closure");

  const unchangedResolution = resolveRefreshObservation(
    target,
    unchanged,
    null,
  );
  assertEquals(unchangedResolution.kind, "found");
  assertEquals(
    factSourceVersionChanged("place-facts-v1-same", "place-facts-v1-same"),
    false,
  );

  const changedResolution = resolveRefreshObservation(target, changed, null);
  assertEquals(changedResolution.kind, "found");
  assertEquals(
    factSourceVersionChanged("place-facts-v1-before", "place-facts-v1-after"),
    true,
  );

  const providerErrorResolution = resolveRefreshObservation(
    target,
    [],
    providerError,
  );
  assertEquals(providerErrorResolution.kind, "provider_error");
  assertEquals(providerErrorResolution.errorCode, "provider_error");

  const closureResolution = resolveRefreshObservation(target, closure, null);
  assertEquals(closureResolution.kind, "closure_suspected");
  assertEquals(closureResolution.errorCode, "provider_missing_place");
});

Deno.test("run metrics は outcome 別に加算される", () => {
  let metrics = emptyDemandRefreshMetrics();
  metrics = addObservationMetric(metrics, "unchanged", true);
  metrics = addObservationMetric(metrics, "changed", true);
  metrics = addObservationMetric(metrics, "provider_error");
  metrics = addObservationMetric(metrics, "closure_suspected");
  metrics = addObservationMetric(metrics, "storage_error");
  assertEquals(metrics.processed, 5);
  assertEquals(metrics.unchanged, 1);
  assertEquals(metrics.changed, 1);
  assertEquals(metrics.providerErrors, 1);
  assertEquals(metrics.closureSuspected, 1);
  assertEquals(metrics.storageErrors, 1);
  assertEquals(metrics.evidenceAppended, 2);
});
