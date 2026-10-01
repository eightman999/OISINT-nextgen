// 料理ジャンル語の言語横断 lexicon (#514)。
//
// 出自は Geoapify provider が持っていた CUISINE_SYNONYMS (実測: 池袋 500 件の OSM
// cuisine 値 coffee_shop / japanese / ramen / chinese / italian / sushi / barbecue …)。
// 特定の Issue の再現例に合わせて語を足さない。ここは provider が実際に返す語彙の
// 台帳であり、requirement 側の表記ゆれ辞書ではない。
//
// 用途は 2 つあり、必要な厳密さが違うため語を分けている:
//
//   en     翻訳同値。「yakiniku ⇔ 焼肉」のように、片方が成り立てばもう片方も
//          成り立つ語だけを入れる。決定論評価 (match の断定) に使う。
//   recall 同値ではないが探索の当たりを増やす拡張語 (焼肉 → barbecue / korean 等)。
//          候補の並べ替えにだけ使い、評価の根拠には使わない。
//
// 決定論評価がこの lexicon を使うのは **script が異なる場合だけ** (英語 requirement
// × 日本語 claim、または日本語 requirement × 英語 claim)。同一 script 内では従来通り
// 部分一致のみで判定するため、「パスタ」が「イタリアン」に一致するような
// 日本語側の判定緩和は起きない。
export interface CuisineLexiconEntry {
  /** 日本語表記 */
  readonly ja: RegExp;
  /** 翻訳同値とみなす英語 / ローマ字表記 */
  readonly en: readonly string[];
  /** 同値ではない探索拡張語 (評価には使わない) */
  readonly recall?: readonly string[];
}

export const CUISINE_LEXICON: readonly CuisineLexiconEntry[] = [
  {
    ja: /焼肉|ホルモン|焼き肉/,
    en: ["yakiniku"],
    recall: ["barbecue", "korean"],
  },
  { ja: /寿司|鮨|すし/, en: ["sushi"] },
  { ja: /ラーメン|らーめん|中華そば/, en: ["ramen"], recall: ["noodle"] },
  { ja: /居酒屋/, en: ["izakaya"], recall: ["japanese"] },
  { ja: /そば|蕎麦/, en: ["soba"], recall: ["noodle"] },
  { ja: /うどん/, en: ["udon"], recall: ["noodle"] },
  { ja: /カレー/, en: ["curry"], recall: ["indian"] },
  { ja: /イタリアン|パスタ|ピザ|ピッツァ/, en: ["italian", "pizza"] },
  { ja: /中華|餃子/, en: ["chinese"] },
  { ja: /フレンチ|フランス料理/, en: ["french"] },
  { ja: /焼き鳥|焼鳥|やきとり/, en: ["yakitori"] },
  { ja: /カフェ|喫茶/, en: ["cafe", "coffee_shop"] },
  { ja: /ステーキ|鉄板/, en: ["steak_house"], recall: ["barbecue"] },
  { ja: /韓国|サムギョプサル/, en: ["korean"] },
  { ja: /タイ料理/, en: ["thai"] },
  { ja: /インド/, en: ["indian"] },
  { ja: /ハンバーガー|バーガー/, en: ["burger"] },
  { ja: /天ぷら|天麩羅/, en: ["tempura"] },
  { ja: /とんかつ|トンカツ|豚カツ/, en: ["tonkatsu"] },
  { ja: /海鮮|魚|刺身/, en: ["seafood"], recall: ["fish"] },
  { ja: /バー|バル/, en: ["bar"], recall: ["wine"] },
];

const JAPANESE_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff]/;

export function isJapaneseCuisineText(text: string): boolean {
  return JAPANESE_SCRIPT.test(text.normalize("NFKC"));
}

function canonical(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

/** OSM cuisine 値は coffee_shop のように区切りを含むため、語単位に割る */
function latinTokens(text: string): string[] {
  return canonical(text).split(/[^a-z0-9_]+/).filter(Boolean);
}

/** 探索用: 日本語ジャンル語 → OSM cuisine 値 (同値語 + 拡張語) */
export function cuisineRecallTerms(term: string): string[] {
  const out: string[] = [];
  for (const entry of CUISINE_LEXICON) {
    if (!entry.ja.test(term)) continue;
    out.push(...entry.en, ...(entry.recall ?? []));
  }
  return out;
}

/**
 * 語が属する同値クラスを返す。複数クラスに跨る語 (「韓国焼肉」「sushi or ramen」等) は
 * どちらの意図か決められないため null を返す (fail-closed)。
 */
export function cuisineEquivalenceClass(term: string): number | null {
  const text = canonical(term);
  if (!text) return null;
  const japanese = isJapaneseCuisineText(text);
  const tokens = japanese ? [] : latinTokens(text);
  const matched: number[] = [];
  CUISINE_LEXICON.forEach((entry, index) => {
    const hit = japanese
      ? entry.ja.test(text)
      // 英語側は部分一致にしない ("bar" が "barbecue" を拾う等の誤爆を避ける)
      : entry.en.some((en) => tokens.includes(en));
    if (hit) matched.push(index);
  });
  return matched.length === 1 ? matched[0] : null;
}

/**
 * claim 側の値 (ジャンル名) が、指定クラスの **claim 側 script** の表記に一致するか。
 * 呼び出し側は requirement と claim の script が異なるときだけ使うこと。
 */
export function cuisineClassMatchesGenre(
  classId: number,
  genreValue: string,
): boolean {
  const entry = CUISINE_LEXICON[classId];
  if (!entry) return false;
  const value = canonical(genreValue);
  if (!value) return false;
  return isJapaneseCuisineText(value)
    ? entry.ja.test(value)
    : latinTokens(value).some((token) => entry.en.includes(token));
}
