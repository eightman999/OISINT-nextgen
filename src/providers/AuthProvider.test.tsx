// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/providers/AuthProvider';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInAnonymously: vi.fn(),
  linkIdentity: vi.fn(),
  signInWithOAuth: vi.fn(),
  rpc: vi.fn(),
  openURL: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ isLiveDataProvider: true }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signInAnonymously: mocks.signInAnonymously,
      linkIdentity: mocks.linkIdentity,
      signInWithOAuth: mocks.signInWithOAuth,
    },
    rpc: mocks.rpc,
  },
}));
vi.mock('expo-linking', () => ({ createURL: () => 'oisint://account' }));

function Probe() {
  const auth = useAuth();
  return (
    <>
      <span data-testid="auth-status">{auth.status}</span>
      <span data-testid="auth-user">{auth.userId ?? ''}</span>
      <span data-testid="auth-display">{auth.displayName ?? ''}</span>
      <span data-testid="auth-email">{auth.email ?? ''}</span>
      <span data-testid="auth-avatar">{auth.avatarUrl ?? ''}</span>
      <span data-testid="auth-admin">{String(auth.isAdmin)}</span>
      <span data-testid="auth-error">{auth.errorMessage ?? ''}</span>
      <button type="button" data-testid="google" onClick={() => void auth.signInWithGoogle()}>
        Google
      </button>
      <button type="button" data-testid="reset" onClick={auth.resetLocalAuthState}>
        Reset
      </button>
      <button type="button" data-testid="set-name" onClick={() => auth.setDisplayName('A local name')}>
        Set name
      </button>
    </>
  );
}

const anonymousSession = {
  user: { id: 'anon-owner-1', is_anonymous: true, email: undefined },
  access_token: 'supabase-access-token',
  refresh_token: 'supabase-refresh-token',
};

const localStorageValues = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageValues.set(key, value),
  removeItem: (key: string) => localStorageValues.delete(key),
  clear: () => localStorageValues.clear(),
};

function latestAuthCallback(): (event: string, session: unknown) => void {
  const callback = [...mocks.onAuthStateChange.mock.calls]
    .reverse()
    .flat()
    .find((value): value is (event: string, session: unknown) => void => typeof value === 'function');
  if (typeof callback !== 'function') throw new Error('auth callback unavailable');
  return callback;
}

describe('AuthProvider ownership handoff (#158)', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageMock });
    localStorageMock.clear();
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'publishable-test-key');
    mocks.getSession.mockResolvedValue({ data: { session: anonymousSession }, error: null });
    mocks.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    // 匿名Google連携は、linkIdentityの前にサーバー発行の操作IDを予約する。
    mocks.rpc.mockResolvedValue({ data: '00000000-0000-4000-8000-00000000158a', error: null });
    mocks.signInAnonymously.mockResolvedValue({ data: { session: anonymousSession }, error: null });
  });

  it('Google link failure keeps the anonymous status and ownership subject', async () => {
    mocks.linkIdentity.mockResolvedValueOnce({
      data: { identity: null },
      error: new Error('identity collision'),
    });
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('anonymous'));
    expect(view.getByTestId('auth-user').textContent).toBe('anon-owner-1');
    fireEvent.click(view.getByTestId('google'));

    await waitFor(() => expect(mocks.linkIdentity).toHaveBeenCalledTimes(1));
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled();
    expect(view.getByTestId('auth-status').textContent).toBe('anonymous');
    expect(view.getByTestId('auth-user').textContent).toBe('anon-owner-1');
    expect(view.getByTestId('auth-error').textContent).toContain('Googleログインを開始できませんでした');
  });

  it('anonymous Google handoff uses linkIdentity and does not trust a client user id', async () => {
    mocks.linkIdentity.mockResolvedValueOnce({ data: { identity: { id: 'google-1' } }, error: null });
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('anonymous'));
    fireEvent.click(view.getByTestId('google'));
    await waitFor(() => expect(mocks.linkIdentity).toHaveBeenCalledTimes(1));
    expect(mocks.linkIdentity).toHaveBeenCalledWith({
      provider: 'google',
      options: expect.objectContaining({
        redirectTo: 'http://localhost:3000/account',
        scopes: 'openid email profile',
      }),
    });
    expect(JSON.stringify(mocks.linkIdentity.mock.calls[0])).not.toContain('anon-owner-1');
  });

  it('does not create anonymous auth while account route is explicitly signed out', async () => {
    mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('signed_out'));
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    expect(view.getByTestId('auth-user').textContent).toBe('');
  });

  it('marks only a server allow-listed permanent user as display-only admin', async () => {
    mocks.getSession.mockResolvedValueOnce({
      data: { session: { ...anonymousSession, user: { id: 'permanent-1', is_anonymous: false, email: 'user@example.com' } } },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('admin'));
    expect(view.getByTestId('auth-admin').textContent).toBe('true');
    expect(view.getByTestId('auth-user').textContent).toBe('permanent-1');
  });

  it('clears the previous permanent profile when the auth subject changes', async () => {
    mocks.getSession.mockResolvedValueOnce({
      data: {
        session: {
          ...anonymousSession,
          user: {
            id: 'permanent-a',
            is_anonymous: false,
            email: 'a@example.com',
            user_metadata: { display_name: 'A profile' },
          },
        },
      },
      error: null,
    });
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-display').textContent).toBe('A profile'));
    const callback = latestAuthCallback();
    callback('SIGNED_IN', {
      user: {
        id: 'permanent-b',
        is_anonymous: false,
        email: 'b@example.com',
        user_metadata: {},
      },
    });

    await waitFor(() => expect(view.getByTestId('auth-user').textContent).toBe('permanent-b'));
    expect(view.getByTestId('auth-display').textContent).toBe('');
  });

  it('does not carry an anonymous local display name into a permanent subject', async () => {
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('anonymous'));
    fireEvent.click(view.getByTestId('set-name'));
    await waitFor(() => expect(view.getByTestId('auth-display').textContent).toBe('A local name'));

    const callback = latestAuthCallback();
    callback('SIGNED_IN', {
      user: {
        id: 'permanent-b',
        is_anonymous: false,
        email: 'b@example.com',
        user_metadata: {},
      },
    });

    await waitFor(() => expect(view.getByTestId('auth-user').textContent).toBe('permanent-b'));
    expect(view.getByTestId('auth-display').textContent).toBe('');
  });

  it('converges the provider to signed_out when deletion cleanup requests local reset', async () => {
    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('anonymous'));
    fireEvent.click(view.getByTestId('reset'));
    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('signed_out'));
    expect(view.getByTestId('auth-user').textContent).toBe('');
    expect(view.getByTestId('auth-admin').textContent).toBe('false');
  });

  it('clears every personal field when initialization errors after observing a session', async () => {
    const session = {
      ...anonymousSession,
      user: {
        id: 'permanent-after-error',
        is_anonymous: false,
        email: 'a@example.com',
        user_metadata: { display_name: 'A profile', avatar_url: 'https://example.test/a.png' },
      },
    };
    mocks.onAuthStateChange.mockImplementationOnce((callback: (event: string, value: unknown) => void) => {
      callback('SIGNED_IN', session);
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mocks.getSession.mockRejectedValueOnce(new Error('auth unavailable'));

    const view = render(
      <AuthProvider autoCreateAnonymousSession={false}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByTestId('auth-status').textContent).toBe('error'));
    expect(view.getByTestId('auth-user').textContent).toBe('');
    expect(view.getByTestId('auth-display').textContent).toBe('');
    expect(view.getByTestId('auth-email').textContent).toBe('');
    expect(view.getByTestId('auth-avatar').textContent).toBe('');
    expect(view.getByTestId('auth-admin').textContent).toBe('false');
  });
});
