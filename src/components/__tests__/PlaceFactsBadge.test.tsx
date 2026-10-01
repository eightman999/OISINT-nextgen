// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PlaceFactsBadge } from '@/components/PlaceFactsBadge';
import { mockPlaceFacts } from '@/data/mockPlaceFacts';

afterEach(cleanup);

describe('PlaceFactsBadge', () => {
  it('矛盾ありのキーに警告を出し、確度と根拠件数を表示する（#333）', () => {
    const { getByTestId, getByText } = render(
      <PlaceFactsBadge facts={mockPlaceFacts['p-a']} />
    );

    getByText('蓄積済みの調査結果（複数調査の集約）');

    // conflicting=true の opening_hours には警告表示
    getByTestId('place-fact-opening_hours');
    expect(getByTestId('place-fact-conflict-opening_hours').textContent).toContain(
      '複数の調査で矛盾があります'
    );

    // confidence 高（card_accepted 100%）と低（reservation 40%）の可視化
    expect(getByTestId('place-fact-card_accepted').textContent).toContain('確度 100%');
    expect(getByTestId('place-fact-card_accepted').textContent).toContain('カード利用: あり');
    expect(getByTestId('place-fact-reservation').textContent).toContain('確度 40%');

    // 矛盾の無いキーには警告を出さない
    expect(
      render(<PlaceFactsBadge facts={mockPlaceFacts['p-a']} />).queryByTestId(
        'place-fact-conflict-card_accepted'
      )
    ).toBeNull();
  });

  it('薄い fact（根拠1件・矛盾なし）は表示しない', () => {
    const { queryByTestId } = render(<PlaceFactsBadge facts={mockPlaceFacts['p-a']} />);
    expect(queryByTestId('place-fact-noise_level')).toBeNull();
  });

  it('place_facts が無い place では何も描画しない（Evidence 表示へのフォールバック）', () => {
    const { queryByTestId } = render(<PlaceFactsBadge facts={[]} />);
    expect(queryByTestId('place-facts')).toBeNull();
  });
});
