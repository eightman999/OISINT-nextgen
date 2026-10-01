import { supabase } from '@/lib/supabase';
import { z } from 'zod';
import type { Session } from '@supabase/supabase-js';
import {
  apiErrorSchema,
  createInvestigationResponseSchema,
  joinInvestigationResponseSchema,
  rerankInvestigationResponseSchema,
  runInvestigationResponseSchema,
} from '@/lib/validation';
import type {
  Candidate,
  CreateInvestigationRequest,
  CreateInvestigationResponse,
  Evidence,
  Investigation,
  InvestigationEvent,
  InvestigationListener,
  InvestigationPreview,
  InvestigationStatus,
  JoinInvestigationRequest,
  JoinInvestigationResponse,
  PlaceFact,
  PlaceFeedback,
  PlaceFeedbackAspect,
  PlaceFeedbackInput,
  PlaceFeedbackSummary,
  PublicCandidate,
  PublicInvestigation,
  Requirement,
  RerankInvestigationRequest,
  RerankInvestigationResponse,
  RunInvestigationRequest,
  RunInvestigationResponse,
  StructuredClaim,
  VoteValue,
} from '@/types';

import type { DataProvider } from './types';
import {
  normalizePlaceFeedbackInput,
  PLACE_FEEDBACK_ASPECTS,
  isCanonicalPlaceFeedbackValue,
  sanitizePlaceFeedbackSummary,
} from '@/lib/placeFeedback';
import { normalizeTrustedOrigin } from '@/lib/trustedOrigins';
import {
  assertInvestigationReadSucceeded,
  buildVoteMutationRow,
  filterProviderLinkedEvidence,
  isPlaceDisplayable,
  mapActiveRestaurantImageKeys,
  mapCandidateRow,
  mapInvestigationMember,
  type CandidateRow,
  type EvaluationRow,
  type InvestigationMemberRow,
  type VoteRow,
} from './liveMapping';

// ============================================================
// 認証（spec.md §19: 匿名サインイン）
// ============================================================

let sessionPromise: Promise<Session> | null = null;

/**
 * getSession/signInAnonymously の結果を一つのsession値として扱う。
 * createではこの戻り値からsubjectとaccess_tokenを同時にsnapshotする。
 */
async function ensureAuthSession(): Promise<Session> {
  const { data } = await supabase.auth.getSession();
  if (data.session?.user) return data.session;

  if (!sessionPromise) {
    sessionPromise = supabase.auth.signInAnonymously().then(({ data: anon, error }) => {
      if (error || !anon.session) {
        throw new Error(`匿名サインインに失敗しました: ${error?.message ?? 'unknown'}`);
      }
      return anon.session;
    });
  }

  try {
    return await sessionPromise;
  } finally {
    // Only deduplicate concurrent creation. A resolved user ID must not survive logout/account switch.
    sessionPromise = null;
  }
}

async function ensureUserId(): Promise<string> {
  return (await ensureAuthSession()).user.id;
}

// ============================================================
// 書き込み系 API: Cloudflare Worker (api.oisint.com) 経由
// issue #101 / docs/api/README.md
//   - 認証・Realtime・読み取り(PostgREST)は引き続き Supabase JS client
//   - 書き込み・調査実行・参加は https://api.oisint.com/v1/* を使う
// ============================================================

const API_BASE_URL = normalizeTrustedOrigin(
  process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oisint.com',
  'api',
);
/**
 * Client-side response budgets are endpoint contracts, not a single transport
 * default.  The research endpoint only acknowledges enqueueing, while create
 * and requirement-added rerank still await provider work on the server.
 */
export const EDGE_TIMEOUT_CONTRACT = {
  receipt: 5_000,
  synchronousCreate: 10_000,
  synchronousRerank: 155_000,
} as const;
export const WORKER_TIMEOUT_CONTRACT = {
  receipt: 10_000,
  synchronousCreate: 14_000,
  synchronousRerank: 180_000,
} as const;
export const API_TIMEOUT_POLICY = {
  receipt: 15_000,
  synchronousCreate: 15_000,
  synchronousRerank: 210_000,
} as const;
type ApiTimeoutPolicy = keyof typeof API_TIMEOUT_POLICY;
const MAX_API_RESPONSE_BYTES = 128 * 1024;

/** JWT付きWorker応答を上限付きstreamとして読む。text()の全読込は許可しない。 */
export async function readLiveAPIResponseText(
  response: Response,
  maxBytes = MAX_API_RESPONSE_BYTES,
): Promise<string> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > limit) {
      throw new Error('API応答のサイズが不正です');
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('API応答ストリームを利用できません');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('API応答が大きすぎます');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('API応答')) throw error;
    throw new Error('API応答を読み取れません');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('API応答を解釈できません');
  }
}

const feedbackMutationResponseSchema = z.object({ feedbackId: z.string().min(1) }).strict();
const visibilityResponseSchema = z.object({ visibility: z.enum(['private', 'public']) }).strict();

async function callApi(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: object,
  timeoutPolicy: ApiTimeoutPolicy = 'receipt',
  idempotencyKey?: string,
  expectedSubject?: string,
): Promise<unknown> {
  if (!API_BASE_URL) {
    throw new Error('Live API の接続先が許可されていません');
  }
  const snapshot = await snapshotAuthSession();
  if (expectedSubject !== undefined) {
    const bearerSubject = readJwtSubject(snapshot.accessToken);
    if (
      expectedSubject !== snapshot.subject ||
      bearerSubject === undefined ||
      bearerSubject !== expectedSubject
    ) {
      throw new AuthIdentityChangedError();
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    API_TIMEOUT_POLICY[timeoutPolicy],
  );
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${snapshot.accessToken}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) throw new ApiRequestError('API応答がタイムアウトしました', 408);
    throw error;
  }

  let text: string;
  try {
    text = await readLiveAPIResponseText(res);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiRequestError('API応答がタイムアウトしました', 408);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // JSON 以外はそのまま扱う
  }

  if (!res.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    const message = parsedError.success ? parsedError.data.error : `API エラー (${res.status})`;
    throw new ApiRequestError(message, res.status);
  }

  return payload;
}

/** create開始時点の同一sessionからsubjectとBearer tokenを取得する値型。 */
export interface AuthSessionSnapshot {
  subject: string;
  accessToken: string;
}

/** Homeが保持する旧subjectと、送信直前のJWT subjectが異なる場合のfail-closed。 */
export class AuthIdentityChangedError extends Error {
  constructor() {
    super('認証状態が切り替わったため、調査作成を中止しました');
    this.name = 'AuthIdentityChangedError';
  }
}

async function snapshotAuthSession(): Promise<AuthSessionSnapshot> {
  // 既存sessionまたは匿名bootstrapの返却値から、subjectとaccess_tokenを
  // 同一session値で採用する。別々のauth取得結果を組み合わせない。
  const session = await ensureAuthSession();
  if (!session.user?.id || !session.access_token) {
    throw new Error('認証セッションがありません');
  }
  const jwtSubject = readJwtSubject(session.access_token);
  // 開発用fixtureなどJWT形状でないtokenはsubject検証を行えないため、
  // expectedSubjectを指定したcreateではcallApi側でfail closedする。
  if (jwtSubject !== undefined && jwtSubject !== session.user.id) {
    throw new AuthIdentityChangedError();
  }
  return { subject: session.user.id, accessToken: session.access_token };
}

function readJwtSubject(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded =
      typeof globalThis.atob === 'function'
        ? globalThis.atob(padded)
        : undefined;
    if (!decoded) return undefined;
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown };
    return typeof value.sub === 'string' && value.sub.length > 0 ? value.sub : undefined;
  } catch {
    return undefined;
  }
}

/** HTTP statusが得られない失敗は受付結果不明としてUIが再利用経路へ収束できる。 */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

// ============================================================
// DB 行 → フロント型のマッピング（supabase/migrations/0002_tables.sql）
// ============================================================

interface RequirementRow {
  id: string;
  text: string;
  normalized_text: string | null;
  kind: string | null;
  priority: string | null;
  weight: number | null;
}

interface EvidenceRow {
  id: string;
  place_id: string;
  investigation_id: string | null;
  scope: string;
  source_type: string;
  source_url: string;
  source_title: string | null;
  excerpt: string | null;
  structured_claims: unknown;
  observed_at: string;
  source_quality: number | null;
  freshness_score: number | null;
  provider_link_id?: string | null;
}

interface InvestigationRow {
  id: string;
  title: string;
  status: string;
  share_token: string;
  visibility?: string | null;
  created_at: string;
  updated_at: string;
}

interface OwnerRawQueryRow {
  raw_query: string;
}

interface OwnerPlaceCoordinatesRow {
  place_id: string;
  lat: number | null;
  lng: number | null;
}

// get_investigation_preview RPC の行（supabase/migrations/0020_share_preview.sql）
interface InvestigationPreviewRow {
  title: string;
  status: string;
  member_count: number;
}

interface InvestigationEventRow {
  id: string;
  investigation_id: string;
  event_type: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// 調査ログの取得上限（issue #332）。再実行を重ねても直近の動きを失わない値に留める
const INVESTIGATION_EVENT_LIMIT = 50;

function mapInvestigationEvent(row: InvestigationEventRow): InvestigationEvent {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    eventType: row.event_type,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function mapRequirement(row: RequirementRow): Requirement {
  return {
    id: row.id,
    text: row.text,
    normalizedText: row.normalized_text ?? row.text,
    kind: (row.kind ?? 'other') as Requirement['kind'],
    priority: (row.priority ?? 'should') as Requirement['priority'],
    weight: row.weight ?? 0.5,
    userAdded: row.kind === null,
  };
}

function mapEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    placeId: row.place_id,
    ...(typeof row.provider_link_id === 'string' ? { providerLinkId: row.provider_link_id } : {}),
    investigationId: row.investigation_id,
    scope: (row.scope === 'investigation' ? 'investigation' : 'shared'),
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title ?? undefined,
    excerpt: row.excerpt ?? '',
    structuredClaims: Array.isArray(row.structured_claims)
      ? (row.structured_claims as StructuredClaim[])
      : [],
    observedAt: row.observed_at,
    sourceQuality: row.source_quality ?? 0,
    freshnessScore: row.freshness_score ?? 0,
  };
}

// place_facts 行（supabase/migrations/0007_p1_accumulation.sql:15-24）。
// 列は place_id / key / value / confidence / evidence_count / conflicting / last_verified_at のみ
// （user_id / investigation_id 無し。共有資産 §33）。
interface PlaceFactRow {
  place_id: string;
  key: string;
  value: unknown;
  confidence: number | null;
  evidence_count: number | null;
  conflicting: boolean | null;
  last_verified_at: string;
}

interface PlaceFeedbackRow {
  id: string;
  place_id: string;
  visited_at: string | null;
  rating: PlaceFeedback['rating'] | null;
  aspect: PlaceFeedbackAspect | null;
  aspect_value: string | null;
  created_at: string | null;
}

interface PlaceFeedbackSummaryRow {
  place_id: string;
  visited_count: number | null;
  rating_count: number | null;
  rating_avg: number | null;
  aspects: unknown;
}

function mapPlaceFact(row: PlaceFactRow): PlaceFact {
  return {
    placeId: row.place_id,
    key: row.key,
    value: row.value,
    confidence: row.confidence ?? 0,
    evidenceCount: row.evidence_count ?? 0,
    conflicting: row.conflicting === true,
    lastVerifiedAt: row.last_verified_at,
  };
}

function mapPlaceFeedback(row: PlaceFeedbackRow): PlaceFeedback {
  return {
    id: row.id,
    placeId: row.place_id,
    ...(row.visited_at ? { visitedAt: row.visited_at } : {}),
    ...(row.rating !== null ? { rating: row.rating as PlaceFeedback['rating'] } : {}),
    ...(row.aspect ? { aspect: row.aspect } : {}),
    ...(row.aspect_value ? { aspectValue: row.aspect_value } : {}),
    ...(row.created_at ? { createdAt: row.created_at } : {}),
  };
}

function mapPlaceFeedbackSummary(row: PlaceFeedbackSummaryRow): PlaceFeedbackSummary {
  const aspects = Array.isArray(row.aspects)
    ? row.aspects.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        const aspect = value.aspect;
        const aspectValue = value.aspect_value;
        const count = value.count;
        if (
          typeof aspect !== 'string' ||
          !PLACE_FEEDBACK_ASPECTS.some((option) => option.value === aspect) ||
          typeof aspectValue !== 'string' ||
          !isCanonicalPlaceFeedbackValue(aspect, aspectValue) ||
          typeof count !== 'number' ||
          !Number.isInteger(count)
        ) {
          return [];
        }
        return [{
          aspect: aspect as PlaceFeedbackAspect,
          aspectValue,
          count,
        }];
      })
    : [];
  return sanitizePlaceFeedbackSummary({
    placeId: row.place_id,
    visitedCount: row.visited_count ?? 0,
    ratingCount: row.rating_count ?? 0,
    ratingAverage: row.rating_avg,
    aspects,
  });
}

async function fetchInvestigation(id: string): Promise<Investigation | undefined> {
  const [
    invRes,
    reqRes,
    candRes,
    evalRes,
    voteRes,
    memberRes,
    ownerQueryRes,
    ownerCoordinatesRes,
    imageCatalogRes,
  ] =
    await Promise.all([
      // raw_query は列権限で authenticated から剥奪済み (#151)。owner は専用 RPC
      // から取得し、通常の member/public read は safe columns に限定する。
      supabase
        .from('investigations')
        .select('id, title, status, share_token, visibility, created_at, updated_at')
        .eq('id', id)
        .maybeSingle(),
      supabase.from('requirements').select('*').eq('investigation_id', id),
      supabase
        .from('candidates')
        // places.lat/lng は owner 専用 RPC でのみ補完する。joined member/public の
        // PostgREST response に精密座標を含めない (#151 / spec.md §33)。
        .select('id, investigation_id, place_id, score, rank, summary, pros, cons, discovery_context, places (id, name, address, metadata, fallback_image_key, place_provider_links (id, provider, storage_policy, expires_at, attribution_policy))')
        .eq('investigation_id', id),
      supabase.from('requirement_evaluations').select('*').eq('investigation_id', id),
      supabase.from('votes').select('candidate_id, user_id, value, comment').eq('investigation_id', id),
      supabase.rpc('get_investigation_members', { inv: id }),
      supabase.rpc('get_investigation_owner_raw_query', { p_investigation: id }),
      supabase.rpc('get_investigation_owner_place_coordinates', { p_investigation: id }),
      supabase
        .from('restaurant_image_catalog')
        .select('image_key')
        .eq('active', true),
    ]);

  assertInvestigationReadSucceeded([
    { label: 'investigation', error: invRes.error },
    { label: 'requirements', error: reqRes.error },
    { label: 'candidates', error: candRes.error },
    { label: 'evaluations', error: evalRes.error },
    { label: 'votes', error: voteRes.error },
    { label: 'members', error: memberRes.error },
    { label: 'owner_query', error: ownerQueryRes.error },
    { label: 'owner_coordinates', error: ownerCoordinatesRes.error },
  ]);

  const inv = invRes.data as InvestigationRow | null;
  if (!inv) return undefined;

  const ownerQuery = ((ownerQueryRes.data ?? []) as OwnerRawQueryRow[])[0]?.raw_query ?? '';
  const ownerCoordinates = new Map(
    ((ownerCoordinatesRes.data ?? []) as OwnerPlaceCoordinatesRow[]).map((row) => [
      row.place_id,
      { lat: row.lat, lng: row.lng },
    ])
  );

  // Shared Evidence is deliberately stored with investigation_id = NULL. Fetch it by the
  // candidate place IDs as well as investigation-scoped rows; filtering only by investigation_id
  // makes every live candidate appear to have no sources.
  const candidateRows = ((candRes.data ?? []) as unknown as CandidateRow[]).map((row) => {
    const coordinate = ownerCoordinates.get(row.place_id);
    if (!row.places || !coordinate) return row;
    return {
      ...row,
      places: {
        ...row.places,
        lat: coordinate.lat,
        lng: coordinate.lng,
      },
    };
  });
  const displayableCandidateRows = candidateRows.filter((row) => isPlaceDisplayable(row.places));
  const placeIds = [...new Set(displayableCandidateRows.map((row) => row.place_id))];
  const sharedEvidenceQuery = placeIds.length
    ? supabase
        .from('evidence')
        .select('*')
        .eq('scope', 'shared')
        .is('investigation_id', null)
        .in('place_id', placeIds)
    : Promise.resolve({ data: [] as unknown[], error: null });
  const [sharedEvidenceRes, scopedEvidenceRes] = await Promise.all([
    sharedEvidenceQuery,
    supabase.from('evidence').select('*').eq('investigation_id', id),
  ]);
  assertInvestigationReadSucceeded([
    { label: 'shared_evidence', error: sharedEvidenceRes.error },
    { label: 'scoped_evidence', error: scopedEvidenceRes.error },
  ]);
  const evidenceRows = [
    ...((sharedEvidenceRes.data ?? []) as EvidenceRow[]),
    ...((scopedEvidenceRes.data ?? []) as EvidenceRow[]),
  ]
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index)
    .map(mapEvidence);

  const requirements = ((reqRes.data ?? []) as RequirementRow[]).map(mapRequirement);
  const evaluations = (evalRes.data ?? []) as EvaluationRow[];
  const votes = (voteRes.data ?? []) as VoteRow[];
  const activeRestaurantImageKeys = mapActiveRestaurantImageKeys(
    imageCatalogRes.data,
    Boolean(imageCatalogRes.error)
  );

  const members = ((memberRes.data ?? []) as InvestigationMemberRow[])
    .map(mapInvestigationMember);

  const candidates: Candidate[] = displayableCandidateRows
    .map((row) =>
      mapCandidateRow(
        row,
        filterProviderLinkedEvidence(row.places, evidenceRows),
        evaluations,
        votes,
        activeRestaurantImageKeys,
        requirements,
      )
    )
    .sort((a, b) => (a.rank || 99) - (b.rank || 99));

  return {
    id: inv.id,
    title: inv.title,
    status: inv.status as InvestigationStatus,
    // member/public の RPC は 0 行なので空文字。owner のみ生の依頼文を取得できる。
    rawQuery: ownerQuery,
    requirements,
    candidates,
    members,
    shareToken: inv.share_token,
    visibility: inv.visibility === 'public' ? 'public' : 'private',
    createdAt: inv.created_at,
    updatedAt: inv.updated_at,
  };
}

// ============================================================
// Provider 実装
// ============================================================

export const liveProvider: DataProvider = {
  async createInvestigation(
    request: CreateInvestigationRequest,
  ): Promise<CreateInvestigationResponse> {
    const {
      idempotencyKey,
      authSubject,
      // userId is a mock-only identity hint and must never cross the live JWT boundary.
      userId: _userId,
      ...body
    } = request;
    const data = await callApi(
      'POST',
      '/v1/investigations',
      body,
      'synchronousCreate',
      idempotencyKey,
      authSubject,
    );
    return createInvestigationResponseSchema.parse(data);
  },

  async runInvestigation(
    request: RunInvestigationRequest
  ): Promise<RunInvestigationResponse> {
    // HTTP は受付（202）だけを待つ。重い本体は EdgeRuntime.waitUntil 側で
    // 継続し、結果画面は Supabase Realtime の status/event を購読する。
    const data = await callApi(
      'POST',
      `/v1/investigations/${request.investigationId}/research`,
      request.searchAnchor ? { searchAnchor: request.searchAnchor } : undefined,
      'receipt',
    );
    return runInvestigationResponseSchema.parse(data);
  },

  async rerankInvestigation(
    request: RerankInvestigationRequest,
  ): Promise<RerankInvestigationResponse> {
    const data = await callApi(
      'POST',
      `/v1/investigations/${request.investigationId}/rerank`,
      { trigger: request.trigger },
      request.trigger === 'requirement_added' ? 'synchronousRerank' : 'receipt',
    );
    return rerankInvestigationResponseSchema.parse(data);
  },

  async joinInvestigation(
    request: JoinInvestigationRequest
  ): Promise<JoinInvestigationResponse> {
    const data = await callApi('POST', '/v1/investigations/join', request);
    return joinInvestigationResponseSchema.parse(data);
  },

  async getInvestigation(id: string): Promise<Investigation | undefined> {
    await ensureUserId();
    return fetchInvestigation(id);
  },

  async getInvestigationPreviewByShareToken(
    shareToken: string
  ): Promise<InvestigationPreview | undefined> {
    // 参加前プレビュー（issue #335 / §33）。security definer RPC が安全な最小集合
    // （タイトル・status・参加人数）だけを返す。RPC は authenticated 限定のため、
    // 他の読み取りと同じく先に匿名セッションを確立する（§19）。
    await ensureUserId();
    const { data, error } = await supabase.rpc('get_investigation_preview', {
      p_share_token: shareToken,
    });
    // 0行は未知/期限切れ token、RPC error は通信障害として画面に分類させる。
    // エラー詳細は捨て、安全な固定文言だけを呼び出し側へ返す。
    if (error) throw new Error('共有調査のプレビューを取得できませんでした');
    const row = ((data ?? []) as InvestigationPreviewRow[])[0];
    if (!row) return undefined; // 未知の token は 0 行（有効性の列挙に使わせない）
    return {
      title: row.title,
      status: row.status as InvestigationStatus,
      memberCount: row.member_count ?? 0,
    };
  },

  async getInvestigationEvents(investigationId: string): Promise<InvestigationEvent[]> {
    // select は member のみ RLS が許可（migrations/0003_rls.sql event_select §23）
    await ensureUserId();
    // 新しい方から上限件数だけ取り、表示用に created_at 昇順へ戻す
    const { data, error } = await supabase
      .from('investigation_events')
      .select('id, investigation_id, event_type, message, metadata, created_at')
      .eq('investigation_id', investigationId)
      .order('created_at', { ascending: false })
      .limit(INVESTIGATION_EVENT_LIMIT);
    if (error) throw new Error(`調査ログの取得に失敗しました: ${error.message}`);
    return ((data ?? []) as InvestigationEventRow[]).map(mapInvestigationEvent).reverse();
  },

  subscribeInvestigation(
    investigationId: string,
    listener: InvestigationListener
  ): () => void {
    let disposed = false;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const refetch = () => {
      // 変更イベントが連続で届くため 300ms debounce でまとめて再取得
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(async () => {
        try {
          const investigation = await fetchInvestigation(investigationId);
          if (!disposed && investigation) listener(investigation);
        } catch {
          // 一時的な取得失敗は次のイベントでリカバリ
        }
      }, 300);
    };

    void (async () => {
      try {
        await ensureUserId();
        if (disposed) return;

        // 認証済みセッションを確立してから Realtime を購読する。
        // 先に subscribe すると RLS 付き Postgres Changes が anon として拒否される。
        channel = supabase
          .channel(`investigation:${investigationId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'investigations',
              filter: `id=eq.${investigationId}`,
            },
            refetch
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'evidence',
            },
            refetch
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'requirement_evaluations',
              filter: `investigation_id=eq.${investigationId}`,
            },
            refetch
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'candidates',
              filter: `investigation_id=eq.${investigationId}`,
            },
            refetch
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'requirements',
              filter: `investigation_id=eq.${investigationId}`,
            },
            refetch
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'votes',
              filter: `investigation_id=eq.${investigationId}`,
            },
            refetch
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'investigation_events',
              filter: `investigation_id=eq.${investigationId}`,
            },
            refetch
          );
        // 初期取得の完了は Realtime 購読の確立を意味しない。購読 handshake 中に
        // 変更が入ると postgres_changes を取り逃がすため、SUBSCRIBED 境界の後で
        // fresh snapshot を必ず取得して、その間の変更も回収する。
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') refetch();
        });
      } catch {
        // useInvestigation 側の再試行導線に任せる。認証障害の詳細はUIへ漏らさない。
      }
    })();

    return () => {
      disposed = true;
      if (refetchTimer) clearTimeout(refetchTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  },

  async getPlaceFacts(placeId: string): Promise<PlaceFact[]> {
    // place_facts は authenticated select のみ許可（migrations/0007 §44.5）。
    // 補助情報のため取得失敗時は空配列にし、Evidence 表示のみへフォールバックさせる。
    await ensureUserId();
    const { data } = await supabase
      .from('place_facts')
      .select('place_id, key, value, confidence, evidence_count, conflicting, last_verified_at')
      .eq('place_id', placeId)
      .order('key', { ascending: true });
    return ((data ?? []) as PlaceFactRow[]).map(mapPlaceFact);
  },

  async getOwnPlaceFeedback(placeId: string): Promise<PlaceFeedback | undefined> {
    // place_feedback は RLS が auth.uid() の本人行だけを返す。user_id はselect列にも含めない。
    await ensureUserId();
    const { data, error } = await supabase
      .from('place_feedback')
      .select('id, place_id, visited_at, rating, aspect, aspect_value, created_at')
      .eq('place_id', placeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`来店記録の取得に失敗しました: ${error.message}`);
    return data ? mapPlaceFeedback(data as PlaceFeedbackRow) : undefined;
  },

  async getPlaceFeedbackSummary(placeIds: string[]): Promise<PlaceFeedbackSummary[]> {
    if (placeIds.length === 0) return [];
    await ensureUserId();
    const { data, error } = await supabase.rpc('get_place_feedback_summary', {
      p_place_ids: [...new Set(placeIds)],
    });
    if (error) throw new Error(`来店集計の取得に失敗しました: ${error.message}`);
    return ((data ?? []) as PlaceFeedbackSummaryRow[]).map(mapPlaceFeedbackSummary);
  },

  async submitPlaceFeedback(placeId: string, input: PlaceFeedbackInput): Promise<PlaceFeedback> {
    const normalized = normalizePlaceFeedbackInput(input);
    const data = await callApi('POST', `/v1/places/${placeId}/feedback`, normalized);
    const parsed = feedbackMutationResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error('来店記録の保存結果を確認できませんでした');
    const feedbackId = parsed.data.feedbackId;
    const saved = await this.getOwnPlaceFeedback(placeId);
    return saved ?? { id: feedbackId, placeId, ...normalized };
  },

  async updatePlaceFeedback(
    placeId: string,
    feedbackId: string,
    input: PlaceFeedbackInput
  ): Promise<PlaceFeedback> {
    const normalized = normalizePlaceFeedbackInput(input);
    const data = await callApi(
      'PATCH',
      `/v1/places/${placeId}/feedback/${feedbackId}`,
      normalized
    );
    const parsed = feedbackMutationResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error('来店記録の更新結果を確認できませんでした');
    const updatedId = parsed.data.feedbackId;
    const saved = await this.getOwnPlaceFeedback(placeId);
    return saved ?? { id: updatedId, placeId, ...normalized };
  },

  async setVote(
    investigationId: string,
    candidateId: string,
    value: VoteValue,
    comment?: string,
  ): Promise<void> {
    // votes は RLS が本人の upsert を許可（migrations/0003_rls.sql §23）
    const userId = await ensureUserId();
    const { error } = await supabase.from('votes').upsert(
      buildVoteMutationRow(
        investigationId,
        candidateId,
        userId,
        value,
        comment,
      ),
      { onConflict: 'candidate_id,user_id' }
    );
    if (error) throw new Error(`投票に失敗しました: ${error.message}`);
  },

  async addRequirement(investigationId: string, text: string): Promise<void> {
    // requirements は editor の insert を RLS が許可（migrations/0003_rls.sql §23）
    const userId = await ensureUserId();
    const { error } = await supabase.from('requirements').insert({
      investigation_id: investigationId,
      created_by: userId,
      text,
      normalized_text: text,
    });
    if (error) throw new Error(`条件の追加に失敗しました: ${error.message}`);
  },

  async removeRequirement(investigationId: string, requirementId: string): Promise<void> {
    // requirements は editor の delete を RLS が許可（migrations/0003_rls.sql §23）
    await ensureUserId();
    const { data, error } = await supabase
      .from('requirements')
      .delete()
      .eq('id', requirementId)
      .eq('investigation_id', investigationId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`条件の削除に失敗しました: ${error.message}`);
    if (!data) throw new Error('条件を削除できませんでした');
  },

  async rotateShareToken(investigationId: string): Promise<string> {
    // share_token の再発行は owner 専用の security definer RPC（migrations/0019 / #177）。
    // 0010 で investigations の直接 UPDATE は禁止済みのため、この RPC が唯一の client 経路。
    await ensureUserId();
    const { data, error } = await supabase.rpc('rotate_share_token', {
      p_investigation: investigationId,
    });
    if (error) {
      throw new Error(`共有リンクの再発行に失敗しました: ${error.message}`);
    }
    if (typeof data !== 'string' || !data) {
      throw new Error('共有リンクの再発行に失敗しました: 不正な応答');
    }
    return data;
  },

  async getPublicInvestigation(id: string): Promise<PublicInvestigation | undefined> {
    // 公開ページ（issue #115 / §33）。get_public_investigation RPC が
    // visibility='public' の行のみメタ情報（id/title/status/created_at）を返す。
    // raw_query / share_token は RPC が返さない設計（migrations/0007）。
    await ensureUserId();
    const { data, error } = await supabase.rpc('get_public_investigation', {
      p_investigation: id,
    });
    if (error) return undefined; // 失敗理由は画面へ漏らさず非公開として扱う
    const meta = ((data ?? []) as {
      id: string;
      title: string;
      status: string;
      created_at: string;
    }[])[0];
    if (!meta) return undefined; // 未知・非公開は 0 行

    // candidates / evaluations / evidence は RLS の readable 判定（member or public）が
    // 許可する。requirements 文面・votes・members は select しない（§33）。
    const [candRes, evalRes, scopedEvidenceRes] = await Promise.all([
      supabase
        .from('candidates')
        // 公開ページは safe columns のみ。精密座標は owner RPC の対象外にする。
        .select('id, investigation_id, place_id, score, rank, summary, pros, cons, discovery_context, places (id, name, address, metadata, fallback_image_key, place_provider_links (id, provider, storage_policy, expires_at, attribution_policy))')
        .eq('investigation_id', id),
      supabase.from('requirement_evaluations').select('*').eq('investigation_id', id),
      supabase.from('evidence').select('*').eq('investigation_id', id),
    ]);
    assertInvestigationReadSucceeded([
      { label: 'public_candidates', error: candRes.error },
      { label: 'public_evaluations', error: evalRes.error },
      { label: 'public_evidence', error: scopedEvidenceRes.error },
    ]);

    const candidateRows = (candRes.data ?? []) as unknown as CandidateRow[];
    const displayableCandidateRows = candidateRows.filter((row) => isPlaceDisplayable(row.places));
    const placeIds = [...new Set(displayableCandidateRows.map((row) => row.place_id))];
    const sharedEvidenceQuery = placeIds.length
      ? supabase
          .from('evidence')
          .select('*')
          .eq('scope', 'shared')
          .is('investigation_id', null)
          .in('place_id', placeIds)
      : Promise.resolve({ data: [] as unknown[], error: null });
    const [sharedEvidenceRes, imageCatalogRes] = await Promise.all([
      sharedEvidenceQuery,
      supabase.from('restaurant_image_catalog').select('image_key').eq('active', true),
    ]);
    assertInvestigationReadSucceeded([
      { label: 'public_shared_evidence', error: sharedEvidenceRes.error },
    ]);

    const evidenceRows = [
      ...((sharedEvidenceRes.data ?? []) as EvidenceRow[]),
      ...((scopedEvidenceRes.data ?? []) as EvidenceRow[]),
    ]
      .filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index)
      .map(mapEvidence);
    const evaluations = (evalRes.data ?? []) as EvaluationRow[];
    const activeRestaurantImageKeys = mapActiveRestaurantImageKeys(
      imageCatalogRes.data,
      Boolean(imageCatalogRes.error)
    );

    const candidates: PublicCandidate[] = displayableCandidateRows
      .map((row) => {
        const mapped = mapCandidateRow(
          row,
          filterProviderLinkedEvidence(row.places, evidenceRows),
          evaluations,
          [],
          activeRestaurantImageKeys,
          []
        );
        return {
          id: mapped.id,
          place: mapped.place,
          score: mapped.score,
          rank: mapped.rank,
          // 要件文面・kind は非公開（§33: requirements は member のみ RLS）。
          // 「条件 N」の連番と判定・説明だけを残す。
          evaluations: mapped.evaluations.map((evaluation, index) => ({
            index: index + 1,
            state: evaluation.state,
            explanation: evaluation.explanation,
          })),
          evidence: mapped.evidence,
          contradictions: mapped.contradictions,
          pros: mapped.pros,
        };
      })
      .sort((a, b) => (a.rank || 99) - (b.rank || 99));

    return {
      id: meta.id,
      title: meta.title,
      status: meta.status as InvestigationStatus,
      createdAt: meta.created_at,
      candidates,
    };
  },

  async setInvestigationVisibility(
    investigationId: string,
    visibility: 'private' | 'public'
  ): Promise<'private' | 'public'> {
    // owner 専用 RPC（migrations/0007）。非 owner は 403/例外になる（#106 契約）。
    const data = await callApi('PATCH', `/v1/investigations/${investigationId}/visibility`, {
      visibility,
    });
    return visibilityResponseSchema.parse(data).visibility;
  },

  async getUserId(): Promise<string> {
    return ensureUserId();
  },
};

// Keep the selected-provider surface identical across build targets. These synchronous helpers
// are intentionally inert in live builds; production screens use the async provider methods.
export const provider = liveProvider;
export const isLiveDataProvider = true;

export function getInvestigationSync(_id: string): Investigation | undefined {
  return undefined;
}

export function getInvestigationByShareTokenSync(
  _shareToken: string
): Investigation | undefined {
  return undefined;
}

export function setVoteForUser(
  _investigationId: string,
  _candidateId: string,
  _userId: string,
  _value: VoteValue,
  _comment?: string,
): boolean {
  return false;
}

export function addRequirementForUser(
  _investigationId: string,
  _text: string,
  _userId: string
): boolean {
  return false;
}

export function removeRequirementForUser(
  _investigationId: string,
  _requirementId: string,
  _userId: string
): boolean {
  return false;
}

export function rotateShareTokenForUser(
  _investigationId: string,
  _userId: string
): string | null {
  return null;
}
