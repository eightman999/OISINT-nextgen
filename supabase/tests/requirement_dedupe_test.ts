import { assertEquals } from "@std/assert";
import {
  dedupeRequirements,
  normalizeRequirementDedupeText,
  validateAndDedupeParsedRequirements,
} from "../functions/_shared/requirement_dedupe.ts";
import type { ParsedRequirements } from "../functions/_shared/validation.ts";

type ParsedRequirement = ParsedRequirements["requirements"][number];

Deno.test("requirement dedupe: Issue #524 の反復条件を1件に統合しweight/priorityを増幅しない", () => {
  const requirements: ParsedRequirement[] = [
    {
      text: "場所: 天神",
      normalizedText: "場所: 天神",
      kind: "location",
      priority: "must",
      weight: 1,
    },
    {
      text: "場所: 天神",
      normalizedText: "場所： 天神",
      kind: "location",
      priority: "must",
      weight: 1,
    },
    {
      text: "3000円前後のビュッフェ",
      normalizedText: "3000円前後のビュッフェ",
      kind: "budget",
      priority: "must",
      weight: 1,
    },
    {
      text: "好き: 肉",
      normalizedText: "好き: 肉",
      kind: "cuisine",
      priority: "should",
      weight: 0.7,
    },
    {
      text: "好き: 肉",
      normalizedText: "好き：　肉",
      kind: "cuisine",
      priority: "must",
      weight: 1,
    },
    {
      text: "避けたい: 高価格",
      normalizedText: "避けたい: 高価格",
      kind: "budget",
      priority: "should",
      weight: 0.6,
    },
    {
      text: "避けたい: 高価格",
      normalizedText: "避けたい： 高価格",
      kind: "budget",
      priority: "must",
      weight: 0.9,
    },
  ];

  const actual = dedupeRequirements(requirements);

  assertEquals(actual.length, 4);
  assertEquals(
    actual.filter((r) => r.normalizedText.includes("天神")).length,
    1,
  );
  assertEquals(actual.filter((r) => r.normalizedText.includes("肉")).length, 1);
  assertEquals(
    actual.filter((r) => r.normalizedText.includes("高価格")).length,
    1,
  );
  assertEquals(
    actual.find((r) => r.normalizedText.includes("肉"))?.weight,
    0.7,
  );
  assertEquals(
    actual.find((r) => r.normalizedText.includes("肉"))?.priority,
    "should",
  );
  assertEquals(
    actual.find((r) => r.normalizedText.includes("高価格"))?.weight,
    0.6,
  );
  assertEquals(
    actual.find((r) => r.normalizedText.includes("高価格"))?.priority,
    "should",
  );
});

Deno.test("requirement dedupe key: 全角半角・英字大小・代表記号・空白を最小限正規化する", () => {
  assertEquals(
    normalizeRequirementDedupeText("  ＬＩＫＥ：　肉。 "),
    normalizeRequirementDedupeText("like: 肉．"),
  );
});

Deno.test("requirement dedupe boundary: 具体予算と抽象的な価格回避を別件として保持する", () => {
  const requirements: ParsedRequirement[] = [
    {
      text: "3000円前後",
      normalizedText: "予算 3000円前後",
      kind: "budget",
      priority: "must",
      weight: 1,
    },
    {
      text: "高価格を避けたい",
      normalizedText: "高価格を避けたい",
      kind: "budget",
      priority: "should",
      weight: 0.6,
    },
  ];

  assertEquals(dedupeRequirements(requirements), requirements);
});

Deno.test("requirement dedupe boundary: location / cuisine の異なる複数条件を保持する", () => {
  const requirements: ParsedRequirement[] = [
    {
      text: "天神",
      normalizedText: "天神",
      kind: "location",
      priority: "must",
      weight: 1,
    },
    {
      text: "博多駅周辺",
      normalizedText: "博多駅周辺",
      kind: "location",
      priority: "should",
      weight: 0.8,
    },
    {
      text: "肉料理",
      normalizedText: "肉料理",
      kind: "cuisine",
      priority: "should",
      weight: 0.7,
    },
    {
      text: "和食",
      normalizedText: "和食",
      kind: "cuisine",
      priority: "nice",
      weight: 0.5,
    },
  ];

  assertEquals(dedupeRequirements(requirements), requirements);
});

Deno.test("requirement dedupe boundary: normalizedText が同一でも kind が異なれば保持する", () => {
  const requirements: ParsedRequirement[] = [
    {
      text: "新宿",
      normalizedText: "新宿",
      kind: "location",
      priority: "must",
      weight: 1,
    },
    {
      text: "新宿",
      normalizedText: "新宿",
      kind: "other",
      priority: "nice",
      weight: 0.4,
    },
  ];

  assertEquals(dedupeRequirements(requirements), requirements);
});

Deno.test("create 共通入口: 新規 provider 相当の重複出力を shape 検証後に統合する", () => {
  const first: ParsedRequirement = {
    text: "好き: 肉",
    normalizedText: "好き: 肉",
    kind: "cuisine",
    priority: "should",
    weight: 0.7,
  };
  const result = validateAndDedupeParsedRequirements({
    title: "8/18 天神 夜飯",
    normalizedQuery: "天神 肉",
    area: "天神",
    requirements: [
      first,
      {
        ...first,
        normalizedText: "好き：　肉",
        priority: "must",
        weight: 1,
      },
    ],
  });

  assertEquals(result.success, true);
  if (!result.success) return;
  assertEquals(result.data.requirements, [first]);
});
