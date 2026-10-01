import { describe, expect, it } from 'vitest';

import {
  apiErrorSchema,
  createInvestigationResponseSchema,
  investigationStatusSchema,
  joinInvestigationResponseSchema,
  matchStateSchema,
  rerankInvestigationResponseSchema,
  runInvestigationRequestSchema,
  runInvestigationResponseSchema,
  structuredClaimSchema,
} from '@/lib/validation';

const VALID_UUID = '4b4b1c8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

describe('API response validation', () => {
  it('accepts valid investigation lifecycle responses', () => {
    expect(
      createInvestigationResponseSchema.safeParse({
        investigationId: VALID_UUID,
        shareToken: VALID_TOKEN,
      }).success
    ).toBe(true);
    expect(runInvestigationResponseSchema.safeParse({ status: 'complete' }).success).toBe(true);
    expect(rerankInvestigationResponseSchema.safeParse({ reranked: false }).success).toBe(true);
    expect(
      joinInvestigationResponseSchema.safeParse({ investigationId: 'inv-001', title: '池袋' }).success
    ).toBe(true);
  });

  it.each([
    { investigationId: 'inv-001', shareToken: VALID_TOKEN },
    { investigationId: VALID_UUID, shareToken: 'short' },
    { investigationId: VALID_UUID, shareToken: 'G'.repeat(32) },
  ])('rejects malformed create responses: %o', (value) => {
    expect(createInvestigationResponseSchema.safeParse(value).success).toBe(false);
  });

  it('rejects unknown status and wrong primitive types', () => {
    expect(investigationStatusSchema.safeParse('running').success).toBe(false);
    expect(runInvestigationResponseSchema.safeParse({ status: 1 }).success).toBe(false);
    expect(rerankInvestigationResponseSchema.safeParse({ reranked: 'true' }).success).toBe(false);
  });

  it('validates error and evaluation primitives', () => {
    expect(apiErrorSchema.safeParse({ error: '失敗しました' }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: 500 }).success).toBe(false);
    expect(matchStateSchema.safeParse('unknown').success).toBe(true);
    expect(matchStateSchema.safeParse('maybe').success).toBe(false);
    expect(
      structuredClaimSchema.parse({ key: 'genre', value: '焼肉' }).rawText
    ).toBe('');
  });

  it('accepts only a finite, bounded transient GPS search anchor', () => {
    expect(runInvestigationRequestSchema.safeParse({
      investigationId: 'inv-001',
      searchAnchor: { lat: 35.7295, lng: 139.7109 },
    }).success).toBe(true);
    expect(runInvestigationRequestSchema.safeParse({
      investigationId: 'inv-001',
      searchAnchor: { lat: 91, lng: 139.7109 },
    }).success).toBe(false);
    expect(runInvestigationRequestSchema.safeParse({
      investigationId: 'inv-001',
      searchAnchor: { lat: 35.7295, lng: 139.7109, rawQuery: 'GPS' },
    }).success).toBe(false);
  });
});
