// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AgeRequirementNote } from '@/components/AgeRequirementNote';

afterEach(cleanup);

describe('AgeRequirementNote', () => {
  // #273: Gemini API Additional Terms の年齢要件（18歳以上）に基づき、対象年齢を常設開示する。
  // サインイン導線（account-age-requirement）とヘルプ（help-age-requirement)へ testID を分けて配置する。
  it('対象年齢（18歳以上）を testID 付きで表示する', () => {
    const { getByTestId } = render(<AgeRequirementNote testID="help-age-requirement" />);

    const text = getByTestId('help-age-requirement').textContent ?? '';
    expect(text).toContain('本サービスは18歳以上の方を対象としています');
  });

  it('配置先ごとに指定した testID を反映する', () => {
    const { getByTestId } = render(<AgeRequirementNote testID="account-age-requirement" />);

    expect(getByTestId('account-age-requirement')).toBeTruthy();
  });
});
