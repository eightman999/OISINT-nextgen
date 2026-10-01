// §15 比較ルールの境界値テスト
import { assertEquals } from "@std/assert";
import {
  closingMinutes,
  detectCombinedContradictions,
  detectContradictions,
  type EvidenceForContradiction,
} from "../functions/_shared/contradiction.ts";
import type { StructuredClaim } from "../functions/_shared/types.ts";
import { filterValidClaims } from "../functions/_shared/validation.ts";

const ev = (
  id: string,
  claims: StructuredClaim[],
  quality = 0.8,
): EvidenceForContradiction => ({
  id,
  placeId: "place-1",
  sourceQuality: quality,
  structuredClaims: claims,
});

const claim = (
  key: StructuredClaim["key"],
  value: unknown,
): StructuredClaim => ({
  key,
  value,
  rawText: "test",
});

Deno.test("boolean: card_accepted の true/false は矛盾", () => {
  const out = detectContradictions([
    ev("e1", [claim("card_accepted", true)]),
    ev("e2", [claim("card_accepted", false)]),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].key, "card_accepted");
  assertEquals(out[0].entries.length, 2);
});

Deno.test("filter boolean: 禁煙・Wi-Fi・子連れ対応のtrue/falseは矛盾", () => {
  for (
    const key of [
      "non_smoking",
      "wifi_available",
      "child_friendly",
    ] as const
  ) {
    const out = detectContradictions([
      ev("e1", [claim(key, true)]),
      ev("e2", [claim(key, false)]),
    ]);
    assertEquals(out.map((item) => item.key), [key]);
  }
});

Deno.test("nearest_station_walk_minutes: 明示された整数分が異なれば矛盾", () => {
  assertEquals(
    detectContradictions([
      ev("e1", [claim("nearest_station_walk_minutes", 5)]),
      ev("e2", [claim("nearest_station_walk_minutes", 5)]),
    ]).length,
    0,
  );
  assertEquals(
    detectContradictions([
      ev("e1", [claim("nearest_station_walk_minutes", 5)]),
      ev("e2", [claim("nearest_station_walk_minutes", 6)]),
    ]).map((item) => item.key),
    ["nearest_station_walk_minutes"],
  );
});

Deno.test("opening_hours: 閉店29分ずれは矛盾でない、30分ずれは矛盾", () => {
  const near = detectContradictions([
    ev("e1", [claim("opening_hours", "17:00-22:31")]),
    ev("e2", [claim("opening_hours", "17:00-23:00")]),
  ]);
  assertEquals(near.length, 0);

  const far = detectContradictions([
    ev("e1", [claim("opening_hours", "17:00-22:30")]),
    ev("e2", [claim("opening_hours", "17:00-23:00")]),
  ]);
  assertEquals(far.length, 1);
});

Deno.test("opening_hours: 深夜越え (18:00-01:00) を閉店25時として扱う", () => {
  assertEquals(closingMinutes("18:00-01:00"), 25 * 60);
  for (const invalid of ["25:00-26:00", "09:99-10:99", "99:99-99:59"]) {
    assertEquals(closingMinutes(invalid), null, invalid);
    assertEquals(
      filterValidClaims([claim("opening_hours", invalid)]).length,
      0,
    );
  }
  assertEquals(
    filterValidClaims([claim("opening_hours", "24:00-02:00")]).length,
    1,
  );
});

Deno.test("budget_dinner: 区間が接していれば矛盾でない、離れていれば矛盾", () => {
  const touching = detectContradictions([
    ev("e1", [claim("budget_dinner", { min: 2000, max: 3000 })]),
    ev("e2", [claim("budget_dinner", { min: 3000, max: 4000 })]),
  ]);
  assertEquals(touching.length, 0);

  const disjoint = detectContradictions([
    ev("e1", [claim("budget_dinner", { min: 2000, max: 2900 })]),
    ev("e2", [claim("budget_dinner", { min: 3000, max: 4000 })]),
  ]);
  assertEquals(disjoint.length, 1);
  assertEquals(
    filterValidClaims([claim("budget_dinner", { min: 9000, max: 1000 })])
      .length,
    0,
  );
});

Deno.test("capacity: 1.9倍は矛盾でない、2倍は矛盾", () => {
  const near = detectContradictions([
    ev("e1", [claim("capacity", 20)]),
    ev("e2", [claim("capacity", 38)]),
  ]);
  assertEquals(near.length, 0);

  const far = detectContradictions([
    ev("e1", [claim("capacity", 20)]),
    ev("e2", [claim("capacity", 40)]),
  ]);
  assertEquals(far.length, 1);
});

Deno.test("genre / noise_level は比較しない (§15)", () => {
  const out = detectContradictions([
    ev("e1", [claim("genre", ["焼肉"]), claim("noise_level", "quiet")]),
    ev("e2", [claim("genre", ["イタリアン"]), claim("noise_level", "loud")]),
  ]);
  assertEquals(out.length, 0);
});

Deno.test("同一 Evidence 内の claim だけでは矛盾にしない (2件未満)", () => {
  const out = detectContradictions([
    ev("e1", [claim("card_accepted", true)]),
  ]);
  assertEquals(out.length, 0);
});

Deno.test("combined矛盾: Evidence間契約を維持しつつ単一row内部相反を1件に統合する", () => {
  const evidence = [
    ev("e1", [
      claim("card_accepted", true),
      claim("card_accepted", false),
    ]),
    ev("e2", [claim("card_accepted", true)]),
  ];

  // cross detector は同一Evidence内のpairを比較しない。
  const cross = detectContradictions(evidence);
  assertEquals(cross.length, 1); // e1(false) vs e2(true) のEvidence間矛盾のみ

  const combined = detectCombinedContradictions(evidence);
  assertEquals(combined.length, 1); // UI/consへ同じkeyの警告を重複させない
  assertEquals(combined[0].key, "card_accepted");
  assertEquals(combined[0].entries.length, 3);
});

Deno.test("パース不能な opening_hours は比較不能として矛盾にしない", () => {
  const out = detectContradictions([
    ev("e1", [claim("opening_hours", "17時〜23時")]),
    ev("e2", [claim("opening_hours", "17:00-22:00")]),
  ]);
  assertEquals(out.length, 0);
});
