// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ProgressIndicator } from '@/components/ProgressIndicator';

afterEach(cleanup);

// statusOrder は 7 ステップ:
// parsing → recalling → searching → collecting_evidence → evaluating → ranking → complete
describe('ProgressIndicator', () => {
  it('marks done steps ✓, the current step ●, and pending steps ○ mid-progress', () => {
    const { getAllByText, queryAllByText } = render(
      <ProgressIndicator status="searching" />
    );

    expect(getAllByText('✓')).toHaveLength(2); // parsing, recalling
    expect(getAllByText('●')).toHaveLength(1); // searching
    expect(queryAllByText('○')).toHaveLength(4); // collecting_evidence 以降
  });

  it('shows every step as done when the investigation is complete (#147-3 表示側)', () => {
    const { getAllByText, queryAllByText } = render(
      <ProgressIndicator status="complete" />
    );

    // complete 行自体も ● ではなく ✓ になる（format.statusSymbol の complete 特例）。
    expect(getAllByText('✓')).toHaveLength(7);
    expect(queryAllByText('●')).toHaveLength(0);
    expect(queryAllByText('○')).toHaveLength(0);
  });

  it('does not mark the future complete row as done while in progress (#147-3)', () => {
    const { getByText } = render(<ProgressIndicator status="evaluating" />);

    // 「完了」ラベル行のシンボルは ○（未到達）でなければならない。
    const completeLabel = getByText('完了');
    const row = completeLabel.parentElement;
    expect(row?.textContent).toBe('○完了');
  });

  it('exposes a live-region label describing the current step', () => {
    const { getByLabelText, getByTestId } = render(
      <ProgressIndicator status="collecting_evidence" />
    );

    getByLabelText('調査の進行状況: Evidence収集');
    expect(getByTestId('progress-steps').getAttribute('aria-live')).toBe('polite');
  });

  it('renders every step label', () => {
    const { getByText } = render(<ProgressIndicator status="parsing" />);

    for (const label of [
      '条件解析',
      '類似調査の確認',
      '候補店探索',
      'Evidence収集',
      '条件評価',
      'ランキング',
      '完了',
    ]) {
      getByText(label);
    }
  });
});
