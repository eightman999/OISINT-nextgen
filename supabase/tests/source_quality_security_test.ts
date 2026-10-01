import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  clamp,
  classifySourceType,
  freshnessScore,
  sourceQuality,
  ttlHours,
} from "../functions/_shared/source_quality.ts";
import type { SourceType } from "../functions/_shared/types.ts";

Deno.test("source type: 大手媒体の正規ドメインとサブドメインを分類する", () => {
  assertEquals(
    classifySourceType("https://www.hotpepper.jp/strJ001177996/"),
    "major_place_provider",
  );
  assertEquals(
    classifySourceType("https://r.gnavi.co.jp/abc123/"),
    "major_place_provider",
  );
  assertEquals(
    classifySourceType("https://hitosara.com/0006012345/"),
    "major_place_provider",
  );
  assertEquals(
    classifySourceType("https://tabelog.com/tokyo/1"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://sub.retty.me/area/1"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://maps.google.com/?q=shop"),
    "major_review_platform",
  );
});

Deno.test("source type: Google本体は/maps配下だけをレビュー媒体へ昇格する", () => {
  assertEquals(
    classifySourceType("https://www.google.com/maps/place/example"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://www.google.co.jp/maps/place/example"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://www.google.com/search?q=tabelog"),
    "other_public_page",
  );
});

Deno.test("source type: 予約ドメインとhostname完全labelを分類する", () => {
  assertEquals(
    classifySourceType("https://shop.tablecheck.com/shops/1"),
    "official_reservation",
  );
  assertEquals(
    classifySourceType("https://yoyaku.toreta.in/shop"),
    "official_reservation",
  );
  assertEquals(
    classifySourceType("https://reserve.example.com/table/1"),
    "official_reservation",
  );
  assertEquals(
    classifySourceType("https://myreserve.example.com/table/1"),
    "other_public_page",
  );
  assertEquals(
    classifySourceType("https://reserved-domain.example.com/"),
    "other_public_page",
  );
});

Deno.test("source type: query/path/紛らわしいsuffixでは信頼度を昇格しない", () => {
  const untrusted = [
    "https://evil.example.com/?ref=tabelog.com",
    "https://evil.example.com/hotpepper.jp/shop",
    "https://evil.example.com/press/all-rights-reserved",
    "https://eviltabelog.com/shop/1",
    "https://fakehotpepper.jp/str/1",
  ];
  for (const url of untrusted) {
    assertEquals(classifySourceType(url), "other_public_page");
  }
});

Deno.test("source type: HTTP(S)以外・壊れたURLを信頼度分類しない", () => {
  assertEquals(classifySourceType("file://tabelog.com/private"), "unknown");
  assertEquals(classifySourceType("ftp://hotpepper.jp/shop"), "unknown");
  assertEquals(classifySourceType("htp:/broken"), "unknown");
  assertEquals(classifySourceType("not a url"), "unknown");
});

Deno.test("source type: hostname末尾ドットを正規化する", () => {
  assertEquals(
    classifySourceType("https://www.hotpepper.jp./strJ001177996/"),
    "major_place_provider",
  );
});

Deno.test("source type: placeNameがhostに十分一致する場合だけ公式サイト候補にする", () => {
  assertEquals(
    classifySourceType("https://nikumitsu-ikebukuro.example.jp/", "NikuMitsu"),
    "official_site",
  );
  assertEquals(
    classifySourceType(
      "https://nikumitsu-ikebukuro.example.jp/",
      "にくみつ 池袋店",
    ),
    "other_public_page",
  );
  assertEquals(
    classifySourceType("https://abc.example.jp/", "abc"),
    "other_public_page",
  );
});

Deno.test("sourceQuality: §14固定値と順序を維持する", () => {
  const expected: Array<[SourceType, number]> = [
    ["official_site", 1],
    ["official_reservation", 0.95],
    ["major_place_provider", 0.85],
    ["major_review_platform", 0.75],
    ["other_public_page", 0.55],
    ["unknown", 0.4],
  ];
  for (const [type, score] of expected) {
    assertEquals(sourceQuality(type), score);
  }
  for (let index = 1; index < expected.length; index += 1) {
    assert(
      sourceQuality(expected[index - 1][0]) >=
        sourceQuality(expected[index][0]),
    );
  }
  assertEquals(sourceQuality("unexpected" as SourceType), 0.4);
});

const NOW = new Date("2026-08-15T00:00:00Z");

Deno.test("freshness: 0/90/180日と範囲外を決定論的にclampする", () => {
  assertEquals(freshnessScore(new Date("2026-08-15T00:00:00Z"), NOW), 1);
  assertAlmostEquals(
    freshnessScore(new Date("2026-05-17T00:00:00Z"), NOW),
    0.5,
  );
  assertEquals(freshnessScore(new Date("2026-02-16T00:00:00Z"), NOW), 0);
  assertEquals(freshnessScore(new Date("2025-08-15T00:00:00Z"), NOW), 0);
  assertEquals(freshnessScore(new Date("2026-08-25T00:00:00Z"), NOW), 1);
});

Deno.test("freshness: 不正日時はNaNを伝播せず中立値へフォールバックする", () => {
  assertEquals(freshnessScore(new Date("invalid"), NOW), 0.5);
  assertEquals(freshnessScore(NOW, new Date("invalid")), 0.5);
});

Deno.test("ttlHoursとclamp: §32既定値と境界を維持する", () => {
  assertEquals(ttlHours("official_site"), 24);
  assertEquals(ttlHours("major_place_provider"), 24);
  assertEquals(ttlHours("other_public_page"), 72);
  assertEquals(ttlHours("unknown"), 24);
  assertEquals(clamp(0.3, 0, 1), 0.3);
  assertEquals(clamp(-5, 0, 1), 0);
  assertEquals(clamp(5, 0, 1), 1);
});
