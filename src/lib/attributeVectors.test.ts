import { describe, expect, it } from 'vitest';

import {
  AGGREGATEABLE_ATTRIBUTE_KEYS,
  PERSONAL_ATTRIBUTE_VECTOR_DIMENSION,
  isAggregateableAttributeKey,
  validatePersonalAttributeVector,
} from '@/lib/attributeVectors';

const vector = () => Array.from({ length: PERSONAL_ATTRIBUTE_VECTOR_DIMENSION }, () => 0.25);

describe('personal attribute vector boundary', () => {
  it('accepts exactly 768 finite values for an individual attribute', () => {
    const checked = validatePersonalAttributeVector('quiet', vector());
    expect(checked?.embedding).toHaveLength(768);
  });

  it('rejects wrong dimensions and non-finite values without clamping', () => {
    expect(validatePersonalAttributeVector('quiet', vector().slice(0, -1))).toBeNull();
    const invalid = vector();
    invalid[10] = Number.NaN;
    expect(validatePersonalAttributeVector('quiet', invalid)).toBeNull();
  });

  it('keeps health individual-only and excludes hard-constraint keys', () => {
    expect(validatePersonalAttributeVector('health', vector())).not.toBeNull();
    expect(isAggregateableAttributeKey('health')).toBe(false);
    expect(isAggregateableAttributeKey('allergy')).toBe(false);
    expect(AGGREGATEABLE_ATTRIBUTE_KEYS).not.toContain('health');
  });
});
