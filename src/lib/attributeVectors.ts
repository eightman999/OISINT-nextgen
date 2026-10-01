export const PERSONAL_ATTRIBUTE_VECTOR_DIMENSION = 768;

// health は個人向けの保存対象になり得るが、匿名集計の許可リストには含めない。
export const PERSONAL_ATTRIBUTE_KEYS = [
  'evidence',
  'health',
  'quiet',
  'value',
  'novelty',
  'groupFit',
] as const;

export type PersonalAttributeKey = (typeof PERSONAL_ATTRIBUTE_KEYS)[number];

export const AGGREGATEABLE_ATTRIBUTE_KEYS = [
  'evidence',
  'quiet',
  'value',
  'novelty',
  'groupFit',
] as const;

export function isPersonalAttributeKey(value: unknown): value is PersonalAttributeKey {
  return typeof value === 'string' && (PERSONAL_ATTRIBUTE_KEYS as readonly string[]).includes(value);
}

export function isAggregateableAttributeKey(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (AGGREGATEABLE_ATTRIBUTE_KEYS as readonly string[]).includes(value)
  );
}

// DB/RPCへ渡す前の境界検証。範囲補正や欠損値の補完は行わず、不正ならnullを返す。
export function validatePersonalAttributeVector(
  attributeKey: unknown,
  vector: unknown,
): { attributeKey: PersonalAttributeKey; embedding: number[] } | null {
  if (!isPersonalAttributeKey(attributeKey) || !Array.isArray(vector)) return null;
  if (vector.length !== PERSONAL_ATTRIBUTE_VECTOR_DIMENSION) return null;
  if (!vector.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return { attributeKey, embedding: [...vector] };
}
