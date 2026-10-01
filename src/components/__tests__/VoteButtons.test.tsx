// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VoteButtons } from '@/components/VoteButtons';

afterEach(cleanup);

describe('VoteButtons', () => {
  it('renders all three vote options with their symbols and labels', () => {
    const { getByLabelText, getByText } = render(<VoteButtons value={0} />);

    getByLabelText('行きたい');
    getByLabelText('どちらでも');
    getByLabelText('行きたくない');
    getByText('👍');
    getByText('🤔');
    getByText('👎');
  });

  // #346: 未投票（votes に行が無い）と明示の 0 票を区別する。
  it('keeps every option unselected while the user has not voted (value undefined)', () => {
    const { getByLabelText } = render(<VoteButtons />);

    const like = getByLabelText('行きたい');
    const neutral = getByLabelText('どちらでも');
    const dislike = getByLabelText('行きたくない');
    // 全ボタンが非アクティブ＝同一スタイル。投票して初めて選択状態が付く。
    expect(like.className).toBe(neutral.className);
    expect(neutral.className).toBe(dislike.className);
  });

  it('styles only the option matching the current vote value', () => {
    // 注: RN-web ~0.21 は accessibilityState を DOM へ転送しないため、
    // aria-selected ではなく class の差分でアクティブ状態をピン留めする。
    const { getByLabelText, rerender } = render(<VoteButtons value={1} />);

    const like = getByLabelText('行きたい');
    const neutral = getByLabelText('どちらでも');
    const dislike = getByLabelText('行きたくない');
    // 非アクティブ同士は同一スタイル、アクティブのみ異なる。
    expect(neutral.className).toBe(dislike.className);
    expect(like.className).not.toBe(neutral.className);

    rerender(<VoteButtons value={-1} />);
    expect(getByLabelText('行きたくない').className).not.toBe(
      getByLabelText('どちらでも').className
    );
    expect(getByLabelText('行きたい').className).toBe(
      getByLabelText('どちらでも').className
    );
  });

  it('calls onChange with 1 / 0 / -1 when each option is pressed', () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<VoteButtons value={0} onChange={onChange} />);

    fireEvent.click(getByLabelText('行きたい'));
    fireEvent.click(getByLabelText('どちらでも'));
    fireEvent.click(getByLabelText('行きたくない'));

    expect(onChange.mock.calls).toEqual([[1], [0], [-1]]);
  });

  it('does not crash when pressed without an onChange handler', () => {
    const { getByLabelText } = render(<VoteButtons value={0} />);
    expect(() => fireEvent.click(getByLabelText('行きたい'))).not.toThrow();
  });
});
