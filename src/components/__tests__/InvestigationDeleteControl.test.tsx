// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvestigationDeleteControl } from '@/components/InvestigationDeleteControl';

afterEach(cleanup);

describe('InvestigationDeleteControl (#167)', () => {
  it('owner以外には削除操作を表示しない', () => {
    const { queryByTestId } = render(
      <InvestigationDeleteControl canDelete={false} onDelete={vi.fn()} />,
    );
    expect(queryByTestId('inv-delete-control')).toBeNull();
  });

  it('一度目は確認だけ、二度目で削除を実行する', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, getByText } = render(
      <InvestigationDeleteControl canDelete onDelete={onDelete} />,
    );
    const button = getByTestId('inv-delete-investigation');

    expect(getByText('この操作は取り消せません。調査本文・条件・投票・進行記録を削除します。共有店舗情報と根拠は残ります。')).toBeTruthy();
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-label')).toBe('調査の削除を確定する');

    fireEvent.click(button);
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('実行中は再操作を受け付けない', () => {
    const { getByTestId } = render(
      <InvestigationDeleteControl canDelete busy onDelete={vi.fn()} />,
    );
    expect((getByTestId('inv-delete-investigation') as HTMLButtonElement).disabled).toBe(true);
  });
});
