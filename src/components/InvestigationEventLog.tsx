import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getInvestigationEvents } from '@/lib/api';
import { colors, radius } from '@/theme';
import type { Investigation, InvestigationEvent } from '@/types';

// 失敗系イベント（run-investigation / pipeline が記録する event_type。issue #332）
const FAILURE_EVENT_TYPES = new Set(['step_failed', 'candidate_failed', 'no_candidates']);

interface InvestigationEventLogProps {
  investigation: Investigation;
}

// step_failed / candidate_failed は metadata.message に失敗理由の詳細を持つ
// （run-investigation/index.ts:159-165 / _shared/pipeline.ts:326-335）。
function failureDetail(event: InvestigationEvent): string | null {
  const detail = event.metadata?.['message'];
  return typeof detail === 'string' && detail.trim() ? detail : null;
}

function formatEventTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// 調査ログ（investigation_events §5.4）。進行中と失敗時は常時展開して
// 「今どのステップで何が起きているか」を見せ、完了後は折りたたみで控えめに残す。
export function InvestigationEventLog({ investigation }: InvestigationEventLogProps) {
  const [events, setEvents] = useState<InvestigationEvent[]>([]);
  const [expanded, setExpanded] = useState(false);

  const alwaysOpen = investigation.status !== 'complete';

  useEffect(() => {
    let mounted = true;
    // live.ts の Realtime 購読は investigation_events の変更でも investigation を
    // 再取得して listener を呼ぶため、その snapshot 更新に乗せてログも再取得する。
    getInvestigationEvents(investigation.id)
      .then((next) => {
        if (mounted) setEvents(next);
      })
      .catch(() => {
        // ログ取得の一時失敗で画面本体を壊さない。次の更新でリカバリする。
      });
    return () => {
      mounted = false;
    };
  }, [investigation]);

  if (events.length === 0) return null;

  const open = alwaysOpen || expanded;
  // 進行中に最新の動きが先頭へ来るよう新しい順で表示する
  const newestFirst = [...events].reverse();

  return (
    <View testID="inv-event-log" accessibilityLiveRegion="polite" style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>調査ログ</Text>
        <Text style={styles.count}>{events.length}件</Text>
        {!alwaysOpen && (
          <Pressable
            testID="inv-event-log-toggle"
            accessibilityRole="button"
            accessibilityLabel={open ? '調査ログを閉じる' : '調査ログを表示'}
            onPress={() => setExpanded((current) => !current)}
            style={styles.toggleButton}
          >
            <Text style={styles.toggleButtonText}>{open ? '閉じる' : '表示'}</Text>
          </Pressable>
        )}
      </View>
      {open && (
        <View style={styles.list}>
          {newestFirst.map((event) => {
            const failed = FAILURE_EVENT_TYPES.has(event.eventType);
            const detail = failed ? failureDetail(event) : null;
            return (
              <View key={event.id} testID={`inv-event-${event.id}`} style={styles.row}>
                <Text style={styles.time}>{formatEventTime(event.createdAt)}</Text>
                <View style={styles.messageCell}>
                  <Text style={[styles.message, failed && styles.failedMessage]}>
                    {/* message は backend が日本語で記録する（§36 規律7）。無い行は種別を出す */}
                    {event.message ?? event.eventType}
                  </Text>
                  {detail ? <Text style={styles.failedDetail}>{detail}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  count: {
    flex: 1,
    fontSize: 11,
    color: colors.textTertiary,
  },
  toggleButton: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  toggleButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
  },
  list: {
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  time: {
    minWidth: 38,
    fontSize: 11,
    lineHeight: 17,
    color: colors.textTertiary,
  },
  messageCell: {
    flex: 1,
    gap: 2,
  },
  message: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  failedMessage: {
    color: colors.danger,
    fontWeight: '700',
  },
  failedDetail: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.danger,
  },
});
