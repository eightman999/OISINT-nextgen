import type {
  Candidate,
  Contradiction,
  Evidence,
  MatchState,
  Requirement,
  RequirementEvaluation,
  InvestigationMember,
  PlaceDomain,
  StructuredClaim,
  VoteValue,
} from '@/types';
import { normalizeGooglePlaceId } from '@/lib/googleMapsUrl';
import { isRestaurantImageKey } from '@/lib/restaurantImages';
import { prepareEvidenceForDisplay } from '@/lib/evidenceSafety';
import {
  deterministicDisplayState,
  isDisplayDeterministicRequirement,
} from '@/lib/evidenceDisplayEvaluation';

export interface PlaceRow {
  id: string;
  name: string;
  address: string | null;
  /**
   * 精密座標は owner 専用 RPC で補完する。joined member/public の safe-column
   * response では列自体が存在しないため optional にする (#151 / §33)。
   */
  lat?: number | null;
  lng?: number | null;
  metadata: Record<string, unknown> | null;
  fallback_image_key: string | null;
  place_provider_links?: PlaceProviderLinkRow[] | null;
}

export interface PlaceProviderLinkRow {
  id?: string;
  provider?: string | null;
  storage_policy?: string | null;
  expires_at?: string | null;
  attribution_policy: string | null;
}

export interface CandidateRow {
  id: string;
  investigation_id: string;
  place_id: string;
  score: number | null;
  rank: number | null;
  summary: string | null;
  pros: unknown;
  cons: unknown;
  discovery_context?: unknown | null;
  places: PlaceRow | null;
}

export interface EvaluationRow {
  candidate_id: string;
  requirement_id: string;
  state: string;
  confidence: number | null;
  explanation: string | null;
  evidence_ids: string[] | null;
}

export interface VoteRow {
  candidate_id: string;
  user_id: string;
  value: number;
  comment?: string | null;
}

export function buildVoteMutationRow(
  investigationId: string,
  candidateId: string,
  userId: string,
  value: VoteValue,
  comment?: string,
) {
  return {
    investigation_id: investigationId,
    candidate_id: candidateId,
    user_id: userId,
    value,
    comment: comment?.trim() || null,
  };
}

export interface InvestigationMemberRow {
  user_id: string;
  display_name: string;
  role: string;
}

/**
 * Presenceを購読していないlive readではonline状態を断定しない。
 * isOnlineを省略するとMemberListのドットは表示されず、mockの疑似presenceと
 * 実在しないlive presenceを混同しない。
 */
export function mapInvestigationMember(
  row: InvestigationMemberRow,
): InvestigationMember {
  const role: InvestigationMember['role'] =
    row.role === 'owner' || row.role === 'editor' || row.role === 'viewer'
      ? row.role
      : 'viewer';
  return {
    id: row.user_id,
    displayName: row.display_name,
    role,
  };
}

/**
 * provider link の storage policy を表示可否へ変換する共通境界。
 *
 * provider 停止時は canonical `places` を消さず link を `ephemeral` + 即時期限へ
 * 変更する。期限切れ/停止済み link だけの候補は UI から隠し、別 provider link が
 * 残る canonical Place は引き続き表示できる。migration 前の link 無し行は既存互換として
 * 表示する。
 */
export function isProviderLinkDisplayable(
  link: PlaceProviderLinkRow,
  now: Date = new Date(),
): boolean {
  if (link.storage_policy === 'ephemeral') return false;
  if (link.expires_at !== null && link.expires_at !== undefined) {
    const expiresAt = Date.parse(link.expires_at);
    return Number.isFinite(expiresAt) && expiresAt > now.getTime();
  }
  return true;
}

export function isPlaceDisplayable(
  place: PlaceRow | null | undefined,
  now: Date = new Date(),
): boolean {
  const links = place?.place_provider_links;
  if (!Array.isArray(links) || links.length === 0) return true;
  return links.some((link) => isProviderLinkDisplayable(link, now));
}

/** 停止済み provider link を参照する Evidence を表示候補から外す。 */
export function filterProviderLinkedEvidence(
  place: PlaceRow | null | undefined,
  rows: readonly Evidence[],
  now: Date = new Date(),
): Evidence[] {
  const links = place?.place_provider_links;
  if (!Array.isArray(links) || links.length === 0) return [...rows];
  const activeLinkIds = new Set(
    links
      .filter((link) => isProviderLinkDisplayable(link, now))
      .flatMap((link) => typeof link.id === 'string' ? [link.id] : []),
  );
  if (activeLinkIds.size === 0) return [];
  // 古い読み取り fixture / migration 前の行には providerLinkId が無い。link provenance
  // が未導入の共有 Evidence まで黙って消さず、provider_link_id がある行だけ判定する。
  return rows.filter((row) =>
    row.providerLinkId === undefined ||
    row.providerLinkId === null ||
    activeLinkIds.has(row.providerLinkId)
  );
}

export function mapActiveRestaurantImageKeys(
  rows: unknown,
  lookupFailed = false
): ReadonlySet<string> {
  if (lookupFailed || !Array.isArray(rows)) return new Set();

  return new Set(
    rows.flatMap((row) => {
      if (!isRecord(row)) return [];
      const imageKey = typeof row.image_key === 'string' ? row.image_key : undefined;
      return isRestaurantImageKey(imageKey) ? [imageKey] : [];
    })
  );
}

export interface InvestigationReadStatus {
  label: string;
  error: unknown | null;
}

// evaluations / evidence 等の query failure を空配列へ潰すと、ComparisonPanel が
// 欠落行を semantic unknown (`?`) として表示してしまう。技術障害は読込失敗として
// useInvestigation の retry 導線へ渡し、根拠不足と混同しない (#312)。
export function assertInvestigationReadSucceeded(
  statuses: readonly InvestigationReadStatus[],
): void {
  const failed = statuses.find((status) => status.error !== null);
  if (failed) {
    throw new Error(`調査データの取得に失敗しました (${failed.label})`);
  }
}

const CLAIM_KEYS = new Set<StructuredClaim['key']>([
  'opening_hours',
  'closed_days',
  'budget_dinner',
  'card_accepted',
  'reservation',
  'private_room',
  'capacity',
  'genre',
  'noise_level',
  'time_limit',
  'non_smoking',
  'wifi_available',
  'child_friendly',
  'nearest_station_walk_minutes',
  'category',
  'price_range',
  'amenities',
  'lodging.room_type',
  'lodging.check_in_time',
  'lodging.check_out_time',
  'rental_space.equipment',
]);

const PLACE_DOMAINS = new Set<PlaceDomain>([
  'restaurant',
  'lodging',
  'rental_space',
  'destination',
  'secondhand',
  'event',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataString(metadata: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function metadataDomain(metadata: Record<string, unknown> | null): PlaceDomain | undefined {
  const value = metadata?.domain;
  return typeof value === 'string' && PLACE_DOMAINS.has(value as PlaceDomain)
    ? value as PlaceDomain
    : undefined;
}

function claimValue(evidence: Evidence[], key: StructuredClaim['key']): unknown {
  for (const item of evidence) {
    const claim = item.structuredClaims.find((entry) => entry.key === key);
    if (claim) return claim.value;
  }
  return undefined;
}

function evidenceSupportsRequirement(
  requirement: Requirement,
  referencedEvidence: readonly Evidence[],
  state: MatchState,
): boolean {
  if (!isDisplayDeterministicRequirement(requirement)) return referencedEvidence.length > 0;
  return deterministicDisplayState(requirement, referencedEvidence) === state;
}

function budgetLabel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const min = value.min;
  const max = value.max;
  if (typeof min !== 'number' || typeof max !== 'number') return undefined;
  return `${min}〜${max}円`;
}

function openingHours(value: unknown): { open?: string; close?: string } {
  if (typeof value !== 'string') return {};
  const match = value.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  return match ? { open: match[1], close: match[2] } : {};
}

function mapPros(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function mapContradictions(value: unknown, fallbackPlaceId: string): Contradiction[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !CLAIM_KEYS.has(entry.key as StructuredClaim['key'])) {
      return [];
    }
    if (!Array.isArray(entry.entries)) return [];
    const entries = entry.entries.flatMap((item) => {
      if (!isRecord(item) || typeof item.evidenceId !== 'string') return [];
      return [{
        evidenceId: item.evidenceId,
        value: item.value,
        sourceQuality: typeof item.sourceQuality === 'number' ? item.sourceQuality : 0,
      }];
    });
    if (entries.length < 2) return [];
    return [{
      placeId: typeof entry.placeId === 'string' ? entry.placeId : fallbackPlaceId,
      key: entry.key as Contradiction['key'],
      entries,
    }];
  });
}

export function mapCandidateRow(
  row: CandidateRow,
  evidenceRows: Evidence[],
  evaluations: EvaluationRow[],
  votes: VoteRow[],
  activeRestaurantImageKeys: ReadonlySet<string> = new Set(),
  requirements?: readonly Requirement[],
): Candidate {
  const candidateEvidence = prepareEvidenceForDisplay(
    evidenceRows.filter((evidence) => evidence.placeId === row.place_id)
  );
  const candidateEvidenceIds = new Set(candidateEvidence.map((evidence) => evidence.id));
  const candidateEvidenceById = new Map(candidateEvidence.map((evidence) => [evidence.id, evidence]));
  const requirementById = requirements
    ? new Map(requirements.map((requirement) => [requirement.id, requirement]))
    : undefined;
  const candidateEvaluations: RequirementEvaluation[] = evaluations
    .filter((evaluation) => evaluation.candidate_id === row.id)
    .map((evaluation) => {
      const evidenceIds = evaluation.evidence_ids ?? [];
      const state = evaluation.state as MatchState;
      const referencedEvidence = evidenceIds.flatMap((id) => {
        const evidence = candidateEvidenceById.get(id);
        return evidence ? [evidence] : [];
      });
      const requirement = requirementById?.get(evaluation.requirement_id);
      const grounded = evidenceIds.length > 0 &&
        evidenceIds.every((id) => candidateEvidenceIds.has(id)) &&
        (!requirementById ||
          (requirement !== undefined && evidenceSupportsRequirement(requirement, referencedEvidence, state)));
      if (state !== 'unknown' && !grounded) {
        return {
          requirementId: evaluation.requirement_id,
          state: 'unknown' as const,
          confidence: 0,
          explanation: '表示可能なEvidenceを確認できないため判定を保留しました',
          evidenceIds: [],
        };
      }
      return {
        requirementId: evaluation.requirement_id,
        state,
        confidence: evaluation.confidence ?? 0,
        explanation: evaluation.explanation ?? '',
        evidenceIds,
      };
    });

  const candidateVotes: Record<string, VoteValue> = {};
  const candidateVoteComments: Record<string, string> = {};
  votes
    .filter((vote) => vote.candidate_id === row.id)
    .forEach((vote) => {
      candidateVotes[vote.user_id] = vote.value as VoteValue;
      const comment = typeof vote.comment === 'string' ? vote.comment.trim() : '';
      if (comment) candidateVoteComments[vote.user_id] = comment;
    });

  const metadata = row.places?.metadata ?? null;
  const shopUrl = metadataString(metadata, 'shopUrl', 'url');
  const photoUrl = metadataString(metadata, 'photoUrl', 'photo');
  const googlePlaceId = normalizeGooglePlaceId(metadataString(metadata, 'googlePlaceId'));
  const fallbackImageKey = row.places?.fallback_image_key;
  const hours = openingHours(claimValue(candidateEvidence, 'opening_hours'));
  const cardAccepted = claimValue(candidateEvidence, 'card_accepted');
  const providerAttributionPolicies = row.places?.place_provider_links?.flatMap((link) =>
    isProviderLinkDisplayable(link) && typeof link.attribution_policy === 'string'
      ? [link.attribution_policy]
      : []
  ) ?? [];
  const discoveryAttributionPolicies = isRecord(row.discovery_context) &&
      Array.isArray(row.discovery_context.attributionPolicies)
    ? row.discovery_context.attributionPolicies.filter(
      (policy): policy is string => policy === 'mlit_n02_attribution'
    )
    : [];

  return {
    id: row.id,
    investigationId: row.investigation_id,
    place: {
      id: row.places?.id ?? row.place_id,
      name: row.places?.name ?? '不明な店舗',
      domain: metadataDomain(metadata),
      address: row.places?.address ?? undefined,
      lat: row.places?.lat ?? undefined,
      lng: row.places?.lng ?? undefined,
      genre: extractGenre(candidateEvidence),
      // 住所を「徒歩アクセス」として表示しない。実測されたaccess値を保持する
      // provider/schemaが導入されるまではunknownとしてタグを出さない。
      access: undefined,
      budget: budgetLabel(claimValue(candidateEvidence, 'budget_dinner')),
      open: hours.open,
      close: hours.close,
      card: typeof cardAccepted === 'boolean' ? (cardAccepted ? '可' : '不可') : undefined,
      urls: shopUrl ? { pc: shopUrl } : undefined,
      photo: photoUrl,
      fallbackImageKey:
        fallbackImageKey &&
        activeRestaurantImageKeys.has(fallbackImageKey) &&
        isRestaurantImageKey(fallbackImageKey)
          ? fallbackImageKey
          : undefined,
      googlePlaceId,
      attributionPolicies: [...new Set([
        ...providerAttributionPolicies,
        ...discoveryAttributionPolicies,
      ])],
    },
    score: row.score ?? 0,
    rank: row.rank ?? 0,
    evaluations: candidateEvaluations,
    evidence: candidateEvidence,
    contradictions: mapContradictions(row.cons, row.place_id),
    pros: mapPros(row.pros),
    votes: candidateVotes,
    ...(Object.keys(candidateVoteComments).length > 0
      ? { voteComments: candidateVoteComments }
      : {}),
  };
}

function extractGenre(evidence: Evidence[]): string | undefined {
  for (const item of evidence) {
    const claim = item.structuredClaims.find((entry) => entry.key === 'genre');
    if (claim && Array.isArray(claim.value) && claim.value.length > 0) {
      return String(claim.value[0]);
    }
  }
  return undefined;
}
