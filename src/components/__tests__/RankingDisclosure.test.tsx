// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RankingDisclosure } from '@/components/RankingDisclosure';

afterEach(cleanup);

describe('RankingDisclosure', () => {
  // #269: 順位=入力条件への適合度（店舗の一般的な優劣ではない）・投票の影響・非金銭性を常設開示する。
  // 文言は ranking.ts（spec §17）の実装事実と同期する。収益化時は #270 の広告表示仕様に従い更新する。
  it('順位の性質・投票の影響・非金銭性を testID 付きで表示する', () => {
    const { getByTestId } = render(<RankingDisclosure />);

    const text = getByTestId('ranking-disclosure').textContent ?? '';
    expect(text).toContain('順位は入力した条件への適合度を示すもの');
    expect(text).toContain('店舗の一般的な優劣や人気の順位ではありません');
    expect(text).toContain('メンバーの投票も順位に反映されます');
    expect(text).toContain('掲載順位について店舗等から金銭を受け取っていません');
  });
});
