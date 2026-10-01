// Safe crawler の純ロジック境界 (#117 / docs/research/07_crawler-architecture.md)
//
// このモジュールは実行基盤・DB・外部ネットワークに依存しない。URL frontier の
// 決定、budget、content hash、backoff、Evidence handoff をここへ閉じ込め、
// queue/worker はこの契約を使う。HTML は fetcher の返却後にリンク抽出へ使うだけで、
// このモジュールから永続化用の raw HTML 型を公開しない。
import {
  type CrawlFetchFailureReason,
  isPublicIpAddress,
  normalizeFetchUrl,
} from "./providers/fetcher.ts";
import { isFetchDenylisted } from "./providers/fetch_denylist.ts";
import {
  classifySourceType,
  freshnessScore,
  sourceQuality,
} from "./source_quality.ts";
import {
  filterValidClaims,
  type StructuredClaimInput,
  structuredClaimSchema,
} from "./validation.ts";
import type { StructuredClaim } from "./types.ts";

export const CRAWL_POLICY_VERSION = "safe-crawl-v1" as const;
export const CRAWL_MAX_ATTEMPTS = 4 as const;
export const CRAWL_ORIGIN_FAILURE_THRESHOLD = 5 as const;
export const CRAWL_BACKOFF_BASE_MS = 60_000 as const;
export const CRAWL_BACKOFF_FACTOR = 4 as const;
export const CRAWL_BACKOFF_MAX_MS = 86_400_000 as const;

export interface CrawlBudgetLimits {
  maxDepth: number;
  maxPagesPerOrigin: number;
  maxPagesTotal: number;
  maxBytesPerResponse: number;
  maxBytesTotal: number;
  maxLinksPerPage: number;
  maxQueryVariantsPerPath: number;
}

export const DEFAULT_CRAWL_BUDGET: Readonly<CrawlBudgetLimits> = Object.freeze({
  maxDepth: 2,
  maxPagesPerOrigin: 10,
  maxPagesTotal: 50,
  maxBytesPerResponse: 500_000,
  maxBytesTotal: 10_000_000,
  maxLinksPerPage: 30,
  maxQueryVariantsPerPath: 3,
});

export type CrawlBudgetRejectReason =
  | "invalid_url"
  | "depth_exceeded"
  | "pages_total_exceeded"
  | "pages_origin_exceeded"
  | "query_variants_exceeded"
  | "bytes_total_exceeded"
  | "duplicate_url";

export interface CrawlBudgetState {
  reservedPagesTotal: number;
  bytesUsedTotal: number;
  pagesByOrigin: Record<string, number>;
  queryVariantsByPath: Record<string, number>;
  /** In-memory duplicate guard. Persisted queue uniqueness remains authoritative. */
  reservedUrls: Set<string>;
}

export interface CrawlBudgetSnapshot {
  policyVersion: typeof CRAWL_POLICY_VERSION;
  remainingPagesTotal: number;
  remainingBytesTotal: number;
  remainingPagesForOrigin: number;
  remainingQueryVariantsForPath: number;
}

export type CrawlBudgetDecision =
  | {
    accepted: true;
    url: URL;
    snapshot: CrawlBudgetSnapshot;
  }
  | { accepted: false; reason: CrawlBudgetRejectReason };

export function createCrawlBudgetState(): CrawlBudgetState {
  return {
    reservedPagesTotal: 0,
    bytesUsedTotal: 0,
    pagesByOrigin: {},
    queryVariantsByPath: {},
    reservedUrls: new Set(),
  };
}

function positiveLimit(
  value: number,
  fallback: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

export function normalizeCrawlBudget(
  input?: Partial<CrawlBudgetLimits>,
): CrawlBudgetLimits {
  const source = input ?? {};
  const maxDepth = source.maxDepth;
  return {
    maxDepth: typeof maxDepth === "number" && Number.isSafeInteger(maxDepth) &&
        maxDepth >= 0
      ? Math.min(maxDepth, DEFAULT_CRAWL_BUDGET.maxDepth)
      : DEFAULT_CRAWL_BUDGET.maxDepth,
    maxPagesPerOrigin: positiveLimit(
      source.maxPagesPerOrigin ?? 0,
      DEFAULT_CRAWL_BUDGET.maxPagesPerOrigin,
      DEFAULT_CRAWL_BUDGET.maxPagesPerOrigin,
    ),
    maxPagesTotal: positiveLimit(
      source.maxPagesTotal ?? 0,
      DEFAULT_CRAWL_BUDGET.maxPagesTotal,
      DEFAULT_CRAWL_BUDGET.maxPagesTotal,
    ),
    maxBytesPerResponse: positiveLimit(
      source.maxBytesPerResponse ?? 0,
      DEFAULT_CRAWL_BUDGET.maxBytesPerResponse,
      DEFAULT_CRAWL_BUDGET.maxBytesPerResponse,
    ),
    maxBytesTotal: positiveLimit(
      source.maxBytesTotal ?? 0,
      DEFAULT_CRAWL_BUDGET.maxBytesTotal,
      DEFAULT_CRAWL_BUDGET.maxBytesTotal,
    ),
    maxLinksPerPage: positiveLimit(
      source.maxLinksPerPage ?? 0,
      DEFAULT_CRAWL_BUDGET.maxLinksPerPage,
      DEFAULT_CRAWL_BUDGET.maxLinksPerPage,
    ),
    maxQueryVariantsPerPath: positiveLimit(
      source.maxQueryVariantsPerPath ?? 0,
      DEFAULT_CRAWL_BUDGET.maxQueryVariantsPerPath,
      DEFAULT_CRAWL_BUDGET.maxQueryVariantsPerPath,
    ),
  };
}

function isLiteralIpHostname(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":") ||
    isPublicIpAddress(host);
}

function normalizePercentEncoding(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => {
    const byte = Number.parseInt(hex, 16);
    const character = String.fromCharCode(byte);
    return /^[A-Za-z0-9\-._~]$/.test(character)
      ? character
      : `%${hex.toUpperCase()}`;
  });
}

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "yclid",
  "_ga",
  "_gl",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTrackingQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return TRACKING_QUERY_KEYS.has(normalized) || normalized.startsWith("utm_");
}

/**
 * Crawler frontier 用の canonical URL。既存 fetcher の安全な URL 判定を通した後、
 * tracker query / fragment / default port / 末尾 slash を正規化する。query の順序は
 * 並べ替えず、サイト固有の意味を壊さない。literal IP と custom port は queue 前に
 * 拒否し、egress 側へ到達する候補を frontier に残さない。
 */
export function canonicalizeCrawlUrl(rawUrl: string, base?: URL): URL | null {
  const normalized = normalizeFetchUrl(rawUrl, base);
  if (
    !normalized || normalized.port || isLiteralIpHostname(normalized.hostname)
  ) {
    return null;
  }
  if (isFetchDenylisted(normalized)) return null;
  if (normalized.hostname === "") return null;

  const url = new URL(normalized.href);
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  url.hash = "";
  url.pathname = normalizePercentEncoding(url.pathname || "/");
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }

  const keptQuery = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingQueryKey(key))
    .map(([key, value]) => [key, value] as const);
  url.search = keptQuery.length > 0
    ? `?${
      new URLSearchParams(keptQuery.map(([key, value]) => [key, value]))
        .toString()
    }`
    : "";

  return url.href.length <= 2_048 ? url : null;
}

export function crawlOrigin(url: URL | string): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return parsed.origin;
}

export function crawlPathKey(url: URL | string): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return `${parsed.origin}${parsed.pathname}`;
}

export function crawlQueryVariantKey(url: URL | string): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return parsed.search;
}

export function reserveCrawlPage(
  state: CrawlBudgetState,
  rawUrl: string | URL,
  depth: number,
  limits: Partial<CrawlBudgetLimits> = {},
  base?: URL,
): CrawlBudgetDecision {
  const budget = normalizeCrawlBudget(limits);
  const url = typeof rawUrl === "string"
    ? canonicalizeCrawlUrl(rawUrl, base)
    : canonicalizeCrawlUrl(rawUrl.href, base);
  if (!url) return { accepted: false, reason: "invalid_url" };
  if (state.reservedUrls.has(url.href)) {
    return { accepted: false, reason: "duplicate_url" };
  }
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > budget.maxDepth) {
    return { accepted: false, reason: "depth_exceeded" };
  }
  if (state.reservedPagesTotal >= budget.maxPagesTotal) {
    return { accepted: false, reason: "pages_total_exceeded" };
  }

  const origin = crawlOrigin(url);
  const pathKey = crawlPathKey(url);
  const originPages = state.pagesByOrigin[origin] ?? 0;
  if (originPages >= budget.maxPagesPerOrigin) {
    return { accepted: false, reason: "pages_origin_exceeded" };
  }
  const variants = state.queryVariantsByPath[pathKey] ?? 0;
  const variantKey = crawlQueryVariantKey(url);
  const variantSeen = state.reservedUrls.size > 0 &&
    [...state.reservedUrls].some((item) => {
      try {
        const parsed = new URL(item);
        return crawlPathKey(parsed) === pathKey &&
          crawlQueryVariantKey(parsed) === variantKey;
      } catch {
        return false;
      }
    });
  if (!variantSeen && variants >= budget.maxQueryVariantsPerPath) {
    return { accepted: false, reason: "query_variants_exceeded" };
  }

  state.reservedUrls.add(url.href);
  state.reservedPagesTotal += 1;
  state.pagesByOrigin[origin] = originPages + 1;
  if (!variantSeen) state.queryVariantsByPath[pathKey] = variants + 1;

  return {
    accepted: true,
    url,
    snapshot: snapshotCrawlBudget(state, url, budget),
  };
}

export function recordCrawlResponseBytes(
  state: CrawlBudgetState,
  bytes: number,
  limits: Partial<CrawlBudgetLimits> = {},
): boolean {
  const budget = normalizeCrawlBudget(limits);
  if (
    !Number.isSafeInteger(bytes) || bytes < 0 ||
    bytes > budget.maxBytesPerResponse ||
    state.bytesUsedTotal > budget.maxBytesTotal - bytes
  ) return false;
  state.bytesUsedTotal += bytes;
  return true;
}

export function canRecordCrawlResponseBytes(
  state: CrawlBudgetState,
  bytes: number,
  limits: Partial<CrawlBudgetLimits> = {},
): boolean {
  const budget = normalizeCrawlBudget(limits);
  return Number.isSafeInteger(bytes) && bytes >= 0 &&
    bytes <= budget.maxBytesPerResponse &&
    state.bytesUsedTotal <= budget.maxBytesTotal - bytes;
}

export function snapshotCrawlBudget(
  state: CrawlBudgetState,
  url: URL,
  limits: Partial<CrawlBudgetLimits> = {},
): CrawlBudgetSnapshot {
  const budget = normalizeCrawlBudget(limits);
  const origin = crawlOrigin(url);
  const pathKey = crawlPathKey(url);
  return {
    policyVersion: CRAWL_POLICY_VERSION,
    remainingPagesTotal: Math.max(
      0,
      budget.maxPagesTotal - state.reservedPagesTotal,
    ),
    remainingBytesTotal: Math.max(
      0,
      budget.maxBytesTotal - state.bytesUsedTotal,
    ),
    remainingPagesForOrigin: Math.max(
      0,
      budget.maxPagesPerOrigin - (state.pagesByOrigin[origin] ?? 0),
    ),
    remainingQueryVariantsForPath: Math.max(
      0,
      budget.maxQueryVariantsPerPath -
        (state.queryVariantsByPath[pathKey] ?? 0),
    ),
  };
}

/** stateをfixture/worker内部で扱う小さな facade。DB側の予算会計とは独立したテスト用。 */
export class CrawlBudgetLedger {
  readonly state = createCrawlBudgetState();
  readonly limits: CrawlBudgetLimits;

  constructor(limits: Partial<CrawlBudgetLimits> = {}) {
    this.limits = normalizeCrawlBudget(limits);
  }

  reserve(
    rawUrl: string | URL,
    depth: number,
    base?: URL,
  ): CrawlBudgetDecision {
    return reserveCrawlPage(this.state, rawUrl, depth, this.limits, base);
  }

  recordBytes(bytes: number): boolean {
    return recordCrawlResponseBytes(this.state, bytes, this.limits);
  }

  canRecordBytes(bytes: number): boolean {
    return canRecordCrawlResponseBytes(this.state, bytes, this.limits);
  }

  snapshot(url: URL): CrawlBudgetSnapshot {
    return snapshotCrawlBudget(this.state, url, this.limits);
  }
}

/** HTML attribute の最小限の entity decode。URL は decode 後に再度 canonicalize する。 */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

/**
 * page あたりの上限を先に適用してから URL を検証する。ページ由来の href も
 * 検索結果 URL と同じ canonicalize/denylist/IP policy を必ず通る。
 */
export function extractCrawlLinks(
  html: string,
  baseUrl: URL | string,
  maxLinks = DEFAULT_CRAWL_BUDGET.maxLinksPerPage,
): string[] {
  if (!html || !Number.isSafeInteger(maxLinks) || maxLinks <= 0) return [];
  const linkLimit = Math.min(maxLinks, DEFAULT_CRAWL_BUDGET.maxLinksPerPage);
  let base: URL;
  try {
    base = typeof baseUrl === "string" ? new URL(baseUrl) : baseUrl;
  } catch {
    return [];
  }
  const links: string[] = [];
  const seen = new Set<string>();
  const anchorPattern =
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(anchorPattern)) {
    if (links.length >= linkLimit) break;
    const raw = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "");
    const canonical = canonicalizeCrawlUrl(raw, base);
    if (!canonical || seen.has(canonical.href)) continue;
    seen.add(canonical.href);
    links.push(canonical.href);
  }
  return links;
}

export function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match) return null;
  const title = decodeHtmlAttribute(match[1])
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 200 ? title.slice(0, 200) : title || null;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class CrawlContentHashSet {
  private readonly hashes = new Set<string>();

  has(hash: string): boolean {
    return /^[0-9a-f]{64}$/.test(hash) && this.hashes.has(hash);
  }

  add(hash: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false;
    if (this.hashes.has(hash)) return false;
    this.hashes.add(hash);
    return true;
  }
}

export type CrawlErrorCode =
  | CrawlFetchFailureReason
  | "budget_exceeded"
  | "duplicate_content"
  | "origin_circuit_open"
  | "lease_lost"
  | "attempt_limit";

export function isRetryableCrawlFailure(code: CrawlErrorCode): boolean {
  return code === "network_error" || code === "timeout";
}

export type CrawlFailureDisposition = "pending" | "failed" | "dead";

export function failureDisposition(
  errorCode: CrawlErrorCode,
  attempt: number,
  maxAttempts = CRAWL_MAX_ATTEMPTS,
): CrawlFailureDisposition {
  if (!isRetryableCrawlFailure(errorCode)) return "failed";
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt >= maxAttempts) {
    return "dead";
  }
  return "pending";
}

export function retryBackoffMs(
  attempt: number,
  randomValue = 0.5,
): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0
    ? attempt
    : 1;
  const exponent = Math.min(12, safeAttempt - 1);
  const base = Math.min(
    CRAWL_BACKOFF_MAX_MS,
    CRAWL_BACKOFF_BASE_MS * CRAWL_BACKOFF_FACTOR ** exponent,
  );
  const random = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5;
  return Math.min(
    CRAWL_BACKOFF_MAX_MS,
    Math.round(base * (0.75 + random * 0.5)),
  );
}

export interface CrawlEvidenceHandoffInput {
  placeId: string;
  investigationId?: string | null;
  sourceUrl: string;
  sourceTitle?: string | null;
  placeName?: string;
  observedAt: string;
  contentHash: string;
  structuredClaims: readonly StructuredClaim[];
}

export interface CrawlEvidenceInsert {
  investigation_id: string | null;
  place_id: string;
  scope: "shared" | "investigation";
  source_type: ReturnType<typeof classifySourceType>;
  source_url: string;
  source_title: string | null;
  /** crawler は raw text を永続化せず、Evidence 抽出器が別途安全な抜粋を作る。 */
  excerpt: null;
  structured_claims: StructuredClaimInput[];
  source_quality: number;
  freshness_score: number;
  observed_at: string;
}

export interface CrawlEvidenceHandoff {
  contentHash: string;
  evidence: CrawlEvidenceInsert;
}

/**
 * 既存 evidence INSERT と place_facts 集約へ渡すための境界。invalid claim は
 * claim 単位で捨て、URL/日時/hash は補正せず拒否する。crawler 自身は Evidence を
 * 真実DBとして持たず、この値を既存のEvidence化経路へ渡すだけにする。
 */
export function buildCrawlEvidenceHandoff(
  input: CrawlEvidenceHandoffInput,
  now = new Date(),
): CrawlEvidenceHandoff | null {
  if (
    typeof input.placeId !== "string" || typeof input.sourceUrl !== "string" ||
    typeof input.observedAt !== "string" ||
    typeof input.contentHash !== "string" ||
    !Array.isArray(input.structuredClaims)
  ) return null;
  const sourceUrl = canonicalizeCrawlUrl(input.sourceUrl);
  const investigationId = input.investigationId ?? null;
  const sourceTitle = typeof input.sourceTitle === "string"
    ? input.sourceTitle.trim() || null
    : null;
  if (
    !sourceUrl || !UUID_RE.test(input.placeId) ||
    (investigationId !== null &&
      (typeof investigationId !== "string" ||
        !UUID_RE.test(investigationId))) ||
    (sourceTitle !== null && sourceTitle.length > 200) ||
    !/^[0-9a-f]{64}$/.test(input.contentHash)
  ) return null;
  const observed = new Date(input.observedAt);
  if (!Number.isFinite(observed.getTime())) return null;
  const placeName = typeof input.placeName === "string"
    ? input.placeName
    : undefined;
  const sourceType = classifySourceType(sourceUrl.href, placeName);
  const schemaCheckedClaims = input.structuredClaims.filter((claim) =>
    structuredClaimSchema.safeParse(claim).success
  );
  const claims = filterValidClaims([...schemaCheckedClaims]);
  return {
    contentHash: input.contentHash,
    evidence: {
      investigation_id: investigationId,
      place_id: input.placeId,
      scope: investigationId ? "investigation" : "shared",
      source_type: sourceType,
      source_url: sourceUrl.href,
      source_title: sourceTitle,
      excerpt: null,
      structured_claims: claims,
      source_quality: sourceQuality(sourceType),
      freshness_score: freshnessScore(observed, now),
      observed_at: observed.toISOString(),
    },
  };
}

export interface CrawlPlaceFactsSource {
  id: string;
  sourceQuality: number;
  observedAt: string;
  structuredClaims: StructuredClaim[];
  sourceUrl: string;
  sourceType: string;
}

export function toPlaceFactsSource(
  handoff: CrawlEvidenceHandoff,
  evidenceId: string,
): CrawlPlaceFactsSource {
  return {
    id: evidenceId,
    sourceQuality: handoff.evidence.source_quality,
    observedAt: handoff.evidence.observed_at,
    structuredClaims: handoff.evidence.structured_claims as StructuredClaim[],
    sourceUrl: handoff.evidence.source_url,
    sourceType: handoff.evidence.source_type,
  };
}

export interface CrawlObservation {
  schema: "oisint.crawler.v1";
  provider: "safe_fetch" | "crawler";
  operation: "enqueue" | "lease" | "fetch" | "complete" | "retry" | "dead";
  domain: string | null;
  outcome: "ok" | "error" | "skipped";
  errorCode?: CrawlErrorCode;
  depth?: number;
  attempt?: number;
  bytes?: number;
  links?: number;
  durationMs?: number;
}

export function buildCrawlObservation(input: {
  provider: CrawlObservation["provider"];
  operation: CrawlObservation["operation"];
  url?: string | URL | null;
  outcome: CrawlObservation["outcome"];
  errorCode?: CrawlErrorCode;
  depth?: number;
  attempt?: number;
  bytes?: number;
  links?: number;
  durationMs?: number;
}): CrawlObservation {
  let domain: string | null = null;
  try {
    const url = input.url
      ? typeof input.url === "string" ? new URL(input.url) : input.url
      : null;
    domain = url?.hostname
      ? url.hostname.toLowerCase().replace(/\.$/, "")
      : null;
  } catch {
    domain = null;
  }
  const observation: CrawlObservation = {
    schema: "oisint.crawler.v1",
    provider: input.provider,
    operation: input.operation,
    domain,
    outcome: input.outcome,
  };
  if (input.errorCode) observation.errorCode = input.errorCode;
  if (
    typeof input.depth === "number" && Number.isSafeInteger(input.depth) &&
    input.depth >= 0
  ) {
    observation.depth = input.depth;
  }
  if (
    typeof input.attempt === "number" && Number.isSafeInteger(input.attempt) &&
    input.attempt >= 0
  ) {
    observation.attempt = input.attempt;
  }
  if (
    typeof input.bytes === "number" && Number.isSafeInteger(input.bytes) &&
    input.bytes >= 0
  ) {
    observation.bytes = input.bytes;
  }
  if (
    typeof input.links === "number" && Number.isSafeInteger(input.links) &&
    input.links >= 0
  ) {
    observation.links = input.links;
  }
  if (Number.isFinite(input.durationMs) && (input.durationMs ?? 0) >= 0) {
    observation.durationMs = input.durationMs;
  }
  return observation;
}
