import { assert, assertEquals, assertFalse } from "@std/assert";
import type { StructuredClaim } from "../functions/_shared/types.ts";
import { MockPlaceProvider } from "../functions/_shared/providers/mock_place.ts";
import type { PlaceSearchResult } from "../functions/_shared/providers/types.ts";
import {
  acceptsDomainResult,
  buildNtRankingBoundary,
  canRunDomainInMode,
  getDomainProfile,
  LODGING_ADAPTER_CONTRACT,
  NT_PROFILE_IDS,
  projectClaimsForDomain,
} from "../functions/_shared/domain_contract.ts";
import { assignRanks } from "../functions/_shared/ranking.ts";
import { claimValuesConflict } from "../functions/_shared/contradiction.ts";
import {
  filterValidClaims,
  type StructuredClaimInput,
  structuredClaimSchema,
} from "../functions/_shared/validation.ts";

const LODGING_CLAIMS: StructuredClaimInput[] = [
  {
    key: "category",
    value: ["business_hotel"],
    rawText: "カテゴリ: ビジネスホテル",
  },
  {
    key: "price_range",
    value: { min: 8000, max: 12000, currency: "JPY", unit: "per_night" },
    rawText: "1泊料金 8000〜12000 JPY",
  },
  { key: "reservation", value: true, rawText: "予約可" },
  { key: "capacity", value: 2, rawText: "定員2名" },
  { key: "amenities", value: ["Wi-Fi", "朝食"], rawText: "設備: Wi-Fi / 朝食" },
  { key: "lodging.room_type", value: "single", rawText: "客室タイプ: single" },
  {
    key: "lodging.check_in_time",
    value: "15:00",
    rawText: "チェックイン15:00",
  },
  {
    key: "lodging.check_out_time",
    value: "10:00",
    rawText: "チェックアウト10:00",
  },
];

Deno.test("#125: 新domainの固定claimは共通validatorを通る", () => {
  const valid = filterValidClaims(LODGING_CLAIMS);
  assertEquals(valid.length, LODGING_CLAIMS.length);
  assert(
    structuredClaimSchema.safeParse(LODGING_CLAIMS[1]).success,
  );
});

Deno.test("#125: lodging adapterはschema/mapping/prompt/UI/停止条件を固定する", () => {
  assertEquals(
    LODGING_ADAPTER_CONTRACT.claimMappings.map((mapping) => mapping.targetKey),
    [
      "category",
      "price_range",
      "reservation",
      "capacity",
      "amenities",
      "lodging.room_type",
      "lodging.check_in_time",
      "lodging.check_out_time",
    ],
  );
  assertEquals(
    LODGING_ADAPTER_CONTRACT.claimMappings.map((mapping) => mapping.schema),
    [
      "category_array",
      "price_range",
      "boolean",
      "positive_number",
      "amenities_array",
      "room_type",
      "clock_time",
      "clock_time",
    ],
  );
  assertEquals(
    LODGING_ADAPTER_CONTRACT.uiLabels["lodging.room_type"],
    "客室タイプ",
  );
  assert(
    LODGING_ADAPTER_CONTRACT.promptFragment.domainInstruction.includes(
      "domain=lodging",
    ),
  );
  assertEquals(LODGING_ADAPTER_CONTRACT.failClosed, {
    liveMode: "deny",
    invalidClaim: "reject",
    unknownClaim: "retain_unknown",
    missingExplicitDomain: "deny",
  });
});

Deno.test("#125: 料金単位・通貨・宿泊時刻の不正値は補完せず破棄する", () => {
  const invalid: StructuredClaimInput[] = [
    {
      key: "price_range",
      value: { min: 8000, max: 12000, currency: "円", unit: "per_night" },
      rawText: "通貨不正",
    },
    {
      key: "price_range",
      value: { min: 8000, max: 12000, currency: "JPY", unit: "per_month" },
      rawText: "単位不正",
    },
    {
      key: "price_range",
      value: {
        min: 8000,
        max: Number.POSITIVE_INFINITY,
        currency: "JPY",
        unit: "per_night",
      },
      rawText: "上限不正",
    },
    {
      key: "lodging.check_in_time",
      value: "15時",
      rawText: "時刻形式不正",
    },
    {
      key: "lodging.check_out_time",
      value: "24:30",
      rawText: "24時台分不正",
    },
  ];
  assertEquals(filterValidClaims(invalid), []);
});

Deno.test("#125: price_rangeは同じ単位だけ比較し、異なる単位はunknown相当で保持する", () => {
  const nightly = { min: 8000, max: 9000, currency: "JPY", unit: "per_night" };
  const expensiveNightly = {
    min: 12000,
    max: 14000,
    currency: "JPY",
    unit: "per_night",
  };
  const hourly = { min: 8000, max: 9000, currency: "JPY", unit: "per_hour" };
  assert(claimValuesConflict("price_range", nightly, expensiveNightly));
  assertFalse(claimValuesConflict("price_range", nightly, hourly));
});

Deno.test("#125: filterValidClaims済みと型付けされた値も投影境界で再検証する", () => {
  const malformed = [
    {
      key: "price_range",
      value: { min: 8000, max: 12000, currency: "円", unit: "per_night" },
      rawText: "通貨不正",
    },
    {
      key: "price_range",
      value: { min: 8000, max: 12000, currency: "JPY", unit: "per_month" },
      rawText: "単位不正",
    },
    {
      key: "price_range",
      value: {
        min: 8000,
        max: Number.POSITIVE_INFINITY,
        currency: "JPY",
        unit: "per_night",
      },
      rawText: "数値不正",
    },
    {
      key: "lodging.check_in_time",
      value: "25:00",
      rawText: "時刻不正",
    },
    { key: "not-a-claim", value: true, rawText: "未知claim" },
  ] as unknown as StructuredClaim[];
  const projection = projectClaimsForDomain("lodging", malformed);
  if (!projection) throw new Error("lodging profile is missing");
  assertEquals(projection.claims, []);
  assertEquals(projection.unknownClaimKeys, []);
  assertEquals(projection.rejectedClaimKeys, [
    "lodging.check_in_time",
    "not-a-claim",
    "price_range",
  ]);
});

Deno.test("#125: 宿泊mockは共通claimとnamespaced claimを同じOISI結果へ投影する", () => {
  const result: PlaceSearchResult = {
    provider: "mock",
    providerPlaceId: "lodging-contract-001",
    domain: "lodging",
    name: "fixture lodging",
    address: "fixture address",
    lat: null,
    lng: null,
    url: "https://mock.oisint.example/lodging-contract-001",
    structuredClaims: filterValidClaims(LODGING_CLAIMS),
    metadata: { mock: true },
  };
  const projection = projectClaimsForDomain(
    result.domain,
    result.structuredClaims,
  );
  if (!projection) throw new Error("lodging profile is missing");
  assertEquals(projection.availability, "mock_only");
  assertEquals(projection.unknownClaimKeys, []);
  assertEquals(projection.claims.map((claim) => claim.key), [
    "category",
    "price_range",
    "reservation",
    "capacity",
    "amenities",
    "lodging.room_type",
    "lodging.check_in_time",
    "lodging.check_out_time",
  ]);
});

Deno.test("#125: lodging指定がrestaurant mock fixtureへ流れる場合は明示domain不一致で拒否する", async () => {
  const provider = new MockPlaceProvider();
  const [fixture] = await provider.search({
    area: "池袋",
    domain: "lodging",
    limit: 1,
  });
  assert(fixture);
  // MockPlaceProviderは現状restaurant互換fixtureをdomain未指定で返す。
  assertEquals(fixture.domain, undefined);
  assert(
    fixture.structuredClaims.some((claim) => claim.key === "budget_dinner"),
  );
  assertFalse(acceptsDomainResult("lodging", fixture));
  assertFalse(canRunDomainInMode("lodging", "live"));
});

Deno.test("#125: profile外のrestaurant/namespaced claimはunknownとして残す", () => {
  const claims = filterValidClaims([
    ...LODGING_CLAIMS,
    { key: "private_room", value: true, rawText: "個室あり" },
  ]);
  const projection = projectClaimsForDomain("rental_space", claims);
  if (!projection) throw new Error("rental_space profile is missing");
  assertEquals(projection.claims.map((claim) => claim.key), [
    "category",
    "price_range",
    "reservation",
    "capacity",
    "amenities",
  ]);
  assertEquals(projection.unknownClaimKeys, [
    "lodging.check_in_time",
    "lodging.check_out_time",
    "lodging.room_type",
    "private_room",
  ]);
});

Deno.test("#125: 未接続domain/liveは実行可とせずfail-closed", () => {
  assert(canRunDomainInMode("restaurant", "live"));
  assert(canRunDomainInMode("lodging", "mock"));
  assertFalse(canRunDomainInMode("lodging", "live"));
  assertFalse(canRunDomainInMode("rental_space", "mock"));
  assertEquals(getDomainProfile("unknown-domain"), null);
});

Deno.test("#125: 全NT profileはdomain別providerでなく同じcandidate ranking境界を使う", () => {
  for (const ntProfile of NT_PROFILE_IDS) {
    assertEquals(
      buildNtRankingBoundary(ntProfile, "lodging"),
      { ntProfile, domain: "lodging", inputKind: "oisi_candidate" },
    );
  }

  // rankingは既存のdomain-neutral関数をそのまま使う。domainで順位を補正しない。
  const ranks = assignRanks([
    { id: "lodging-a", score: 0.8, createdAt: "2026-08-30T00:00:00Z" },
    { id: "restaurant-a", score: 0.7, createdAt: "2026-08-30T00:00:01Z" },
  ]);
  assertEquals(ranks.get("lodging-a"), 1);
  assertEquals(ranks.get("restaurant-a"), 2);
});
