import type { TasteAxis } from '@/lib/personaCalibration';

export interface CanonicalTasteSignal {
  label: string;
  axisTargets: Partial<Record<TasteAxis, number>>;
}

interface TasteTaxonomyEntry extends CanonicalTasteSignal {
  patterns: RegExp[];
}

const TAXONOMY: TasteTaxonomyEntry[] = [
  { label: 'ラーメン', patterns: [/ラーメン/i, /らーめん/i, /ramen/i], axisTargets: {} },
  {
    label: 'うどん・そば',
    patterns: [/うどん/i, /蕎麦/i, /そば/i, /soba/i, /udon/i],
    axisTargets: {},
  },
  { label: '寿司', patterns: [/寿司/i, /鮨/i, /sushi/i], axisTargets: {} },
  {
    label: '和食',
    patterns: [/和食/i, /日本料理/i, /washoku/i, /japanese cuisine/i],
    axisTargets: {},
  },
  {
    label: '町中華・中華',
    patterns: [/町中華/i, /中華/i, /点心/i, /餃子/i, /chinese/i, /dim sum/i],
    axisTargets: {},
  },
  {
    label: '焼肉',
    patterns: [/焼肉/i, /ホルモン/i, /yakiniku/i, /korean bbq/i],
    axisTargets: {},
  },
  { label: 'カレー', patterns: [/カレー/i, /curry/i], axisTargets: {} },
  {
    label: 'イタリアン',
    patterns: [/イタリアン/i, /パスタ/i, /ピザ/i, /italian/i, /pizza/i, /pasta/i],
    axisTargets: {},
  },
  {
    label: 'フレンチ',
    patterns: [/フレンチ/i, /フランス料理/i, /french cuisine/i, /bistro/i],
    axisTargets: {},
  },
  {
    label: 'カフェ',
    patterns: [/カフェ/i, /喫茶/i, /コーヒー/i, /coffee/i, /cafe/i, /café/i],
    axisTargets: {},
  },
  {
    label: 'パン・ベーカリー',
    patterns: [/パン屋/i, /ベーカリー/i, /bakery/i, /boulangerie/i],
    axisTargets: {},
  },
  {
    label: 'スイーツ',
    patterns: [/スイーツ/i, /ケーキ/i, /甘味/i, /dessert/i, /sweets/i, /patisserie/i],
    axisTargets: {},
  },
  { label: '居酒屋', patterns: [/居酒屋/i, /izakaya/i], axisTargets: {} },
  { label: '海鮮', patterns: [/海鮮/i, /魚介/i, /seafood/i], axisTargets: {} },
  {
    label: '郷土料理',
    patterns: [/郷土料理/i, /ご当地/i, /local cuisine/i, /regional cuisine/i],
    axisTargets: { novelty: 78 },
  },
  {
    label: 'ヴィーガン・菜食',
    patterns: [/ヴィーガン/i, /ビーガン/i, /菜食/i, /vegan/i, /vegetarian/i],
    axisTargets: { health: 82 },
  },
  {
    label: '静かな店',
    patterns: [/静か/i, /落ち着/i, /会話しやす/i, /quiet/i, /calm/i],
    axisTargets: { quiet: 86 },
  },
  {
    label: 'にぎやかな店',
    patterns: [/にぎやか/i, /賑やか/i, /活気/i, /lively/i, /vibrant/i],
    axisTargets: { quiet: 20 },
  },
  {
    label: '子連れ向け',
    patterns: [/子連れ/i, /キッズ/i, /家族/i, /family friendly/i, /kids menu/i],
    axisTargets: { groupFit: 86 },
  },
  {
    label: '個人店',
    patterns: [/個人店/i, /店主/i, /ローカル店/i, /independent/i, /owner.?run/i],
    axisTargets: { novelty: 82 },
  },
  {
    label: 'コスパ重視',
    patterns: [/コスパ/i, /手頃/i, /リーズナブル/i, /安く/i, /value for money/i, /affordable/i],
    axisTargets: { value: 86 },
  },
  {
    label: '特別な日',
    patterns: [/記念日/i, /誕生日/i, /デート/i, /お祝い/i, /anniversary/i, /special occasion/i],
    axisTargets: { quiet: 68, groupFit: 70 },
  },
  {
    label: '会食・仕事',
    patterns: [/会食/i, /接待/i, /仕事/i, /商談/i, /business dinner/i],
    axisTargets: { quiet: 78, evidence: 72 },
  },
  {
    label: 'ヘルシー',
    patterns: [/ヘルシー/i, /脂控え/i, /低糖質/i, /高たんぱく/i, /healthy/i, /low.?carb/i],
    axisTargets: { health: 88 },
  },
  {
    label: '公式情報を確認',
    patterns: [/公式情報/i, /公式サイト/i, /更新日/i, /根拠/i, /一次情報/i, /official source/i],
    axisTargets: { evidence: 88 },
  },
];

const TAXONOMY_BY_LABEL = new Map(TAXONOMY.map((entry) => [entry.label, entry]));

export function matchCanonicalTasteSignals(text: string): CanonicalTasteSignal[] {
  const bounded = text.normalize('NFKC').trim().slice(0, 5000);
  if (!bounded) return [];

  return TAXONOMY.filter((entry) => entry.patterns.some((pattern) => pattern.test(bounded))).map(
    ({ label, axisTargets }) => ({ label, axisTargets: { ...axisTargets } }),
  );
}

export function getCanonicalTasteSignal(label: string): CanonicalTasteSignal | undefined {
  const entry = TAXONOMY_BY_LABEL.get(label.trim());
  if (!entry) return undefined;
  return { label: entry.label, axisTargets: { ...entry.axisTargets } };
}

export function mergeAxisTargets(
  signals: readonly CanonicalTasteSignal[],
): Partial<Record<TasteAxis, number>> {
  const values = new Map<TasteAxis, number[]>();
  for (const signal of signals) {
    for (const [axis, target] of Object.entries(signal.axisTargets) as [TasteAxis, number][]) {
      const current = values.get(axis) ?? [];
      current.push(target);
      values.set(axis, current);
    }
  }

  return Object.fromEntries(
    [...values.entries()].map(([axis, targets]) => [
      axis,
      targets.reduce((total, target) => total + target, 0) / targets.length,
    ]),
  );
}
