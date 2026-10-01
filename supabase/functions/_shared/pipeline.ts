// 調査パイプラインの共有ロジック (spec.md §25.2, §25.3)
// run-investigation と rerank-investigation の両方から使う。
import type { SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "./db.ts";
import {
  filterValidClaims,
  type GroundedCandidateInvestigation,
  groundedCandidateInvestigationSchema,
  type StructuredClaimInput,
  validateGroundedCandidateReferences,
} from "./validation.ts";
import { getProviders } from "./providers/index.ts";
import type {
  AIProvider,
  CandidateInvestigationInput,
} from "./providers/types.ts";
import {
  clamp,
  classifySourceType,
  freshnessScore,
  sourceQuality,
  ttlHours,
} from "./source_quality.ts";
import {
  claimValuesConflict,
  contradictedKeys,
  detectCombinedContradictions,
} from "./contradiction.ts";
import {
  DatabaseOperationError,
  throwIfDatabaseError,
} from "./database_error.ts";
import {
  EVIDENCE_EXCERPT_LIMIT,
  filterEvidenceForInvestigation,
  formatNeutralSharedClaim,
  isReusableSafeSharedEvidence,
  neutralCitationExcerpt,
  neutralizeClaimsForModelPrompt,
} from "./evidence_content.ts";
import {
  isSafeModelNeutralSharedUrl,
  parsePublicHttpUrl,
} from "./public_url.ts";
import type { CrawlEvidenceHandoff } from "./crawler.ts";
import {
  assignRanks,
  computeScore,
  cosineSimilarity,
  cosineToUnit,
  type RankingEvaluation,
  type RankingRequirement,
  recallBonus,
  recallBonusLine,
  type RecallPlacePreference,
  semanticMatchScore,
} from "./ranking.ts";
import {
  canonicalValue,
  evaluateFromEvidence,
  planKnownEvidenceForCandidate,
  refreshPlaceFacts,
  structuredFilterClaimKeyForRequirement,
} from "./facts.ts";
import type { ClaimKey, MatchState } from "./types.ts";
import {
  type ClaimWithEvidence,
  deterministicEvaluations,
} from "./requirement_matching.ts";
import { resolveRequirementSource } from "./requirement_source.ts";
import {
  CANDIDATE_PROVIDER_ATTEMPT_TIMEOUT_MS,
  CANDIDATE_PROVIDER_MAX_ATTEMPTS,
  throwIfAborted,
  withAbortTimeout,
} from "./timeout_policy.ts";
export { withAbortTimeout } from "./timeout_policy.ts";
import {
  parseEmbeddingVector,
  validateEmbedding,
  validateEmbeddingVectorString,
} from "./embedding_validation.ts";

// §5.4 Hard Rule 4: 各候補調査 (検索 + ページfetch(並列) + Gemini) は
// 1試行60秒。requirement_added は最大2試行をawaitするため外側予算は別に持つ。

type EmbeddingBoundary = "provider_ingress" | "db_readback";
type EmbeddingContext = "investigation" | "requirement" | "evidence" | "place";

function logInvalidEmbedding(
  boundary: EmbeddingBoundary,
  context: EmbeddingContext,
  reason: "not_array" | "wrong_dimension" | "invalid_value",
): void {
  console.warn(JSON.stringify({
    metric: "embedding_invalid",
    boundary,
    context,
    reason,
  }));
}

function parseRankingVector(
  raw: string | null | undefined,
  context: EmbeddingContext,
): number[] | null {
  if (!raw) return null;
  const checked = validateEmbeddingVectorString(raw);
  if (checked.ok) return checked.value;
  logInvalidEmbedding("db_readback", context, checked.reason);
  return null;
}

// ClaimKey → 対応する RequirementKind (§15 評価への影響)
export const CLAIM_TO_KIND: Partial<Record<ClaimKey, string[]>> = {
  opening_hours: ["time"],
  closed_days: ["time"],
  budget_dinner: ["budget"],
  card_accepted: ["payment"],
  reservation: ["reservation"],
  private_room: ["reservation", "party_size"],
  capacity: ["party_size"],
  non_smoking: ["dietary", "atmosphere", "other"],
  wifi_available: ["access", "other"],
  child_friendly: ["atmosphere", "other"],
  nearest_station_walk_minutes: ["access"],
};

export function guardRankingMatchAgainstContradictions(
  state: RankingEvaluation["state"],
  confidence: number,
  kind: string,
  conflictKeys: ReadonlySet<ClaimKey>,
): { state: RankingEvaluation["state"]; confidence: number } {
  const conflicted = [...conflictKeys].some((key) =>
    (CLAIM_TO_KIND[key] ?? []).includes(kind)
  );
  return conflicted && state !== "unknown"
    ? { state: "partial", confidence: Math.min(confidence, 0.5) }
    : { state, confidence };
}

export interface CandidateRow {
  id: string;
  place_id: string;
  places: {
    id: string;
    name: string;
    address: string | null;
    provider: string;
    provider_place_id: string;
  };
}

/**
 * 候補単位の調査計画をstageメトリクスへ渡す結果。
 * 既存の呼び出し側は戻り値を無視できるよう、DBの内容や本文は含めない。
 */
export interface CandidateResearchOutcome {
  reusedRequirementCount: number;
  unresolvedRequirementCount: number;
  unknownRequirementCount: number;
  externalResearchAttempted: boolean;
}

export interface PipelineRequirement {
  id: string;
  originalText: string;
  normalizedText: string;
  kind: string;
  priority: string;
  // 0..1 (#552 pre-rank の入力)。既存の呼び出し側フィクスチャを壊さないため任意とし、
  // 未指定は §17 と同じ 0.5 として扱う
  weight?: number;
  sourceAttested: boolean;
}

export type EvidenceScope = "shared" | "investigation";

export interface EvidenceClaimReference {
  id: string;
  scope: EvidenceScope;
  investigationId: string | null;
  placeId: string;
  sourceUrl: string;
  structuredClaims: readonly StructuredClaimInput[];
  excerpt: string;
  sourceQuality: number;
}

function evidenceClaimSignature(claim: StructuredClaimInput): string {
  return `${claim.key}:${canonicalValue(claim.value)}`;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { formatNeutralSharedClaim };

function neutralizeSharedClaims(
  claims: readonly StructuredClaimInput[],
): StructuredClaimInput[] {
  return neutralizeClaimsForModelPrompt(claims);
}

// 同じURLを支持する複数findingのclaimを1つのEvidence行へ保存するための決定論merge。
// key+valueが同じclaimはrawTextの辞書順最小を残し、出力自体もsignature順に固定する。
export function mergeEvidenceClaims(
  claimGroups: readonly (readonly StructuredClaimInput[])[],
): StructuredClaimInput[] {
  const validClaims = filterValidClaims(
    claimGroups.flatMap((claims) => [...claims]),
  );
  const bySignature = new Map<string, StructuredClaimInput>();
  for (const claim of validClaims) {
    const signature = evidenceClaimSignature(claim);
    const existing = bySignature.get(signature);
    if (!existing || compareCodeUnits(claim.rawText, existing.rawText) < 0) {
      bySignature.set(signature, claim);
    }
  }
  return [...bySignature.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, claim]) => claim);
}

function evidenceContainsAllClaims(
  storedClaims: unknown,
  requiredClaims: readonly StructuredClaimInput[],
  requireRawText = false,
): boolean {
  const validStored = filterValidClaims(
    Array.isArray(storedClaims) ? storedClaims as StructuredClaimInput[] : [],
  );
  // every([]) で無関係な同一URL Evidenceを再利用しない。claimなし同士だけは
  // citation Evidenceとして再利用できるが、matchの根拠にはならない。
  if (requiredClaims.length === 0) return validStored.length === 0;
  const requiredKeys = new Set(requiredClaims.map((claim) => claim.key));
  const storedValuesByKey = new Map<ClaimKey, unknown[]>();
  for (const claim of validStored) {
    if (!requiredKeys.has(claim.key)) continue;
    const values = storedValuesByKey.get(claim.key) ?? [];
    if (
      values.some((value) => claimValuesConflict(claim.key, value, claim.value))
    ) {
      // 必要claimを含んでいても、同じrow内に相反値があれば根拠として再利用しない。
      return false;
    }
    values.push(claim.value);
    storedValuesByKey.set(claim.key, values);
  }
  return requiredClaims.every((claim) =>
    validStored.some((stored) =>
      evidenceClaimSignature(stored) === evidenceClaimSignature(claim) &&
      (!requireRawText || stored.rawText === claim.rawText)
    )
  );
}

export async function loadCandidates(
  db: SupabaseClient,
  invId: string,
): Promise<CandidateRow[]> {
  const { data, error } = await db
    .from("candidates")
    .select(
      "id, place_id, places (id, name, address, provider, provider_place_id)",
    )
    .eq("investigation_id", invId);
  throwIfDatabaseError(error, "candidates.select");
  return (data ?? []) as unknown as CandidateRow[];
}

export async function loadRequirements(
  db: SupabaseClient,
  invId: string,
): Promise<PipelineRequirement[]> {
  const [requirementsResult, investigationResult] = await Promise.all([
    db.from("requirements")
      .select("id, normalized_text, text, kind, priority, weight")
      .eq("investigation_id", invId),
    db.from("investigations")
      .select("raw_query")
      .eq("id", invId)
      .maybeSingle(),
  ]);
  throwIfDatabaseError(requirementsResult.error, "requirements.select");
  throwIfDatabaseError(
    investigationResult.error,
    "investigations.raw_query_select",
  );
  const rawQuery = investigationResult.data?.raw_query;
  if (typeof rawQuery !== "string") {
    throw new DatabaseOperationError(
      "investigations.raw_query_select",
      "investigation raw_query is missing",
    );
  }
  return (requirementsResult.data ?? []).map((r) => {
    const text = typeof r.text === "string" ? r.text : "";
    const normalizedText = typeof r.normalized_text === "string"
      ? r.normalized_text
      : text;
    const source = resolveRequirementSource({
      storedKind: typeof r.kind === "string" ? r.kind : null,
      text,
      normalizedText,
      rawQuery,
    });
    return {
      id: r.id,
      originalText: source.originalText,
      normalizedText,
      kind: source.kind,
      priority: r.priority ?? "should",
      weight: typeof r.weight === "number" ? r.weight : 0.5,
      sourceAttested: source.sourceAttested,
    };
  });
}

// TTL 内の shared Evidence が同一 place × URL かつ必要claimを全て含めば再利用する。
// freshでもclaim不足ならUPDATEせず、必要claimを持つ新しい行を追記する (§44.4)。
// observedAt: データを provider から実際に取得した時刻 (ISO)。external_cache (§32) 経由の
// データで observed_at が実年齢より新しくならないようにする (#289)。省略時は now。
async function insertEvidenceReferenceIfStale(
  db: SupabaseClient,
  placeId: string,
  url: string,
  title: string,
  sourceTypeHint: string | null,
  claims: StructuredClaimInput[],
  excerpt: string,
  contentMode: "model-neutral" | "trusted-provider",
  observedAt?: string,
  embeddingProvider?: Pick<AIProvider, "embed">,
): Promise<EvidenceClaimReference | null> {
  if (!parsePublicHttpUrl(url)) return null;
  if (contentMode === "model-neutral" && !isSafeModelNeutralSharedUrl(url)) {
    return null;
  }
  const sourceType = sourceTypeHint ?? classifySourceType(url);
  const ttl = ttlHours(sourceType as Parameters<typeof ttlHours>[0]);
  const cutoff = new Date(Date.now() - ttl * 3600_000).toISOString();
  const mergedClaims = mergeEvidenceClaims([claims]);
  const validClaims = contentMode === "model-neutral"
    ? neutralizeSharedClaims(mergedClaims)
    : mergedClaims;
  const neutralSourceTitle = neutralCitationExcerpt(url);
  const neutralSharedExcerpt = validClaims.length > 0
    ? validClaims.map((claim) => claim.rawText).join("。")
    : neutralSourceTitle;
  const expectedSourceTitle = contentMode === "model-neutral"
    ? neutralSourceTitle
    : title;
  // trusted-provider の excerpt は「保存する claim の rawText を順に連結したもの」が
  // 契約 (evidence_content.ts の isTrustedPlaceProviderRow が同じ式で検証する)。
  // 呼び出し側が渡した excerpt をそのまま使うと、mergeEvidenceClaims が claim を
  // key 昇順へ並べ替えた分だけ順序がずれ、書いた行を自分で再利用できなくなる (#514)。
  const trustedProviderExcerpt = validClaims.length > 0
    ? validClaims.map((claim) => claim.rawText).join("。")
    : (excerpt.trim() || title);
  const expectedStoredExcerpt =
    (contentMode === "model-neutral"
      ? neutralSharedExcerpt
      : trustedProviderExcerpt).slice(0, EVIDENCE_EXCERPT_LIMIT);
  const existingQuery = db
    .from("evidence")
    .select(
      "id, scope, investigation_id, place_id, source_url, source_type, source_title, structured_claims, excerpt, source_quality",
    )
    .eq("place_id", placeId)
    .eq("source_url", url)
    .eq("scope", "shared")
    .is("investigation_id", null);
  const { data: existingRows, error: existingError } = await existingQuery
    .gt("observed_at", cutoff)
    .order("observed_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(50);
  throwIfDatabaseError(existingError, "evidence.stale_select");
  const reusable = (existingRows ?? []).find((row) =>
    row.scope === "shared" && row.investigation_id === null &&
    row.place_id === placeId && row.source_url === url &&
    evidenceContainsAllClaims(
      row.structured_claims,
      validClaims,
      contentMode === "trusted-provider",
    ) &&
    (contentMode === "model-neutral"
      ? isReusableSafeSharedEvidence(row)
      : row.source_type === sourceType &&
        row.source_title === expectedSourceTitle &&
        row.excerpt === expectedStoredExcerpt)
  );
  if (reusable) {
    return {
      id: reusable.id,
      structuredClaims: filterValidClaims(
        Array.isArray(reusable.structured_claims)
          ? reusable.structured_claims as StructuredClaimInput[]
          : [],
      ),
      scope: reusable.scope === "investigation" ? "investigation" : "shared",
      investigationId: typeof reusable.investigation_id === "string"
        ? reusable.investigation_id
        : null,
      placeId: reusable.place_id,
      sourceUrl: reusable.source_url,
      excerpt: typeof reusable.excerpt === "string" ? reusable.excerpt : "",
      sourceQuality: typeof reusable.source_quality === "number"
        ? reusable.source_quality
        : 0.4,
    };
  }

  const observedAtMs = observedAt ? Date.parse(observedAt) : NaN;
  const now = Number.isFinite(observedAtMs)
    ? new Date(observedAtMs)
    : new Date();

  // excerpt の embedding を evidence.embedding へ保存 (§16.2 / §16.3: 768 次元固定。issue #103)。
  // mock モードでは MockAIProvider.embed (外部 API 非依存・決定論) が使われるため
  // §5.4 Fallback を壊さない。失敗しても Evidence 自体は保存する
  // (embedding 無しの候補は §17 の P0 代用式へフォールバックする)。
  const storedExcerpt = expectedStoredExcerpt;
  let embedding: string | null = null;
  const shouldEmbed = contentMode === "trusted-provider" ||
    validClaims.length > 0;
  if (shouldEmbed && storedExcerpt.trim().length > 0) {
    try {
      const embedder = embeddingProvider ?? getProviders().ai;
      const [vec] = await embedder.embed([storedExcerpt]);
      const checked = validateEmbedding(vec);
      if (checked.ok) {
        embedding = JSON.stringify(checked.value);
      } else {
        logInvalidEmbedding("provider_ingress", "evidence", checked.reason);
      }
    } catch {
      // embedding 無しでも Evidence は保存する
    }
  }

  const { data: inserted, error: insertError } = await db
    .from("evidence")
    .insert({
      place_id: placeId,
      scope: "shared",
      investigation_id: null,
      source_type: sourceType,
      source_url: url,
      source_title: expectedSourceTitle,
      excerpt: storedExcerpt,
      structured_claims: validClaims,
      source_quality: sourceQuality(
        sourceType as Parameters<typeof sourceQuality>[0],
      ),
      freshness_score: freshnessScore(now),
      observed_at: now.toISOString(),
      embedding,
    })
    .select(
      "id, scope, investigation_id, place_id, source_url, structured_claims, excerpt, source_quality",
    )
    .single();
  throwIfDatabaseError(insertError, "evidence.insert");
  if (!inserted?.id) {
    throw new DatabaseOperationError(
      "evidence.insert",
      "insert succeeded without an Evidence id",
    );
  }
  if (
    inserted.scope !== "shared" || inserted.investigation_id !== null ||
    inserted.place_id !== placeId || inserted.source_url !== url
  ) {
    throw new DatabaseOperationError(
      "evidence.insert",
      "inserted Evidence ownership/provenance fields do not match the write",
    );
  }
  return {
    id: inserted.id,
    // DBが返した永続化後の値だけを後段guardへ渡す。取得できなければ空としてfail-closed。
    structuredClaims: filterValidClaims(
      Array.isArray(inserted.structured_claims)
        ? inserted.structured_claims as StructuredClaimInput[]
        : [],
    ),
    scope: inserted.scope === "investigation" ? "investigation" : "shared",
    investigationId: typeof inserted.investigation_id === "string"
      ? inserted.investigation_id
      : null,
    placeId: inserted.place_id,
    sourceUrl: inserted.source_url,
    excerpt: typeof inserted.excerpt === "string" ? inserted.excerpt : "",
    sourceQuality: typeof inserted.source_quality === "number"
      ? inserted.source_quality
      : 0.4,
  };
}

export async function insertEvidenceIfStale(
  db: SupabaseClient,
  placeId: string,
  url: string,
  title: string,
  sourceTypeHint: string | null,
  claims: StructuredClaimInput[],
  excerpt: string,
  observedAt?: string,
  embeddingProvider?: Pick<AIProvider, "embed">,
): Promise<string | null> {
  const evidence = await insertEvidenceReferenceIfStale(
    db,
    placeId,
    url,
    title,
    sourceTypeHint,
    claims,
    excerpt,
    "trusted-provider",
    observedAt,
    embeddingProvider,
  );
  return evidence?.id ?? null;
}

/**
 * crawler成功を既存Evidence経路へ接続する。raw HTML/textは受け取らず、
 * URL・hash・検証済みのmodel-neutral claimだけを永続化対象にする。
 */
export async function insertCrawlEvidenceIfStale(
  db: SupabaseClient,
  handoff: CrawlEvidenceHandoff,
): Promise<string | null> {
  const evidence = handoff.evidence;
  if (
    !/^[0-9a-f]{64}$/.test(handoff.contentHash) ||
    evidence.scope !== "shared" || evidence.investigation_id !== null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(evidence.place_id) ||
    !isSafeModelNeutralSharedUrl(evidence.source_url) ||
    parsePublicHttpUrl(evidence.source_url)?.href !== evidence.source_url
  ) return null;

  const modelNeutralKeys = new Set<ClaimKey>([
    "card_accepted",
    "reservation",
    "private_room",
    "capacity",
    "budget_dinner",
    "opening_hours",
    "non_smoking",
    "wifi_available",
    "child_friendly",
    "nearest_station_walk_minutes",
    "category",
    "price_range",
    "amenities",
    "lodging.room_type",
    "lodging.check_in_time",
    "lodging.check_out_time",
    "rental_space.equipment",
  ]);
  const claims = mergeEvidenceClaims([evidence.structured_claims]).filter(
    (claim) => modelNeutralKeys.has(claim.key),
  );
  const title = neutralCitationExcerpt(evidence.source_url);
  const inserted = await insertEvidenceReferenceIfStale(
    db,
    evidence.place_id,
    evidence.source_url,
    title,
    evidence.source_type,
    claims,
    title,
    "model-neutral",
    evidence.observed_at,
  );
  return inserted?.id ?? null;
}

export async function insertUnknownEvaluations(
  db: SupabaseClient,
  invId: string,
  candidateId: string,
  requirementIds: string[],
): Promise<void> {
  if (requirementIds.length === 0) return;
  const { error } = await db.from("requirement_evaluations").upsert(
    requirementIds.map((rid) => ({
      investigation_id: invId,
      candidate_id: candidateId,
      requirement_id: rid,
      state: "unknown",
      confidence: null,
      explanation: "調査に失敗したため不明です",
      evidence_ids: [],
    })),
    { onConflict: "candidate_id,requirement_id" },
  );
  throwIfDatabaseError(error, "requirement_evaluations.unknown_upsert");
}

export interface CandidateEvaluationRow {
  investigation_id: string;
  candidate_id: string;
  requirement_id: string;
  state: "match" | "partial" | "mismatch" | "unknown";
  confidence: number | null;
  explanation: string;
  evidence_ids: string[];
}

export async function persistCandidateEvaluations(
  db: SupabaseClient,
  rows: CandidateEvaluationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db.from("requirement_evaluations").upsert(rows, {
    onConflict: "candidate_id,requirement_id",
  });
  throwIfDatabaseError(error, "requirement_evaluations.candidate_upsert");
}

// requirement_evaluations の upsert 行 (DB スキーマと同形)
export interface EvaluationRow {
  investigation_id: string;
  candidate_id: string;
  requirement_id: string;
  state: MatchState;
  confidence: number | null;
  explanation: string;
  evidence_ids: string[];
}

// 判定可能な provider facts と要件をコード突合し、AI 評価より優先して上書きする
// (issue #312 是正案1)。AI が match と返してもコードが mismatch なら mismatch。
// claim が無い / 正規化できない requirement は従来どおり AI 評価のまま。
// 純関数 (rows を in-place 更新するのみ。DB 非依存) として単体テストする
export function applyClaimMatchingOverrides(
  rows: EvaluationRow[],
  requirements: Array<
    Pick<
      PipelineRequirement,
      "id" | "kind" | "originalText" | "normalizedText" | "sourceAttested"
    >
  >,
  claims: ClaimWithEvidence[],
): void {
  if (rows.length === 0 || claims.length === 0) return;
  const det = deterministicEvaluations(
    requirements.filter((requirement) => requirement.sourceAttested),
    claims,
  );
  for (const row of rows) {
    const d = det.get(row.requirement_id);
    if (!d) continue;
    row.state = d.state;
    row.confidence = d.confidence;
    row.explanation = d.explanation;
    row.evidence_ids = d.evidenceIds;
  }
}

// §30 / §5 / §12 Critical Rule の破棄ガード (純関数・DB 非依存)。
// - sourceUrls のうち実 citation に無い URL は Evidence に採用しない (捏造対策)
// - Evidence 0 件の finding は match にできない → unknown / confidence 0
// - confidence が 0..1 の範囲外なら clamp せず破棄して unknown / null
export interface GuardedEvaluation {
  state: "match" | "partial" | "mismatch" | "unknown";
  confidence: number | null;
  evidenceIds: string[];
  explanation: string;
}

export interface EvaluationEvidenceContext {
  placeId: string;
  sharedByUrl: ReadonlyMap<string, EvidenceClaimReference>;
  neutralCitationByRequirement: ReadonlyMap<
    string,
    ReadonlyMap<string, EvidenceClaimReference>
  >;
}

const DETERMINISTIC_SHARED_KINDS = new Set([
  "payment",
  "budget",
  "reservation",
  "party_size",
  "time",
]);

function usesDeterministicSharedClaims(
  requirement: Pick<
    PipelineRequirement,
    "kind" | "originalText" | "normalizedText"
  >,
): boolean {
  return DETERMINISTIC_SHARED_KINDS.has(requirement.kind) ||
    structuredFilterClaimKeyForRequirement(
        requirement.originalText,
        requirement.normalizedText,
      ) !== null;
}

function isClaimRelevantToRequirement(
  claim: StructuredClaimInput,
  requirement: Pick<
    PipelineRequirement,
    "kind" | "originalText" | "normalizedText" | "sourceAttested"
  >,
): boolean {
  const structuredFilterKey = structuredFilterClaimKeyForRequirement(
    requirement.originalText,
    requirement.normalizedText,
  );
  if (structuredFilterKey) return claim.key === structuredFilterKey;

  switch (requirement.kind) {
    case "payment":
      return claim.key === "card_accepted";
    case "budget":
      return claim.key === "budget_dinner";
    case "party_size":
      return claim.key === "capacity";
    case "time":
      return claim.key === "opening_hours";
    case "reservation": {
      // reservation kind は「予約」と「個室」の双方を含むため、文面で分離する。
      // 個室claimだけで席予約を、予約claimだけで個室を根拠付けない。
      const text = requirement.normalizedText.normalize("NFKC");
      if (text.includes("個室")) return claim.key === "private_room";
      if (text.includes("予約")) return claim.key === "reservation";
      return false;
    }
    default:
      return false;
  }
}

export function guardEvaluation(
  finding: {
    requirementId: string;
    state: "match" | "partial" | "mismatch" | "unknown";
    confidence: number;
    explanation: string;
    sourceUrls: string[];
    claims: StructuredClaimInput[];
  },
  requirement: Pick<
    PipelineRequirement,
    "kind" | "originalText" | "normalizedText" | "sourceAttested"
  >,
  citationUrls: ReadonlySet<string>,
  evidenceContext: EvaluationEvidenceContext,
): GuardedEvaluation {
  let state = finding.state;
  let confidence: number | null = finding.confidence;
  let explanation = finding.explanation;
  let evidenceIds: string[] = [];

  // A model-supplied citation is an untrusted reference, not a hint that can
  // be repaired by dropping only the unknown URL.  One URL outside the
  // provider citation set invalidates the whole evaluation; otherwise a
  // fabricated citation could be hidden beside a real one while retaining a
  // match/partial conclusion.
  const hasUnknownCitation = finding.sourceUrls.some((url) =>
    !citationUrls.has(url)
  );
  if (hasUnknownCitation) {
    state = "unknown";
    confidence = 0;
    explanation = "引用URLに未検証の参照が含まれるため判定を破棄しました";
  } else if (!requirement.sourceAttested) {
    if (state !== "unknown") {
      state = "unknown";
      confidence = 0;
      explanation =
        "ユーザー原文に一意な条件記述を確認できないため判定を保留しました";
    }
  } else if (usesDeterministicSharedClaims(requirement)) {
    // deterministic対応kindは、finding自身のvalid claimとactual shared rowを
    // 厳格judgeへ戻す。AIがmatchでも、strict結果がpartial/mismatchなら置換する。
    const relevantClaims = mergeEvidenceClaims([finding.claims]).filter(
      (claim) => isClaimRelevantToRequirement(claim, requirement),
    );
    const relevantSignatures = new Set(
      relevantClaims.map(evidenceClaimSignature),
    );
    const citedShared = finding.sourceUrls
      .filter((url) => citationUrls.has(url))
      .map((url) => ({ url, ref: evidenceContext.sharedByUrl.get(url) }))
      .filter((entry): entry is { url: string; ref: EvidenceClaimReference } =>
        !!entry.ref && entry.ref.scope === "shared" &&
        entry.ref.investigationId === null &&
        entry.ref.placeId === evidenceContext.placeId &&
        entry.ref.sourceUrl === entry.url &&
        evidenceContainsAllClaims(entry.ref.structuredClaims, relevantClaims)
      )
      .map(({ ref }) => ({
        id: ref.id,
        sourceUrl: "shared-evidence",
        sourceQuality: ref.sourceQuality,
        observedAt: "1970-01-01T00:00:00.000Z",
        structuredClaims: ref.structuredClaims.filter((claim) =>
          relevantSignatures.has(evidenceClaimSignature(claim))
        ),
      }));

    const strict = relevantClaims.length > 0 && citedShared.length > 0
      ? evaluateFromEvidence([{
        id: finding.requirementId,
        originalText: requirement.originalText,
        normalizedText: requirement.normalizedText,
        kind: requirement.kind,
        priority: "must",
      }], citedShared).resolvedEvaluations[0]
      : undefined;
    if (strict) {
      // 構造化claimの決定論判定はAI stateより優先する。
      state = strict.state;
      confidence = strict.confidence;
      explanation = strict.explanation;
      evidenceIds = strict.evidenceIds;
    } else if (finding.state !== "unknown") {
      state = "unknown";
      confidence = 0;
      explanation = "引用Evidenceの構造化claimから条件を判定できません";
      evidenceIds = [];
    }
  } else {
    // semantic validator未実装/ClaimKey非対応kindは、このrunで同じ
    // requirementに帰属した単一URLの中立shared citationだけをAI matchの根拠にする。
    const citationByUrl = evidenceContext.neutralCitationByRequirement.get(
      finding.requirementId,
    );
    const citedNeutral = finding.sourceUrls
      .filter((url) => citationUrls.has(url))
      .map((url) => ({ url, ref: citationByUrl?.get(url) }))
      .filter((entry): entry is { url: string; ref: EvidenceClaimReference } =>
        !!entry.ref && entry.ref.scope === "shared" &&
        entry.ref.investigationId === null &&
        entry.ref.placeId === evidenceContext.placeId &&
        entry.ref.sourceUrl === entry.url &&
        entry.ref.excerpt.trim().length > 0
      );
    evidenceIds = citedNeutral.map(({ ref }) => ref.id);
    if (state !== "unknown" && evidenceIds.length === 0) {
      state = "unknown";
      confidence = 0;
      explanation = "この調査の単一引用URLに対応するEvidenceを確認できません";
    }
  }
  // confidence が 0..1 の範囲外なら clamp せず破棄して unknown (§30)
  if (
    !Number.isFinite(finding.confidence) || finding.confidence < 0 ||
    finding.confidence > 1
  ) {
    state = "unknown";
    confidence = null;
    explanation = "confidenceが許容範囲外のため判定を破棄しました";
    evidenceIds = [];
  }
  return { state, confidence, evidenceIds, explanation };
}

// 1 候補の調査 → Evidence 保存 → 評価保存 (候補単位 commit)。
// requirements には評価したい条件のみを渡す (rerank の requirement_added では新条件のみ §25.3)。
// 外部 provider / model の失敗だけを semantic unknown にする。DB・内部処理の失敗は
// coverage を未完のまま呼び出し元へ伝播し、run step が再試行できるようにする。
export async function investigateAndPersist(
  db: SupabaseClient,
  invId: string,
  candidate: CandidateRow,
  requirements: PipelineRequirement[],
  opts: { updateSummary: boolean; ai?: AIProvider; signal?: AbortSignal },
): Promise<CandidateResearchOutcome> {
  throwIfAborted(opts.signal);
  requirements = requirements.map((requirement) =>
    requirement.sourceAttested
      ? requirement
      : { ...requirement, originalText: "" }
  );
  const ai = opts.ai ?? getProviders().ai;
  const place = candidate.places;

  // ガード: mock 由来の架空店 (provider='mock') を live モードで実 Web 調査しない。
  // モード切替を跨いだ再実行 (mock で作った候補を live で run/rerank) で
  // 架空店を Serper/Gemini に投げてしまう事故の防止。
  if (
    place.provider === "mock" &&
    (Deno.env.get("DATA_PROVIDER_MODE") ?? "live") !== "mock"
  ) {
    await insertUnknownEvaluations(
      db,
      invId,
      candidate.id,
      requirements.map((r) => r.id),
    );
    try {
      await logEvent(
        db,
        invId,
        "candidate_skipped",
        "本番調査の対象外の候補のため、調査をスキップしました",
        { candidateId: candidate.id },
      );
    } catch {
      // coverage は保存済み。監査ログは副次書込みとして best-effort。
    }
    return {
      reusedRequirementCount: 0,
      unresolvedRequirementCount: requirements.length,
      unknownRequirementCount: requirements.length,
      externalResearchAttempted: false,
    };
  }

  try {
    // Evidence #0 を含む fresh shared Evidence を id/source_url 付きで保持し、
    // 決定論で判定可能な requirement と research 対象を計画する。ここでは保存しない。
    const reuse = await planKnownEvidenceForCandidate(
      db,
      candidate,
      requirements,
    );
    const sourceAttestedByRequirementId = new Map(
      requirements.map((requirement) => [
        requirement.id,
        requirement.sourceAttested,
      ]),
    );
    // FactRequirement は weight を持たないため、元の requirement から復元する
    const weightByRequirementId = new Map(
      requirements.map((requirement) => [requirement.id, requirement.weight]),
    );
    // facts.ts intentionally exposes a provider-neutral FactRequirement shape.
    // Restore the source-attestation bit at this boundary instead of defaulting
    // it to true: unresolved requirements must not bypass the raw-query gate.
    const unresolvedRequirements: PipelineRequirement[] = reuse
      .unresolvedRequirements.map((requirement) => ({
        ...requirement,
        weight: weightByRequirementId.get(requirement.id) ?? 0.5,
        sourceAttested:
          sourceAttestedByRequirementId.get(requirement.id) === true,
      }));
    const unresolvedRequirementIds = new Set(
      unresolvedRequirements.map((requirement) => requirement.id),
    );
    const unresolvedRequirementById = new Map(
      unresolvedRequirements.map((
        requirement,
      ) => [requirement.id, requirement]),
    );
    const resolvedRows: CandidateEvaluationRow[] = reuse.resolvedEvaluations
      .map((evaluation) => ({
        investigation_id: invId,
        candidate_id: candidate.id,
        requirement_id: evaluation.requirementId,
        state: evaluation.state,
        confidence: evaluation.confidence,
        explanation: evaluation.explanation,
        evidence_ids: evaluation.evidenceIds,
      }));
    const knownClaims = neutralizeClaimsForModelPrompt(
      mergeEvidenceClaims(
        reuse.knownEvidence.map((e) =>
          e.structuredClaims as StructuredClaimInput[]
        ),
      ),
    );

    // provider facts のコード突合にも、同じsafe Evidence集合と実在IDを全て渡す。
    // 矛盾keyをここで捨てると、researchの片側claimだけでcategorical stateへ戻る。
    // deterministicEvaluations側でpartialへ収束させ、両論のIDを保持する。
    const knownClaimEntries: ClaimWithEvidence[] = reuse.knownEvidence.flatMap(
      (evidence) =>
        evidence.structuredClaims
          .map((claim) => ({
            key: claim.key,
            value: claim.value,
            rawText: formatNeutralSharedClaim(claim),
            evidenceIds: [evidence.id],
          })),
    );
    // address は ClaimKey の正本には含めず places に保持する。place provider の
    // major provider Evidence #0 が実在する場合だけ、同じ Evidence ID を伴う
    // run 内限定の突合入力として住所を渡す。
    if (place.address?.trim()) {
      for (const evidence of reuse.knownEvidence) {
        if (evidence.sourceType !== "major_place_provider") continue;
        knownClaimEntries.push({
          key: "place_address",
          value: place.address,
          rawText: place.address,
          evidenceIds: [evidence.id],
        });
      }
    }

    const logReuse = async (): Promise<void> => {
      if (reuse.resolvedEvaluations.length === 0) return;
      try {
        await logEvent(
          db,
          invId,
          "evidence_reused",
          `${place.name} は蓄積済みEvidenceで ${reuse.resolvedEvaluations.length}/${requirements.length} 条件を判定しました`,
          {
            candidateId: candidate.id,
            count: reuse.resolvedEvaluations.length,
            unresolvedCount: unresolvedRequirements.length,
          },
        );
      } catch {
        // 評価 coverage 成立後の監査ログは best-effort。
      }
    };

    // summary を先に保存し、evaluation の一括 upsert を候補完了の marker にする。
    if (unresolvedRequirements.length === 0) {
      if (opts.updateSummary) {
        const { error } = await db.from("candidates").update({
          summary:
            `${candidate.places.name} は蓄積済みEvidenceから全条件を評価しました。`,
        }).eq("id", candidate.id);
        throwIfDatabaseError(error, "candidates.summary_update");
      }
      await persistCandidateEvaluations(db, resolvedRows);
      await logReuse();
      await refreshPlaceFacts(db, place.id);
      return {
        reusedRequirementCount: resolvedRows.length,
        unresolvedRequirementCount: 0,
        unknownRequirementCount: 0,
        externalResearchAttempted: false,
      };
    }

    // timeout 20 秒。失敗は 1 回だけ retry (§5.4 Hard Rule 4, §30)
    const input: CandidateInvestigationInput = {
      place: {
        name: place.name,
        address: place.address ?? "",
        providerPlaceId: place.provider_place_id,
      },
      // originalTextはstrict判定専用。provider入力へ暗黙に広げず、既存契約の
      // normalized fieldsだけを明示projectする。
      requirements: unresolvedRequirements.map((requirement) => ({
        id: requirement.id,
        normalizedText: requirement.normalizedText,
        kind: requirement.kind,
        priority: requirement.priority,
      })),
      knownClaims,
    };
    let research: GroundedCandidateInvestigation | null = null;
    let lastError = "";
    for (
      let attempt = 0;
      attempt < CANDIDATE_PROVIDER_MAX_ATTEMPTS && !research;
      attempt++
    ) {
      try {
        const raw = await withAbortTimeout(
          (signal) => ai.investigateCandidate(input, signal),
          CANDIDATE_PROVIDER_ATTEMPT_TIMEOUT_MS,
          opts.signal,
        );
        throwIfAborted(opts.signal);
        const check = groundedCandidateInvestigationSchema.safeParse(raw);
        if (check.success) {
          const references = validateGroundedCandidateReferences(
            check.data,
            unresolvedRequirementIds,
          );
          if (references.ok) {
            research = check.data;
          } else {
            lastError = `reference_invalid:${references.reason}`;
          }
        } else lastError = check.error.message.slice(0, 300);
      } catch (e) {
        throwIfAborted(opts.signal);
        lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }

    if (!research) {
      // 外部失敗だけは未解決条件を unknown にし、再利用済み評価と同じ一回の
      // candidate upsert へ統合する。途中 coverage を作らない。#459の予算・
      // 時間帯code突合がsafeな既知claimで成立する行だけはAI失敗時も上書きする。
      const unknownRows: CandidateEvaluationRow[] = unresolvedRequirements.map(
        (requirement) => ({
          investigation_id: invId,
          candidate_id: candidate.id,
          requirement_id: requirement.id,
          state: "unknown",
          confidence: null,
          explanation: "外部調査に失敗したため不明です",
          evidence_ids: [],
        }),
      );
      applyClaimMatchingOverrides(
        unknownRows,
        unresolvedRequirements,
        knownClaimEntries,
      );
      await persistCandidateEvaluations(db, [...resolvedRows, ...unknownRows]);
      await logReuse();
      try {
        await logEvent(
          db,
          invId,
          "candidate_failed",
          `${place.name} の外部調査に失敗したため未解決条件を不明として続行します`,
          { candidateId: candidate.id, message: lastError },
        );
      } catch {
        // evaluation coverage は成立済み。監査ログは best-effort。
      }
      return {
        reusedRequirementCount: resolvedRows.length,
        unresolvedRequirementCount: unresolvedRequirements.length,
        unknownRequirementCount: unknownRows.filter((row) =>
          row.state === "unknown"
        ).length,
        externalResearchAttempted: true,
      };
    }

    // 実行した検索 query を監査ログとして保存 (§5.4 Search Log)。thought は保存しない
    try {
      await logEvent(
        db,
        invId,
        "search_executed",
        `${place.name} を調査しました`,
        {
          candidateId: candidate.id,
          searchQueries: research.searchQueries,
          // Web Research の歩留まり (#514)。全 unknown のとき Serper / fetch /
          // 評価のどこで落ちたかを、本文や URL を出さずに切り分けるための件数
          ...(research.diagnostics ? { research: research.diagnostics } : {}),
          citationCount: research.citations.length,
          findingCount: research.findings.length,
        },
      );
    } catch {
      // 検索結果の保存処理は続行する。監査ログは副次書込み。
    }

    // citation に存在する URL だけを Evidence として採用 (§5)
    const citationUrls = new Set(research.citations.map((c) => c.url));
    const citationTitles = new Map<string, string | null>();
    for (
      const citation of [...research.citations].sort((a, b) =>
        compareCodeUnits(a.url, b.url) ||
        compareCodeUnits(a.title ?? "", b.title ?? "")
      )
    ) {
      if (!citationTitles.has(citation.url)) {
        citationTitles.set(citation.url, citation.title);
      }
    }
    const sharedByUrl = new Map<string, EvidenceClaimReference>();
    const neutralCitationByRequirement = new Map<
      string,
      Map<string, EvidenceClaimReference>
    >();

    // providerが同一requirementを重複返した場合は先頭だけを採用し、Evidence計画と
    // evaluationの双方を同じfinding集合に固定する。別findingの説明を借りない。
    const selectedFindings: GroundedCandidateInvestigation["findings"] = [];
    const selectedRequirementIds = new Set<string>();
    for (const finding of research.findings) {
      if (!unresolvedRequirementIds.has(finding.requirementId)) continue;
      if (selectedRequirementIds.has(finding.requirementId)) continue;
      selectedRequirementIds.add(finding.requirementId);
      selectedFindings.push(finding);
    }

    // shared rowはvalidated structured factsだけをURL単位に集約する。excerpt/rawTextは
    // insert側でkey/value由来の中立表現へ置換し、AI explanationを一切保存しない。
    const sharedPlans = new Map<string, StructuredClaimInput[][]>();
    const neutralCitationPlans: Array<{
      requirementId: string;
      url: string;
    }> = [];
    for (const finding of selectedFindings) {
      // 範囲外confidenceのfindingは評価だけでなくEvidence計画からも破棄する。
      // claimをsharedへ残すと、同じrunの後段や将来runでstrict factとして復活する。
      if (
        !Number.isFinite(finding.confidence) || finding.confidence < 0 ||
        finding.confidence > 1
      ) continue;
      const requirement = unresolvedRequirementById.get(finding.requirementId);
      if (!requirement) continue;
      const validUrls = [
        ...new Set(
          finding.sourceUrls.filter((url) => citationUrls.has(url)),
        ),
      ];
      const deterministicClaims = DETERMINISTIC_SHARED_KINDS.has(
          requirement.kind,
        )
        ? mergeEvidenceClaims([finding.claims]).filter((claim) =>
          isClaimRelevantToRequirement(claim, requirement)
        )
        : [];
      for (const url of validUrls) {
        // claim-level source対応をprovider契約が持たないため、複数URL findingのclaimを
        // 各URLへ複製しない。単一URLかつstrict judge対応claimだけをsharedへ保存する。
        if (validUrls.length === 1 && deterministicClaims.length > 0) {
          const groups = sharedPlans.get(url) ?? [];
          groups.push(deterministicClaims);
          sharedPlans.set(url, groups);
        }
        if (
          !DETERMINISTIC_SHARED_KINDS.has(requirement.kind) &&
          validUrls.length === 1
        ) {
          neutralCitationPlans.push({
            requirementId: finding.requirementId,
            url,
          });
        }
      }
    }

    for (const url of [...sharedPlans.keys()].sort()) {
      const claims = mergeEvidenceClaims(sharedPlans.get(url)!);
      if (claims.length === 0) continue;
      const evidence = await insertEvidenceReferenceIfStale(
        db,
        place.id,
        url,
        citationTitles.get(url) ?? url,
        null,
        claims,
        citationTitles.get(url) ?? url,
        "model-neutral",
        undefined,
        ai,
      );
      if (evidence) sharedByUrl.set(url, evidence);
    }
    for (
      const plan of neutralCitationPlans.sort((a, b) =>
        compareCodeUnits(a.requirementId, b.requirementId) ||
        compareCodeUnits(a.url, b.url)
      )
    ) {
      const evidence = await insertEvidenceReferenceIfStale(
        db,
        place.id,
        plan.url,
        citationTitles.get(plan.url) ?? plan.url,
        null,
        [],
        citationTitles.get(plan.url) ?? plan.url,
        "model-neutral",
        undefined,
        ai,
      );
      if (!evidence) continue;
      const byUrl = neutralCitationByRequirement.get(plan.requirementId) ??
        new Map();
      byUrl.set(plan.url, evidence);
      neutralCitationByRequirement.set(plan.requirementId, byUrl);
    }

    // requirement_evaluations 保存 (§30 の破棄ルールを適用。guardEvaluation は純関数として単体テスト済み)
    const researchedByRequirement = new Map<string, CandidateEvaluationRow>();
    for (const finding of selectedFindings) {
      const requirement = unresolvedRequirementById.get(finding.requirementId);
      if (!requirement) continue;
      const guarded = guardEvaluation(
        finding,
        requirement,
        citationUrls,
        {
          placeId: place.id,
          sharedByUrl,
          neutralCitationByRequirement,
        },
      );
      researchedByRequirement.set(finding.requirementId, {
        investigation_id: invId,
        candidate_id: candidate.id,
        requirement_id: finding.requirementId,
        state: guarded.state,
        confidence: guarded.confidence,
        explanation: guarded.explanation,
        evidence_ids: guarded.evidenceIds,
      });
    }

    // 評価が返らなかった requirement は unknown で埋め、入力 requirement 順を保つ (§31)
    const researchedRows: CandidateEvaluationRow[] = unresolvedRequirements
      .map((requirement) =>
        researchedByRequirement.get(requirement.id) ?? {
          investigation_id: invId,
          candidate_id: candidate.id,
          requirement_id: requirement.id,
          state: "unknown" as const,
          confidence: null,
          explanation: "公開情報からは確認できませんでした",
          evidence_ids: [],
        }
      );

    // 予算・時間帯のコード突合 (#312): research が返した claim も、実在 citation に
    // 対応するactual Evidence idを持つものだけ入力に加える。findingが複数URLを
    // 引用した場合や、保存行がfinding自身のclaimを含まない場合はfail-closed。
    const researchClaimEntries: ClaimWithEvidence[] = selectedFindings
      .flatMap((finding) => {
        if (
          !Number.isFinite(finding.confidence) || finding.confidence < 0 ||
          finding.confidence > 1
        ) return [];
        const requirement = unresolvedRequirementById.get(
          finding.requirementId,
        );
        if (!requirement) return [];
        const validUrls = [
          ...new Set(
            finding.sourceUrls.filter((url) => citationUrls.has(url)),
          ),
        ];
        if (validUrls.length !== 1) return [];
        const evidence = sharedByUrl.get(validUrls[0]);
        if (!evidence) return [];
        const claims = mergeEvidenceClaims([finding.claims]).filter((claim) =>
          isClaimRelevantToRequirement(claim, requirement)
        );
        if (
          claims.length === 0 ||
          !evidenceContainsAllClaims(evidence.structuredClaims, claims)
        ) return [];
        return claims.map((claim) => ({
          key: claim.key,
          value: claim.value,
          rawText: formatNeutralSharedClaim(claim),
          evidenceIds: [evidence.id],
        }));
      });
    applyClaimMatchingOverrides(researchedRows, unresolvedRequirements, [
      ...knownClaimEntries,
      ...researchClaimEntries,
    ]);

    // summary / Evidence の永続化が全て成功してから、全条件を一度に upsertする。
    // この upsert が coverage 完了 marker なので、前段失敗時は次回同候補を再処理する。
    if (opts.updateSummary) {
      const { error } = await db.from("candidates").update({
        summary: research.summary,
      }).eq(
        "id",
        candidate.id,
      );
      throwIfDatabaseError(error, "candidates.summary_update");
    }
    await persistCandidateEvaluations(db, [...resolvedRows, ...researchedRows]);
    await logReuse();

    // 候補 commit 後に place_facts を更新 (§44.5 / issue #104)。
    // shared Evidence + §15 矛盾検出結果からの決定論集約。失敗しても候補 commit は成立済み
    await refreshPlaceFacts(db, place.id);
    return {
      reusedRequirementCount: resolvedRows.length,
      unresolvedRequirementCount: unresolvedRequirements.length,
      unknownRequirementCount: researchedRows.filter((row) =>
        row.state === "unknown"
      ).length,
      externalResearchAttempted: true,
    };
  } catch (e) {
    try {
      await logEvent(
        db,
        invId,
        "candidate_failed",
        `${place.name} の調査処理が失敗しました。再試行します`,
        {
          candidateId: candidate.id,
          message: e instanceof Error ? e.message : String(e),
        },
      );
    } catch {
      // 元の技術エラーを保持する。
    }
    throw e;
  }
}

interface RankingCandidateDbRow {
  id: string;
  place_id: string;
  created_at: string;
  places: { embedding: string | null } | { embedding: string | null }[] | null;
}

interface RankingEvidenceDbRow {
  id: string;
  scope: EvidenceScope;
  investigation_id: string | null;
  place_id: string;
  source_url: string;
  source_type: string;
  source_title: string | null;
  excerpt: string | null;
  source_quality: number | null;
  observed_at: string;
  structured_claims: unknown;
  embedding: string | null;
}

interface RankingEvaluationDbRow {
  id: string;
  candidate_id: string;
  requirement_id: string;
  state: RankingEvaluation["state"];
  confidence: number | null;
  explanation: string | null;
  evidence_ids: unknown;
}

interface RankingVoteDbRow {
  candidate_id: string;
  value: number;
}

interface RankingEvaluationCommit {
  id: string;
  candidate_id: string;
  requirement_id: string;
  state: RankingEvaluation["state"];
  confidence: number;
  explanation: string | null;
  evidence_ids: string[];
}

interface RankingCandidateCommit {
  id: string;
  score: number;
  rank: number;
  cons: unknown[];
  pros: string[];
  conflict_count: number;
}

/**
 * rankInvestigation のDB round-trip上限。候補数・要件数に依存しない。
 * investigations / requirements / recall / members / candidates / evidence /
 * evaluations / votes の8 bulk read + 1 commit RPCで構成する。
 */
export const RANKING_BULK_QUERY_COUNT = 9;
const RANKING_EMPTY_QUERY_COUNT = 6;

// 矛盾検出 (§15) + score 計算 (§17) + rank 更新。常に全候補を再計算する冪等処理。
// Evidence/evaluation/voteを候補ごとに読まず、最後の変更を1 RPCへ束ねる (#608)。
export async function rankInvestigation(
  db: SupabaseClient,
  invId: string,
  finalCandidateLimit?: number,
): Promise<void> {
  const { data: inv, error: invError } = await db.from("investigations")
    .select("embedding, raw_query").eq("id", invId).single();
  throwIfDatabaseError(invError, "investigations.ranking_select");
  if (typeof inv?.raw_query !== "string") {
    throw new DatabaseOperationError(
      "investigations.ranking_select",
      "investigation raw_query is missing",
    );
  }
  const invEmbedding = parseRankingVector(inv?.embedding, "investigation");

  const { data: reqRows, error: reqError } = await db
    .from("requirements")
    .select("id, kind, priority, weight, embedding, normalized_text, text")
    .eq("investigation_id", invId);
  throwIfDatabaseError(reqError, "requirements.ranking_select");
  const requirementRows = (reqRows ?? []) as unknown as Array<{
    id: string;
    kind: string | null;
    priority: string | null;
    weight: number | null;
    embedding: string | null;
    normalized_text: string | null;
    text: string | null;
  }>;
  const requirements: RankingRequirement[] = requirementRows.map((r) => ({
    id: r.id,
    priority: (r.priority ?? "should") as RankingRequirement["priority"],
    weight: r.weight ?? 0.5,
  }));
  const requirementRowById = new Map(
    requirementRows.map((row) => [row.id, row]),
  );
  const sourceByReq = new Map(
    requirementRows.map((r) => {
      const text = typeof r.text === "string" ? r.text : "";
      const normalizedText = typeof r.normalized_text === "string"
        ? r.normalized_text
        : text;
      return [
        r.id,
        resolveRequirementSource({
          storedKind: typeof r.kind === "string" ? r.kind : null,
          text,
          normalizedText,
          rawQuery: inv.raw_query,
        }),
      ] as const;
    }),
  );
  const kindByReq = new Map(
    [...sourceByReq].map(([id, source]) => [id, source.kind]),
  );
  const verifiedSourceByReq = new Map(
    [...sourceByReq].map(([id, source]) => [id, source.sourceAttested]),
  );

  // requirement.embedding はAI計算だけを候補loop外で行い、DB反映はcommit RPCへ束ねる。
  // 既存embeddingは再利用し、失敗時はsemantic_matchの既存fallbackへ進む。
  const { ai } = getProviders();
  const requirementEmbeddings: number[][] = [];
  const requirementEmbeddingUpdates: Array<
    { id: string; embedding: number[] }
  > = [];
  for (const r of requirementRows) {
    if (verifiedSourceByReq.get(r.id) !== true) continue;
    let vec = parseRankingVector(r.embedding, "requirement");
    if (!vec) {
      const text = typeof r.normalized_text === "string"
        ? r.normalized_text
        : r.text;
      if (typeof text === "string" && text.length > 0) {
        try {
          const [v] = await ai.embed([text]);
          const checked = validateEmbedding(v);
          if (checked.ok) {
            vec = checked.value;
            requirementEmbeddingUpdates.push({
              id: r.id,
              embedding: checked.value,
            });
          } else {
            logInvalidEmbedding(
              "provider_ingress",
              "requirement",
              checked.reason,
            );
          }
        } catch {
          // embedding 無しでも続行
        }
      }
    }
    if (vec) requirementEmbeddings.push(vec);
  }

  // 過去グループ嗜好 (issue #105): recalling step が保存した recall_preference event を読む。
  // run / rerank の両経路がこの関数を通るため、加点の源はここで一元化される
  const { data: recallEvent, error: recallError } = await db
    .from("investigation_events")
    .select("metadata")
    .eq("investigation_id", invId)
    .eq("event_type", "recall_preference")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwIfDatabaseError(recallError, "investigation_events.recall_select");
  const recallPrefs: RecallPlacePreference[] = (
    ((recallEvent?.metadata as { places?: unknown[] } | null)?.places ??
      []) as Array<
        { placeId?: unknown; avgVote?: unknown; similarity?: unknown }
      >
  )
    .filter((p) =>
      typeof p.placeId === "string" && typeof p.avgVote === "number" &&
      typeof p.similarity === "number"
    )
    .map((p) => ({
      placeId: p.placeId as string,
      avgVote: p.avgVote as number,
      similarity: p.similarity as number,
    }));

  const { count: memberCount, error: memberCountError } = await db
    .from("investigation_members")
    .select("user_id", { count: "exact", head: true })
    .eq("investigation_id", invId);
  throwIfDatabaseError(memberCountError, "investigation_members.count");

  const { data: candidates, error: candidatesError } = await db
    .from("candidates")
    .select("id, place_id, created_at, places (embedding)")
    .eq("investigation_id", invId);
  throwIfDatabaseError(candidatesError, "candidates.ranking_select");
  const candidateRows =
    (candidates ?? []) as unknown as RankingCandidateDbRow[];
  const candidateIds = candidateRows.map((candidate) => candidate.id);
  const placeIds = [
    ...new Set(candidateRows.map((candidate) => candidate.place_id)),
  ];

  // 候補に紐づく3テーブルをまとめて取得する。空候補だけは不要なDB round-tripを省く。
  let evidenceRows: RankingEvidenceDbRow[] = [];
  let evaluationRows: RankingEvaluationDbRow[] = [];
  let voteRows: RankingVoteDbRow[] = [];
  if (candidateIds.length > 0) {
    const [evidenceResult, evaluationsResult, votesResult] = await Promise.all([
      db.from("evidence")
        .select(
          "id, scope, investigation_id, place_id, source_url, source_type, source_title, excerpt, source_quality, observed_at, structured_claims, embedding",
        )
        .in("place_id", placeIds)
        .or(`scope.eq.shared,investigation_id.eq.${invId}`),
      db.from("requirement_evaluations")
        .select(
          "id, candidate_id, requirement_id, state, confidence, explanation, evidence_ids",
        )
        .eq("investigation_id", invId)
        .in("candidate_id", candidateIds),
      db.from("votes")
        .select("candidate_id, value")
        .eq("investigation_id", invId)
        .in("candidate_id", candidateIds),
    ]);
    throwIfDatabaseError(evidenceResult.error, "evidence.ranking_select");
    throwIfDatabaseError(
      evaluationsResult.error,
      "requirement_evaluations.ranking_select",
    );
    throwIfDatabaseError(votesResult.error, "votes.ranking_select");
    evidenceRows =
      (evidenceResult.data ?? []) as unknown as RankingEvidenceDbRow[];
    evaluationRows =
      (evaluationsResult.data ?? []) as unknown as RankingEvaluationDbRow[];
    voteRows = (votesResult.data ?? []) as unknown as RankingVoteDbRow[];
  }
  const evidenceByPlace = new Map<string, RankingEvidenceDbRow[]>();
  for (const row of evidenceRows) {
    const rows = evidenceByPlace.get(row.place_id) ?? [];
    rows.push(row);
    evidenceByPlace.set(row.place_id, rows);
  }
  const evaluationsByCandidate = new Map<string, RankingEvaluationDbRow[]>();
  for (const row of evaluationRows) {
    const rows = evaluationsByCandidate.get(row.candidate_id) ?? [];
    rows.push(row);
    evaluationsByCandidate.set(row.candidate_id, rows);
  }
  const votesByCandidate = new Map<string, RankingVoteDbRow[]>();
  for (const row of voteRows) {
    const rows = votesByCandidate.get(row.candidate_id) ?? [];
    rows.push(row);
    votesByCandidate.set(row.candidate_id, rows);
  }

  const scored: { id: string; score: number; createdAt: string }[] = [];
  const evaluationUpdates: RankingEvaluationCommit[] = [];
  const candidateCommits: RankingCandidateCommit[] = [];

  for (const c of candidateRows) {
    const usableEvidenceRows = filterEvidenceForInvestigation(
      evidenceByPlace.get(c.place_id) ?? [],
      invId,
    );

    // 矛盾検出 (§15) — コードで行う
    const contradictions = detectCombinedContradictions(
      usableEvidenceRows.map((e) => ({
        id: e.id,
        placeId: c.place_id,
        sourceQuality: e.source_quality ?? 0.4,
        structuredClaims: (e.structured_claims ?? []) as never[],
      })),
    );
    const conflictKeys = contradictedKeys(contradictions);
    const usableEvidenceIds = new Set(
      usableEvidenceRows.map((row) => row.id),
    );
    const evaluations: RankingEvaluation[] = [];
    for (const ev of evaluationsByCandidate.get(c.id) ?? []) {
      let state = ev.state;
      let confidence = ev.confidence ?? 0;
      const kind = kindByReq.get(ev.requirement_id) ?? "other";
      const requirementRow = requirementRowById.get(ev.requirement_id);
      const source = sourceByReq.get(ev.requirement_id);
      const claimRelevanceRequirement = {
        kind,
        originalText: source?.originalText ?? "",
        normalizedText: (typeof requirementRow?.normalized_text === "string"
          ? requirementRow.normalized_text
          : requirementRow?.text) ?? "",
        sourceAttested: source?.sourceAttested ?? false,
      };
      const relevantContradictions = contradictions.filter((contradiction) =>
        isClaimRelevantToRequirement({
          key: contradiction.key,
          value: null,
          rawText: "",
        }, claimRelevanceRequirement)
      );
      const relevantConflictKeys = new Set(
        relevantContradictions.map((contradiction) =>
          contradiction.key
        ),
      );
      const kindIsConflicted = relevantContradictions.length > 0;
      const contradictionEvidenceIds = new Set(
        relevantContradictions.flatMap((contradiction) =>
          contradiction.entries.flatMap((entry) =>
            usableEvidenceIds.has(entry.evidenceId) ? [entry.evidenceId] : []
          )
        ),
      );
      let explanation: string | undefined;
      const originalEvidenceIds = Array.isArray(ev.evidence_ids)
        ? ev.evidence_ids.filter((id: unknown): id is string =>
          typeof id === "string"
        )
        : [];
      let evidenceIds = [...originalEvidenceIds];
      const idsAreUsable = evidenceIds.length > 0 &&
        evidenceIds.every((id) => usableEvidenceIds.has(id));
      if (verifiedSourceByReq.get(ev.requirement_id) !== true) {
        state = "unknown";
        confidence = 0;
        explanation =
          "ユーザー原文に一意な条件記述を確認できないため判定を保留しました";
        evidenceIds = [];
      } else if (state !== "unknown" && !idsAreUsable) {
        state = "unknown";
        confidence = 0;
        explanation =
          "評価に対応する有効なEvidenceを確認できないため判定を保留しました";
        evidenceIds = [];
      } else if (kindIsConflicted) {
        const guarded = state === "unknown"
          ? { state: "partial" as const, confidence: 0.5 }
          : guardRankingMatchAgainstContradictions(
            state,
            confidence,
            kind,
            relevantConflictKeys,
          );
        state = guarded.state;
        confidence = guarded.confidence;
        explanation = "情報源が矛盾するため部分適合として扱います";
        evidenceIds = [...contradictionEvidenceIds].sort(compareCodeUnits);
      } else if (
        idsAreUsable && usesDeterministicSharedClaims(claimRelevanceRequirement)
      ) {
        // 既存evaluationが一部IDしか持たなくても、同じ候補にある全safe rowのうち
        // 当該Requirementへ実際に対応するclaimを再評価する。
        const relevantRows = usableEvidenceRows.flatMap((row) => {
          const claims = filterValidClaims(
            Array.isArray(row.structured_claims)
              ? row.structured_claims as StructuredClaimInput[]
              : [],
          ).filter((claim) =>
            isClaimRelevantToRequirement(claim, claimRelevanceRequirement)
          );
          return claims.length > 0 ? [{ row, claims }] : [];
        });
        const claimEntries: ClaimWithEvidence[] = relevantRows.flatMap(
          ({ row, claims }) =>
            claims.map((claim) => ({ ...claim, evidenceIds: [row.id] })),
        );
        const strictRequirement = {
          id: ev.requirement_id,
          originalText: source?.originalText ?? "",
          normalizedText: (typeof requirementRow?.normalized_text === "string"
            ? requirementRow.normalized_text
            : requirementRow?.text) ?? "",
          kind,
          priority: requirementRow?.priority ?? "should",
        };
        const strict = kind === "time" || kind === "budget"
          ? deterministicEvaluations([strictRequirement], claimEntries).get(
            ev.requirement_id,
          )
          : evaluateFromEvidence(
            [strictRequirement],
            relevantRows.map(({ row, claims }) => ({
              id: row.id,
              sourceUrl: row.source_url,
              sourceQuality: row.source_quality ?? 0.4,
              observedAt: row.observed_at,
              structuredClaims: claims,
            })),
          ).resolvedEvaluations[0];
        if (strict) {
          state = strict.state;
          confidence = strict.confidence;
          explanation = strict.explanation;
          evidenceIds = strict.evidenceIds;
        } else if (state !== "unknown") {
          state = "unknown";
          confidence = 0;
          explanation =
            "Evidenceの内容が条件判定に対応しないため判定を保留しました";
          evidenceIds = [];
        }
      }
      const currentExplanation = typeof ev.explanation === "string"
        ? ev.explanation
        : null;
      const changed = state !== ev.state ||
        confidence !== (ev.confidence ?? 0) ||
        (explanation !== undefined && explanation !== currentExplanation) ||
        JSON.stringify(evidenceIds) !== JSON.stringify(originalEvidenceIds);
      if (changed) {
        if (typeof ev.id !== "string" || ev.id.length === 0) {
          throw new DatabaseOperationError(
            "requirement_evaluations.ranking_select",
            "evaluation id is missing",
          );
        }
        evaluationUpdates.push({
          id: ev.id,
          candidate_id: c.id,
          requirement_id: ev.requirement_id,
          state,
          confidence,
          explanation: explanation === undefined
            ? currentExplanation
            : explanation,
          evidence_ids: evidenceIds,
        });
      }
      evaluations.push({ requirementId: ev.requirement_id, state, confidence });
    }

    // semantic_match 正式版 (§17 / issue #103):
    // requirement.embedding × evidence.embedding 群の cosine 最大値を requirement ごとに取り平均。
    // evidence embedding が無い候補は P0 代用式へフォールバックする。
    const evidenceEmbeddings = usableEvidenceRows
      .map((e) => parseRankingVector(e.embedding, "evidence"))
      .filter((v): v is number[] => v !== null);
    const officialSemantic = semanticMatchScore(
      requirementEmbeddings,
      evidenceEmbeddings,
    );
    const placeEmbedding = parseRankingVector(
      (Array.isArray(c.places) ? c.places[0] : c.places)?.embedding ?? null,
      "place",
    );
    const semanticMatch = officialSemantic ??
      (invEmbedding && placeEmbedding
        ? cosineToUnit(cosineSimilarity(invEmbedding, placeEmbedding))
        : 0);

    const now = new Date();
    const baseScore = computeScore({
      requirements,
      evaluations,
      evidenceQualities: usableEvidenceRows.map((e) => e.source_quality ?? 0.4),
      evidenceFreshness: usableEvidenceRows.map((e) =>
        freshnessScore(new Date(e.observed_at), now)
      ),
      voteValues: (votesByCandidate.get(c.id) ?? []).map((v) => v.value),
      memberCount: memberCount ?? 1,
      semanticMatch,
    });

    // 過去グループ嗜好の独立加点 (issue #105)。§17 の基本式は変えない。
    const bonus = recallBonus(c.place_id, recallPrefs);
    const score = clamp(baseScore + bonus, 0, 1);
    const pros = bonus > 0 ? [recallBonusLine(bonus)] : [];
    candidateCommits.push({
      id: c.id,
      score,
      rank: 0,
      cons: contradictions,
      pros,
      conflict_count: conflictKeys.size,
    });
    scored.push({ id: c.id, score, createdAt: c.created_at });
  }

  // rank: score 降順、同点は created_at 昇順 (§17 最終処理)
  const ranks = assignRanks(scored);
  for (const candidate of candidateCommits) {
    const rank = ranks.get(candidate.id);
    if (rank === undefined) {
      throw new DatabaseOperationError(
        "candidates.ranking_select",
        "rank missing for candidate",
      );
    }
    candidate.rank = rank;
  }

  // A future policy may investigate a larger durable pool, but the product
  // contract and public result remain Top 3. Delete only losing rows after
  // deterministic ranking; Evidence remains canonical by place.
  const finalLimit = typeof finalCandidateLimit === "number" &&
      Number.isInteger(finalCandidateLimit) && finalCandidateLimit >= 1
    ? finalCandidateLimit
    : null;
  const discardedIds = finalLimit !== null && ranks.size > finalLimit
    ? [...ranks.entries()]
      .filter(([, rank]) => rank > finalLimit)
      .map(([id]) => id)
    : [];
  const finalCount = finalLimit === null
    ? scored.length
    : Math.min(scored.length, finalLimit);
  const queryCount = candidateIds.length > 0
    ? RANKING_BULK_QUERY_COUNT
    : RANKING_EMPTY_QUERY_COUNT;

  // evaluation / score / rank / Top 3削除 / ranking event を1 transactionへ束ねる。
  // RPCがエラーまたはcancelされた場合は全変更とeventがrollbackされる。
  const { data: commitData, error: commitError } = await db.rpc(
    "persist_investigation_ranking",
    {
      p_investigation_id: invId,
      p_requirement_embeddings: requirementEmbeddingUpdates,
      p_evaluations: evaluationUpdates,
      p_candidates: candidateCommits,
      p_discarded_candidate_ids: discardedIds,
      p_final_count: finalCount,
      p_research_pool_count: scored.length,
      p_db_query_count: queryCount,
    },
  );
  throwIfDatabaseError(commitError, "ranking.commit");
  const metrics = commitData as
    | {
      queryCount?: unknown;
      updatedRows?: unknown;
      latencyMs?: unknown;
    }
    | null
    | undefined;
  if (
    metrics === null || metrics === undefined ||
    typeof metrics.queryCount !== "number" ||
    !Number.isInteger(metrics.queryCount) ||
    metrics.queryCount !== queryCount ||
    typeof metrics.updatedRows !== "number" ||
    !Number.isFinite(metrics.updatedRows) ||
    metrics.updatedRows < 0 ||
    typeof metrics.latencyMs !== "number" ||
    !Number.isFinite(metrics.latencyMs) ||
    metrics.latencyMs < 0
  ) {
    throw new DatabaseOperationError(
      "ranking.commit",
      "ranking commit returned invalid metrics",
    );
  }
}

export function parseVector(raw: string | null | undefined): number[] | null {
  return parseEmbeddingVector(raw);
}
