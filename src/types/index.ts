// 共通型定義（仕様書のデータモデルに沿って随時追加）

export type InvestigationStatus =
  | 'draft'
  | 'parsing'
  | 'recalling'
  | 'searching'
  | 'collecting_evidence'
  | 'evaluating'
  | 'ranking'
  | 'complete'
  | 'failed';

export type RequirementKind =
  | 'location'
  | 'budget'
  | 'cuisine'
  | 'payment'
  | 'reservation'
  | 'atmosphere'
  | 'party_size'
  | 'time'
  | 'access'
  | 'dietary'
  | 'other';

export type RequirementPriority = 'must' | 'should' | 'nice';

export type MatchState = 'match' | 'partial' | 'mismatch' | 'unknown';

export type VoteValue = -1 | 0 | 1;

export type PlaceFeedbackRating = -1 | 0 | 1;
export type PlaceFeedbackAspect = 'noise' | 'space' | 'value' | 'service';

/** 本人の来店後フィードバック。user_id はUI契約へ含めない。 */
export interface PlaceFeedback {
  id: string;
  placeId: string;
  visitedAt?: string;
  rating?: PlaceFeedbackRating;
  aspect?: PlaceFeedbackAspect;
  aspectValue?: string;
  createdAt?: string;
}

export interface PlaceFeedbackInput {
  visitedAt?: string;
  rating?: PlaceFeedbackRating;
  aspect?: PlaceFeedbackAspect;
  aspectValue?: string;
}

export interface PlaceFeedbackAspectSummary {
  aspect: PlaceFeedbackAspect;
  aspectValue: string;
  count: number;
}

/** 公開可能な集計のみ。3件未満の値はservice層で除外する。 */
export interface PlaceFeedbackSummary {
  placeId: string;
  visitedCount: number;
  ratingCount: number;
  ratingAverage: number | null;
  aspects: PlaceFeedbackAspectSummary[];
}

export type TasteHealthGoal = 'none' | 'diet' | 'high_protein';

export interface TasteProfile {
  likes: string[];
  avoid: string[];
  allergies: string;
  healthGoal: TasteHealthGoal;
}

export interface LocationSelection {
  label: string;
  source: 'gps' | 'map';
  latitude?: number;
  longitude?: number;
}

/**
 * 現在地検索のためだけに run request へ渡す一時 anchor。
 * rawQuery / 共有 URL / 調査イベント / DB へ保存してはならない。
 */
export interface LocationSearchAnchor {
  lat: number;
  lng: number;
}

export interface Requirement {
  id: string;
  text: string;
  normalizedText: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  weight: number;
  /** DB kind=null の参加者追加条件。client側で決定論kindを推定できる唯一の経路。 */
  userAdded?: boolean;
}

export interface RequirementEvaluation {
  requirementId: string;
  state: MatchState;
  confidence: number;
  explanation: string;
  evidenceIds: string[];
}

export interface Evidence {
  id: string;
  placeId: string;
  /** provider link が分かる共有 Evidence は、停止・期限切れ時に表示から除外する。 */
  providerLinkId?: string | null;
  investigationId: string | null;
  scope: 'shared' | 'investigation';
  sourceType: string;
  sourceUrl: string;
  sourceTitle?: string;
  excerpt: string;
  structuredClaims: StructuredClaim[];
  observedAt: string;
  sourceQuality: number;
  freshnessScore: number;
}

export type ClaimKey =
  | 'opening_hours'
  | 'closed_days'
  | 'budget_dinner'
  | 'card_accepted'
  | 'reservation'
  | 'private_room'
  | 'capacity'
  | 'genre'
  | 'noise_level'
  | 'time_limit'
  | 'non_smoking'
  | 'wifi_available'
  | 'child_friendly'
  | 'nearest_station_walk_minutes'
  // OISI共通層の汎用claim。旧restaurant keyとの互換を保つ (#125)。
  | 'category'
  | 'price_range'
  | 'amenities'
  | 'lodging.room_type'
  | 'lodging.check_in_time'
  | 'lodging.check_out_time'
  | 'rental_space.equipment';

export interface StructuredClaim {
  key: ClaimKey;
  value: unknown;
  rawText: string;
}

/** OISIが扱う対象domain。未設定の既存行はrestaurant互換として推測せず保持する。 */
export type PlaceDomain =
  | 'restaurant'
  | 'lodging'
  | 'rental_space'
  | 'destination'
  | 'secondhand'
  | 'event';

export interface Contradiction {
  placeId: string;
  key: ClaimKey;
  entries: { evidenceId: string; value: unknown; sourceQuality: number }[];
}

export interface Place {
  id: string;
  name: string;
  /** providerが明示したdomain。欠落値を別domainへ推測変換しない (#125)。 */
  domain?: PlaceDomain;
  address?: string;
  lat?: number;
  lng?: number;
  genre?: string;
  access?: string;
  budget?: string;
  open?: string;
  close?: string;
  card?: string;
  urls?: { pc?: string };
  /** HTTPS provider URL. Bundled keys remain accepted for legacy/mock fixtures. */
  photo?: string;
  /** Active key referenced by public.places.fallback_image_key. */
  fallbackImageKey?: string;
  /** Explicit Google Places identity. Never inferred from an arbitrary Maps/Takeout URL. */
  googlePlaceId?: string;
  attributionPolicies?: string[];
}

// place 単位の集約ビュー place_facts の 1 行（supabase/migrations/0007_p1_accumulation.sql / §44.5）。
// 列は place_id / key / value / confidence / evidence_count / conflicting / last_verified_at のみで、
// user_id や investigation_id を持たない共有資産（§33 表 / §44.3 L2）。
export interface PlaceFact {
  placeId: string;
  /** ClaimKey（§13）に加え、feedback 由来キー（space_comfort 等）も入るため string（DB は text） */
  key: string;
  value: unknown;
  /** 支持 Evidence の source_quality から算出（0..1）。§44.5 */
  confidence: number;
  evidenceCount: number;
  /** 矛盾は潰さず flag で残す（§15 / §44.5） */
  conflicting: boolean;
  lastVerifiedAt: string;
}

export interface Candidate {
  id: string;
  investigationId: string;
  place: Place;
  score: number;
  rank: number;
  evaluations: RequirementEvaluation[];
  evidence: Evidence[];
  contradictions: Contradiction[];
  /** Backend の candidates.pros。LIVE でも説明可能な加点理由を失わない。 */
  pros?: string[];
  votes: Record<string, VoteValue>;
  /** votes.comment。空文字は保持せず、投票者IDごとの任意コメントだけを載せる。 */
  voteComments?: Record<string, string>;
}

export interface InvestigationMember {
  id: string;
  displayName: string;
  isOnline?: boolean;
  role?: 'owner' | 'editor' | 'viewer';
}

export interface Investigation {
  id: string;
  title: string;
  status: InvestigationStatus;
  rawQuery: string;
  requirements: Requirement[];
  candidates: Candidate[];
  members: InvestigationMember[];
  shareToken: string;
  /** 公開設定（§3 P1 / #115）。既定 private。live は investigations.visibility 列 */
  visibility?: 'private' | 'public';
  createdAt: string;
  updatedAt: string;
}

/**
 * 参加前プレビュー（issue #335 / spec.md §33）。
 * share_token 所持者へ見せてよい安全な最小集合のみ。
 * rawQuery・requirements 文面・votes・candidates・メンバー個人情報は含めない。
 */
export interface InvestigationPreview {
  title: string;
  status: InvestigationStatus;
  /** 参加人数の集計値のみ（§33: 名前・IDは非公開） */
  memberCount: number;
}

/**
 * 公開 Investigation の閲覧ページ用データ（issue #115 / §3 P1, §33）。
 * get_public_investigation RPC + RLS で読める範囲のみ。
 * rawQuery・requirements 文面・votes・メンバー個人情報は含めない。
 * 候補は条件文なし（評価は kind 粒度の表示のみ）。
 */
export interface PublicInvestigation {
  id: string;
  title: string;
  status: InvestigationStatus;
  createdAt: string;
  candidates: PublicCandidate[];
}

export interface PublicCandidate {
  id: string;
  place: Place;
  score: number;
  rank: number;
  /**
   * requirement 文面・kind は §33 で非公開（requirements は member のみ RLS）。
   * 公開ページでは「条件 N」の連番と判定・説明だけを表示する。
   */
  evaluations: {
    index: number;
    state: MatchState;
    explanation: string;
  }[];
  evidence: Evidence[];
  contradictions: Contradiction[];
  pros?: string[];
}

// investigation_events の1行（§5.4 Search Log / supabase/migrations/0002_tables.sql:157-166）。
// 列名は実スキーマ（id / investigation_id / event_type / message / metadata / created_at）に対応する。
export interface InvestigationEvent {
  id: string;
  investigationId: string;
  eventType: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateInvestigationRequest {
  query: string;
  displayName: string;
  /** Mock/live provider で同一参加者を識別するための任意の安定ID。 */
  userId?: string;
  /** timeout後の再送を同じinvestigationへ収束させる、リクエスト単位のキー。 */
  idempotencyKey: string;
  /**
   * create開始時にHomeが観測したJWT subject。HTTP bodyには含めず、live
   * providerが同一auth sessionのJWT subjectと照合する。
   */
  authSubject: string;
}

export interface CreateInvestigationResponse {
  investigationId: string;
  shareToken: string;
}

export interface RunInvestigationRequest {
  investigationId: string;
  /** GPS 許可時だけ送る。調査データへ保存しない一時値。 */
  searchAnchor?: LocationSearchAnchor;
}

export type RunInvestigationReason = 'location_anchor_required';

export interface RunInvestigationResponse {
  status: InvestigationStatus;
  reason?: RunInvestigationReason;
  /** API互換用。画面表示は固定文言を使う。 */
  message?: string;
}

export type RerankTrigger = 'vote' | 'requirement_added' | 'requirement_removed';

export interface RerankInvestigationRequest {
  investigationId: string;
  trigger: RerankTrigger;
}

export interface RerankInvestigationResponse {
  reranked: boolean;
}

export interface JoinInvestigationRequest {
  shareToken: string;
  displayName: string;
  /** 未指定時は displayName を後方互換の識別子として扱う。 */
  userId?: string;
}

export interface JoinInvestigationResponse {
  investigationId: string;
  title: string;
}

export interface ApiError {
  error: string;
}

export type InvestigationListener = (investigation: Investigation) => void;
