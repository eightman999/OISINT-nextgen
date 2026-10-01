import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  locationScopeSchema,
  parseLocationScopeFromText,
  queryHasExplicitLocationMarker,
  queryMentionsCurrentLocation,
  resolveLocationScope,
} from "../functions/_shared/rail_scope.ts";

Deno.test("rail scope parser emits line without station sequence", () => {
  const result = parseLocationScopeFromText("西武池袋線沿線で焼肉");
  assertEquals(result, { type: "line", line: "西武池袋線" });
  assertFalse("stations" in (result ?? {}));
  assert(locationScopeSchema.safeParse(result).success);
});

Deno.test("rail scope parser recovers a line when the model omitted 沿線", () => {
  assertEquals(parseLocationScopeFromText("西武池袋線で焼肉"), {
    type: "line",
    line: "西武池袋線",
  });
});

Deno.test("rail scope parser does not absorb ordinary text before a line", () => {
  assertEquals(parseLocationScopeFromText("焼肉を西武池袋線で探す"), {
    type: "line",
    line: "西武池袋線",
  });
});

Deno.test("scope parser declines negated current location", () => {
  assertEquals(
    parseLocationScopeFromText("現在地ではなく新宿で寿司"),
    undefined,
  );
});

Deno.test("scope parser declines a contrastive rail line", () => {
  assertEquals(
    parseLocationScopeFromText("西武池袋線ではなく東武東上線で焼肉"),
    undefined,
  );
});

Deno.test("scope resolution repairs null metadata from the original query", () => {
  assertEquals(resolveLocationScope("西武池袋線で焼肉", null), {
    status: "resolved",
    source: "query",
    scope: { type: "line", line: "西武池袋線" },
  });
});

Deno.test("scope resolution keeps malformed metadata fail-closed", () => {
  assertEquals(resolveLocationScope("西武池袋線で焼肉", { type: "line" }), {
    status: "invalid",
  });
});

Deno.test("current location is an explicit scope without coordinates", () => {
  const result = parseLocationScopeFromText("現在地付近で寿司");
  assertEquals(result, { type: "current_location" });
  assert(locationScopeSchema.safeParse(result).success);
  assertFalse(
    locationScopeSchema.safeParse({
      type: "current_location",
      lat: 35.7,
      lng: 139.7,
    }).success,
  );
  assertFalse(
    locationScopeSchema.safeParse({ type: "point", place: "現在地" }).success,
  );
});

Deno.test("current location parser does not match a word fragment", () => {
  assertEquals(parseLocationScopeFromText("こころ温まる店で夕食"), undefined);
  assertEquals(parseLocationScopeFromText("静かな店で夕食"), undefined);
});

Deno.test("between and station hops scopes are structured without guessing a line", () => {
  assertEquals(parseLocationScopeFromText("池袋〜所沢の間で居酒屋"), {
    type: "between",
    from: "池袋",
    to: "所沢",
  });
  assertEquals(parseLocationScopeFromText("練馬から3駅以内"), {
    type: "station_hops",
    origin: "練馬",
    maxStops: 3,
  });
  assertEquals(parseLocationScopeFromText("西武池袋線の練馬から3駅以内"), {
    type: "station_hops",
    origin: "練馬",
    maxStops: 3,
    line: "西武池袋線",
  });
});

Deno.test("N02 does not claim travel time support", () => {
  assertEquals(parseLocationScopeFromText("新宿から30分以内"), {
    type: "travel_time",
    origin: "新宿",
    maxMinutes: 30,
  });
});

Deno.test("scope parser distinguishes alternatives from a between/corridor range", () => {
  assertEquals(parseLocationScopeFromText("渋谷か新宿で焼肉"), {
    type: "any_of",
    places: ["渋谷", "新宿"],
  });
  assertEquals(parseLocationScopeFromText("渋谷〜新宿の間で焼肉"), {
    type: "between",
    from: "渋谷",
    to: "新宿",
  });
  assertEquals(parseLocationScopeFromText("渋谷から横浜へ行く途中で探す"), {
    type: "corridor",
    from: "渋谷",
    to: "横浜",
  });
});

Deno.test("scope parser preserves multiple origins without applying #146 fairness", () => {
  assertEquals(parseLocationScopeFromText("渋谷と新宿から集まりやすい店"), {
    type: "multi_origin",
    origins: ["渋谷", "新宿"],
  });
});

Deno.test("scope parser accepts an explicitly marked point without geocoding it", () => {
  assertEquals(parseLocationScopeFromText("場所: 池袋で焼肉"), {
    type: "point",
    place: "池袋",
  });
  assertEquals(
    parseLocationScopeFromText("場所: 池袋駅 / 静かに話せる肉料理"),
    {
      type: "point",
      place: "池袋駅",
    },
  );
  assertEquals(parseLocationScopeFromText("池袋駅周辺で焼肉"), {
    type: "point",
    place: "池袋",
  });
});

Deno.test("explicit location marker is detectable after query composition", () => {
  assert(queryHasExplicitLocationMarker("場所: 池袋駅 / 静かに話せる肉料理"));
  assertFalse(queryHasExplicitLocationMarker("静かに話せる肉料理"));
});

// #317: 場所語が皆無の入力に対し、モデルが area/locationScope へ current_location
// を自己判断で補ってしまう regression を確認した。run-investigation はこの検出器で
// モデル出力の current_location をraw queryへ照合し、実在しなければ信用しない。
Deno.test("queryMentionsCurrentLocation: 現在地を指す語が実在する入力は true", () => {
  for (
    const query of [
      "現在地で寿司",
      "場所: 現在地付近 / 寿司",
      "ここら辺でランチ",
      "この辺で焼肉、静かめ",
    ]
  ) {
    assert(
      queryMentionsCurrentLocation(query),
      `${JSON.stringify(query)} が現在地表現ありと判定されなかった`,
    );
  }
});

Deno.test("queryMentionsCurrentLocation: 場所語が皆無の入力は false (現在地を推測で補わない)", () => {
  for (
    const query of [
      "3人。3000円くらい。肉。カード可。静かめ。",
      "焼肉、個室、カード可",
      "",
    ]
  ) {
    assertFalse(
      queryMentionsCurrentLocation(query),
      `${JSON.stringify(query)} が誤って現在地表現ありと判定された`,
    );
  }
});

Deno.test("queryMentionsCurrentLocation: 実在の地名や単語断片は false (部分一致で誤爆しない)", () => {
  assertFalse(queryMentionsCurrentLocation("池袋で寿司"));
  assertFalse(queryMentionsCurrentLocation("こころ温まる店で夕食"));
});
