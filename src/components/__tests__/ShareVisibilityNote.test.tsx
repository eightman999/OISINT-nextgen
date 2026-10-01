// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ShareVisibilityNote } from '@/components/ShareVisibilityNote';

afterEach(cleanup);

describe('ShareVisibilityNote', () => {
  // #275: 共有調査で「誰に何が見えるか」を共有前に明示する（電気通信事業法4条・通信の秘密）。
  // 文言は Issue #275 の是正案（監査レポート §7.2 案）と一致させる。
  it('共有先に見える範囲と入力注意を testID 付きで表示する', () => {
    const { getByTestId } = render(<ShareVisibilityNote />);

    const text = getByTestId('share-visibility-note').textContent ?? '';
    expect(text).toContain('共有リンクを知っている人は、この調査に参加して');
    expect(text).toContain('あなたが入力した条件の文章・候補・投票を見ることができます');
    expect(text).toContain('個人が特定される情報や秘密の情報は入力しないでください');
  });
});
