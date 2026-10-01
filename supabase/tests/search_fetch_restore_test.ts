// モデル出力 (短縮 rid / ページ番号参照 #126) の復元テスト (search_fetch_research.ts)
import { assertEquals, assertThrows } from "@std/assert";
import { restoreFindings } from "../functions/_shared/providers/search_fetch_research.ts";
import type { ModelInvestigation } from "../functions/_shared/providers/google_ai.ts";

const RID_MAP = new Map([
  ["r1", "11111111-1111-1111-1111-111111111111"],
  ["r2", "22222222-2222-2222-2222-222222222222"],
]);
const PAGE_URLS = [
  "https://example.com/official",
  "https://tabelog.example.com/shop",
  "https://blog.example.com/review",
];

function finding(
  over: Partial<ModelInvestigation["findings"][number]>,
): ModelInvestigation["findings"][number] {
  return {
    rid: "r1",
    state: "match",
    confidence: 0.9,
    explanation: "公式サイトに記載あり",
    sourcePages: [1],
    claims: [],
    ...over,
  };
}

Deno.test("restoreFindings: rid とページ番号を UUID / URL へ復元する", () => {
  const out = restoreFindings(
    [finding({ rid: "r2", sourcePages: [1, 3] })],
    RID_MAP,
    PAGE_URLS,
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].requirementId, "22222222-2222-2222-2222-222222222222");
  assertEquals(out[0].sourceUrls, [PAGE_URLS[0], PAGE_URLS[2]]);
  assertEquals(out[0].state, "match");
});

Deno.test("restoreFindings: 未知ridを実在ridの横に混ぜても結果全体を破棄する", () => {
  assertThrows(
    () =>
      restoreFindings(
        [finding({ rid: "r99" }), finding({ rid: "r1" })],
        RID_MAP,
        PAGE_URLS,
      ),
    Error,
    "unknown_requirement",
  );
});

Deno.test("restoreFindings: 範囲外・非整数pageが1件でもあれば結果全体を破棄する", () => {
  assertThrows(
    () =>
      restoreFindings(
        [finding({ sourcePages: [0, 1, 4, -1, 1.5, 99] })],
        RID_MAP,
        PAGE_URLS,
      ),
    Error,
    "unknown_page",
  );
});

Deno.test("restoreFindings: 同一requirementの重複findingは結果全体を破棄する", () => {
  assertThrows(
    () =>
      restoreFindings(
        [finding({ sourcePages: [1] }), finding({ sourcePages: [2] })],
        RID_MAP,
        PAGE_URLS,
      ),
    Error,
    "duplicate_requirement",
  );
});

Deno.test("restoreFindings: 重複ページ番号の URL は重複排除する", () => {
  const out = restoreFindings(
    [finding({ sourcePages: [2, 2, 2] })],
    RID_MAP,
    PAGE_URLS,
  );
  assertEquals(out[0].sourceUrls, [PAGE_URLS[1]]);
});

Deno.test("restoreFindings: ページ番号 0 件は sourceUrls 空 (match 降格は pipeline 側 §12)", () => {
  const out = restoreFindings(
    [finding({ sourcePages: [] })],
    RID_MAP,
    PAGE_URLS,
  );
  assertEquals(out[0].sourceUrls, []);
});

Deno.test("restoreFindings: claims は key/value/rawText のみ通す", () => {
  const out = restoreFindings(
    [finding({
      claims: [{ key: "card_accepted", value: true, rawText: "カード利用可" }],
    })],
    RID_MAP,
    PAGE_URLS,
  );
  assertEquals(out[0].claims, [{
    key: "card_accepted",
    value: true,
    rawText: "カード利用可",
  }]);
});
