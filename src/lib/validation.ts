import { z } from 'zod';

// Edge/APIレスポンスを画面へ渡す前に検証する（spec.md §25 / §30）。
// 外部応答の型を信頼せず、不正値は呼び出し側へ例外として返す。
export const investigationStatusSchema = z.enum([
  'draft',
  'parsing',
  'recalling',
  'searching',
  'collecting_evidence',
  'evaluating',
  'ranking',
  'complete',
  'failed',
]);

export const createInvestigationResponseSchema = z.object({
  investigationId: z.string().uuid(),
  shareToken: z.string().regex(/^[0-9a-f]{32}$/),
}).strict();

export const runInvestigationResponseSchema = z.object({
  status: investigationStatusSchema,
  reason: z.enum(['location_anchor_required']).optional(),
  message: z.string().optional(),
}).strict();

/** GPS の座標は run request の一時 anchor にだけ許可する。 */
export const locationSearchAnchorSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
}).strict();

export const runInvestigationRequestSchema = z.object({
  // Mock seed investigations use a stable non-UUID id. The live gateway/Edge
  // boundary validates UUID route parameters separately.
  investigationId: z.string().min(1),
  searchAnchor: locationSearchAnchorSchema.optional(),
}).strict();

export const LOCATION_ANCHOR_REQUIRED_REASON = 'location_anchor_required' as const;
export const LOCATION_ANCHOR_REQUIRED_MESSAGE =
  '現在地を検索に使用できませんでした。駅名・地名を入力してください。';

export const rerankInvestigationResponseSchema = z.object({
  reranked: z.boolean(),
}).strict();

export const joinInvestigationResponseSchema = z.object({
  // Seeded mock data uses a human-readable id; live responses are UUIDs.
  investigationId: z.string().min(1),
  title: z.string(),
}).strict();

// rotate_share_token RPC の応答（#177）。0002 の default と同じ 32 hex 固定。
export const rotateShareTokenResponseSchema = z.string().regex(/^[0-9a-f]{32}$/);

// 参加前プレビュー（issue #335 / spec.md §33）。安全な最小集合だけを画面へ通す。
export const investigationPreviewSchema = z.object({
  title: z.string(),
  status: investigationStatusSchema,
  memberCount: z.number().int().nonnegative(),
});

export const apiErrorSchema = z.object({
  error: z.string(),
}).strict();

export const matchStateSchema = z.enum(['match', 'partial', 'mismatch', 'unknown']);

export const structuredClaimSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  rawText: z.string().optional().default(''),
});
