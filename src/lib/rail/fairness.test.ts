import { describe, expect, it } from 'vitest';

import {
  rankTransitFairness,
  rankTransitFairnessFromProvider,
  type TransitMatrix,
  type TransitMatrixProvider,
  type TransitMatrixRequest,
} from '@/lib/rail/fairness';

const request: TransitMatrixRequest = {
  origins: ['yokohama', 'machida', 'nerima'],
  candidates: ['shinjuku', 'shibuya', 'ikebukuro'],
  departureAt: '2026-08-23T18:00:00+09:00',
};

function matrix(cells: TransitMatrix['cells']): TransitMatrix {
  return {
    request,
    source: { providerId: 'fixture-transit', datasetVersion: 'fixture-2026-08-23' },
    cells,
  };
}

const completeCells: TransitMatrix['cells'] = [
  { origin: 'yokohama', candidate: 'shinjuku', minutes: 38 },
  { origin: 'machida', candidate: 'shinjuku', minutes: 32 },
  { origin: 'nerima', candidate: 'shinjuku', minutes: 25 },
  { origin: 'yokohama', candidate: 'shibuya', minutes: 31 },
  { origin: 'machida', candidate: 'shibuya', minutes: 35 },
  { origin: 'nerima', candidate: 'shibuya', minutes: 42 },
  { origin: 'yokohama', candidate: 'ikebukuro', minutes: 45 },
  { origin: 'machida', candidate: 'ikebukuro', minutes: 44 },
  { origin: 'nerima', candidate: 'ikebukuro', minutes: 18 },
];

describe('multi-origin transit fairness (#146)', () => {
  it('minimaxを主目的とし、比較用の起点別所要時間を保持する', () => {
    const result = rankTransitFairness(matrix([...completeCells].reverse()));

    expect(result.status).toBe('ranked');
    if (result.status !== 'ranked') return;
    expect(result.candidates.map((entry) => entry.candidate)).toEqual([
      'shinjuku',
      'shibuya',
      'ikebukuro',
    ]);
    expect(result.candidates[0]).toMatchObject({
      candidate: 'shinjuku',
      maxMinutes: 38,
      totalMinutes: 95,
      access: [
        { origin: 'yokohama', minutes: 38 },
        { origin: 'machida', minutes: 32 },
        { origin: 'nerima', minutes: 25 },
      ],
    });
  });

  it('最大時間、合計時間、分散、candidate IDの順で決定的にtie-breakする', () => {
    const tieRequest = {
      ...request,
      candidates: ['variance-high', 'variance-low', 'total-high', 'a-id', 'b-id'],
    };
    const values: Record<string, number[]> = {
      'variance-high': [10, 20, 30],
      'variance-low': [19, 20, 21],
      'total-high': [20, 20, 30],
      'a-id': [19, 20, 21],
      'b-id': [19, 20, 21],
    };
    const result = rankTransitFairness({
      ...matrix([]),
      request: tieRequest,
      cells: tieRequest.candidates.flatMap((candidate) =>
        tieRequest.origins.map((origin, index) => ({
          origin,
          candidate,
          minutes: values[candidate][index],
        })),
      ),
    });

    expect(result.status).toBe('ranked');
    if (result.status !== 'ranked') return;
    expect(result.candidates.map((entry) => entry.candidate)).toEqual([
      'a-id',
      'b-id',
      'variance-low',
      'variance-high',
      'total-high',
    ]);
  });

  it('欠損matrixを部分順位で補わず、欠損セルを明示してfail-closedにする', () => {
    const result = rankTransitFairness(matrix(completeCells.slice(1)));

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'incomplete_matrix',
      missingCells: [{ origin: 'yokohama', candidate: 'shinjuku' }],
    });
  });

  it.each([
    {
      name: '重複セル',
      cells: [...completeCells, completeCells[0]],
      reason: 'duplicate_cell',
    },
    {
      name: '負の所要時間',
      cells: [{ ...completeCells[0], minutes: -1 }, ...completeCells.slice(1)],
      reason: 'invalid_duration',
    },
    {
      name: '対象外セル',
      cells: [{ ...completeCells[0], origin: 'unknown' }, ...completeCells.slice(1)],
      reason: 'unexpected_cell',
    },
  ])('$nameを受理しない', ({ cells, reason }) => {
    expect(rankTransitFairness(matrix(cells))).toMatchObject({
      status: 'unavailable',
      reason,
    });
  });

  it('provider失敗と依頼内容の改変をunknownのまま分離する', async () => {
    const unavailable: TransitMatrixProvider = {
      getTransitMatrix: () => Promise.reject(new Error('secret provider detail')),
    };
    await expect(rankTransitFairnessFromProvider(unavailable, request)).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider_unavailable',
    });

    const mismatched: TransitMatrixProvider = {
      getTransitMatrix: () =>
        Promise.resolve({
          ...matrix(completeCells),
          request: { ...request, departureAt: '2026-08-24T18:00:00+09:00' },
        }),
    };
    await expect(rankTransitFairnessFromProvider(mismatched, request)).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider_request_mismatch',
    });
  });
});
