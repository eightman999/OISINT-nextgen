import { describe, expect, it, vi } from 'vitest';
import { isTrustedApiOrigin, isTrustedSupabaseOrigin } from '@/lib/trustedOrigins';

const createClient = vi.hoisted(() => vi.fn((url: string, key: string, options: unknown) => ({
  url,
  key,
  options,
})));

vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@/lib/authStorage', () => ({
  providerSafeAuthStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

describe('Supabase auth boundary', () => {
  it('uses PKCE and the provider-safe session storage without exposing provider tokens', async () => {
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'public-anon-key');

    const { isSupabaseConfigured } = await import('@/lib/supabase');
    expect(isSupabaseConfigured).toBe(true);
    expect(createClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'public-anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: expect.any(Object),
        }),
      }),
    );
    expect(JSON.stringify(createClient.mock.calls)).not.toMatch(/provider_(?:refresh_)?token/i);
  });

  it('Auth JWTの宛先は正規originへ限定し、悪性URLをfail-closedにする', () => {
    expect(isTrustedSupabaseOrigin('https://project.supabase.co')).toBe(true);
    for (const rejected of [
      'https://project.supabase.co.attacker.example',
      'https://user:pass@project.supabase.co',
      'https://project.supabase.co:8443',
      'https://project.supabase.co/functions/v1/run-investigation',
      'https://project.supabase.co/?next=https://attacker.example',
      'https://attacker.example',
    ]) {
      expect(isTrustedSupabaseOrigin(rejected), rejected).toBe(false);
    }
    expect(isTrustedSupabaseOrigin('http://127.0.0.1:54321', false)).toBe(false);
    expect(isTrustedSupabaseOrigin('http://127.0.0.1:54321', true)).toBe(true);
  });

  it('API URLも本番originまたは明示localだけを許可する', () => {
    expect(isTrustedApiOrigin('https://api.oisint.com')).toBe(true);
    for (const rejected of [
      'https://api.oisint.com.attacker.example',
      'https://user:pass@api.oisint.com',
      'https://api.oisint.com:8443',
      'https://api.oisint.com/v1',
      'https://api.oisint.com/?redirect=https://attacker.example',
      'https://attacker.example',
    ]) {
      expect(isTrustedApiOrigin(rejected), rejected).toBe(false);
    }
    expect(isTrustedApiOrigin('http://localhost:8787', true)).toBe(true);
    expect(isTrustedApiOrigin('http://localhost:8787', false)).toBe(false);
  });
});
