// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DisclaimerNote } from '@/components/DisclaimerNote';

afterEach(cleanup);

describe('DisclaimerNote', () => {
  // #266: 文面は owner 承認待ち。#230（規約・免責）の確定時に同期して更新する。
  it('店舗情報の限界表示の1行を testID 付きで表示する', () => {
    const { getByTestId } = render(<DisclaimerNote />);

    expect(getByTestId('disclaimer-note').textContent).toBe(
      '店舗情報は外部情報の自動収集であり正確性を保証しません。最終確認は店舗へお願いします。'
    );
  });
});
