import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { isLiveDataProvider } from '@/lib/api';
import { supabase } from '@/lib/supabase';

export interface InAppNotification {
  id: string;
  message: string;
}

export interface InvestigationNotifications {
  /** 直近の通知（toast 表示用）。新しい順で最大 5 件保持する */
  notifications: InAppNotification[];
  /** 未読件数（タイトルバッジ等に使う） */
  unreadCount: number;
  markAllRead: () => void;
}

const MAX_NOTIFICATIONS = 5;
const COMPLETE_EVENT_TYPES = new Set(['search_completed', 'step_completed']);
const FAILURE_EVENT_TYPES = new Set(['step_failed', 'candidate_failed', 'no_candidates']);

function notificationForEvent(
  eventType: string,
  message: string | null
): InAppNotification | null {
  // 調査完了（§3 P1 / #114）。complete ステップのイベントだけを通知対象にする。
  // 失敗系イベントはエラー表示に専念させるため通知にはしない。
  if (eventType === 'step_started' && message === '調査が完了しました') {
    return { id: 'complete', message: '調査が完了しました。候補を確認できます。' };
  }
  if (COMPLETE_EVENT_TYPES.has(eventType)) {
    return { id: eventType, message: '調査の進行状況が更新されました。' };
  }
  return null;
}

function voteNotificationForRow(
  newValue: number
): InAppNotification | null {
  // 新規投票（#114）。value の正負で行きたい/行きたくないに読み替える。
  if (newValue > 0) return { id: 'vote-up', message: '新しい投票が入りました（行きたい）' };
  if (newValue < 0) return { id: 'vote-down', message: '新しい投票が入りました（行きたくない）' };
  return null;
}

// 通知用の購読チャンネルを作る。mock では購読しない（通知は live のみ）。
function createChannel(
  investigationId: string,
  onNotification: (notification: InAppNotification) => void
): (() => void) | null {
  if (!isLiveDataProvider) return null;

  const channel: RealtimeChannel = supabase
    .channel(`notification:${investigationId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'investigation_events',
        filter: `investigation_id=eq.${investigationId}`,
      },
      (payload) => {
        const row = payload.new as { event_type?: string; message?: string | null } | undefined;
        if (!row?.event_type || FAILURE_EVENT_TYPES.has(row.event_type)) return;
        const notification = notificationForEvent(row.event_type, row.message ?? null);
        if (notification) onNotification({ ...notification, id: `${notification.id}:${Date.now()}` });
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'votes',
        filter: `investigation_id=eq.${investigationId}`,
      },
      (payload) => {
        const row = payload.new as { value?: number } | undefined;
        if (typeof row?.value !== 'number') return;
        const notification = voteNotificationForRow(row.value);
        if (notification) onNotification({ ...notification, id: `${notification.id}:${Date.now()}` });
      }
    );

  channel.subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

// 調査画面の in-app 通知（issue #114 / §3 P1, §20）。Push には踏み込まない。
// 完了イベントと新規投票を Realtime で受け、toast とタイトルバッジへ反映する。
export function useInvestigationNotifications(
  investigationId: string | undefined,
  subjectKey = 'unscoped-preview',
) {
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastTitle = useRef<string | null>(null);
  const identityRef = useRef({ key: subjectKey, generation: 0 });
  const [identityState, setIdentityState] = useState({ key: subjectKey, generation: 0 });
  const visibleForSubject = identityState.key === subjectKey;
  const identityGeneration = visibleForSubject
    ? identityState.generation
    : identityState.generation + 1;

  useEffect(() => {
    let mounted = true;
    const generation = identityGeneration;
    identityRef.current = { key: subjectKey, generation };
    const isCurrent = () =>
      mounted &&
      identityRef.current.key === subjectKey &&
      identityRef.current.generation === generation;
    const resetForSubject = async () => {
      await Promise.resolve();
      if (!mounted || !isCurrent()) return;
      setIdentityState({ key: subjectKey, generation });
      setNotifications([]);
      setUnreadCount(0);
    };
    void resetForSubject();
    if (!investigationId) return undefined;
    const dispose = createChannel(investigationId, (notification) => {
      if (!isCurrent()) return;
      setNotifications((current) =>
        [notification, ...current].slice(0, MAX_NOTIFICATIONS)
      );
      setUnreadCount((current) => current + 1);
    });
    return () => {
      mounted = false;
      dispose?.();
    };
  }, [identityGeneration, investigationId, subjectKey]);

  // タブ非アクティブ時のタイトルバッジ（軽量通知 §3 P1）。Web のみ。
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const baseTitle = document.title;
    const apply = () => {
      const title = visibleForSubject && unreadCount > 0 ? `(${unreadCount}) ${baseTitle}` : baseTitle;
      document.title = title;
    };
    apply();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setUnreadCount(0);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.title = baseTitle;
      document.removeEventListener('visibilitychange', onVisibility);
      lastTitle.current = null;
    };
  }, [unreadCount, visibleForSubject]);

  const markAllRead = () => setUnreadCount(0);

  return {
    notifications: visibleForSubject ? notifications : [],
    unreadCount: visibleForSubject ? unreadCount : 0,
    markAllRead,
  };
}
