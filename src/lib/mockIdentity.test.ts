// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('mock identity boundary', () => {
  function installStorage(): Storage {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
    return storage;
  }

  beforeEach(() => {
    vi.resetModules();
    installStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Auth側とprovider側がlocalStorageの同じsubjectを共有する', async () => {
    const { getOrCreateMockUserId } = await import('@/lib/mockIdentity');
    const { mockProvider } = await import('@/lib/providers/mock');

    expect(await mockProvider.getUserId()).toBe(getOrCreateMockUserId());
    expect(window.localStorage.getItem('oisint:mock-auth-subject:v1')).toBe(
      await mockProvider.getUserId(),
    );
  });

  it('localStorageが使えない場合も同一module fallbackを再利用する', async () => {
    const { getOrCreateMockUserId } = await import('@/lib/mockIdentity');
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage unavailable');
      },
    });

    try {
      const first = getOrCreateMockUserId();
      const { mockProvider } = await import('@/lib/providers/mock');
      expect(getOrCreateMockUserId()).toBe(first);
      expect(await mockProvider.getUserId()).toBe(first);
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });
});
