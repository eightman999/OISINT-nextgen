// Provider interfaces (spec.md §26 / contracts/providers.md)
// EvidenceSearchProvider / TavilyEvidenceProvider は作らない (§26)。
import type { z } from "zod";
import type { StructuredClaim } from "../types.ts";
import type {
  GroundedCandidateInvestigation,
  LocationAnchor,
  ParsedRequirements,
} from "../validation.ts";
import type {
  PreRankCandidate,
  PreRankRequirement,
  PreRankResult,
} from "../prerank.ts";
import type { LocationScope } from "../rail_scope.ts";
import type { OisiDomain } from "../domain_contract.ts";

/** Public, non-user coordinate supplied by the versioned N02 rail dataset. */
export interface PublicSearchAnchor {
  lat: number;
  lng: number;
  cacheKey: string;
  /** Optional provenance for multi-anchor Broad Discovery; never user GPS. */
  stationGroupId?: string;
  stationName?: string;
  lineId?: string;
  componentId?: string;
  pathKey?: string;
  sequence?: number | null;
  radiusMeters?: number;
}

export interface PlaceSearchQuery {
  area: string; // 例: "池袋"
  /** OISI domain。未指定は既存restaurant互換のため、providerが別domainを推測しない。 */
  domain?: OisiDomain;
  /** Structured location is authoritative; area remains the legacy fallback. */
  locationScope?: LocationScope;
  keyword?: string; // カテゴリ・自由語
  budgetMin?: number;
  // 予算上限。現 provider (Geoapify) は予算で絞れないため未使用 (#297)
  budgetMax?: number;
  partySize?: number;
  // 探索poolの上限。最終表示候補は policy/ranking 側で3件に固定する。
  limit: number;
  // N02 station coordinates are public dataset data and may use the normal
  // provider cache. This is deliberately distinct from a user's GPS anchor.
  publicSearchAnchor?: PublicSearchAnchor;
  /** #509 Broad Discovery may submit all public rail anchors in one request. */
  publicSearchAnchors?: readonly PublicSearchAnchor[];
  /** User GPS anchor. Transient run input; never pass it through provider cache. */
  searchAnchor?: LocationAnchor;
}

// provider 識別子 (#530)。単一 provider 固定にしない。DB では
// place_provider_links.provider に入る。新 provider 追加時にこの型を union で
// 増やさない — pipeline / UI へ provider-specific 分岐を広げないため string とする。
export type ProviderId = string;

// run-investigation が提供する相関付きの観測 sink。入力値・URL・応答本文は
// 渡さず、固定 operation と時間/件数だけを記録する。
export interface ProviderMetric {
  provider: string;
  operation: string;
  durationMs: number;
  /** API に渡した独立 item 数。本文・query は渡さない。 */
  itemCount?: number;
  semaphoreWaitMs?: number;
  retryCount?: number;
  outcome: "ok" | "error";
}

export interface ProviderInstrumentation {
  onMetric(metric: ProviderMetric): void;
}

// provider 規約上の保存可否 (#473 provider rights matrix が正本)。
// place_provider_links.storage_policy と同じ語彙を使う。
export type StoragePolicy = "persistent" | "ttl" | "id_only" | "ephemeral";

// provider ごとの保存・表示契約 (#530)。adapter が自分で申告し、書き込み側が
// place_provider_links へそのまま記録する。呼び出し側に provider 名の if を書かない。
export interface ProviderMeta {
  id: ProviderId;
  storagePolicy: StoragePolicy;
  // 表示義務の識別子 (例: "osm_odbl_attribution" / "mlit_n02_attribution")。
  // 表示義務が無い provider (mock) は null
  attributionPolicy: string | null;
  // storagePolicy="ttl" のときの保存期限 (時間)。persistent では null
  ttlHours: number | null;
}

export interface PlaceSearchResult {
  provider: ProviderId;
  providerPlaceId: string; // place_provider_links.provider_place_id
  /** domain adapterが明示した対象。欠落時は推測せず既存互換として扱う。 */
  domain?: OisiDomain;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  url: string; // 対象ページ URL (Evidence #0 の source_url)
  structuredClaims: StructuredClaim[]; // §13 の ClaimKey に正規化済み
  metadata: Record<string, unknown>;
  // provider API を実際に呼んだ時刻 (ISO)。external_cache (§32) 経由でも元の取得時刻を保つ。
  // places.refreshed_at / Evidence #0 の observed_at の入力 (#289)。mock は付けない
  fetchedAt?: string;
}

export interface PlaceSearchProvider {
  // 保存 / 表示契約の申告 (#530)。書き込み側はこれを place_provider_links へ記録する
  readonly meta: ProviderMeta;
  search(query: PlaceSearchQuery): Promise<PlaceSearchResult[]>;
  // provider 由来 places の個別取得 (#289)。TTL provider の自動更新または
  // persistent provider の明示的 freshness 操作から呼ぶ。
  // 未実装の provider (mock) は再取得の対象外 (§5.4 Fallback 不変)
  fetchByIds?(providerPlaceIds: string[]): Promise<PlaceSearchResult[]>;
}

export interface CandidateInvestigationInput {
  place: {
    name: string;
    address: string;
    providerPlaceId: string;
    domain?: OisiDomain;
  };
  requirements: Array<{
    id: string;
    normalizedText: string;
    kind: string;
    priority: string;
  }>;
  knownClaims: StructuredClaim[]; // place provider 由来 Evidence #0 の claims
}

// AI の責務を vendor から分離する。GoogleAIClient / Workers AI adapter 等は
// これらの小さな契約を実装し、pipeline は AIProvider だけを見る (#512)。
export interface RequirementParser {
  parseRequirements(
    query: string,
    signal?: AbortSignal,
  ): Promise<ParsedRequirements>;
}

export interface CandidateResearcher {
  investigateCandidate(
    input: CandidateInvestigationInput,
    signal?: AbortSignal,
  ): Promise<GroundedCandidateInvestigation>;
}

export interface EmbeddingProvider {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>; // texts.length 個の独立 768 次元 vector (§5, §16.3)
}

// Structured Output の schema / validation / retry は adapter 境界で吸収する。
// call site は vendor 固有の API・モデル名を知らず、前回検証エラーだけを再送する。
export interface ResearchEvaluationRequest<T> {
  buildPrompt: (previousError: string | null) => string;
  schema: unknown;
  validate: (raw: unknown) => z.ZodSafeParseResult<T>;
  maxAttempts?: number;
}

export interface ResearchEvaluator {
  evaluate<T>(
    request: ResearchEvaluationRequest<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface SearchFetchResearchDependencies {
  parser: RequirementParser;
  research: ResearchEvaluator;
  embedding: EmbeddingProvider;
}

export interface AIProvider
  extends RequirementParser, CandidateResearcher, EmbeddingProvider {}

// ============================================================
// Pre-Rank provider (issue #552)
// Broad Discovery 候補を、高価な Web Research + Gemini Judge へ渡す前に絞る段。
// provider 名を pipeline / UI へハードコードしない — 切替は providers/index.ts の
// getPreRankProvider() 1 箇所のみ (§26 と同じ規律)。
// ============================================================

export interface PreRankProvider {
  readonly id: ProviderId;
  // 失敗しても throw しない契約。障害時は決定論 pre-rank を返し、
  // Investigation を完走させる (issue #552 Fallback Rules)
  preRank(
    candidates: PreRankCandidate[],
    requirements: PreRankRequirement[],
  ): Promise<PreRankOutcome>;
}

// 監査・コスト計測用 (issue #552 Cost Strategy の stage 別記録)
export interface PreRankOutcome {
  provider: ProviderId;
  results: PreRankResult[];
  // AI 出力を採用できた候補 / 棄却した候補
  acceptedIds: string[];
  rejectedIds: string[];
  // 決定論 fallback へ落ちた理由 (正常時 null)
  fallbackReason: string | null;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  // reasoning (thinking) が実際に何 token 使われたか。pre-rank は推論を切る想定なので
  // 0 であるべきで、0 でなければ max_tokens の枠食い潰しの兆候 (#552)
  reasoningTokens: number | null;
  // 外部APIへの実測リクエスト時間。未設定・未接続時は null。
  apiLatencyMs?: number | null;
  // 非ストリーミングadapterではfirst tokenを観測できないため null。
  ttftMs?: number | null;
  latencyMs: number;
}
