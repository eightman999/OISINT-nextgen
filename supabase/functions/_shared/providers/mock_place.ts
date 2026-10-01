// MockPlaceProvider (spec.md §5.4 Fallback, §26)
// 外部 API を一切呼ばず、標準3店舗とlimit依存のBroad fixtureを返す。
// live と同じ interface・同じ型を通す。
//
// データは mock 専用のデモ用データ (#297 で旧 provider 由来の実データ・実 URL を撤去)。
// 店名・住所は実在の店を指すが、URL は mock.oisint.example のダミーで、外部 provider の
// ページ・ID は参照しない。provider は 'mock' のまま (live 調査ガードの対象。クレジット保護)。
import type {
  PlaceSearchProvider,
  PlaceSearchQuery,
  PlaceSearchResult,
  ProviderMeta,
} from "./types.ts";

const SNAPSHOT_AT = "2026-08-15";

const MOCK_PLACES: PlaceSearchResult[] = [
  {
    provider: "mock",
    providerPlaceId: "mock-001",
    name: "池袋いちば 西口店",
    address: "東京都豊島区池袋２-47-12 第2絆ビル 1F",
    lat: 35.7333600224,
    lng: 139.7111993528,
    url: "https://mock.oisint.example/place/mock-001",
    structuredClaims: [
      // 11:30～翌0:00 → 正規化 11:30-24:00
      // mock research 側の「公式サイト(デモ用) 23:00」と 60 分ずれる → 矛盾デモ用 (§15)
      {
        key: "opening_hours",
        value: "11:30-24:00",
        rawText: "営業時間 11:30～翌0:00 (L.O. 23:00)",
      },
      { key: "card_accepted", value: true, rawText: "カード利用可" },
      { key: "private_room", value: true, rawText: "個室あり" },
      { key: "non_smoking", value: true, rawText: "デモ設定: 全席禁煙" },
      { key: "wifi_available", value: true, rawText: "デモ設定: Wi-Fiあり" },
      { key: "child_friendly", value: true, rawText: "デモ設定: 子連れ対応" },
      {
        key: "nearest_station_walk_minutes",
        value: 4,
        rawText: "デモ設定: 最寄り駅から徒歩4分",
      },
      {
        key: "budget_dinner",
        value: { min: 3001, max: 4000 },
        rawText: "予算 3001～4000円",
      },
      { key: "capacity", value: 36, rawText: "総席数36席" },
      {
        key: "genre",
        value: ["焼肉・ホルモン"],
        rawText: "ジャンル: 焼肉・ホルモン",
      },
    ],
    // metadata は live provider と同一構造 (§5.4「本番と同じ interface・同じ型」)。
    // shopUrl / photoUrl は実在 URL を捏造せず、mock と分かるダミーにする
    metadata: {
      source: "mock",
      mock: true,
      snapshotAt: SNAPSHOT_AT,
      photoUrl: "https://placehold.co/238x238?text=OISINT+mock-001",
      shopUrl: "https://mock.oisint.example/place/mock-001",
    },
  },
  {
    provider: "mock",
    providerPlaceId: "mock-002",
    name: "にくみつ 池袋店",
    address: "東京都豊島区南池袋１-27-8 大庄東口ビル9F",
    lat: 35.7294985567,
    lng: 139.712846869,
    url: "https://mock.oisint.example/place/mock-002",
    structuredClaims: [
      {
        key: "opening_hours",
        value: "15:00-23:00",
        rawText: "営業時間 月～金 15:00～23:00 (L.O. 22:30)",
      },
      { key: "card_accepted", value: true, rawText: "カード利用可" },
      {
        key: "private_room",
        value: true,
        rawText: "全席完全個室・2名様~個室をご案内",
      },
      { key: "non_smoking", value: true, rawText: "デモ設定: 全席禁煙" },
      { key: "wifi_available", value: false, rawText: "デモ設定: Wi-Fiなし" },
      { key: "child_friendly", value: true, rawText: "デモ設定: 子連れ対応" },
      {
        key: "nearest_station_walk_minutes",
        value: 6,
        rawText: "デモ設定: 最寄り駅から徒歩6分",
      },
      {
        key: "budget_dinner",
        value: { min: 3001, max: 4000 },
        rawText: "予算 3001～4000円",
      },
      { key: "capacity", value: 66, rawText: "総席数66席" },
      {
        key: "genre",
        value: ["焼肉・ホルモン"],
        rawText: "ジャンル: 焼肉・ホルモン",
      },
      {
        key: "noise_level",
        value: "quiet",
        rawText: "全席完全個室で落ち着いて話せる",
      },
    ],
    metadata: {
      source: "mock",
      mock: true,
      snapshotAt: SNAPSHOT_AT,
      photoUrl: "https://placehold.co/238x238?text=OISINT+mock-002",
      shopUrl: "https://mock.oisint.example/place/mock-002",
    },
  },
  {
    provider: "mock",
    providerPlaceId: "mock-003",
    name: "焼肉の和民 池袋東口店",
    address: "東京都豊島区南池袋１-23-1 フジビル6F",
    lat: 35.7287966815,
    lng: 139.7124877612,
    url: "https://mock.oisint.example/place/mock-003",
    structuredClaims: [
      {
        key: "opening_hours",
        value: "11:00-24:00",
        rawText: "営業時間 11:00～翌0:00",
      },
      { key: "card_accepted", value: true, rawText: "カード利用可" },
      { key: "private_room", value: false, rawText: "個室なし" },
      { key: "non_smoking", value: false, rawText: "デモ設定: 喫煙可" },
      { key: "wifi_available", value: true, rawText: "デモ設定: Wi-Fiあり" },
      {
        key: "child_friendly",
        value: false,
        rawText: "デモ設定: 子連れ非対応",
      },
      {
        key: "nearest_station_walk_minutes",
        value: 9,
        rawText: "デモ設定: 最寄り駅から徒歩9分",
      },
      {
        key: "budget_dinner",
        value: { min: 2001, max: 3000 },
        rawText: "予算 2001～3000円",
      },
      { key: "capacity", value: 96, rawText: "総席数96席" },
      {
        key: "genre",
        value: ["焼肉・ホルモン"],
        rawText: "ジャンル: 焼肉・ホルモン",
      },
    ],
    metadata: {
      source: "mock",
      mock: true,
      snapshotAt: SNAPSHOT_AT,
      photoUrl: "https://placehold.co/238x238?text=OISINT+mock-003",
      shopUrl: "https://mock.oisint.example/place/mock-003",
    },
  },
];

// #509 の Broad Discovery を外部 API なしで再現するための決定論的な広域 fixture。
// 先頭 3 件は既存のデモ契約を維持し、limit > 3 のときだけ追加候補を返す。
// 実在店舗・実在 URL の代用にしないため、名称と URL は mock 専用値にする。
const MOCK_BROAD_PLACES: PlaceSearchResult[] = [
  ...MOCK_PLACES,
  ...Array.from(
    { length: 21 },
    (_, offset): PlaceSearchResult => {
      const number = offset + 4;
      const providerPlaceId = `mock-broad-${String(number).padStart(2, "0")}`;
      const category = number % 4 === 0 ? "焼肉・ホルモン" : "居酒屋";
      const budget = number % 3 === 0
        ? { min: 2001, max: 3000 }
        : { min: 3001, max: 4000 };
      const url = `https://mock.oisint.example/place/${providerPlaceId}`;
      return {
        provider: "mock",
        providerPlaceId,
        name: `検証用候補${String(number).padStart(2, "0")}`,
        address: `東京都豊島区池袋${(number % 9) + 1}-${(number % 20) + 1}`,
        lat: 35.728 + offset * 0.0001,
        lng: 139.710 + offset * 0.0001,
        url,
        structuredClaims: [
          {
            key: "genre",
            value: [category],
            rawText: `ジャンル: ${category}`,
          },
          {
            key: "budget_dinner",
            value: budget,
            rawText: `予算 ${budget.min}～${budget.max}円`,
          },
          {
            key: "card_accepted",
            value: number % 2 === 0,
            rawText: number % 2 === 0 ? "カード利用可" : "カード利用不可",
          },
        ],
        metadata: {
          source: "mock",
          mock: true,
          broadFixture: true,
          snapshotAt: SNAPSHOT_AT,
          photoUrl: `https://mock.oisint.example/photo/${providerPlaceId}`,
          shopUrl: url,
        },
      };
    },
  ),
];

/** Broad Discovery fixture の総候補数。テスト／監査用であり実運用の上限ではない。 */
export const MOCK_BROAD_CANDIDATE_COUNT = MOCK_BROAD_PLACES.length;

export class MockPlaceProvider implements PlaceSearchProvider {
  // mock は外部 provider 由来データではないので保存制限も表示義務も無い
  readonly meta: ProviderMeta = {
    id: "mock",
    storagePolicy: "persistent",
    attributionPolicy: null,
    ttlHours: null,
  };

  search(query: PlaceSearchQuery): Promise<PlaceSearchResult[]> {
    // area / keyword に関わらず決定論的な fixture を返す。従来の limit=3 は
    // 既存デモ互換で先頭3件、Broad Discovery の limit>3 では追加候補も返す。
    const limit = Number.isSafeInteger(query.limit) && query.limit > 0
      ? query.limit
      : 0;
    return Promise.resolve(MOCK_BROAD_PLACES.slice(0, limit));
  }
}
