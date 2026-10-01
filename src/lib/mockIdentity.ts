const MOCK_USER_ID_STORAGE_KEY = 'oisint:mock-auth-subject:v1';

let fallbackMockUserId: string | null = null;

function generateMockUserId(): string {
  return 'u-' + Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

/**
 * Mock UIとmock providerが同じ論理subjectを使うための正本。
 * localStorageが利用できないSSR/テスト環境でも、このmodule内fallbackを共有する。
 */
export function getOrCreateMockUserId(): string {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(MOCK_USER_ID_STORAGE_KEY);
      if (stored && /^u-[0-9a-f]{8}$/u.test(stored)) return stored;
      if (!fallbackMockUserId) fallbackMockUserId = generateMockUserId();
      window.localStorage.setItem(MOCK_USER_ID_STORAGE_KEY, fallbackMockUserId);
      return fallbackMockUserId;
    } catch {
      // localStorageが拒否されても同一module内のfallbackを使い続ける。
    }
  }

  if (!fallbackMockUserId) fallbackMockUserId = generateMockUserId();
  return fallbackMockUserId;
}
