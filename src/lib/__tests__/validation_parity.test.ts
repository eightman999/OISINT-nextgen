// issue #367: zod major を全レイヤ 4.4.3 へ統一した後、同一入力ベクタに対する
// 判定が front (Node zod) と edge (Deno zod) で一致し続けることを front 側から固定する。
// 共有ベクタは scripts/fixtures/zod-parity-vectors.json。edge 側の対になるテストは
// supabase/tests/validation_parity_test.ts (Deno)。判定を変える場合は両方を更新する。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createInvestigationResponseSchema, matchStateSchema } from '@/lib/validation';
import rawVectors from '../../../scripts/fixtures/zod-parity-vectors.json';

interface StringCase {
  input: string;
  valid: boolean;
  note?: string;
}
interface NumberCase {
  input: number;
  valid: boolean;
  note?: string;
}
interface ParityVectors {
  uuid: StringCase[];
  shareToken: StringCase[];
  matchState: StringCase[];
  weight: NumberCase[];
}

const vectors = rawVectors as ParityVectors;

const VALID_UUID = '4b4b1c8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

describe('zod parity vectors (#367)', () => {
  it('parity(uuid): createInvestigationResponseSchema.investigationId の判定が共有ベクタと一致', () => {
    for (const c of vectors.uuid) {
      expect(
        createInvestigationResponseSchema.safeParse({
          investigationId: c.input,
          shareToken: VALID_TOKEN,
        }).success,
        `${c.input}: ${c.note ?? ''}`
      ).toBe(c.valid);
    }
  });

  it('parity(share_token): createInvestigationResponseSchema.shareToken の判定が共有ベクタと一致', () => {
    for (const c of vectors.shareToken) {
      expect(
        createInvestigationResponseSchema.safeParse({
          investigationId: VALID_UUID,
          shareToken: c.input,
        }).success,
        `${c.input}: ${c.note ?? ''}`
      ).toBe(c.valid);
    }
  });

  it('parity(enum): matchStateSchema の判定が共有ベクタと一致', () => {
    for (const c of vectors.matchState) {
      expect(matchStateSchema.safeParse(c.input).success, `${c.input}: ${c.note ?? ''}`).toBe(
        c.valid
      );
    }
  });

  it('parity(数値境界): weight (0..1) の判定が共有ベクタと一致', () => {
    // front に weight スキーマは無いため、edge の parsedRequirementsSchema.weight と
    // 同一表現のプリミティブで zod ランタイム間の判定一致を固定する
    const weightContract = z.number().min(0).max(1);
    for (const c of vectors.weight) {
      expect(weightContract.safeParse(c.input).success, `${c.input}: ${c.note ?? ''}`).toBe(
        c.valid
      );
    }
  });
});
