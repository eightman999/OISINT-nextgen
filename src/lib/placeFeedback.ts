import type {
  PlaceFeedback,
  PlaceFeedbackAspect,
  PlaceFeedbackInput,
  PlaceFeedbackSummary,
} from '@/types';

export const PLACE_FEEDBACK_MIN_SAMPLE_SIZE = 3;

export const PLACE_FEEDBACK_ASPECTS: readonly {
  value: PlaceFeedbackAspect;
  label: string;
}[] = [
  { value: 'noise', label: '静かさ' },
  { value: 'space', label: '席の快適さ' },
  { value: 'value', label: 'コスパ' },
  { value: 'service', label: '接客' },
];

// Shared UGC is intentionally a closed vocabulary.  Existing legacy rows may
// contain older synonyms/free text, but new writes and public facts must use
// only these canonical values.
export const PLACE_FEEDBACK_VALUE_OPTIONS: Readonly<
  Record<PlaceFeedbackAspect, readonly { value: string; label: string }[]>
> = {
  noise: [
    { value: 'quiet', label: '静か' },
    { value: 'loud', label: 'にぎやか' },
  ],
  space: [
    { value: 'comfortable', label: '快適' },
    { value: 'cramped', label: '窮屈' },
  ],
  value: [
    { value: 'good', label: '納得' },
    { value: 'bad', label: '割高' },
  ],
  service: [
    { value: 'good', label: '丁寧' },
    { value: 'bad', label: '気になった' },
  ],
};

export function isCanonicalPlaceFeedbackValue(
  aspect: PlaceFeedbackAspect | string | undefined,
  value: string | undefined,
): boolean {
  if (!aspect || !value) return false;
  return (PLACE_FEEDBACK_VALUE_OPTIONS[aspect as PlaceFeedbackAspect] ?? [])
    .some((option) => option.value === value);
}

export function placeFeedbackAspectLabel(aspect: PlaceFeedbackAspect): string {
  return PLACE_FEEDBACK_ASPECTS.find((item) => item.value === aspect)?.label ?? '店舗の様子';
}

/** 公開集計に表示できる、canonicalな項目値の日本語ラベルだけを返す。 */
export function placeFeedbackValueLabel(
  aspect: PlaceFeedbackAspect,
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return PLACE_FEEDBACK_VALUE_OPTIONS[aspect]?.find((item) => item.value === value)?.label;
}

/** API/RPCへ渡す値を正規化し、空の入力や不正な組み合わせを拒否する。 */
export function normalizePlaceFeedbackInput(input: PlaceFeedbackInput): PlaceFeedbackInput {
  const visitedAt = input.visitedAt?.trim();
  const aspectValue = input.aspectValue?.trim();
  const normalized: PlaceFeedbackInput = {
    ...(visitedAt ? { visitedAt } : {}),
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    ...(input.aspect ? { aspect: input.aspect } : {}),
    ...(aspectValue ? { aspectValue } : {}),
  };

  if (normalized.visitedAt && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.visitedAt)) {
    throw new Error('来店日はYYYY-MM-DD形式で入力してください');
  }
  if (normalized.aspect && !PLACE_FEEDBACK_ASPECTS.some((item) => item.value === normalized.aspect)) {
    throw new Error('店舗の様子の項目が不正です');
  }
  if (normalized.aspectValue && !normalized.aspect) {
    throw new Error('評価項目を選択してから内容を入力してください');
  }
  if (normalized.aspectValue && !isCanonicalPlaceFeedbackValue(normalized.aspect, normalized.aspectValue)) {
    throw new Error('店舗の様子は選択肢から選んでください');
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error('来店日・評価・店舗の様子のいずれかを入力してください');
  }
  return normalized;
}

/** RPCの生集計を、3件未満の推測ができない表示契約へ落とす。 */
export function sanitizePlaceFeedbackSummary(
  summary: PlaceFeedbackSummary,
): PlaceFeedbackSummary {
  const visitedCount = Number.isInteger(summary.visitedCount) &&
    summary.visitedCount >= PLACE_FEEDBACK_MIN_SAMPLE_SIZE
    ? summary.visitedCount
    : 0;
  const ratingCount = Number.isInteger(summary.ratingCount) &&
    summary.ratingCount >= PLACE_FEEDBACK_MIN_SAMPLE_SIZE
    ? summary.ratingCount
    : 0;
  const ratingAverage = ratingCount > 0 &&
    typeof summary.ratingAverage === 'number' &&
    Number.isFinite(summary.ratingAverage)
    ? summary.ratingAverage
    : null;

  return {
    placeId: summary.placeId,
    visitedCount,
    ratingCount,
    ratingAverage,
    aspects: summary.aspects.filter(
      (aspect) => Number.isInteger(aspect.count) &&
        aspect.count >= PLACE_FEEDBACK_MIN_SAMPLE_SIZE &&
        isCanonicalPlaceFeedbackValue(aspect.aspect, aspect.aspectValue),
    ),
  };
}

export function hasDisplayablePlaceFeedbackSummary(summary: PlaceFeedbackSummary | undefined): boolean {
  return Boolean(
    summary &&
      (summary.visitedCount >= PLACE_FEEDBACK_MIN_SAMPLE_SIZE ||
        summary.ratingCount >= PLACE_FEEDBACK_MIN_SAMPLE_SIZE ||
        summary.ratingAverage !== null ||
        summary.aspects.length > 0),
  );
}

export function formatPlaceFeedbackRating(rating: PlaceFeedback['rating']): string {
  if (rating === 1) return 'よかった';
  if (rating === -1) return '気になった';
  if (rating === 0) return 'どちらでもない';
  return '未入力';
}
