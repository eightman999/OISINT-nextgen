// 軽量フェッチャ (spec.md §5.4 / 2026-08-16 改訂)
// クローラーではない。以下の制約を厳守する:
//   - 検索結果として得た既知 URL のみを fetch (ページ内リンクを辿らない)
//   - timeout 10 秒 / レスポンス上限 500KB
//   - User-Agent 明示 / robots.txt は RFC 9309 準拠で評価し、拒否された URL は
//     fetch しない (redirect の各 hop も再判定)
//   - X-Robots-Tag / <meta name="robots"> の noindex・nosnippet・noarchive・
//     noai (none 含む) を尊重し、該当ページは Evidence 化しない
//   - 利用規約で自動収集を明示的に禁止しているドメイン (fetch_denylist.ts) には
//     robots.txt の取得を含め接続しない (Issue #287)
//   - 原文 HTML は保存せず、タグ除去テキストを Gemini へ渡すのみ (§44.3 L1)
//   - private経路へ到達できる通常の fetch は使わず、公開Internet限定gatewayを必須とする

import { withCache } from "../cache.ts";
import { throwIfAborted, withAbortTimeout } from "../timeout_policy.ts";
import {
  DEFAULT_FETCH_DENYLIST_POLICY,
  type FetchDenylistPolicy,
  isFetchDenylisted,
} from "./fetch_denylist.ts";

// 実送出される UA は egress gateway (apps/api/src/egress.ts の EGRESS_USER_AGENT)
// が付与する。robots.txt の照合対象名が割れないよう両者は同一値でなければ
// ならない (一致は tests/robots_test.ts で検証する)。
export const USER_AGENT =
  "OISINT-Fetcher/0.2 (+https://oisint.com; research bot)";
const FETCH_TIMEOUT_MS = 10_000;
const ROBOTS_TIMEOUT_MS = 3_000;
const MAX_BYTES = 500_000;
// RFC 9309 §2.5: パーサは少なくとも 500 KiB (= 512,000 bytes) を処理すること
const ROBOTS_MAX_PARSE_BYTES = 512_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_REDIRECTS = 5;
export const MAX_CRAWL_DELAY_SECONDS = 86_400;
const EGRESS_POLICY = "deny-private-public-egress-v1";

export interface FetchDeadlinePolicy {
  fetchTimeoutMs: number;
  robotsTimeoutMs: number;
}

const DEFAULT_FETCH_DEADLINES: FetchDeadlinePolicy = Object.freeze({
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  robotsTimeoutMs: ROBOTS_TIMEOUT_MS,
});

export interface FetchedPage {
  url: string;
  text: string;
}

/**
 * クローラー専用の詳細結果。html はリンク抽出中だけメモリ上に置き、
 * queue / DB / ログへは保存しない。
 */
export interface CrawlFetchedPage extends FetchedPage {
  html: string;
  contentType: string;
  byteLength: number;
  nofollow: boolean;
  crawlDelaySeconds: number | null;
}

export type CrawlFetchFailureReason =
  | FetchFailureReason
  | "robots_unavailable"
  | "robots_denied"
  | "redirect_loop"
  | "redirect_rejected"
  | "network_error"
  | "timeout"
  | "http_error"
  | "auth_required"
  | "non_html"
  | "body_too_large"
  | "mime_mismatch"
  | "robots_meta_denied"
  | "empty_body"
  | "aborted";

export type CrawlFetchResult =
  | { ok: true; page: CrawlFetchedPage }
  | {
    ok: false;
    reason: CrawlFetchFailureReason;
    crawlDelaySeconds?: number | null;
  };

type DnsRecordType = "A" | "AAAA";

/**
 * `fetchHop` はDNS検証結果とは独立に、private addressへ到達できないtransportで
 * なければならない。渡すaddress一覧は検証済み証跡であり、接続先固定の主張ではない。
 * そのためDNSが検証後に変化しても、transport側の公開Internet境界で拒否できる。
 */
export interface SafeFetchDependencies {
  connectionPolicy: typeof EGRESS_POLICY;
  // owner が明示した deny-only ポリシー。未指定時は現在の既定 denylist を
  // 使う。空配列を渡した場合も allowlist へ補完せず、robots / SSRF / egress
  // の各境界は維持する。
  fetchDenylistPolicy?: FetchDenylistPolicy;
  resolveDns(
    hostname: string,
    recordType: DnsRecordType,
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
  fetchHop(
    url: string,
    validatedAddresses: readonly string[],
    init: RequestInit,
  ): Promise<Response>;
  /** raw robots.txt ではなく、解析済みpolicyだけを保持する。 */
  robotsPolicyCache?: RobotsPolicyCache;
}

interface ValidatedTarget {
  url: URL;
  addresses: readonly string[];
}

interface SafeResponse {
  response: Response;
  finalUrl: URL;
}

/** AbortSignalを受け取らないDNS等も、呼び出し側のhard deadlineへ収束させる。 */
async function waitForSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await promise;
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(
        signal.reason ?? new DOMException("operation aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // `promise`がdeadline後にrejectしてもunhandled rejectionにしないため、
    // Promise.raceへ直接渡して両分岐へhandlerを登録する。
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  return octets.every((part) => Number.isInteger(part) && part <= 255)
    ? octets
    : null;
}

function parseIpv6(value: string): readonly number[] | null {
  let input = value.toLowerCase();
  if (input.startsWith("[") && input.endsWith("]")) {
    input = input.slice(1, -1);
  }
  if (!input || input.includes("%")) return null;

  const dottedTail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedTail) {
    const ipv4 = parseIpv4(dottedTail[1]);
    if (!ipv4) return null;
    input = input.slice(0, -dottedTail[1].length) +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:` +
      `${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const hasCompression = input.includes("::");
  const missing = 8 - left.length - right.length;
  if ((hasCompression && missing < 1) || (!hasCompression && missing !== 0)) {
    return null;
  }

  const groups = [
    ...left,
    ...Array(hasCompression ? missing : 0).fill("0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224 // multicast / reserved / broadcast
  );
}

function embeddedIpv4(groups: readonly number[]): readonly number[] {
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ];
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const firstSixZero = groups.slice(0, 6).every((group) => group === 0);
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff;
  const nat64WellKnown = groups[0] === 0x64 && groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);

  // IPv4-compatible, IPv4-mapped, and RFC 6052 well-known NAT64 forms must
  // inherit the embedded IPv4 classification.
  if (firstSixZero || ipv4Mapped || nat64WellKnown) {
    return isPublicIpv4(embeddedIpv4(groups));
  }

  // RFC 8215 local-use NAT64 prefix. Its embedding layout is deployment
  // specific, so the whole range is rejected rather than guessed.
  if (
    groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1
  ) return false;

  // 6to4 embeds an IPv4 address in bits 16..48.
  if (groups[0] === 0x2002) {
    return isPublicIpv4([
      groups[1] >> 8,
      groups[1] & 0xff,
      groups[2] >> 8,
      groups[2] & 0xff,
    ]);
  }

  return !(
    (groups[0] & 0xfe00) === 0xfc00 || // ULA fc00::/7
    (groups[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (groups[0] & 0xffc0) === 0xfec0 || // deprecated site-local
    (groups[0] & 0xff00) === 0xff00 || // multicast
    (groups[0] === 0x100 && groups.slice(1, 4).every((g) => g === 0)) ||
    (groups[0] === 0x2001 && (groups[1] & 0xfe00) === 0) ||
    (groups[0] === 0x2001 && groups[1] === 0x0db8) ||
    (groups[0] & 0xe000) !== 0x2000 // only global-unicast 2000::/3
  );
}

/** True only for globally routable unicast addresses accepted by the fetcher. */
export function isPublicIpAddress(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  return ipv6 ? isPublicIpv6(ipv6) : false;
}

function isProtocolRelative(value: string): boolean {
  return /^(?:[\\/]{2})/.test(value);
}

/** Parse and canonicalize a fetch target without performing DNS resolution. */
export function normalizeFetchUrl(rawUrl: string, base?: URL): URL | null {
  if (!rawUrl || rawUrl !== rawUrl.trim() || isProtocolRelative(rawUrl)) {
    return null;
  }
  if (!base && !/^https?:\/\//i.test(rawUrl)) return null;
  if (/^https?:[^/]/i.test(rawUrl)) return null;

  let url: URL;
  try {
    url = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname.endsWith(".home") || hostname.endsWith(".lan") ||
    hostname === "oisint.com" || hostname.endsWith(".oisint.com")
  ) return null;
  url.hostname = hostname;
  url.hash = "";
  return url;
}

// 取得できなかった理由の粗い分類 (#514)。URL そのものはログにも event にも出さず、
// この enum だけを集計に使う (§34)。
export type FetchFailureReason =
  | "no_gateway"
  | "bad_url"
  | "denylisted"
  | "non_public_address"
  | "dns_failed"
  | "blocked_or_empty";

type TargetResult =
  | { ok: true; target: ValidatedTarget }
  | { ok: false; reason: FetchFailureReason };

function literalIpFromHostname(hostname: string): string | null {
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return parseIpv4(literal) || parseIpv6(literal) ? literal : null;
}

async function resolveTarget(
  rawUrl: string,
  dependencies: SafeFetchDependencies,
  base?: URL,
  signal?: AbortSignal,
): Promise<TargetResult> {
  throwIfAborted(signal);
  if (dependencies.connectionPolicy !== EGRESS_POLICY) {
    return { ok: false, reason: "no_gateway" };
  }
  const url = normalizeFetchUrl(rawUrl, base);
  if (!url) return { ok: false, reason: "bad_url" };
  // 利用規約で自動収集を明示的に禁止しているドメイン (サブドメイン含む) は
  // DNS 解決より前に弾く (Issue #287)。resolveTarget は初回 URL・robots.txt・
  // redirect の各 hop (allowsHop 判定より前) の全てで呼ばれるため、denylist
  // 対象ホストへはリクエストを一切送らない。robots.txt 拒否と同じく取得しない。
  const denylistPolicy = dependencies.fetchDenylistPolicy ??
    DEFAULT_FETCH_DENYLIST_POLICY;
  if (isFetchDenylisted(url, denylistPolicy)) {
    return { ok: false, reason: "denylisted" };
  }

  const literal = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (parseIpv4(literal) || parseIpv6(literal)) {
    return isPublicIpAddress(literal)
      ? { ok: true, target: { url, addresses: [literal] } }
      : { ok: false, reason: "non_public_address" };
  }

  let addresses: string[];
  try {
    const [a, aaaa] = await waitForSignal(
      Promise.all([
        dependencies.resolveDns(literal, "A", signal),
        dependencies.resolveDns(literal, "AAAA", signal),
      ]),
      signal,
    );
    addresses = [...new Set([...a, ...aaaa])];
  } catch {
    // Edge Runtime が DNS 解決 API を提供しない場合もここへ落ちる
    return { ok: false, reason: "dns_failed" };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns_failed" };
  if (addresses.some((address) => !isPublicIpAddress(address))) {
    return { ok: false, reason: "non_public_address" };
  }
  return { ok: true, target: { url, addresses } };
}

async function validateTarget(
  rawUrl: string,
  dependencies: SafeFetchDependencies,
  base?: URL,
  signal?: AbortSignal,
): Promise<ValidatedTarget | null> {
  const result = await resolveTarget(rawUrl, dependencies, base, signal);
  return result.ok ? result.target : null;
}

function isRedirect(response: Response): boolean {
  return [301, 302, 303, 307, 308].includes(response.status);
}

function isAuthenticationUrl(url: URL): boolean {
  return /(?:^|\/)(?:login|signin|sign-in|auth|authenticate)(?:\/|$)/i.test(
    url.pathname,
  );
}

type InternalSafeFetchResult =
  | { ok: true; response: Response; finalUrl: URL }
  | {
    ok: false;
    reason:
      | "target_rejected"
      | "robots_denied"
      | "redirect_loop"
      | "redirect_rejected"
      | "auth_required"
      | "network_error"
      | "timeout"
      | "aborted";
    targetReason?: FetchFailureReason;
  };

/** safeFetch と同じ境界を保ちつつ、crawlerの再試行判定用に粗い失敗理由を返す。 */
async function safeFetchWithFailure(
  rawUrl: string,
  timeoutMs: number,
  dependencies: SafeFetchDependencies,
  base?: URL,
  allowsHop?: (url: URL) => boolean,
  parentSignal?: AbortSignal,
): Promise<InternalSafeFetchResult> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else {parentSignal.addEventListener("abort", abortFromParent, {
        once: true,
      });}
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let candidate = rawUrl;
  let candidateBase = base;

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          reason: parentSignal?.aborted ? "aborted" : "timeout",
        };
      }
      const targetResult = await resolveTarget(
        candidate,
        dependencies,
        candidateBase,
        controller.signal,
      );
      if (controller.signal.aborted) {
        return {
          ok: false,
          reason: parentSignal?.aborted ? "aborted" : "timeout",
        };
      }
      if (!targetResult.ok) {
        return {
          ok: false,
          reason: "target_rejected",
          targetReason: targetResult.reason,
        };
      }
      const target = targetResult.target;
      if (allowsHop && !allowsHop(target.url)) {
        return { ok: false, reason: "robots_denied" };
      }

      let response: Response;
      try {
        response = await waitForSignal(
          dependencies.fetchHop(
            target.url.href,
            target.addresses,
            {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept-Language": "ja",
              },
              redirect: "manual",
              signal: controller.signal,
            },
          ),
          controller.signal,
        );
      } catch {
        return {
          ok: false,
          reason: controller.signal.aborted
            ? parentSignal?.aborted ? "aborted" : "timeout"
            : "network_error",
        };
      }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: parentSignal?.aborted ? "aborted" : "timeout",
        };
      }
      if (!isRedirect(response)) {
        return { ok: true, response, finalUrl: target.url };
      }

      const location = response.headers.get("location");
      void response.body?.cancel().catch(() => undefined);
      if (!location || redirects === MAX_REDIRECTS) {
        return { ok: false, reason: "redirect_loop" };
      }
      const next = normalizeFetchUrl(location, target.url);
      if (!next || next.origin !== target.url.origin) {
        return { ok: false, reason: "redirect_rejected" };
      }
      if (isAuthenticationUrl(next)) {
        return { ok: false, reason: "auth_required" };
      }
      candidate = next.href;
      candidateBase = undefined;
    }
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? parentSignal?.aborted ? "aborted" : "timeout"
        : "network_error",
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
  return { ok: false, reason: "redirect_loop" };
}

async function safeFetch(
  rawUrl: string,
  timeoutMs: number,
  dependencies: SafeFetchDependencies,
  base?: URL,
  // redirect の各 hop (初回 URL を含む) を fetch する直前に呼ぶ許可判定。
  // robots.txt の再判定に使う (robots.txt 自体の取得では渡さない)。
  allowsHop?: (url: URL) => boolean,
  parentSignal?: AbortSignal,
): Promise<SafeResponse | null> {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let candidate = rawUrl;
  let candidateBase = base;

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (controller.signal.aborted) return null;
      const target = await validateTarget(
        candidate,
        dependencies,
        candidateBase,
        controller.signal,
      );
      if (!target) return null;
      if (allowsHop && !allowsHop(target.url)) return null;
      if (controller.signal.aborted) return null;

      const response = await waitForSignal(
        dependencies.fetchHop(
          target.url.href,
          target.addresses,
          {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "ja",
            },
            redirect: "manual",
            signal: controller.signal,
          },
        ),
        controller.signal,
      );
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!isRedirect(response)) return { response, finalUrl: target.url };

      const location = response.headers.get("location");
      // Transport実装のcancelが停止しても、次のhop/deadlineを保持する。
      void response.body?.cancel().catch(() => undefined);
      if (!location || redirects === MAX_REDIRECTS) return null;
      const next = normalizeFetchUrl(location, target.url);
      // Cross-origin redirects would require a second robots policy decision.
      // Search providers return canonical URLs, so fail closed instead.
      if (!next || next.origin !== target.url.origin) return null;
      candidate = next.href;
      candidateBase = undefined;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309: Robots Exclusion Protocol)
// ---------------------------------------------------------------------------

// robots.txt の group 照合に使う product token (RFC §2.2.1、case-insensitive)
const ROBOTS_PRODUCT_TOKEN = USER_AGENT.split("/")[0].toLowerCase();

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicySnapshot {
  rules: readonly RobotsRule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsPolicyCacheRecord {
  fetchedAt: string;
  available: boolean;
  rules: readonly RobotsRule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsPolicyCache {
  get(origin: string): Promise<RobotsPolicyCacheRecord | null>;
  set(origin: string, record: RobotsPolicyCacheRecord): Promise<void>;
}

const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

// percent-encoding の正規化 (RFC §2.2.2)。pattern と対象パスの双方に適用し、
// 同一表現へ揃えてから比較する:
//   - unreserved 文字の %XX は復号 (%61 → a)
//   - それ以外の %XX は大文字 hex へ統一 (%c3%a9 → %C3%A9)
//   - 非 ASCII 文字は UTF-8 percent-encode (é → %C3%A9)
function normalizeRobotsPath(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
      const hex = input.slice(i + 1, i + 3);
      const byte = Number.parseInt(hex, 16);
      const decoded = String.fromCharCode(byte);
      out += byte < 0x80 && UNRESERVED.test(decoded)
        ? decoded
        : `%${hex.toUpperCase()}`;
      i += 3;
      continue;
    }
    const codePoint = input.codePointAt(i) ?? 0;
    if (codePoint < 0x80) {
      out += ch;
      i += 1;
      continue;
    }
    const full = String.fromCodePoint(codePoint);
    out += encodeURIComponent(full);
    i += full.length;
  }
  return out;
}

// pattern 中の "*" は任意長 (RFC §2.2.3)、末尾 "$" は終端一致。
// 攻撃的な pattern による backtracking を避けるため regex は使わない。
function robotsPathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");

  if (!path.startsWith(parts[0])) return false;
  let position = parts[0].length;
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (anchored && index === parts.length - 1) {
      return path.length - part.length >= position && path.endsWith(part);
    }
    const found = path.indexOf(part, position);
    if (found === -1) return false;
    position = found + part.length;
  }
  return anchored ? position === path.length : true;
}

// product token に一致するruleとcrawl-delayを返す。crawl-delayはRFC 9309の
// directiveではないが、相手サイトの負荷を抑える慣行として安全側で尊重する。
export function parseRobotsPolicy(body: string): RobotsPolicySnapshot {
  const specificRules: RobotsRule[] = [];
  const wildcardRules: RobotsRule[] = [];
  const specificDelays: number[] = [];
  const wildcardDelays: number[] = [];
  let sawSpecificGroup = false;
  let sawWildcardGroup = false;
  let groupSpecific = false;
  let groupWildcard = false;
  let inGroupHeader = false;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue; // 空行は group 状態を変えない (RFC §2.2 ABNF)
    const directive = line.match(/^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/);
    if (!directive) continue; // 解釈できない行は無視
    const name = directive[1].toLowerCase();
    const value = directive[2].trim();

    if (name === "user-agent") {
      if (!inGroupHeader) {
        groupSpecific = false;
        groupWildcard = false;
        inGroupHeader = true;
      }
      // "OISINT-Fetcher/0.2" のような version 付き表記も product token で照合
      const token = value.split(/[\s/]/)[0].toLowerCase();
      if (token === "*") {
        groupWildcard = true;
        sawWildcardGroup = true;
      } else if (token === ROBOTS_PRODUCT_TOKEN) {
        groupSpecific = true;
        sawSpecificGroup = true;
      }
      continue;
    }

    inGroupHeader = false;
    if (name === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay > 0) {
        const bounded = Math.min(delay, MAX_CRAWL_DELAY_SECONDS);
        if (groupSpecific) specificDelays.push(bounded);
        if (groupWildcard) wildcardDelays.push(bounded);
      }
      continue;
    }
    if (name !== "allow" && name !== "disallow") continue;
    if (!value) continue;
    const rule = {
      allow: name === "allow",
      pattern: normalizeRobotsPath(value),
    };
    if (groupSpecific) specificRules.push(rule);
    if (groupWildcard) wildcardRules.push(rule);
  }

  // 一致 group があるときは "*" group を併用しない (RFC §2.2.1)
  const rules = sawSpecificGroup
    ? specificRules
    : sawWildcardGroup
    ? wildcardRules
    : [];
  const delays = sawSpecificGroup ? specificDelays : wildcardDelays;
  return {
    rules,
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : null,
  };
}

// 最長一致 (most specific match) で判定し、同長なら allow を優先 (RFC §2.2.2)。
// どの rule にも一致しなければ許可。
function robotsRulesAllow(rules: readonly RobotsRule[], path: string): boolean {
  let bestLength = -1;
  let bestAllow = true;
  for (const rule of rules) {
    if (!robotsPathMatches(rule.pattern, path)) continue;
    if (rule.pattern.length > bestLength) {
      bestLength = rule.pattern.length;
      bestAllow = rule.allow;
    } else if (rule.pattern.length === bestLength && rule.allow) {
      bestAllow = true;
    }
  }
  return bestAllow;
}

/** robots.txt 本文 (取得済み文字列) が URL への fetch を許可するか判定する。 */
export function robotsTxtAllows(body: string, url: URL): boolean {
  return robotsRulesAllow(
    parseRobotsPolicy(body).rules,
    normalizeRobotsPath(url.pathname + url.search),
  );
}

// ---------------------------------------------------------------------------
// X-Robots-Tag / <meta name="robots">
// (Google: Robots meta tag, data-nosnippet, and X-Robots-Tag specifications)
// https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
// ---------------------------------------------------------------------------

// Evidence 化を遮断する rule。none は noindex, nofollow の短縮形 (Google 仕様)
// なので noindex と同様に扱う。noindex = 掲載拒否 / nosnippet = 抜粋拒否 /
// noarchive = 保存拒否。いずれも「抜粋を保存・表示するな」という意思表示として
// 扱い、本文を Evidence 化しない (Issue #293)。
// noai は Google 仕様外だが「AI にコンテンツを利用させない」意思表示として
// 掲げるサイトがある慣行。本文を Gemini へ渡す本 fetcher では収集禁止の慣行への
// 追従 (Issue #287) として noindex と同様に遮断する。
// nofollow 単独は「ページ内リンクを辿るな」の意思表示であり、リンクを一切
// 辿らない本 fetcher (§5.4) では設計上常に充足するため遮断しない。
const BLOCKING_ROBOTS_RULES: ReadonlySet<string> = new Set([
  "noindex",
  "nosnippet",
  "noarchive",
  "noai",
  "none",
]);
const NOFOLLOW_ROBOTS_RULES: ReadonlySet<string> = new Set([
  "nofollow",
  "none",
]);

// 対象名が自分を指すか。"robots" は全 crawler 向け、product token
// ("oisint-fetcher") は自 UA 向け指定。いずれも case-insensitive で照合する。
function robotsNameTargetsUs(name: string): boolean {
  return name === "robots" || name === ROBOTS_PRODUCT_TOKEN;
}

// "noindex, nofollow" のような comma 区切り rule 列に遮断 rule が含まれるか。
// X-Robots-Tag は "googlebot: noindex" のように rule の前へ user agent を
// 置けるため、":" を含む token は対象 UA が自分のときだけ評価する。
// UA 指定のない rule は全 crawler 向け (Google 仕様)。unavailable_after 等の
// 値付き directive はこの解釈でも遮断 rule に一致しないため誤遮断しない。
function robotsRulesDeny(value: string): boolean {
  for (const rawToken of value.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    const colon = token.indexOf(":");
    if (colon === -1) {
      if (BLOCKING_ROBOTS_RULES.has(token)) return true;
      continue;
    }
    const scope = token.slice(0, colon).trim();
    const rule = token.slice(colon + 1).trim();
    if (robotsNameTargetsUs(scope) && BLOCKING_ROBOTS_RULES.has(rule)) {
      return true;
    }
  }
  return false;
}

function robotsRulesContain(
  value: string,
  rules: ReadonlySet<string>,
): boolean {
  for (const rawToken of value.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    const colon = token.indexOf(":");
    if (colon === -1) {
      if (rules.has(token)) return true;
      continue;
    }
    const scope = token.slice(0, colon).trim();
    const rule = token.slice(colon + 1).trim();
    if (robotsNameTargetsUs(scope) && rules.has(rule)) return true;
  }
  return false;
}

// meta タグ文字列から属性値を取り出す (引用符あり / なしの双方に対応)。
function metaAttribute(tag: string, attribute: "name" | "content"): string {
  const pattern = attribute === "name"
    ? /(?:^|[^\w-])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
    : /(?:^|[^\w-])content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  const match = tag.match(pattern);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

export interface RobotsMetaDirectives {
  blockEvidence: boolean;
  nofollow: boolean;
}

// head限定にせず走査し、Evidence遮断とlink追跡遮断を別々に返す。
export function parseRobotsMetaDirectives(
  html: string,
): RobotsMetaDirectives {
  let blockEvidence = false;
  let nofollow = false;
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!robotsNameTargetsUs(metaAttribute(tag, "name").toLowerCase())) {
      continue;
    }
    const content = metaAttribute(tag, "content");
    if (robotsRulesDeny(content)) blockEvidence = true;
    if (robotsRulesContain(content, NOFOLLOW_ROBOTS_RULES)) nofollow = true;
  }
  return { blockEvidence, nofollow };
}

function robotsMetaDenies(html: string): boolean {
  return parseRobotsMetaDirectives(html).blockEvidence;
}

async function readBodyTextAtMost(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await waitForSignal(reader.read(), signal);
      if (done) break;
      const remaining = maxBytes - total;
      const bounded = value.byteLength > remaining
        ? value.subarray(0, remaining)
        : value;
      chunks.push(bounded);
      total += bounded.byteLength;
    }
  } finally {
    // cancel実装自体が停止してもdeadline処理を保持しない。
    void reader.cancel(signal?.reason).catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(
      0,
      Math.min(chunk.byteLength, merged.byteLength - offset),
    );
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= merged.byteLength) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

interface BoundedBody {
  bytes: Uint8Array;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/** crawler本文を上限・独立deadline付きで読む。 */
async function readBodyBytesAtMost(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      bytes: new Uint8Array(),
      truncated: false,
      timedOut: false,
      aborted: parentSignal?.aborted ?? false,
    };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let abortHandler: (() => void) | undefined;
  const read = async (): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (!truncated && total >= maxBytes) {
      const next = await reader.read();
      truncated = !next.done;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncated };
  };

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error("crawl response timeout"));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!parentSignal) return;
    abortHandler = () => reject(new Error("crawl response aborted"));
    if (parentSignal.aborted) abortHandler();
    else parentSignal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    const result = await Promise.race([read(), timeout, aborted]);
    return { ...result, timedOut: false, aborted: false };
  } catch {
    void reader.cancel(parentSignal?.reason).catch(() => undefined);
    return {
      bytes: new Uint8Array(),
      truncated: false,
      timedOut,
      aborted: parentSignal?.aborted ?? false,
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (parentSignal && abortHandler) {
      parentSignal.removeEventListener("abort", abortHandler);
    }
    void reader.cancel(parentSignal?.reason).catch(() => undefined);
  }
}

// origin の robots.txt を 1 回取得し、URL ごとの許可判定 (redirect hop 再判定に
// 使い回す) を返す。到達可否の扱いは RFC 9309 に従う:
//   - 2xx: 先頭 500 KiB を解析して判定 (§2.5)
//   - 4xx: robots.txt なしとみなし全許可 (§2.3.1.3)
//   - 5xx・ネットワークエラー・timeout・redirect 失敗: 全拒否 (§2.3.1.4)
async function loadRobotsPolicy(
  url: URL,
  dependencies: SafeFetchDependencies,
  parentSignal?: AbortSignal,
  timeoutMs = ROBOTS_TIMEOUT_MS,
): Promise<(target: URL) => boolean> {
  return (await loadRobotsPolicyDetails(
    url,
    dependencies,
    parentSignal,
    timeoutMs,
  )).allows;
}

export interface LoadedRobotsPolicy {
  available: boolean;
  allows: (target: URL) => boolean;
  crawlDelaySeconds: number | null;
}

function loadedRobotsPolicy(
  record: RobotsPolicyCacheRecord,
): LoadedRobotsPolicy | null {
  const fetchedAt = Date.parse(record.fetchedAt);
  const age = Date.now() - fetchedAt;
  if (
    !Number.isFinite(fetchedAt) || age < 0 || age > ROBOTS_CACHE_TTL_MS ||
    typeof record.available !== "boolean" || !Array.isArray(record.rules) ||
    record.rules.some((rule) =>
      !rule || typeof rule.pattern !== "string" ||
      rule.pattern.length > ROBOTS_MAX_PARSE_BYTES ||
      typeof rule.allow !== "boolean"
    ) ||
    (record.crawlDelaySeconds !== null &&
      (!Number.isFinite(record.crawlDelaySeconds) ||
        record.crawlDelaySeconds <= 0 ||
        record.crawlDelaySeconds > MAX_CRAWL_DELAY_SECONDS))
  ) return null;
  return {
    available: record.available,
    allows: (target) =>
      record.available && robotsRulesAllow(
        record.rules,
        normalizeRobotsPath(target.pathname + target.search),
      ),
    crawlDelaySeconds: record.crawlDelaySeconds,
  };
}

async function cacheRobotsPolicy(
  cache: RobotsPolicyCache | undefined,
  origin: string,
  available: boolean,
  policy: RobotsPolicySnapshot,
  signal?: AbortSignal,
): Promise<void> {
  if (!cache) return;
  try {
    await waitForSignal(
      cache.set(origin, {
        fetchedAt: new Date().toISOString(),
        available,
        rules: policy.rules,
        crawlDelaySeconds: policy.crawlDelaySeconds,
      }),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // cache障害は現在の取得判定へ影響させない。
  }
}

/** origin単位の解析済みrobots policyを返す。raw本文はcacheしない。 */
export async function loadRobotsPolicyDetails(
  url: URL,
  dependencies: SafeFetchDependencies,
  parentSignal?: AbortSignal,
  timeoutMs = ROBOTS_TIMEOUT_MS,
): Promise<LoadedRobotsPolicy> {
  const cache = dependencies.robotsPolicyCache;

  try {
    return await withAbortTimeout(
      async (signal) => {
        if (cache) {
          try {
            const cached = await waitForSignal(cache.get(url.origin), signal);
            if (cached) {
              const loaded = loadedRobotsPolicy(cached);
              if (loaded) {
                throwIfAborted(signal);
                return loaded;
              }
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // cache read failureはmissとして扱う。
          }
        }
        throwIfAborted(signal);
        const result = await safeFetch(
          `${url.origin}/robots.txt`,
          timeoutMs,
          dependencies,
          undefined,
          undefined,
          signal,
        );
        if (!result) {
          return {
            available: false,
            allows: () => false,
            crawlDelaySeconds: null,
          };
        }
        const { response } = result;
        if (response.ok) {
          const body = await readBodyTextAtMost(
            response,
            ROBOTS_MAX_PARSE_BYTES,
            signal,
          );
          throwIfAborted(signal);
          const policy = parseRobotsPolicy(body);
          await cacheRobotsPolicy(cache, url.origin, true, policy, signal);
          return {
            available: true,
            allows: (target: URL) =>
              robotsRulesAllow(
                policy.rules,
                normalizeRobotsPath(target.pathname + target.search),
              ),
            crawlDelaySeconds: policy.crawlDelaySeconds,
          };
        }
        void response.body?.cancel().catch(() => undefined);
        if (response.status >= 400 && response.status < 500) {
          const policy = {
            rules: [],
            crawlDelaySeconds: null,
          } satisfies RobotsPolicySnapshot;
          await cacheRobotsPolicy(cache, url.origin, true, policy, signal);
          return {
            available: true,
            allows: () => true,
            crawlDelaySeconds: null,
          };
        }
        const policy = {
          rules: [],
          crawlDelaySeconds: null,
        } satisfies RobotsPolicySnapshot;
        await cacheRobotsPolicy(cache, url.origin, false, policy, signal);
        return {
          available: false,
          allows: () => false,
          crawlDelaySeconds: null,
        };
      },
      timeoutMs,
      parentSignal,
    );
  } catch {
    // DNS/header/bodyのどこでdeadlineへ到達してもfail-closed。
    return { available: false, allows: () => false, crawlDelaySeconds: null };
  }
}

let productionDependencies: SafeFetchDependencies | null | undefined;

function dnsNoData(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound ||
    (error instanceof Error &&
      /no record|not found|no data/i.test(error.message));
}

async function resolveDns(
  hostname: string,
  recordType: DnsRecordType,
): Promise<readonly string[]> {
  try {
    return await Deno.resolveDns(hostname, recordType);
  } catch (error) {
    if (dnsNoData(error)) return [];
    throw error;
  }
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Supabase Edge Runtime does not expose a fetch-time custom resolver or peer IP.
 * Production therefore sends each already-resolved hop to the OISINT Cloudflare
 * gateway. That Worker uses global_fetch_strictly_public and returns redirects
 * without following them, so this function revalidates every hop before another
 * signed request. No target URL or shared secret is logged.
 */
function getProductionDependencies(): SafeFetchDependencies | null {
  if (productionDependencies !== undefined) return productionDependencies;
  productionDependencies = null;
  try {
    if (Deno.env.get("SSRF_EGRESS_POLICY") !== EGRESS_POLICY) return null;
    const rawGatewayUrl = Deno.env.get("SSRF_EGRESS_GATEWAY_URL") ?? "";
    const gatewayUrl = new URL(rawGatewayUrl);
    if (
      gatewayUrl.protocol !== "https:" || gatewayUrl.username ||
      gatewayUrl.password || gatewayUrl.port || gatewayUrl.search ||
      gatewayUrl.hash || gatewayUrl.pathname !== "/v1/internal/egress-fetch"
    ) return null;
    const secret = Deno.env.get("EGRESS_GATEWAY_SECRET") ?? "";
    if (secret.length < 32) return null;

    productionDependencies = {
      connectionPolicy: EGRESS_POLICY,
      fetchDenylistPolicy: DEFAULT_FETCH_DENYLIST_POLICY,
      resolveDns,
      fetchHop: async (url, addresses, init) => {
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const nonce = crypto.randomUUID();
        const validatedAddresses = [...new Set(addresses)].sort();
        const payload = `egress:v2:${timestamp}:${nonce}:${url}:${
          validatedAddresses.join(",")
        }`;
        const signature = await hmacHex(secret, payload);
        return fetch(gatewayUrl.href, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-OISINT-Egress-Timestamp": timestamp,
            "X-OISINT-Egress-Signature": signature,
          },
          body: JSON.stringify({ url, nonce, validatedAddresses }),
          redirect: "manual",
          signal: init.signal,
        });
      },
    };
  } catch {
    productionDependencies = null;
  }
  return productionDependencies;
}

// HTML → 本文テキスト (script/style 除去 → タグ除去 → 空白正規化)
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function isHtmlContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function hasBinaryOrKnownNonHtmlPrefix(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 512));
  if (sample.length >= 5) {
    const ascii = new TextDecoder().decode(sample.subarray(0, 16));
    if (
      ascii.startsWith("%PDF-") || ascii.startsWith("PK\x03\x04") ||
      ascii.startsWith("GIF8") || ascii.startsWith("RIFF")
    ) return true;
  }
  return sample.some((byte) =>
    byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20)
  );
}

/**
 * crawler用safe fetch。HTMLはリンク抽出の間だけ返し、永続化は呼び出し側で禁止する。
 */
export async function fetchPageForCrawlWithDependencies(
  rawUrl: string,
  dependencies: SafeFetchDependencies,
  signal?: AbortSignal,
): Promise<CrawlFetchResult> {
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const initialUrl = normalizeFetchUrl(rawUrl);
  if (!initialUrl || initialUrl.port) return { ok: false, reason: "bad_url" };
  const initialLiteral = literalIpFromHostname(initialUrl.hostname);
  if (initialLiteral) {
    return {
      ok: false,
      reason: isPublicIpAddress(initialLiteral)
        ? "bad_url"
        : "non_public_address",
    };
  }
  const initialResult = await resolveTarget(
    rawUrl,
    dependencies,
    undefined,
    signal,
  );
  if (!initialResult.ok) return { ok: false, reason: initialResult.reason };

  const robots = await loadRobotsPolicyDetails(
    initialResult.target.url,
    dependencies,
    signal,
  );
  const failure = (reason: CrawlFetchFailureReason): CrawlFetchResult =>
    robots.crawlDelaySeconds === null
      ? { ok: false, reason }
      : { ok: false, reason, crawlDelaySeconds: robots.crawlDelaySeconds };
  if (signal?.aborted) return failure("aborted");
  if (!robots.available) return failure("robots_unavailable");

  const allowsCrawlHop = (target: URL): boolean => {
    if (target.port || literalIpFromHostname(target.hostname)) return false;
    return robots.allows(target);
  };
  const result = await safeFetchWithFailure(
    initialResult.target.url.href,
    FETCH_TIMEOUT_MS,
    dependencies,
    undefined,
    allowsCrawlHop,
    signal,
  );
  if (!result.ok) {
    if (result.reason === "target_rejected") {
      return failure(result.targetReason ?? "blocked_or_empty");
    }
    return failure(result.reason);
  }

  const { response, finalUrl } = result;
  if (isAuthenticationUrl(finalUrl)) {
    void response.body?.cancel().catch(() => undefined);
    return failure("auth_required");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return failure(
      response.status === 401 || response.status === 403
        ? "auth_required"
        : "http_error",
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!isHtmlContentType(contentType)) {
    void response.body?.cancel().catch(() => undefined);
    return failure("non_html");
  }
  const xRobotsTag = response.headers.get("x-robots-tag");
  if (xRobotsTag && robotsRulesDeny(xRobotsTag)) {
    void response.body?.cancel().catch(() => undefined);
    return failure("robots_meta_denied");
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      void response.body?.cancel().catch(() => undefined);
      return failure("mime_mismatch");
    }
    if (contentLength > MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return failure("body_too_large");
    }
  }
  if (response.headers.get("x-oisint-truncated") === "1") {
    void response.body?.cancel().catch(() => undefined);
    return failure("body_too_large");
  }

  const body = await readBodyBytesAtMost(
    response,
    MAX_BYTES,
    FETCH_TIMEOUT_MS,
    signal,
  );
  if (body.aborted || signal?.aborted) return failure("aborted");
  if (body.timedOut) return failure("timeout");
  if (body.truncated) return failure("body_too_large");
  if (hasBinaryOrKnownNonHtmlPrefix(body.bytes)) {
    return failure("mime_mismatch");
  }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(body.bytes);
  const meta = parseRobotsMetaDirectives(html);
  if (meta.blockEvidence) return failure("robots_meta_denied");
  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (!text) return failure("empty_body");
  return {
    ok: true,
    page: {
      url: finalUrl.href,
      text,
      html,
      contentType,
      byteLength: body.bytes.byteLength,
      nofollow: meta.nofollow || robotsRulesContain(
        xRobotsTag ?? "",
        NOFOLLOW_ROBOTS_RULES,
      ),
      crawlDelaySeconds: robots.crawlDelaySeconds,
    },
  };
}

/** 本番でも既存の公開Internet専用egress gatewayだけを使う。 */
export async function fetchPageForCrawl(
  rawUrl: string,
  signal?: AbortSignal,
  robotsPolicyCache?: RobotsPolicyCache,
): Promise<CrawlFetchResult> {
  const dependencies = getProductionDependencies();
  if (!dependencies) return { ok: false, reason: "no_gateway" };
  return await fetchPageForCrawlWithDependencies(
    rawUrl,
    robotsPolicyCache ? { ...dependencies, robotsPolicyCache } : dependencies,
    signal,
  );
}

/** Test seam that exercises the complete robots + body security boundary. */
export async function fetchPageTextWithDependencies(
  rawUrl: string,
  dependencies: SafeFetchDependencies,
  signal?: AbortSignal,
  deadlines: Partial<FetchDeadlinePolicy> = {},
): Promise<FetchedPage | null> {
  const policy: FetchDeadlinePolicy = {
    fetchTimeoutMs: Number.isFinite(deadlines.fetchTimeoutMs)
      ? Math.max(1, Math.floor(deadlines.fetchTimeoutMs as number))
      : DEFAULT_FETCH_DEADLINES.fetchTimeoutMs,
    robotsTimeoutMs: Number.isFinite(deadlines.robotsTimeoutMs)
      ? Math.max(1, Math.floor(deadlines.robotsTimeoutMs as number))
      : DEFAULT_FETCH_DEADLINES.robotsTimeoutMs,
  };

  try {
    return await withAbortTimeout(
      async (deadlineSignal) => {
        // 初回precheckのDNSから最終body読了までを単一の10秒契約に含める。
        const initial = await validateTarget(
          rawUrl,
          dependencies,
          undefined,
          deadlineSignal,
        );
        if (!initial) return null;

        // robots.txt は origin ごとに 1 回取得し、初回 URL と same-origin redirect の
        // 各 hop のパスをこの policy で再判定する (RFC 9309)。
        const robotsAllows = await loadRobotsPolicy(
          initial.url,
          dependencies,
          deadlineSignal,
          policy.robotsTimeoutMs,
        );
        throwIfAborted(deadlineSignal);
        const result = await safeFetch(
          initial.url.href,
          policy.fetchTimeoutMs,
          dependencies,
          undefined,
          robotsAllows,
          deadlineSignal,
        );
        if (!result?.response.ok) {
          void result?.response.body?.cancel().catch(() => undefined);
          return null;
        }
        const contentType = result.response.headers.get("content-type") ?? "";
        if (!contentType.includes("html") && !contentType.includes("text")) {
          void result.response.body?.cancel().catch(() => undefined);
          return null;
        }

        // X-Robots-Tag による意思表示 (noindex / nosnippet / noarchive / none) を
        // 尊重し、本文を読まずに破棄する (Issue #293)
        const xRobotsTag = result.response.headers.get("x-robots-tag");
        if (xRobotsTag && robotsRulesDeny(xRobotsTag)) {
          void result.response.body?.cancel().catch(() => undefined);
          return null;
        }

        const html = await readBodyTextAtMost(
          result.response,
          MAX_BYTES,
          deadlineSignal,
        );
        // <meta name="robots"> (自 UA 向け指定を含む) による意思表示も同様に尊重する
        if (robotsMetaDenies(html)) return null;
        const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
        return text ? { url: result.finalUrl.href, text } : null;
      },
      policy.fetchTimeoutMs,
      signal,
    );
  } catch {
    return null;
  }
}

// 1 URL を fetch してテキスト化。失敗・拒否は null。SSRF policy version を
// cache key に含め、旧ポリシーで取得した entry は再利用しない。
export async function fetchPageText(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<FetchedPage | null> {
  return (await fetchPageTextWithReason(rawUrl, signal)).page;
}

/**
 * fetchPageText と同じ経路だが、取得できなかった理由の粗い分類も返す (#514)。
 * live で「Web Evidence 0 / 全 unknown」になったとき、Serper が 0 件なのか、
 * gateway 設定なのか、DNS なのか、robots/本文側なのかを切り分けるための最小の観測。
 * URL・本文は返さない (§34)。
 */
export async function fetchPageTextWithReason(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<{ page: FetchedPage | null; reason: FetchFailureReason | null }> {
  const dependencies = getProductionDependencies();
  if (!dependencies) return { page: null, reason: "no_gateway" };
  try {
    return await withAbortTimeout(
      async (deadlineSignal) => {
        const target = await resolveTarget(
          rawUrl,
          dependencies,
          undefined,
          deadlineSignal,
        );
        if (!target.ok) return { page: null, reason: target.reason };
        const page = await withCache<FetchedPage>(
          "fetch",
          { policy: EGRESS_POLICY, url: target.target.url.href },
          () =>
            fetchPageTextWithDependencies(
              target.target.url.href,
              dependencies,
              deadlineSignal,
            ),
          deadlineSignal,
        );
        return { page, reason: page ? null : "blocked_or_empty" };
      },
      FETCH_TIMEOUT_MS,
      signal,
    );
  } catch {
    return { page: null, reason: "blocked_or_empty" };
  }
}
