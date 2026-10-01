import { z } from 'zod';

import { isLiveDataProvider } from '@/lib/api';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

const analyticsCoverageSchema = z
  .object({
    active_users: z.literal('measured'),
    investigations: z.literal('measured'),
    shared_joins: z.literal('measured'),
    search: z.enum(['measured', 'not_measured']),
  })
  .strict();

export const privateAnalyticsWindowSchema = z
  .object({
    days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    window_start: z.string().min(1),
    window_end: z.string().min(1),
    active_users: z.number().int().nonnegative(),
    investigations_created: z.number().int().nonnegative(),
    investigations_completed: z.number().int().nonnegative(),
    investigations_failed: z.number().int().nonnegative(),
    shared_joins: z.number().int().nonnegative(),
    search_successes: z.number().int().nonnegative(),
    search_failures: z.number().int().nonnegative(),
    search_success_rate: z.number().min(0).max(1).nullable(),
    coverage: analyticsCoverageSchema,
  })
  .strict();

export const privateAnalyticsDashboardSchema = z
  .object({
    schema: z.literal('oisint.private_analytics.v1'),
    computed_at: z.string().nullable(),
    windows: z.array(privateAnalyticsWindowSchema),
  })
  .strict();

export type PrivateAnalyticsDashboard = z.infer<typeof privateAnalyticsDashboardSchema>;
export type PrivateAnalyticsWindow = z.infer<typeof privateAnalyticsWindowSchema>;

function assertLiveSupabase(): void {
  if (!isLiveDataProvider || !isSupabaseConfigured) {
    throw new Error('運用メトリクスは本番データ接続時だけ利用できます。');
  }
}

export async function loadPrivateAnalytics(): Promise<PrivateAnalyticsDashboard> {
  assertLiveSupabase();
  const { data, error } = await supabase.rpc('get_private_analytics');
  if (error) throw new Error('運用メトリクスを読み込めませんでした。');

  const parsed = privateAnalyticsDashboardSchema.safeParse(data);
  if (!parsed.success) throw new Error('運用メトリクスの応答形式を確認できませんでした。');
  return parsed.data;
}

export async function loadPrivateAnalyticsOptOut(): Promise<boolean> {
  assertLiveSupabase();
  const { data, error } = await supabase.rpc('get_private_analytics_opt_out');
  if (error || typeof data !== 'boolean') {
    throw new Error('集計設定を読み込めませんでした。');
  }
  return data;
}

export async function setPrivateAnalyticsOptOut(optedOut: boolean): Promise<boolean> {
  assertLiveSupabase();
  const { data, error } = await supabase.rpc('set_private_analytics_opt_out', {
    p_opted_out: optedOut,
  });
  if (error || data !== optedOut) {
    throw new Error('集計設定を更新できませんでした。');
  }
  return data;
}
