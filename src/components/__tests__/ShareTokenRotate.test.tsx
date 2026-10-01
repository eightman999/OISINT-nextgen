// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShareTokenRotate } from '@/components/ShareTokenRotate';

const rotateShareToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ rotateShareToken }));

afterEach(() => {
  cleanup();
  rotateShareToken.mockReset();
});

const NEW_TOKEN = 'a'.repeat(32);

describe('ShareTokenRotate', () => {
  it('1回目の押下では実行せず、旧リンク失効の警告と確認ボタンを出す', () => {
    const onRotated = vi.fn();
    const { getByLabelText, getByText } = render(
      <ShareTokenRotate investigationId="inv-1" userId="owner-1" onRotated={onRotated} />
    );

    fireEvent.click(getByLabelText('共有リンクを作り直す'));

    getByText('今までの共有リンクは使えなくなります。参加済みのメンバーはそのまま残ります。');
    getByText('本当に作り直す');
    expect(rotateShareToken).not.toHaveBeenCalled();
    expect(onRotated).not.toHaveBeenCalled();
  });

  it('2回目の押下で rotate を実行し、新 token を onRotated へ渡す', async () => {
    rotateShareToken.mockResolvedValueOnce(NEW_TOKEN);
    const onRotated = vi.fn();
    const { getByLabelText, findByText } = render(
      <ShareTokenRotate investigationId="inv-1" userId="owner-1" onRotated={onRotated} />
    );

    fireEvent.click(getByLabelText('共有リンクを作り直す'));
    fireEvent.click(getByLabelText('共有リンクの作り直しを確定'));

    await findByText('共有リンクを作り直しました。以前のリンクは使えません。');
    expect(rotateShareToken).toHaveBeenCalledWith('inv-1', 'owner-1');
    expect(onRotated).toHaveBeenCalledWith(NEW_TOKEN);
  });

  it('キャンセルで確認状態を解除し、rotate を実行しない', () => {
    const onRotated = vi.fn();
    const { getByLabelText, queryByText } = render(
      <ShareTokenRotate investigationId="inv-1" userId="owner-1" onRotated={onRotated} />
    );

    fireEvent.click(getByLabelText('共有リンクを作り直す'));
    fireEvent.click(getByLabelText('共有リンクの作り直しをやめる'));

    expect(queryByText('本当に作り直す')).toBeNull();
    expect(rotateShareToken).not.toHaveBeenCalled();
  });

  it('rotate 失敗時はエラーを表示し、onRotated を呼ばない', async () => {
    rotateShareToken.mockRejectedValueOnce(new Error('denied'));
    const onRotated = vi.fn();
    const { getByLabelText, findByText } = render(
      <ShareTokenRotate investigationId="inv-1" userId="owner-1" onRotated={onRotated} />
    );

    fireEvent.click(getByLabelText('共有リンクを作り直す'));
    fireEvent.click(getByLabelText('共有リンクの作り直しを確定'));

    await findByText('共有リンクを作り直せませんでした。権限と通信状態を確認してください。');
    expect(onRotated).not.toHaveBeenCalled();
  });
});
