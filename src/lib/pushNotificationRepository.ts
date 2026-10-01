import { z } from 'zod';

import { isLiveDataProvider } from '@/lib/api';
import {
  DEFAULT_PUSH_PREFERENCES,
  type PushPreferences,
  pushPreferencesSchema,
} from '@/lib/pushNotifications';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

const pushPreferenceResponseSchema = z
  .object({
    notifications_enabled: z.boolean(),
    group_updates_enabled: z.boolean(),
    permission_status: z.enum(['not_requested', 'granted', 'denied']),
  })
  .strict();

function assertLiveConnection(): void {
  if (!isLiveDataProvider || !isSupabaseConfigured) {
    throw new Error('Push通知設定は本番データ接続時だけ利用できます。');
  }
}

function fromServer(value: unknown): PushPreferences {
  const parsed = pushPreferenceResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Push通知設定の応答形式を確認できませんでした。');
  return {
    notificationsEnabled: parsed.data.notifications_enabled,
    groupUpdatesEnabled: parsed.data.group_updates_enabled,
    permissionStatus: parsed.data.permission_status,
  };
}

export async function loadPushPreferences(): Promise<PushPreferences> {
  assertLiveConnection();
  const { data, error } = await supabase.rpc('get_push_notification_preferences');
  if (error) throw new Error('Push通知設定を読み込めませんでした。');
  return fromServer(data ?? {
    notifications_enabled: DEFAULT_PUSH_PREFERENCES.notificationsEnabled,
    group_updates_enabled: DEFAULT_PUSH_PREFERENCES.groupUpdatesEnabled,
    permission_status: DEFAULT_PUSH_PREFERENCES.permissionStatus,
  });
}

export async function savePushPreferences(preferences: PushPreferences): Promise<PushPreferences> {
  assertLiveConnection();
  const validated = pushPreferencesSchema.parse(preferences);
  const { data, error } = await supabase.rpc('set_push_notification_preferences', {
    p_notifications_enabled: validated.notificationsEnabled,
    p_group_updates_enabled: validated.groupUpdatesEnabled,
    p_permission_status: validated.permissionStatus,
  });
  if (error) throw new Error('Push通知設定を更新できませんでした。');
  return fromServer(data);
}

export async function recordPushOpen(
  notificationId: string,
  stage: 'notification_opened' | 'deep_link_opened',
): Promise<void> {
  assertLiveConnection();
  const parsedId = z.string().uuid().safeParse(notificationId);
  if (!parsedId.success) return;
  const { data, error } = await supabase.rpc('record_push_notification_open', {
    p_notification_id: parsedId.data,
    p_stage: stage,
  });
  if (error || data !== true) throw new Error('Push通知の開封状態を記録できませんでした。');
}
