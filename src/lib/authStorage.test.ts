import { describe, expect, it } from 'vitest';

import { isSupabaseAuthStorageKey, stripOAuthProviderTokens } from '@/lib/authStorage';

describe('provider-safe Supabase auth storage', () => {
  it('removes Google provider tokens while preserving the Supabase session', () => {
    const safe = JSON.parse(
      stripOAuthProviderTokens(
        JSON.stringify({
          provider_token: 'google-access-token',
          provider_refresh_token: 'google-refresh-token',
          access_token: 'supabase-jwt',
          refresh_token: 'supabase-refresh-token',
          expires_at: 123,
        }),
      ),
    );

    expect(safe).not.toHaveProperty('provider_token');
    expect(safe).not.toHaveProperty('provider_refresh_token');
    expect(safe.access_token).toBe('supabase-jwt');
    expect(safe.refresh_token).toBe('supabase-refresh-token');
  });

  it('also strips a nested future-compatible session shape', () => {
    const safe = JSON.parse(
      stripOAuthProviderTokens(
        JSON.stringify({
          session: {
            provider_token: 'provider',
            provider_refresh_token: 'provider-refresh',
            access_token: 'supabase',
          },
        }),
      ),
    );

    expect(safe.session).toEqual({ access_token: 'supabase' });
  });

  it('leaves unrelated PKCE storage values unchanged', () => {
    expect(stripOAuthProviderTokens('pkce-verifier-value')).toBe('pkce-verifier-value');
    expect(stripOAuthProviderTokens(JSON.stringify('pkce-verifier-value'))).toBe(
      JSON.stringify('pkce-verifier-value'),
    );
  });

  it('recognizes only Supabase auth session keys for deletion fallback', () => {
    expect(isSupabaseAuthStorageKey('sb-127-auth-token')).toBe(true);
    expect(isSupabaseAuthStorageKey('sb-127-code-verifier')).toBe(false);
    expect(isSupabaseAuthStorageKey('oisint:personalization:v1')).toBe(false);
  });
});
