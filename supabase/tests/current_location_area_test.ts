// 「現在地付近×寿司」(座標未提供) の再現テスト (issue #317 / spec.md §29, §31)
//
// クライアントは座標を送らない (現在地対応 #108 は P1) ため、area に使えない
// 「現在地」系の語は keyword のみの検索へフォールバックしなければならない。
//
// live provider (Geoapify) 側の「現在地」経路は tests/geoapify_test.ts が持つ。
// ここは provider 非依存の判定 (isCurrentLocationArea) と、mock のデモ完走を守る。
// 旧 provider は #297 で撤去したため、旧 provider 前提のケースは削除した。
import { assert, assertEquals } from "@std/assert";
import { isCurrentLocationArea } from "../functions/_shared/providers/area.ts";
import { MockPlaceProvider } from "../functions/_shared/providers/mock_place.ts";

// ============================================================
// mock モードのデモ完走 (§5.4 Fallback): 現在地でも mock は固定 3 件を返す
// ============================================================

Deno.test("mock: MockPlaceProvider は area=現在地 でも固定 3 件を返す (デモ完走を壊さない)", async () => {
  const out = await new MockPlaceProvider().search({
    area: "現在地",
    keyword: "寿司",
    limit: 3,
  });
  assertEquals(out.length, 3);
});

Deno.test("mock: current_location の明示 searchAnchor を PlaceSearchQuery として受ける", async () => {
  const out = await new MockPlaceProvider().search({
    area: "現在地",
    keyword: "焼肉",
    limit: 3,
    searchAnchor: { lat: 35.7295, lng: 139.7109 },
  });
  assertEquals(out.length, 3);
});

// ============================================================
// isCurrentLocationArea (純関数)
// ============================================================

Deno.test("isCurrentLocationArea: 「現在地」系の語と接尾語ゆれを true にする", () => {
  for (
    const area of [
      "現在地",
      "現在位置",
      "現在地点",
      "現在地付近",
      "現在地周辺",
      "現在地の近く",
      "現在地のすぐ近く",
      "現在地あたり",
      "ここ",
      "この辺",
      "このへん",
      "近く",
      "近所",
      "今いる場所",
      " 現在地 ", // 前後空白は無視
    ]
  ) {
    assert(isCurrentLocationArea(area), `${area} が現在地扱いにならなかった`);
  }
});

Deno.test("isCurrentLocationArea: 実在の地名や部分一致は false にする", () => {
  for (
    const area of [
      "池袋",
      "新宿",
      "練馬",
      "池袋周辺", // 地名 + 接尾語は現在地扱いしない
      "駅近く",
      "ここのつ", // 完全一致のみ (部分一致で誤爆しない)
      "",
      "  ",
    ]
  ) {
    assertEquals(
      isCurrentLocationArea(area),
      false,
      `${JSON.stringify(area)} が誤って現在地扱いになった`,
    );
  }
  assertEquals(isCurrentLocationArea(null), false);
  assertEquals(isCurrentLocationArea(undefined), false);
});
