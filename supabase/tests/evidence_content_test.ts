import { assertEquals } from "@std/assert";
import {
  filterEvidenceForInvestigation,
  filterReusableSafeSharedEvidence,
  formatNeutralSharedClaim,
  isReusableSafeSharedEvidence,
  neutralizeClaimsForModelPrompt,
} from "../functions/_shared/evidence_content.ts";

Deno.test("evidence content: legacy要件echo行はreuse不可、決定論中立行はreuse可", () => {
  const base = {
    source_url: "https://official.example/menu",
    source_type: "other_public_page",
    structured_claims: [{
      key: "card_accepted",
      value: true,
      rawText: "クレジットカード利用可",
    }],
  };
  assertEquals(
    isReusableSafeSharedEvidence({
      ...base,
      source_title: "公開ページ (official.example)",
      excerpt: "クレジットカード利用可",
    }),
    true,
  );
  assertEquals(
    isReusableSafeSharedEvidence({
      ...base,
      source_title: "私の条件",
      excerpt: "私の秘密の条件でカード可",
      structured_claims: [{
        key: "card_accepted",
        value: true,
        rawText: "私の秘密の条件でカード可",
      }],
    }),
    false,
  );
});

Deno.test("evidence content: claimless citationはhostname由来の中立形式だけreuseする", () => {
  const base = {
    source_url: "https://official.example/menu",
    source_type: "other_public_page",
    structured_claims: [],
  };
  assertEquals(
    isReusableSafeSharedEvidence({
      ...base,
      source_title: "公開ページ (official.example)",
      excerpt: "公開ページ (official.example)",
    }),
    true,
  );
  assertEquals(
    isReusableSafeSharedEvidence({
      ...base,
      source_title: "公開ページ (official.example)",
      excerpt: "私の秘密の条件",
    }),
    false,
  );
});

Deno.test("evidence content: model-neutral shared URLはschemeとtenant非依存性をfail-closedにする", () => {
  const safeRow = {
    source_url: "https://official.example/menu",
    source_type: "other_public_page",
    source_title: "公開ページ (official.example)",
    excerpt: "公開ページ (official.example)",
    structured_claims: [],
  };
  assertEquals(isReusableSafeSharedEvidence(safeRow), true);
  for (
    const source_url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "ftp://official.example/menu",
      "https://user:secret@official.example/menu",
      "https://official.example/menu?q=秘密の予算3000円&token=abc",
      "https://official.example/menu#秘密の条件",
    ]
  ) {
    assertEquals(
      isReusableSafeSharedEvidence({ ...safeRow, source_url }),
      false,
      source_url,
    );
  }
});

Deno.test("evidence content: model proseを保持できる自由文字列claimはmodel-neutral reuseしない", () => {
  for (
    const claim of [
      {
        key: "genre",
        value: ["秘密の予算3000円"],
        rawText: 'genre=["秘密の予算3000円"]',
      },
      {
        key: "closed_days",
        value: "カードは使いたくない",
        rawText: 'closed_days="カードは使いたくない"',
      },
    ]
  ) {
    assertEquals(
      isReusableSafeSharedEvidence({
        source_url: "https://official.example/menu",
        source_type: "other_public_page",
        source_title: "公開ページ (official.example)",
        excerpt: claim.rawText,
        structured_claims: [claim],
      }),
      false,
    );
  }
});

Deno.test("evidence content: claim由来のexcerptを持つprovider行だけをtrustedとする", () => {
  const claims = [{
    key: "card_accepted",
    value: true,
    rawText: "カード利用可",
  }];
  assertEquals(
    isReusableSafeSharedEvidence({
      source_url: "https://places.example/shop/1",
      source_type: "major_place_provider",
      source_title: "店名 - 店舗情報",
      excerpt: "カード利用可",
      structured_claims: claims,
    }),
    true,
  );
  // #297: seed の「(スナップショット)」例外分岐は撤去した。excerpt が claim 由来で
  // なければ、どのホストであっても trusted にしない
  assertEquals(
    isReusableSafeSharedEvidence({
      source_url: "https://mock.oisint.example/place/mock-001",
      source_type: "major_place_provider",
      source_title: "店名 - 店舗情報 (スナップショット)",
      excerpt: "固定seedの公開店舗情報",
      structured_claims: claims,
    }),
    false,
  );
  assertEquals(
    isReusableSafeSharedEvidence({
      source_url: "https://attacker.example/page",
      source_type: "major_place_provider",
      source_title: "店名 - 店舗情報",
      excerpt: "秘密",
      structured_claims: claims,
    }),
    false,
  );
  for (
    const source_url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "ftp://places.example/shop",
      "https://user:secret@places.example/shop",
    ]
  ) {
    assertEquals(
      isReusableSafeSharedEvidence({
        source_url,
        source_type: "major_place_provider",
        source_title: "店名 - 店舗情報",
        excerpt: "カード利用可",
        structured_claims: claims,
      }),
      false,
      source_url,
    );
  }
});

Deno.test("evidence content: AI promptへ渡すrawTextはkey/value由来に置き換える", () => {
  const neutralized = neutralizeClaimsForModelPrompt([{
    key: "budget_dinner",
    value: { min: 3000, max: 5000 },
    rawText: "私の秘密の予算条件",
  }]);
  assertEquals(neutralized[0].rawText, "夕食予算: 3000〜5000円");
  assertEquals(
    formatNeutralSharedClaim({
      key: "opening_hours",
      value: "17:00-23:00",
      rawText: "secret",
    }),
    "営業時間: 17:00-23:00",
  );
  assertEquals(
    [
      { key: "non_smoking", value: true, rawText: "secret" },
      { key: "wifi_available", value: false, rawText: "secret" },
      { key: "child_friendly", value: true, rawText: "secret" },
      {
        key: "nearest_station_walk_minutes",
        value: 5,
        rawText: "secret",
      },
    ].map((claim) =>
      formatNeutralSharedClaim(
        claim as Parameters<typeof formatNeutralSharedClaim>[0],
      )
    ),
    ["全席禁煙", "Wi-Fiなし", "子連れ対応", "最寄り駅から徒歩5分"],
  );
});

Deno.test("evidence content: filter claimの中立shared行を再利用できる", () => {
  const claims = [
    { key: "non_smoking", value: true, rawText: "全席禁煙" },
    { key: "wifi_available", value: true, rawText: "Wi-Fiあり" },
    { key: "child_friendly", value: true, rawText: "子連れ対応" },
    {
      key: "nearest_station_walk_minutes",
      value: 4,
      rawText: "最寄り駅から徒歩4分",
    },
  ];
  assertEquals(
    isReusableSafeSharedEvidence({
      source_url: "https://official.example/access",
      source_type: "other_public_page",
      source_title: "公開ページ (official.example)",
      excerpt: claims.map((claim) => claim.rawText).join("。"),
      structured_claims: claims,
    }),
    true,
  );
});

Deno.test("evidence content: legacy sharedと別investigation行をfacts/ranking入力から除外する", () => {
  const safeShared = {
    id: "safe-shared",
    scope: "shared",
    investigation_id: null,
    source_url: "https://official.example/menu",
    source_type: "other_public_page",
    source_title: "公開ページ (official.example)",
    excerpt: "クレジットカード利用可",
    structured_claims: [{
      key: "card_accepted",
      value: true,
      rawText: "クレジットカード利用可",
    }],
  };
  const unsafeLegacy = {
    ...safeShared,
    id: "unsafe-legacy",
    source_title: "以前の利用者条件",
    excerpt: "以前の利用者はカードを避けたい",
    structured_claims: [{
      key: "card_accepted",
      value: false,
      rawText: "以前の利用者はカードを避けたい",
    }],
  };
  const currentPrivate = {
    ...unsafeLegacy,
    id: "current-private",
    scope: "investigation",
    investigation_id: "inv-current",
  };
  const otherPrivate = {
    ...currentPrivate,
    id: "other-private",
    investigation_id: "inv-other",
  };

  assertEquals(
    filterReusableSafeSharedEvidence([unsafeLegacy, safeShared]).map((row) =>
      row.id
    ),
    ["safe-shared"],
  );
  assertEquals(
    filterEvidenceForInvestigation(
      [unsafeLegacy, safeShared, currentPrivate, otherPrivate],
      "inv-current",
    ).map((row) => row.id),
    ["safe-shared", "current-private"],
  );
});
