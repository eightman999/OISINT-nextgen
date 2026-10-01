import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteInvestigation } from '@/lib/investigationRepository';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    functions: { invoke: mocks.invoke },
  },
}));

describe('deleteInvestigation (#167)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'owner-1', is_anonymous: true } },
      error: null,
    });
    mocks.invoke.mockResolvedValue({ data: { deleted: true }, error: null });
  });

  it('匿名を含む本人JWTを確認し、調査IDだけをEdgeへ渡す', async () => {
    const investigationId = '00000000-0000-4000-8000-000000000001';
    await deleteInvestigation(investigationId);

    expect(mocks.invoke).toHaveBeenCalledWith('delete-investigation', {
      body: { investigationId },
    });
  });

  it('JWTなし・Edge失敗は安全な固定エラーへ変換する', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no auth') });
    await expect(deleteInvestigation('00000000-0000-4000-8000-000000000001')).rejects.toThrow(
      '認証が必要です。',
    );

    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: 'owner-1', is_anonymous: true } },
      error: null,
    });
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('edge failed') });
    await expect(deleteInvestigation('00000000-0000-4000-8000-000000000001')).rejects.toThrow(
      '調査を削除できませんでした。',
    );
  });
});
