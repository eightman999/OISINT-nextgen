// Place provider ごとの帰属表記（#530 / #297 / spec.md §27）。
//
// 表示義務は provider 規約で決まる（正本: docs/legal/provider-data-rights.md）。
// backend の PLACE_PROVIDER を切り替えたのにフッターのクレジットが取り残される事故を
// 防ぐため、表示する組み合わせをここ 1 箇所に集約し、公開設定
// EXPO_PUBLIC_PLACE_PROVIDER で選ぶ（secret ではない。§34 で client に置いてよい値）。

export type PlaceProviderId = 'geoapify' | 'overture';

export interface Attribution {
  id: string;
  label: string;
  url: string;
  accessibilityLabel: string;
}

// クレジットは provider が変わっても同じ testID で特定できるようにする。
// e2e (e2e/tests/footer-responsive.spec.ts) が testID で位置・文言を検証しており、
// provider ごとに testID を変えると provider 切替のたびに e2e が壊れる
export const FOOTER_CREDIT_TEST_ID = 'footer-credit-link';

// Geoapify Terms and Conditions v5 (2024-02-02):
// "you must always provide OpenStreetMap attribution"
const OPENSTREETMAP: Attribution = {
  id: 'openstreetmap',
  label: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
  accessibilityLabel: 'OpenStreetMap の著作権表示ページを開く',
};

// 同 v5: "Geoapify attribution is mandatory when using Free subscription plan"
// 有料プランへ移行しても表記自体は許容されるため、常に併記する
const GEOAPIFY: Attribution = {
  id: 'geoapify',
  label: 'Powered by Geoapify',
  url: 'https://www.geoapify.com/',
  accessibilityLabel: 'Geoapify のサイトを開く',
};

export const MLIT_N02_ATTRIBUTION: Attribution = {
  id: 'mlit-n02',
  label: '出典：国土交通省「国土数値情報（鉄道データ N02）」を加工して作成',
  url: 'https://nlftp.mlit.go.jp/ksj/',
  accessibilityLabel: '国土交通省 国土数値情報のページを開く',
};

// owner 決定 (2026-08-21 / #559): Overture のライセンス表示は共通フッターへ列挙せず、
// 「データ提供元・ライセンス」ページ (app/data-sources.tsx) 1 枚に集約する。
// フッターに出すのはそのページへのリンクだけなので、クレジット行は空にする。
// Geoapify は Free プランの表記義務が provider 規約側にあるため従来どおりフッターへ出す。
const BY_PROVIDER: Record<PlaceProviderId, Attribution[]> = {
  geoapify: [OPENSTREETMAP, GEOAPIFY],
  overture: [],
};

// 未設定・未知の値は現行の既定 provider (Geoapify) として扱う。
// クレジットを空にすると表示義務違反になるため、fallback を「表記なし」にはしない。
export function placeProviderId(raw?: string | null): PlaceProviderId {
  return raw?.trim() === 'overture' ? 'overture' : 'geoapify';
}

export function attributionsFor(raw?: string | null): Attribution[] {
  return BY_PROVIDER[placeProviderId(raw)];
}

export function attributionsForPolicies(policies?: readonly string[] | null): Attribution[] {
  if (!policies) return [];
  const seen = new Set<string>();
  return policies.flatMap((policy) => {
    const attributions = policy === 'mlit_n02_attribution'
      ? [MLIT_N02_ATTRIBUTION]
      : policy === 'osm_odbl_attribution'
      ? [OPENSTREETMAP, GEOAPIFY]
      // 'overture_cdla_attribution' はここでは何も返さない。Overture の表示義務は
      // 「データ提供元・ライセンス」ページで果たす (#559 owner 決定 2026-08-21)
      : [];
    return attributions.filter((attribution) => {
      if (seen.has(attribution.id)) return false;
      seen.add(attribution.id);
      return true;
    });
  });
}

export function activeAttributions(): Attribution[] {
  return attributionsFor(process.env.EXPO_PUBLIC_PLACE_PROVIDER);
}
