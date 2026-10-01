// source_quality.ts のユニットテスト (spec.md §14 ソース信頼度 / §17 freshness / §32 TTL)
// classifySourceType の URL 分類、sourceQuality の重み順序、freshnessScore の境界、
// ttlHours の kind 別テーブル、clamp の挙動を検証する。純関数のみ・ネットワーク不要。
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  clamp,
  classifySourceType,
  freshnessScore,
  sourceQuality,
  ttlHours,
} from "../functions/_shared/source_quality.ts";
import type { SourceType } from "../functions/_shared/types.ts";

// ============================================================
// classifySourceType (§14)
// ============================================================

Deno.test("classifySourceType: 大手グルメサイト (hotpepper / gnavi / hitosara) は major_place_provider", () => {
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
});

Deno.test("classifySourceType: レビューサイト (tabelog / retty / Google Maps) は major_review_platform", () => {
  assertEquals(
    classifySourceType("https://tabelog.com/tokyo/A1305/A130501/13000000/"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://retty.me/area/PRE13/"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://www.google.com/maps/place/%E7%84%BC%E8%82%89"),
    "major_review_platform",
  );
  assertEquals(
    classifySourceType("https://maps.google.com/?q=nikumitsu"),
    "major_review_platform",
  );
});

Deno.test("classifySourceType: 予約系ホスト (tablecheck / toreta / yoyaku) は official_reservation", () => {
  assertEquals(
    classifySourceType("https://www.tablecheck.com/shops/nikumitsu/reserve"),
    "official_reservation",
  );
  assertEquals(
    classifySourceType("https://yoyaku.toreta.in/nikumitsu"),
    "official_reservation",
  );
});

Deno.test("classifySourceType: placeName が host に含まれる独自ドメインのみ official_site", () => {
  // ASCII 化した店名 (4 文字以上) が host に含まれる場合のみ公式扱い
  assertEquals(
    classifySourceType("https://nikumitsu-ikebukuro.example.jp/", "NikuMitsu"),
    "official_site",
  );
  // 日本語のみの店名は ASCII 化すると空 → official_site 判定は発動しない (安全側)
  assertEquals(
    classifySourceType(
      "https://nikumitsu-ikebukuro.example.jp/",
      "にくみつ 池袋店",
    ),
    "other_public_page",
  );
  // ASCII 3 文字以下も発動しない
  assertEquals(
    classifySourceType("https://abc.example.jp/", "abc"),
    "other_public_page",
  );
});

Deno.test("classifySourceType: 大手に該当しない未知ドメインは other_public_page (unknown ではない)", () => {
  assertEquals(
    classifySourceType("https://blog.example.com/gourmet/123"),
    "other_public_page",
  );
});

Deno.test("classifySourceType: URL としてパース不能な入力は unknown", () => {
  assertEquals(classifySourceType("こんにちは"), "unknown");
  assertEquals(classifySourceType(""), "unknown");
  assertEquals(classifySourceType("htp:/broken"), "unknown");
});

Deno.test("classifySourceType: 判定順序は place_provider > review > reservation", () => {
  // hotpepper ドメイン内の予約ページ ('yoyaku' を含む) でも major_place_provider が先勝ち
  assertEquals(
    classifySourceType("https://www.hotpepper.jp/yoyaku/strJ001/"),
    "major_place_provider",
  );
});

Deno.test("classifySourceType: クエリ文字列の大手ドメイン名では昇格しない", () => {
  // #188/#206: hostnameのドット境界付き一致だけを信頼し、queryによる品質吊り上げを拒否する。
  assertEquals(
    classifySourceType("https://evil.example.com/?ref=tabelog.com"),
    "other_public_page",
  );
});

Deno.test("classifySourceType: pathのreserve部分一致では予約サイトへ昇格しない", () => {
  // #188/#206: reservation判定もhostname境界へ限定する。
  assertEquals(
    classifySourceType("https://example.com/press/all-rights-reserved"),
    "other_public_page",
  );
});

// ============================================================
// sourceQuality (§14 固定 heuristic)
// ============================================================

Deno.test("sourceQuality: §14 の固定値どおり", () => {
  assertEquals(sourceQuality("official_site"), 1.0);
  assertEquals(sourceQuality("official_reservation"), 0.95);
  assertEquals(sourceQuality("major_place_provider"), 0.85);
  assertEquals(sourceQuality("major_review_platform"), 0.75);
  assertEquals(sourceQuality("other_public_page"), 0.55);
  assertEquals(sourceQuality("unknown"), 0.4);
});

Deno.test("sourceQuality: official ≥ major ≥ other ≥ unknown の順序が保たれる", () => {
  const order: SourceType[] = [
    "official_site",
    "official_reservation",
    "major_place_provider",
    "major_review_platform",
    "other_public_page",
    "unknown",
  ];
  for (let i = 1; i < order.length; i++) {
    assert(
      sourceQuality(order[i - 1]) >= sourceQuality(order[i]),
      `${order[i - 1]} < ${order[i]} になっている`,
    );
  }
});

Deno.test("sourceQuality: 未知の source_type は unknown と同じ 0.4 へフォールバック", () => {
  assertEquals(sourceQuality("bogus_type" as SourceType), 0.4);
});

// ============================================================
// freshnessScore (§17: clamp(1 - ageDays/180, 0, 1))
// ============================================================

const NOW = new Date("2026-08-15T00:00:00Z");

Deno.test("freshnessScore: 観測直後は 1.0、90 日で 0.5、180 日で 0", () => {
  assertEquals(freshnessScore(new Date("2026-08-15T00:00:00Z"), NOW), 1.0);
  assertAlmostEquals(
    freshnessScore(new Date("2026-05-17T00:00:00Z"), NOW),
    0.5,
  ); // 90 日前
  assertEquals(freshnessScore(new Date("2026-02-16T00:00:00Z"), NOW), 0); // 180 日前
});

Deno.test("freshnessScore: 180 日超は 0 で下限クランプ、未来日付は 1 で上限クランプ", () => {
  assertEquals(freshnessScore(new Date("2025-08-15T00:00:00Z"), NOW), 0); // 365 日前
  assertEquals(freshnessScore(new Date("2026-08-25T00:00:00Z"), NOW), 1); // 10 日未来
});

Deno.test("freshnessScore: 不正な日付はNaNを伝播せず中立値0.5へ倒す", () => {
  // #188/#206: 不明な観測日時が合成スコア全体をNaN化しないことを固定する。
  assertEquals(freshnessScore(new Date("garbage"), NOW), 0.5);
});

// ============================================================
// ttlHours (§32 source_type 別 TTL)
// ============================================================

Deno.test("ttlHours: official_site/major_place_provider=24h, other_public_page=72h", () => {
  assertEquals(ttlHours("official_site"), 24);
  assertEquals(ttlHours("major_place_provider"), 24);
  assertEquals(ttlHours("other_public_page"), 72);
});

Deno.test("ttlHours: テーブルにない kind は既定 24h", () => {
  assertEquals(ttlHours("official_reservation"), 24);
  assertEquals(ttlHours("major_review_platform"), 24);
  assertEquals(ttlHours("unknown"), 24);
});

// ============================================================
// clamp
// ============================================================

Deno.test("clamp: 範囲内はそのまま、範囲外は端へ丸める", () => {
  assertEquals(clamp(0.3, 0, 1), 0.3);
  assertEquals(clamp(-5, 0, 1), 0);
  assertEquals(clamp(5, 0, 1), 1);
  assertEquals(clamp(0, 0, 1), 0);
  assertEquals(clamp(1, 0, 1), 1);
});
