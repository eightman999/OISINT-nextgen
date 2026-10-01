import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  loadGrowthSessionMetrics,
  type GrowthSessionMetrics,
} from '@/lib/growthLoop';
import { colors, radius } from '@/theme';

interface GrowthLoopProgressProps {
  investigationId: string;
  refreshKey: string;
  fallbackParticipantCount: number;
}

export function GrowthLoopProgress({
  investigationId,
  refreshKey,
  fallbackParticipantCount,
}: GrowthLoopProgressProps) {
  const [metrics, setMetrics] = useState<GrowthSessionMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadGrowthSessionMetrics(investigationId)
      .then((next) => {
        if (!cancelled) setMetrics(next);
      })
      .catch(() => {
        // 計測の失敗で共同意思決定を止めない。既存snapshotだけを表示する。
      });
    return () => {
      cancelled = true;
    };
  }, [investigationId, refreshKey]);

  const participants = metrics?.events.participant_joined ?? fallbackParticipantCount;
  const activated = metrics?.events.participant_activated;
  const rankingChanged = metrics?.events.ranking_changed;
  const returned = metrics?.events.participant_returned;

  return (
    <View testID="growth-loop-progress" style={styles.container}>
      <Text style={styles.eyebrow}>みんなで決める次の一歩</Text>
      <Text style={styles.guide}>
        最短は候補を1つ開いて投票です。必要なら条件を追加すると、全員の候補ランキングへ反映されます。
      </Text>
      <View style={styles.steps}>
        <Metric label="参加" value={`${participants}人`} />
        <Metric label="最初の行動" value={activated === undefined ? '投票・条件追加' : `${activated}人`} />
        <Metric label="順位変化" value={rankingChanged === undefined ? '反映待ち' : `${rankingChanged}回`} />
        <Metric label="再訪" value={returned === undefined ? '通知から戻れます' : `${returned}人`} />
      </View>
      {rankingChanged !== undefined && rankingChanged > 0 ? (
        <Text testID="growth-ranking-updated" accessibilityLiveRegion="polite" style={styles.updated}>
          投票や条件を反映してランキングが変わりました。
        </Text>
      ) : null}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 14,
    fontWeight: '700',
  },
  guide: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  steps: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metric: {
    minWidth: 118,
    flexGrow: 1,
    gap: 3,
    padding: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  metricLabel: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  metricValue: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  updated: {
    color: colors.info,
    fontSize: 12,
    fontWeight: '600',
  },
});
