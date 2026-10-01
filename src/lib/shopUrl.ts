// 店舗ページ・予約導線 URL（places.metadata.shopUrl → place.urls.pc、§3 P1 / #109）。
// DB 由来の外部入力なので Evidence リンクと同様にユーザーのタップでのみ開くが、
// https 以外（http / javascript: 等）は表示せず捨てる（§30 の入力検証方針に合わせ fail closed）。
function isRetiredProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'hotpepper.jp' || host.endsWith('.hotpepper.jp');
}

export function safeShopUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !isRetiredProviderHost(parsed.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}
