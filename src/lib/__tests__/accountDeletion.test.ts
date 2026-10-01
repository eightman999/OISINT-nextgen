import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteAccount } from '@/lib/accountRepository';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: mocks.getUser,
      getSession: mocks.getSession,
      signOut: mocks.signOut,
    },
  },
}));

describe('deleteAccount (#167)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'public-anon-key');
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', is_anonymous: false } },
      error: null,
    });
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: 'user-1' },
          access_token: 'jwt-token',
        },
      },
      error: null,
    });
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.signOut.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('JWT subjectを確認し、削除対象をbodyへ渡さずtrusted Edge経路を呼ぶ', async () => {
    await deleteAccount();

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/delete-account',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          apikey: 'public-anon-key',
        }),
      }),
    );
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('匿名JWTでも本人のアカウント削除をEdgeへ委譲する', async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: 'anon-1', is_anonymous: true } },
      error: null,
    });
    mocks.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'anon-1' }, access_token: 'anon-jwt' } },
      error: null,
    });

    await deleteAccount();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('JWTが無い場合はEdgeもAuthセッション破棄も呼ばない', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no auth') });

    await expect(deleteAccount()).rejects.toThrow('認証が必要です。');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('掃除Edge失敗時にAuthセッション破棄を成功扱いしない', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('edge failed'));

    await expect(deleteAccount()).rejects.toThrow('アカウントを削除できませんでした。');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('成功HTTPでも削除確認レスポンスが無ければAuthセッションを破棄しない', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: false }), { status: 200 }),
    );

    await expect(deleteAccount()).rejects.toThrow('アカウントを削除できませんでした。');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('unknown fieldを含む削除応答を成功扱いしない', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: true, userId: 'leak' }), { status: 200 }),
    );

    await expect(deleteAccount()).rejects.toThrow('アカウントを削除できませんでした。');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('過大応答をstream上限で拒否する', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('x'.repeat(16 * 1024 + 1), { status: 200 }),
    );

    await expect(deleteAccount()).rejects.toThrow('アカウントを削除できませんでした。');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('不正UTF-8応答を拒否する', async () => {
    const body = new Uint8Array([0x7b, 0x22, 0x64, 0x65, 0x6c, 0x65, 0x74, 0x65, 0x64, 0x22, 0x3a, 0xff, 0x7d]);
    mocks.fetch.mockResolvedValueOnce(new Response(body, { status: 200 }));

    await expect(deleteAccount()).rejects.toThrow('アカウントを削除できませんでした。');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('redirect拒否をfetch契約へ渡す', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('redirect blocked'));

    await expect(deleteAccount()).rejects.toThrow('アカウントを削除できませんでした。');
    expect(mocks.fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('サーバー削除成功後のlocal signOut失敗は削除失敗に変換しない', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: new Error('storage unavailable') });

    await expect(deleteAccount()).resolves.toEqual({ localSessionCleared: false });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('local signOutがthrowしてもサーバー削除成功を維持する', async () => {
    mocks.signOut.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteAccount()).resolves.toEqual({ localSessionCleared: false });
  });
});
