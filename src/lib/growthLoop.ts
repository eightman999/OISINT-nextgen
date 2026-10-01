import { z } from 'zod';

import { isLiveDataProvider } from '@/lib/api';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

const nonNegativeCount = z.number().int().nonnegative();
const optionalRate = z.number().nonnegative().nullable();

export const growthSessionMetricsSchema = z
  .object({
    schema: z.literal('oisint.growth_session.v1'),
    events: z
      .object({
        investigation_created: z.literal(1),
        share_opened: nonNegativeCount,
        participant_joined: nonNegativeCount,
        participant_activated: nonNegativeCount,
        requirement_added: nonNegativeCount,
        vote_cast: nonNegativeCount,
        ranking_changed: nonNegativeCount,
        participant_returned: nonNegativeCount,
        participant_returned_7d: nonNegativeCount,
        participant_returned_via_push: nonNegativeCount,
        participant_created_new_investigation: nonNegativeCount,
      })
      .strict(),
    derived: z
      .object({
        share_to_join_conversion: optionalRate,
        join_to_first_action_conversion: optionalRate,
        group_completed: z.boolean(),
        invite_coefficient: optionalRate,
        return_7d_rate: optionalRate,
      })
      .strict(),
  })
  .strict();

export type GrowthSessionMetrics = z.infer<typeof growthSessionMetricsSchema>;

function canRecordLiveMetrics(): boolean {
  return isLiveDataProvider && isSupabaseConfigured;
}

export async function recordGrowthShareOpen(shareToken: string): Promise<boolean> {
  if (!canRecordLiveMetrics()) return false;
  if (!/^[0-9a-f]{32}$/u.test(shareToken)) return false;

  const { data, error } = await supabase.rpc('record_growth_share_open', {
    p_share_token: shareToken,
  });
  if (error || typeof data !== 'boolean') {
    throw new Error('共有導線の計測状態を保存できませんでした。');
  }
  return data;
}

export async function recordGrowthReturn(investigationId: string): Promise<boolean> {
  if (!canRecordLiveMetrics()) return false;
  const parsedId = z.string().uuid().safeParse(investigationId);
  if (!parsedId.success) return false;

  const { data, error } = await supabase.rpc('record_growth_return', {
    p_investigation_id: parsedId.data,
  });
  if (error || typeof data !== 'boolean') {
    throw new Error('再訪状態を保存できませんでした。');
  }
  return data;
}

export async function loadGrowthSessionMetrics(
  investigationId: string,
): Promise<GrowthSessionMetrics | null> {
  if (!canRecordLiveMetrics()) return null;
  const parsedId = z.string().uuid().safeParse(investigationId);
  if (!parsedId.success) return null;

  const { data, error } = await supabase.rpc('get_growth_session_metrics', {
    p_investigation_id: parsedId.data,
  });
  if (error) throw new Error('共同セッションの集計を読み込めませんでした。');

  const parsed = growthSessionMetricsSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('共同セッションの集計形式を確認できませんでした。');
  }
  return parsed.data;
}
