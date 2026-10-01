import {
  createInvestigationResponseSchema,
  investigationPreviewSchema,
  joinInvestigationResponseSchema,
  rerankInvestigationResponseSchema,
  runInvestigationRequestSchema,
  rotateShareTokenResponseSchema,
  runInvestigationResponseSchema,
} from '@/lib/validation';
import type {
  CreateInvestigationRequest,
  CreateInvestigationResponse,
  Investigation,
  InvestigationEvent,
  InvestigationListener,
  InvestigationPreview,
  JoinInvestigationRequest,
  JoinInvestigationResponse,
  PlaceFact,
  PlaceFeedback,
  PlaceFeedbackInput,
  PlaceFeedbackSummary,
  PublicInvestigation,
  RerankInvestigationRequest,
  RerankInvestigationResponse,
  RunInvestigationRequest,
  RunInvestigationResponse,
  VoteValue,
} from '@/types';
import type { DataProvider } from './providers/types';
import { sanitizePlaceFeedbackSummary } from './placeFeedback';
import { isTrustedApiOrigin, isTrustedSupabaseOrigin } from './trustedOrigins';
import {
  addRequirementForUser,
  getInvestigationByShareTokenSync,
  getInvestigationSync,
  isLiveDataProvider,
  provider as selectedProvider,
  removeRequirementForUser,
  rotateShareTokenForUser,
  setVoteForUser,
} from './providers/selected';

export { isLiveDataProvider };

const hasLiveConfig =
  !!process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY &&
  isTrustedSupabaseOrigin(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '') &&
  isTrustedApiOrigin(
    process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oisint.com',
  );

let provider: DataProvider | null = null;

function getProvider(): DataProvider {
  if (provider) return provider;

  if (!isLiveDataProvider) {
    provider = selectedProvider;
    return provider;
  }

  if (!hasLiveConfig) {
    throw new Error(
      'Live Supabase API is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.'
    );
  }

  // The selected-provider module is mapped to live.ts for production by Metro. No mock provider
  // is imported into that production dependency graph.
  provider = selectedProvider;
  return provider;
}

export async function createInvestigation(
  request: CreateInvestigationRequest
): Promise<CreateInvestigationResponse> {
  return createInvestigationResponseSchema.parse(
    await getProvider().createInvestigation(request)
  );
}

export async function runInvestigation(
  request: RunInvestigationRequest
): Promise<RunInvestigationResponse> {
  const checked = runInvestigationRequestSchema.parse(request);
  return runInvestigationResponseSchema.parse(await getProvider().runInvestigation(checked));
}

export async function rerankInvestigation(
  request: RerankInvestigationRequest
): Promise<RerankInvestigationResponse> {
  return rerankInvestigationResponseSchema.parse(
    await getProvider().rerankInvestigation(request)
  );
}

export async function joinInvestigation(
  request: JoinInvestigationRequest
): Promise<JoinInvestigationResponse> {
  return joinInvestigationResponseSchema.parse(await getProvider().joinInvestigation(request));
}

export function subscribeInvestigation(
  investigationId: string,
  listener: InvestigationListener
): () => void {
  return getProvider().subscribeInvestigation(investigationId, listener);
}

// The synchronous accessor is retained for existing mock tests and seed preview only.
// Live screens use getInvestigationAsync or subscribeInvestigation.
export function getInvestigation(id: string): Investigation | undefined {
  if (isLiveDataProvider) return undefined;
  return getInvestigationSync(id);
}

export async function getInvestigationAsync(id: string): Promise<Investigation | undefined> {
  return getProvider().getInvestigation(id);
}

export function getInvestigationByShareToken(shareToken: string): Investigation | undefined {
  if (isLiveDataProvider) return undefined;
  return getInvestigationByShareTokenSync(shareToken);
}

// 参加前プレビュー（issue #335 / spec.md §33）。mock/live 共通の非同期経路で、
// share_token から安全な最小集合（タイトル・status・参加人数）のみを返す。
export async function getInvestigationPreviewByShareToken(
  shareToken: string
): Promise<InvestigationPreview | undefined> {
  const preview = await getProvider().getInvestigationPreviewByShareToken(shareToken);
  return preview ? investigationPreviewSchema.parse(preview) : undefined;
}

// Legacy UI/test compatibility. New code should use setVote/addRequirement.
export function setInvestigationVote(
  investigationId: string,
  candidateId: string,
  userId: string,
  value: VoteValue
): void {
  if (!isLiveDataProvider) {
    setVoteForUser(investigationId, candidateId, userId, value);
    return;
  }
  void getProvider().setVote(investigationId, candidateId, value);
}

export function addInvestigationRequirement(
  investigationId: string,
  text: string,
  userId: string
): boolean {
  if (!isLiveDataProvider) {
    return addRequirementForUser(investigationId, text, userId);
  }
  void getProvider().addRequirement(investigationId, text);
  return true;
}

export function setVote(
  investigationId: string,
  candidateId: string,
  value: VoteValue,
  userId?: string,
  comment?: string,
): Promise<void> {
  if (!isLiveDataProvider) {
    setVoteForUser(
      investigationId,
      candidateId,
      userId || 'mock-user',
      value,
      comment,
    );
    return Promise.resolve();
  }
  return getProvider().setVote(investigationId, candidateId, value, comment);
}

export function addRequirement(
  investigationId: string,
  text: string,
  userId?: string
): Promise<void> {
  if (!isLiveDataProvider) {
    const ok = addRequirementForUser(
      investigationId,
      text,
      userId || 'mock-user'
    );
    return ok
      ? Promise.resolve()
      : Promise.reject(new Error('条件を追加する権限がありません'));
  }
  return getProvider().addRequirement(investigationId, text);
}

export function removeRequirement(
  investigationId: string,
  requirementId: string,
  userId?: string
): Promise<void> {
  if (!isLiveDataProvider) {
    const ok = removeRequirementForUser(
      investigationId,
      requirementId,
      userId || 'mock-user'
    );
    return ok
      ? Promise.resolve()
      : Promise.reject(new Error('条件を削除する権限がありません'));
  }
  return getProvider().removeRequirement(investigationId, requirementId);
}

// share_token の owner 再発行（#177）。旧 token は即時無効、参加済みメンバーは維持。
// live は owner RPC rotate_share_token（migrations/0019）、mock はストアの差し替え。
export function rotateShareToken(
  investigationId: string,
  userId?: string
): Promise<string> {
  if (!isLiveDataProvider) {
    const newToken = rotateShareTokenForUser(investigationId, userId || 'mock-user');
    return newToken
      ? Promise.resolve(rotateShareTokenResponseSchema.parse(newToken))
      : Promise.reject(new Error('共有リンクを再発行する権限がありません'));
  }
  return getProvider()
    .rotateShareToken(investigationId)
    .then((newToken) => rotateShareTokenResponseSchema.parse(newToken));
}

export function getUserId(): Promise<string> {
  return getProvider().getUserId();
}

// 調査ログ（investigation_events §5.4 / issue #332）。created_at 昇順で返す。
export async function getInvestigationEvents(
  investigationId: string
): Promise<InvestigationEvent[]> {
  return getProvider().getInvestigationEvents(investigationId);
}

// 対象 place の place_facts（§44.5 集約ビュー）を読む。共有資産（§33）のため個人文脈を持たない。
export function getPlaceFacts(placeId: string): Promise<PlaceFact[]> {
  return getProvider().getPlaceFacts(placeId);
}

// 来店後フィードバックのfrontend facade（#110）。本人行と集計を別経路・別型で扱い、
// user_idをUIへ返さない。書き込みはprovider側でAPI Worker/RLSの既存契約へ委ねる。
export function getOwnPlaceFeedback(placeId: string): Promise<PlaceFeedback | undefined> {
  return getProvider().getOwnPlaceFeedback(placeId);
}

export function getPlaceFeedbackSummary(placeIds: string[]): Promise<PlaceFeedbackSummary[]> {
  return getProvider()
    .getPlaceFeedbackSummary(placeIds)
    .then((summaries) => summaries.map(sanitizePlaceFeedbackSummary));
}

export function savePlaceFeedback(
  placeId: string,
  input: PlaceFeedbackInput,
  existingFeedbackId?: string,
): Promise<PlaceFeedback> {
  return existingFeedbackId
    ? getProvider().updatePlaceFeedback(placeId, existingFeedbackId, input)
    : getProvider().submitPlaceFeedback(placeId, input);
}

// 公開 Investigation の閲覧（issue #115 / §33）。visibility='public' の
// 安全な最小集合のみ。未知・非公開は undefined（理由は返さない）。
export async function getPublicInvestigation(
  id: string
): Promise<PublicInvestigation | undefined> {
  return getProvider().getPublicInvestigation(id);
}

// 公開/非公開の切り替え（issue #115 / #106）。owner 以外は失敗する。
export async function setInvestigationVisibility(
  investigationId: string,
  visibility: 'private' | 'public'
): Promise<'private' | 'public'> {
  return getProvider().setInvestigationVisibility(investigationId, visibility);
}
