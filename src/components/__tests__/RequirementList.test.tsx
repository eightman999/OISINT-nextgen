// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequirementList } from '@/components/RequirementList';
import { mockRequirements } from '@/data/mock';

afterEach(cleanup);

describe('RequirementList', () => {
  it('renders one chip per requirement using normalizedText', () => {
    const { getByText } = render(<RequirementList requirements={mockRequirements} />);

    for (const requirement of mockRequirements) {
      getByText(requirement.normalizedText);
    }
  });

  it('shows the add chip only when onAddPress is provided, and wires the press', () => {
    const withoutAdd = render(<RequirementList requirements={mockRequirements} />);
    expect(withoutAdd.queryByLabelText('条件を追加')).toBeNull();
    withoutAdd.unmount();

    const onAddPress = vi.fn();
    const { getByLabelText } = render(
      <RequirementList requirements={mockRequirements} onAddPress={onAddPress} />
    );
    fireEvent.click(getByLabelText('条件を追加'));
    expect(onAddPress).toHaveBeenCalledTimes(1);
  });
});
