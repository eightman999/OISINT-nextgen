interface AuthStorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const providerSafeAuthStorage: AuthStorageAdapter = {
  getItem(key) {
    const storage = getBrowserStorage();
    if (!storage) return null;
    try {
      const stored = storage.getItem(key);
      if (!stored) return stored;
      const safeValue = stripOAuthProviderTokens(stored);
      if (safeValue !== stored) storage.setItem(key, safeValue);
      return safeValue;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    const safeValue = stripOAuthProviderTokens(value);
    const storage = getBrowserStorage();
    if (storage) {
      try {
        storage.setItem(key, safeValue);
        return;
      } catch {
        // The SDK keeps the current session in memory; do not share a module-level SSR fallback.
      }
    }
  },
  removeItem(key) {
    const storage = getBrowserStorage();
    if (storage) {
      try {
        storage.removeItem(key);
      } catch {
        // Storage may be blocked by browser privacy settings.
      }
    }
  },
};

/** Auth削除後にSDKのlocal signOutが失敗した場合の最終ローカル掃除。 */
export function clearPersistedAuthSession(): void {
  const storage = getBrowserStorage();
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key !== null && isSupabaseAuthStorageKey(key),
    );
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // storage accessが拒否されても、呼び出し側はサーバー削除成功を維持し、再読込を案内する。
  }
}

export function isSupabaseAuthStorageKey(key: string): boolean {
  return /^sb-[^\s]+-auth-token$/.test(key);
}

export function stripOAuthProviderTokens(serialized: string): string {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return serialized;

    const safe = { ...(parsed as Record<string, unknown>) };
    delete safe.provider_token;
    delete safe.provider_refresh_token;

    if (safe.session && typeof safe.session === 'object' && !Array.isArray(safe.session)) {
      const nestedSession = { ...(safe.session as Record<string, unknown>) };
      delete nestedSession.provider_token;
      delete nestedSession.provider_refresh_token;
      safe.session = nestedSession;
    }

    return JSON.stringify(safe);
  } catch {
    // Supabase may store non-session values (for example a PKCE verifier) through the same adapter.
    return serialized;
  }
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'object' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}
