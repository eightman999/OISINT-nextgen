const PUBLIC_NO_AUTO_AUTH_PATHS = new Set(['/demo', '/account', '/admin/analytics']);
const WEB_AUTH_REDIRECT_ORIGINS = new Set([
  'https://oisint.com',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  'http://127.0.0.1:8081',
  'http://localhost:8081',
]);
const NATIVE_AUTH_REDIRECT_URLS = new Set(['oisint://account']);

export function normalizeEmailLogin(identifier: string): string {
  const normalized = identifier.trim();
  // CI/debug fixtureだけがTEST短縮入力を許可し、production bundleへ導線を残さない。
  if (process.env.NODE_ENV !== 'production' && normalized.toUpperCase() === 'TEST') {
    return ['test', 'example.com'].join('@');
  }
  return normalized.toLowerCase();
}

/** 匿名JWTから別メールアカウントへ移る操作は、利用者の明示確認を要求する。 */
export function requiresAnonymousEmailSwitchConfirmation(
  isAnonymous: boolean,
  confirmed: boolean,
): boolean {
  return isAnonymous && !confirmed;
}

/** 匿名セッションは同じJWT subjectを保つlink、その他は通常OAuth sign-inを使う。 */
export function googleAuthFlowFor(
  status: 'anonymous' | 'authenticated' | 'admin' | string,
): 'link_identity' | 'sign_in_oauth' {
  return status === 'anonymous' ? 'link_identity' : 'sign_in_oauth';
}

/** server削除後、local signOutが失敗したときも失敗表示にせず安全な案内へ戻す。 */
export function accountDeletionRedirect(localSessionCleared: boolean): '/' | '/account?deletion=local-session-warning' {
  return localSessionCleared ? '/' : '/account?deletion=local-session-warning';
}

export function shouldAutoCreateAnonymousSession(pathname: string | null | undefined): boolean {
  // Router初期化中に未確定のURLを製品トップと解釈すると、/account直アクセスで
  // 匿名セッションを先に作る競合が起きるため、未確定時はfail-closedにする。
  if (!pathname) return false;
  const normalized = normalizePathname(pathname);
  return !PUBLIC_NO_AUTO_AUTH_PATHS.has(normalized);
}

export function buildWebAuthRedirect(origin: string | null | undefined): string {
  const fallback = 'https://oisint.com';

  try {
    const parsed = new URL(origin || fallback);
    if (!WEB_AUTH_REDIRECT_ORIGINS.has(parsed.origin)) {
      return `${fallback}/account`;
    }
    return new URL('/account', parsed.origin).toString();
  } catch {
    return `${fallback}/account`;
  }
}

/**
 * OAuth callback は Supabase の allow-list と同じ exact URL 契約で判定する。
 * origin-only、別パス、query/hash 付き、custom scheme の別 host は許可しない。
 */
export function isAllowedAuthRedirect(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'oisint:') {
      return NATIVE_AUTH_REDIRECT_URLS.has(url);
    }
    return WEB_AUTH_REDIRECT_ORIGINS.has(parsed.origin) &&
      parsed.pathname === '/account' &&
      parsed.search === '' &&
      parsed.hash === '';
  } catch {
    return false;
  }
}

function normalizePathname(pathname: string | null | undefined): string {
  const value = (pathname || '/').split('?')[0].split('#')[0];
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  const withoutTrailingSlash =
    withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
  return withoutTrailingSlash.toLowerCase();
}
