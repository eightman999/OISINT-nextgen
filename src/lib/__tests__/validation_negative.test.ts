import { describe, expect, it } from 'vitest';

import {
  apiErrorSchema,
  createInvestigationResponseSchema,
  investigationStatusSchema,
  joinInvestigationResponseSchema,
  rerankInvestigationResponseSchema,
  runInvestigationResponseSchema,
  structuredClaimSchema,
} from '@/lib/validation';

const VALID_UUID = '4b4b1c8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

describe('API response validation: negative and edge cases', () => {
  it('rejects unknown and case-mismatched status values', () => {
    expect(investigationStatusSchema.safeParse('paused').success).toBe(false);
    expect(investigationStatusSchema.safeParse('COMPLETE').success).toBe(false);
    expect(investigationStatusSchema.safeParse('').success).toBe(false);
    expect(investigationStatusSchema.safeParse(undefined).success).toBe(false);
  });

  it('rejects unknown extra fields at the external response boundary', () => {
    // 外部応答は unknown key を画面・状態へ取り込まない。strict schema の契約を固定する。
    expect(createInvestigationResponseSchema.safeParse({
      investigationId: VALID_UUID,
      shareToken: VALID_TOKEN,
      extraField: 'should-disappear',
    }).success).toBe(false);

    expect(runInvestigationResponseSchema.safeParse({ status: 'complete', debug: true }).success)
      .toBe(false);
  });

  it('rejects responses with missing required fields', () => {
    expect(createInvestigationResponseSchema.safeParse({}).success).toBe(false);
    expect(
      createInvestigationResponseSchema.safeParse({ investigationId: VALID_UUID }).success
    ).toBe(false);
    expect(runInvestigationResponseSchema.safeParse({}).success).toBe(false);
    expect(joinInvestigationResponseSchema.safeParse({ title: '池袋' }).success).toBe(false);
  });

  it('rejects malformed nested structures', () => {
    expect(structuredClaimSchema.safeParse({ value: '焼肉' }).success).toBe(false);
    expect(structuredClaimSchema.safeParse({ key: 123, value: '焼肉' }).success).toBe(false);
    expect(
      structuredClaimSchema.safeParse({ key: 'genre', value: '焼肉', rawText: 123 }).success
    ).toBe(false);
    expect(
      joinInvestigationResponseSchema.safeParse({ investigationId: { id: 'x' }, title: 't' })
        .success
    ).toBe(false);
    expect(apiErrorSchema.safeParse({ error: { message: '失敗' } }).success).toBe(false);
    expect(rerankInvestigationResponseSchema.safeParse(null).success).toBe(false);
  });

  it('pins lenient corners of the current schemas', () => {
    // structuredClaim.key は ClaimKey enum に制限されておらず任意文字列を受ける（現状仕様）。
    expect(
      structuredClaimSchema.safeParse({ key: 'not_a_known_claim_key', value: null }).success
    ).toBe(true);
    // join レスポンスの title は空文字も許容される（現状仕様）。
    expect(
      joinInvestigationResponseSchema.safeParse({ investigationId: 'inv-001', title: '' })
        .success
    ).toBe(true);
    // investigationId の min(1) は空文字のみ拒否する。
    expect(
      joinInvestigationResponseSchema.safeParse({ investigationId: '', title: '池袋' }).success
    ).toBe(false);
  });
});
