// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SensitiveInputNote } from '@/components/SensitiveInputNote';

afterEach(cleanup);

describe('SensitiveInputNote', () => {
  // #280: APPI 法20条2項。文言は Issue の指定に合わせる。
  // 同意取得/入力禁止の方針判断は owner 待ちのため、UIコピーのみで固定する。
  it('要配慮個人情報の注意喚起1行を testID 付きで表示する', () => {
    const { getByTestId } = render(<SensitiveInputNote />);

    expect(getByTestId('sensitive-input-note').textContent).toBe(
      '持病・アレルギーなどの要配慮個人情報は入力しないでください。'
    );
  });
});
