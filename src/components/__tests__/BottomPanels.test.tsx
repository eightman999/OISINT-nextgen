// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ComparisonPanel } from '@/components/BottomPanels';
import { mockInvestigation, mockRequirements } from '@/data/mock';

afterEach(cleanup);

describe('ComparisonPanel', () => {
  it('compares three candidates by score, evidence count, votes, and requirement state', () => {
    const { getByTestId, getByText } = render(
      <ComparisonPanel
        candidates={mockInvestigation.candidates}
        requirements={mockRequirements}
        isWide
      />
    );

    getByTestId('candidate-comparison-wide');
    getByText('1位 店A');
    getByText('2位 店B');
    getByText('3位 店C');
    expect(getByTestId('comparison-score-c-1').textContent).toBe('0.91');
    expect(getByTestId('comparison-evidence-c-1').textContent).toBe('2件');
    expect(getByTestId('comparison-votes-c-1').textContent).toBe('👍 2 / 🤔 1 / 👎 0');
    expect(getByTestId('comparison-state-c-3-r-4').textContent).toBe('?');
    expect(getByTestId('comparison-state-c-3-r-4').getAttribute('aria-label')).toBe(
      '店C: 判定不明'
    );
    expect(getByTestId('comparison-state-c-2-r-5').textContent).toBe('×');
  });

  it('uses candidate-by-candidate vertical stacking on mobile without dropping metrics', () => {
    const { getByTestId, getAllByText } = render(
      <ComparisonPanel
        candidates={mockInvestigation.candidates}
        requirements={mockRequirements}
        isWide={false}
      />
    );

    getByTestId('candidate-comparison-stacked');
    expect(getAllByText('順位計算値')).toHaveLength(3);
    expect(getAllByText('Evidence')).toHaveLength(3);
    expect(getAllByText('投票')).toHaveLength(3);
    expect(getByTestId('comparison-score-c-3').textContent).toBe('0.79');
    expect(getByTestId('comparison-votes-c-3').textContent).toBe('👍 2 / 🤔 0 / 👎 1');
    expect(getByTestId('comparison-state-c-3-r-4').textContent).toBe('?');
  });

  it('treats a missing evaluation as unknown instead of mismatch', () => {
    const missingEvaluation = {
      ...mockInvestigation.candidates[0],
      evaluations: mockInvestigation.candidates[0].evaluations.filter(
        (evaluation) => evaluation.requirementId !== 'r-1'
      ),
    };
    const { getByTestId } = render(
      <ComparisonPanel
        candidates={[missingEvaluation]}
        requirements={[mockRequirements[0]]}
        isWide
      />
    );

    expect(getByTestId('comparison-state-c-1-r-1').textContent).toBe('?');
    expect(getByTestId('comparison-state-c-1-r-1').getAttribute('aria-label')).toBe(
      '店A: 判定不明'
    );
  });

  it('does not render a non-finite ranking score as a normal number', () => {
    const invalidScore = { ...mockInvestigation.candidates[0], score: Number.NaN };
    const { getByTestId } = render(
      <ComparisonPanel candidates={[invalidScore]} requirements={[]} isWide />
    );

    expect(getByTestId('comparison-score-c-1').textContent).toBe('?');
  });
});
