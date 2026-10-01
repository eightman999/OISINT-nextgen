// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VisibilityToggle } from '@/components/VisibilityToggle';
import { setInvestigationVisibility } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  setInvestigationVisibility: vi.fn(),
}));

const setVisibilityMock = vi.mocked(setInvestigationVisibility);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VisibilityToggle', () => {
  it('owner 以外には切り替え UI を表示しない（#115）', () => {
    const { container } = render(
      <VisibilityToggle investigationId="inv-001" visibility="private" canToggle={false} />
    );
    expect(container.querySelector('[data-testid="inv-visibility"]')).toBeNull();
  });

  it('private → public の切り替えを PATCH 経由で行い、コールバックへ通知する', async () => {
    setVisibilityMock.mockResolvedValue('public');
    const onVisibilityChange = vi.fn();

    const { getByTestId, getByText } = render(
      <VisibilityToggle
        investigationId="inv-001"
        visibility="private"
        canToggle
        onVisibilityChange={onVisibilityChange}
      />
    );

    getByText('非公開');
    fireEvent.click(getByTestId('inv-visibility-toggle'));
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith('public'));
    expect(setVisibilityMock).toHaveBeenCalledWith('inv-001', 'public');
  });

  it('公開中は「非公開にする」を表示し、失敗時はエラーを出す', async () => {
    setVisibilityMock.mockRejectedValue(new Error('権限がありません'));

    const { getByTestId, getByText, findByText } = render(
      <VisibilityToggle investigationId="inv-001" visibility="public" canToggle />
    );

    getByText('公開中');
    fireEvent.click(getByTestId('inv-visibility-toggle'));
    await findByText('公開設定を変更できませんでした。権限と通信状態を確認してください。');
  });
});
