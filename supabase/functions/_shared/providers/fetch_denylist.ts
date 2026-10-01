// fetch 対象ドメインの denylist (spec.md §5.4 / Issue #287)
//
// 利用規約で自動収集 (クローリング・スクレイピング等) を明示的に禁止している
// ことが広く知られている国内グルメ口コミ大手を保守的に列挙する。該当ドメイン
// (サブドメイン含む) には robots.txt の取得を含め一切のリクエストを送らない。
// 掲載理由は「規約で自動収集を禁止しているため」という運用判断であり、法的
// 評価の断定ではない (著作権法施行規則 4条の4 の収集禁止の慣行への追従。
// docs/legal/audit-copyright.md R4)。
// 対象サイトの追加・削除の方針決定は owner 作業として Issue #287 に残す。
// 規約 URL は 2026-08-16 に到達確認できたもののみ記載する。
export const FETCH_DENYLIST_DOMAINS: readonly string[] = Object.freeze([
  // 食べログ: 規約で自動収集を禁止しているため (https://tabelog.com/help/rules/)
  "tabelog.com",
  // Retty: 規約で自動収集を禁止しているため
  "retty.me",
  // ヒトサラ: 規約で自動収集を禁止しているため
  "hitosara.com",
  // ぐるなび: 規約で自動収集を禁止しているため
  "gnavi.co.jp",
  // ホットペッパーグルメ: #297 で公式 API の利用を終了した後も、Web ページの
  // 自動収集は行わない (リクルート Webサービス利用規約
  // https://cdn.p.recruit.co.jp/terms/rws-t-1001/index.html)
  "hotpepper.jp",
]);

/**
 * URL を拒否するためだけの明示的なポリシー。
 *
 * `domains: []` は owner が対象をまだ決めていない状態を表現できるが、
 * それを許可リストへ補完したり、別のドメインを推測して追加したりしない。
 * ドメイン単位の判定が不要な場合も、robots / SSRF / egress の境界は別途
 * 必ず適用される。
 */
export interface FetchDenylistPolicy {
  readonly domains: readonly string[];
}

function normalizeDenylistDomain(raw: string): string {
  const domain = raw.toLowerCase().replace(/\.$/, "");
  const labels = domain.split(".");
  const valid = raw === raw.trim() && domain.length <= 253 &&
    domain.length > 0 &&
    labels.every((label) =>
      label.length > 0 && label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    );
  if (!valid) throw new TypeError("invalid fetch denylist domain");
  return domain;
}

/**
 * owner が明示した denylist を immutable なポリシーへ変換する。
 * 空配列はそのまま保持し、allowlist や既定値へ暗黙補完しない。
 * 不正な値は黙って無視せず fail-closed に設定を失敗させる。
 */
export function createFetchDenylistPolicy(
  domains: readonly string[],
): FetchDenylistPolicy {
  const normalized = [...new Set(domains.map(normalizeDenylistDomain))];
  return Object.freeze({ domains: Object.freeze(normalized) });
}

export const DEFAULT_FETCH_DENYLIST_POLICY: FetchDenylistPolicy =
  createFetchDenylistPolicy(FETCH_DENYLIST_DOMAINS);

// 判定は必ず正規化した hostname に対して行う (source_quality.ts と同じ流儀)。
// URL 全体の部分一致にすると、path / query にドメイン名を混ぜた URL を誤って
// 弾き、eviltabelog.com のような別ドメインを見逃す。
function isDomainOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * URL の hostname が denylist ドメイン (サブドメイン含む) に一致するか。
 * normalizeFetchUrl 済みの URL を想定するが、防御的に再正規化して判定する。
 */
export function isFetchDenylisted(
  url: URL,
  policy: FetchDenylistPolicy = DEFAULT_FETCH_DENYLIST_POLICY,
): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return policy.domains.some((domain) => isDomainOrSubdomain(host, domain));
}
