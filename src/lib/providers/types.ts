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

// mock / live を差し替え可能にするための共通インターフェース（CLAUDE.md 実装規律 4）
export interface DataProvider {
  // Edge Functions（書き込みは必ずこの4本を経由 §25）
  createInvestigation(req: CreateInvestigationRequest): Promise<CreateInvestigationResponse>;
  runInvestigation(req: RunInvestigationRequest): Promise<RunInvestigationResponse>;
  rerankInvestigation(req: RerankInvestigationRequest): Promise<RerankInvestigationResponse>;
  joinInvestigation(req: JoinInvestigationRequest): Promise<JoinInvestigationResponse>;

  // 読み取り（live は PostgREST SELECT + Realtime §20, §23）
  getInvestigation(id: string): Promise<Investigation | undefined>;
  // 調査ログ（investigation_events §5.4）。created_at 昇順で返す（issue #332）
  getInvestigationEvents(investigationId: string): Promise<InvestigationEvent[]>;
  subscribeInvestigation(id: string, listener: InvestigationListener): () => void;

  // 参加前プレビュー（issue #335 / §33）。share_token から安全な最小集合のみを返す。
  // 未知の token は undefined（理由は返さない）。
  getInvestigationPreviewByShareToken(
    shareToken: string
  ): Promise<InvestigationPreview | undefined>;

  // place_facts の読み取り（§44.5。共有資産 §33、RLS は authenticated select のみ）
  getPlaceFacts(placeId: string): Promise<PlaceFact[]>;

  // 来店後フィードバック。生の行は本人の最新行だけ、集計は3件以上のみを返す。
  getOwnPlaceFeedback(placeId: string): Promise<PlaceFeedback | undefined>;
  getPlaceFeedbackSummary(placeIds: string[]): Promise<PlaceFeedbackSummary[]>;
  submitPlaceFeedback(placeId: string, input: PlaceFeedbackInput): Promise<PlaceFeedback>;
  updatePlaceFeedback(
    placeId: string,
    feedbackId: string,
    input: PlaceFeedbackInput
  ): Promise<PlaceFeedback>;

  // 公開 Investigation の閲覧（issue #115 / §33）。visibility='public' の
  // 安全な最小集合のみを返す。未知・非公開の場合は undefined。
  getPublicInvestigation(id: string): Promise<PublicInvestigation | undefined>;

  // 公開/非公開の切り替え（issue #115 / #106）。owner のみ成功する。
  setInvestigationVisibility(
    investigationId: string,
    visibility: 'private' | 'public'
  ): Promise<'private' | 'public'>;

  // RLS が直接許可している書き込み（votes upsert / requirements insert/delete §23）
  setVote(
    investigationId: string,
    candidateId: string,
    value: VoteValue,
    comment?: string,
  ): Promise<void>;
  addRequirement(investigationId: string, text: string): Promise<void>;
  removeRequirement(investigationId: string, requirementId: string): Promise<void>;

  // share_token の owner 再発行（issue #177。live は owner RPC rotate_share_token、
  // mock はストアの token 差し替え。戻り値は新 token）
  rotateShareToken(investigationId: string): Promise<string>;

  // 認証済みユーザー ID（live は Supabase 匿名認証、mock はローカル生成）
  getUserId(): Promise<string>;
}
