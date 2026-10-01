import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildWebAuthRedirect,
  accountDeletionRedirect,
  googleAuthFlowFor,
  isAllowedAuthRedirect,
  normalizeEmailLogin,
  requiresAnonymousEmailSwitchConfirmation,
  shouldAutoCreateAnonymousSession,
} from '@/lib/authRouting';

describe('auth routing boundaries', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['/DEMO', '/demo/', '/account', 'account?from=demo', '/admin/analytics'])(
    'does not create an anonymous account on %s',
    (pathname) => {
      expect(shouldAutoCreateAnonymousSession(pathname)).toBe(false);
    },
  );

  it('does not create an anonymous account while the router path is unresolved', () => {
    expect(shouldAutoCreateAnonymousSession(null)).toBe(false);
    expect(shouldAutoCreateAnonymousSession(undefined)).toBe(false);
  });

  it.each(['/', '/help', '/investigations/example'])(
    'keeps anonymous usage available on product route %s',
    (pathname) => {
      expect(shouldAutoCreateAnonymousSession(pathname)).toBe(true);
    },
  );

  it('maps the public TEST login identifier to the seeded email', () => {
    expect(normalizeEmailLogin('TEST')).toBe('test@example.com');
    expect(normalizeEmailLogin(' test ')).toBe('test@example.com');
  });

  it('normalizes regular email login identifiers', () => {
    expect(normalizeEmailLogin(' User@Example.COM ')).toBe('user@example.com');
  });

  it('does not accept the debug TEST shortcut in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(normalizeEmailLogin('TEST')).toBe('test');
  });

  it('requires explicit confirmation before anonymous email account switching', () => {
    expect(requiresAnonymousEmailSwitchConfirmation(true, false)).toBe(true);
    expect(requiresAnonymousEmailSwitchConfirmation(true, true)).toBe(false);
    expect(requiresAnonymousEmailSwitchConfirmation(false, false)).toBe(false);
  });

  it('uses linkIdentity only for anonymous ownership-preserving Google handoff', () => {
    expect(googleAuthFlowFor('anonymous')).toBe('link_identity');
    expect(googleAuthFlowFor('authenticated')).toBe('sign_in_oauth');
    expect(googleAuthFlowFor('admin')).toBe('sign_in_oauth');
  });

  it('routes local-session cleanup failures to an explicit safe notice', () => {
    expect(accountDeletionRedirect(true)).toBe('/');
    expect(accountDeletionRedirect(false)).toBe('/account?deletion=local-session-warning');
  });

  it('pins OAuth redirects to the account path on the current origin', () => {
    expect(buildWebAuthRedirect('http://localhost:8081/evil?next=https://attacker.example')).toBe(
      'http://localhost:8081/account',
    );
    expect(buildWebAuthRedirect('https://oisint.com/DEMO')).toBe(
      'https://oisint.com/account',
    );
    expect(buildWebAuthRedirect('http://127.0.0.1:8081/evil')).toBe(
      'http://127.0.0.1:8081/account',
    );
  });

  it.each([
    'javascript:alert(1)',
    'https://attacker.example',
    'https://oisint.com.attacker.example',
    'https://oisint.com:444',
    'http://localhost:8082',
    'http://127.0.0.1:8081.attacker.example',
    'file:///tmp/account',
    '//attacker.example/account',
  ])('rejects redirect origin outside the exact allow-list: %s', (origin) => {
    expect(buildWebAuthRedirect(origin)).toBe('https://oisint.com/account');
  });

  it('keeps native and web callback policy aligned with the exact Supabase URLs', () => {
    expect(isAllowedAuthRedirect('oisint://account')).toBe(true);
    expect(isAllowedAuthRedirect('https://oisint.com/account')).toBe(true);
    expect(isAllowedAuthRedirect('http://localhost:8081/account')).toBe(true);
  });

  it.each([
    'oisint://account/other',
    'oisint://attacker/account',
    'oisint://account?next=https://attacker.example',
    'https://oisint.com',
    'https://oisint.com/account/',
    'https://oisint.com/account?next=https://attacker.example',
    'https://oisint.com.evil.example/account',
  ])('rejects non-exact callback URL: %s', (url) => {
    expect(isAllowedAuthRedirect(url)).toBe(false);
  });
});
