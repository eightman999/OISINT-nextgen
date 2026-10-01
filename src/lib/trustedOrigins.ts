/**
 * Client-side egress destinations.  These checks are intentionally narrower
 * than a generic URL parser: Supabase/Auth credentials must never follow an
 * arbitrary EXPO_PUBLIC_* URL.
 */
function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function isTrustedSupabaseOrigin(
  raw: string,
  allowLocal = isDevelopmentRuntime(),
): boolean {
  try {
    const url = new URL(raw);
    const local = isLocalHost(url.hostname);
    const projectHost = /^[a-z0-9][a-z0-9-]{0,62}\.supabase\.co$/i.test(url.hostname);
    if (local) {
      if (!allowLocal || !['http:', 'https:'].includes(url.protocol)) return false;
    } else if (!projectHost || url.protocol !== 'https:') {
      return false;
    }
    return !url.username && !url.password && (local || !url.port) &&
      (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isTrustedApiOrigin(
  raw: string,
  allowLocal = isDevelopmentRuntime(),
): boolean {
  try {
    const url = new URL(raw);
    const local = isLocalHost(url.hostname);
    const productionHost = url.hostname.toLowerCase() === 'api.oisint.com';
    if (local) {
      if (!allowLocal || !['http:', 'https:'].includes(url.protocol)) return false;
    } else if (!productionHost || url.protocol !== 'https:') {
      return false;
    }
    return !url.username && !url.password && (local || !url.port) &&
      (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function normalizeTrustedOrigin(
  raw: string,
  kind: 'supabase' | 'api',
): string | null {
  const trusted = kind === 'supabase' ? isTrustedSupabaseOrigin(raw) : isTrustedApiOrigin(raw);
  if (!trusted) return null;
  return new URL(raw).origin;
}
