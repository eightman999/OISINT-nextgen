// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CandidateLocationCard } from '@/components/CandidateLocationCard';

afterEach(cleanup);

describe('CandidateLocationCard', () => {
  it('住所は表示するが精密座標の数値を表示しない', () => {
    const { getByTestId, queryByText } = render(
      <CandidateLocationCard
        place={{
          id: 'place-1',
          name: '候補店',
          address: '東京都千代田区丸の内1丁目',
          lat: 35.681236,
          lng: 139.767125,
        }}
      />,
    );

    expect(getByTestId('candidate-location-address').textContent).toBe(
      '東京都千代田区丸の内1丁目',
    );
    expect(getByTestId('candidate-location-precision-note').textContent).toContain(
      '数値はこの画面や共有URLに表示しません',
    );
    expect(queryByText(/35\.681236|139\.767125/)).toBeNull();
  });

  it('住所・座標が無い場合は未確認を明示する', () => {
    const { getByTestId } = render(
      <CandidateLocationCard place={{ id: 'place-2', name: '未確認店' }} />,
    );

    expect(getByTestId('candidate-location-address').textContent).toBe(
      '住所はEvidenceで確認できていません',
    );
    expect(getByTestId('candidate-location-precision-note').textContent).toContain(
      '精密位置は未確認',
    );
  });

  it('範囲外の座標は確認済みとして扱わない', () => {
    const { getByTestId } = render(
      <CandidateLocationCard
        place={{ id: 'place-3', name: '不正座標店', lat: 91, lng: 181 }}
      />,
    );

    expect(getByTestId('candidate-location-precision-note').textContent).toContain(
      '精密位置は未確認',
    );
  });
});
