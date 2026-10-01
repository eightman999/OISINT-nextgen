export const RESTAURANT_IMAGE_KEYS = [
  'demo-yakiniku-v1.jpg',
  'demo-izakaya-v1.jpg',
  'demo-steak-v1.jpg',
  'demo-sushi-v1.jpg',
  'demo-cafe-v1.jpg',
  'demo-ramen-v1.jpg',
  'demo-italian-v1.jpg',
  'demo-washoku-v1.jpg',
  'demo-chinese-v1.jpg',
  'demo-bistro-v1.jpg',
  'demo-yakitori-v1.jpg',
  'demo-tempura-v1.jpg',
  'demo-soba-v1.jpg',
  'demo-udon-v1.jpg',
  'demo-curry-v1.jpg',
  'demo-korean-v1.jpg',
  'demo-spanish-v1.jpg',
  'demo-seafood-v1.jpg',
  'demo-vegan-v1.jpg',
  'demo-bakery-v1.jpg',
] as const;

export type RestaurantImageKey = (typeof RESTAURANT_IMAGE_KEYS)[number];

// Remote photo hosts that a candidate image may be loaded from. The former
// provider image CDN was removed with the provider (#297); no
// current provider (Geoapify/OSM) ships shop photos, so the list is empty and
// candidates without approved photos display no image. The mechanism stays in place
// so a future provider can be added here without re-deriving the boundary:
// fail closed for every host that is not listed, so rendering a candidate can
// never turn an arbitrary database URL into a browser/phone request.
export const RESTAURANT_REMOTE_IMAGE_HOSTS: readonly string[] = [];

export type ResolvedRestaurantImage =
  | { kind: 'remote'; uri: string }
  | { kind: 'none' };

interface ResolveRestaurantImageInput {
  photo?: string | null;
  /** Legacy catalog metadata; accepted for compatibility but never displayed. */
  fallbackImageKey?: string | null;
  genre?: string | null;
  /** Legacy fallback seed; no generated fallback is displayed. */
  fallbackSeed?: string | null;
}

interface GenreImageRule {
  key: RestaurantImageKey;
  aliases: readonly string[];
  exactAliases?: readonly string[];
}

// Rule order is product policy, not an implementation detail: specific dishes
// beat broad cuisines, a dietary qualifier beats a venue type, and named
// cuisines beat generic 居酒屋 / バル / パン matches.
const GENRE_IMAGE_RULES: readonly GenreImageRule[] = [
  {
    key: 'demo-yakiniku-v1.jpg',
    aliases: ['焼肉', '焼き肉', 'ホルモン', 'バーベキュー', 'bbq'],
  },
  {
    key: 'demo-yakitori-v1.jpg',
    aliases: ['焼き鳥', '焼鳥', '串焼き', '串焼'],
  },
  {
    key: 'demo-steak-v1.jpg',
    aliases: ['ステーキ', '鉄板焼き', '鉄板焼', 'ハンバーグ', 'グリル'],
  },
  {
    key: 'demo-sushi-v1.jpg',
    aliases: ['寿司', '鮨', 'すし'],
  },
  {
    key: 'demo-vegan-v1.jpg',
    aliases: ['プラントベース', 'ヴィーガン', 'ビーガン', 'ベジタリアン', '野菜料理'],
  },
  {
    key: 'demo-cafe-v1.jpg',
    aliases: [
      'フレンチトースト',
      'パンケーキ',
      'カフェ',
      '喫茶店',
      '喫茶',
      '珈琲',
      'コーヒー',
      'スイーツ',
    ],
  },
  {
    key: 'demo-bakery-v1.jpg',
    aliases: [
      'ブーランジェリー',
      'ベーカリー',
      'パン専門店',
      'パン専門',
      'パン屋',
      'パン店',
      'カレーパン',
      '食パン',
      '菓子パン',
      '惣菜パン',
    ],
    // A raw substring match would misclassify シャンパンバー as a bakery.
    exactAliases: ['パン'],
  },
  {
    key: 'demo-ramen-v1.jpg',
    aliases: [
      '台湾まぜそば',
      '中華そば',
      'まぜそば',
      '油そば',
      'ラーメン',
      'らーめん',
      '拉麺',
      'つけ麺',
      '担々麺',
      '担担麺',
    ],
  },
  {
    key: 'demo-soba-v1.jpg',
    aliases: ['蕎麦', 'そば'],
  },
  {
    key: 'demo-udon-v1.jpg',
    aliases: ['うどん', '饂飩'],
  },
  {
    key: 'demo-tempura-v1.jpg',
    aliases: ['天ぷら', '天麩羅', '天婦羅'],
  },
  {
    key: 'demo-curry-v1.jpg',
    aliases: ['スープカレー', 'カレーライス', 'カレー', 'カリー'],
  },
  {
    key: 'demo-italian-v1.jpg',
    aliases: ['イタリアンバル', 'イタリア料理', 'イタリアン', 'ピッツァ', 'ピザ', 'パスタ'],
  },
  {
    key: 'demo-chinese-v1.jpg',
    aliases: [
      '中国料理',
      '台湾料理',
      '中華料理',
      '四川料理',
      '広東料理',
      '町中華',
      '中華',
      '餃子',
    ],
  },
  {
    key: 'demo-korean-v1.jpg',
    aliases: ['韓国料理', '韓国家庭料理', '韓国', 'コリアン'],
  },
  {
    key: 'demo-spanish-v1.jpg',
    aliases: ['スペイン料理', 'スペインバル', 'スペイン', 'スパニッシュ', 'パエリア', 'タパス'],
  },
  {
    key: 'demo-seafood-v1.jpg',
    aliases: ['シーフード', '海鮮料理', '魚介料理', '海鮮', '魚介', '刺身'],
  },
  {
    key: 'demo-washoku-v1.jpg',
    aliases: [
      '日本料理',
      '和食',
      '懐石',
      '会席',
      '割烹',
      '定食',
    ],
  },
  {
    key: 'demo-izakaya-v1.jpg',
    aliases: ['居酒屋', '大衆酒場', '酒場', 'ダイニングバー'],
  },
  {
    key: 'demo-bistro-v1.jpg',
    aliases: ['フランス料理', 'ビストロ', 'フレンチ', '洋食', 'バル'],
  },
] as const;

const RESTAURANT_IMAGE_KEY_SET: ReadonlySet<string> = new Set(RESTAURANT_IMAGE_KEYS);
// Built from the allowlist. With no hosts allowed the pattern never matches.
const RESTAURANT_REMOTE_IMAGE_PREFIX = RESTAURANT_REMOTE_IMAGE_HOSTS.length > 0
  ? new RegExp(
      `^https://(?:${RESTAURANT_REMOTE_IMAGE_HOSTS.map((host) =>
        host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ).join('|')})(?::443)?(?=$|[/?#])`,
      'i'
    )
  : null;
const UNSAFE_REMOTE_IMAGE_CHARACTERS = /[\\\s\u0000-\u001f\u007f]/u;
const DEFAULT_FALLBACK_SEED = 'oisint-restaurant';

function normalizedText(value?: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000・･/_-]+/g, '');
}

function validHttpsUrl(value?: string | null): string | undefined {
  const candidate = value?.trim();
  if (!candidate || UNSAFE_REMOTE_IMAGE_CHARACTERS.test(candidate)) return undefined;

  // Do not delegate the security boundary to the runtime URL implementation:
  // WHATWG URL, React Native's URL polyfill, and Foundation NSURL do not parse
  // every malformed authority identically. Match a strict provider authority,
  // then rebuild the only origin that the platform image loader may receive.
  if (!RESTAURANT_REMOTE_IMAGE_PREFIX) return undefined;
  const prefix = RESTAURANT_REMOTE_IMAGE_PREFIX.exec(candidate)?.[0];
  if (!prefix) return undefined;

  const host = prefix.replace(/^https:\/\//i, '').replace(/:443$/, '').toLowerCase();
  const suffix = candidate.slice(prefix.length);
  return `https://${host}${suffix || '/'}`;
}

export function isRestaurantImageKey(value?: string | null): value is RestaurantImageKey {
  return typeof value === 'string' && RESTAURANT_IMAGE_KEY_SET.has(value);
}

export function restaurantImageKeyForGenre(
  genre?: string | null
): RestaurantImageKey | undefined {
  const candidate = normalizedText(genre);
  if (!candidate) return undefined;

  for (const rule of GENRE_IMAGE_RULES) {
    const hasPartialAlias = rule.aliases.some((alias) =>
      candidate.includes(normalizedText(alias))
    );
    const hasExactAlias = rule.exactAliases?.some((alias) => candidate === normalizedText(alias));
    if (hasPartialAlias || hasExactAlias) {
      return rule.key;
    }
  }

  return undefined;
}

export function deterministicRestaurantImageKey(seed?: string | null): RestaurantImageKey {
  const value = normalizedText(seed) || DEFAULT_FALLBACK_SEED;
  let hash = 0;

  for (const character of value) {
    hash = (Math.imul(hash, 31) + (character.codePointAt(0) ?? 0)) >>> 0;
  }

  return RESTAURANT_IMAGE_KEYS[hash % RESTAURANT_IMAGE_KEYS.length];
}

/** Resolves approved photos only; generated catalog keys are never displayed. */
export function resolveRestaurantImage({
  photo,
}: ResolveRestaurantImageInput): ResolvedRestaurantImage {
  const remoteUri = validHttpsUrl(photo);
  return remoteUri ? { kind: 'remote', uri: remoteUri } : { kind: 'none' };
}
