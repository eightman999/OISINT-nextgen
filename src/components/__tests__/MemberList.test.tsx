// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MemberList } from '@/components/MemberList';
import { mockMembers } from '@/data/mock';

afterEach(cleanup);

describe('MemberList', () => {
  it('shows one avatar initial per member and the participant count', () => {
    const { getByTestId, getByText } = render(<MemberList members={mockMembers} />);

    getByText('ま');
    getByText('ゆ');
    getByText('た');
    expect(getByTestId('member-count').textContent).toBe('3人が参加中');
  });

  it('shows a zero participant count for an empty member list', () => {
    const { getByTestId } = render(<MemberList members={[]} />);

    expect(getByTestId('member-count').textContent).toBe('0人が参加中');
  });
});
