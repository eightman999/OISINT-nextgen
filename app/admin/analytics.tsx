import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  loadPrivateAnalytics,
  type PrivateAnalyticsDashboard,
  type PrivateAnalyticsWindow,
} from '@/lib/privateAnalytics';
import { useAuth } from '@/providers/AuthProvider';
import { colors, radius } from '@/theme';

function formatCount(value: number): string {
  return value.toLocaleString('ja-JP');
}

function formatRate(window: PrivateAnalyticsWindow): string {
  if (window.coverage.search === 'not_measured' || window.search_success_rate === null) {
    return '未計測';
  }
  return `${(window.search_success_rate * 100).toFixed(1)}%`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function WindowCard({ window }: { window: PrivateAnalyticsWindow }) {
  return (
    <View testID={`private-analytics-window-${window.days}`} style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{window.days}日間</Text>
        <Text style={styles.cardPeriod}>
          {new Date(window.window_start).toLocaleDateString('ja-JP')}〜
          {new Date(window.window_end).toLocaleDateString('ja-JP')}
        </Text>
      </View>
      <View style={styles.metricGrid}>
        <Metric label="ユニーク利用者" value={formatCount(window.active_users)} />
        <Metric label="調査作成" value={formatCount(window.investigations_created)} />
        <Metric label="調査完了" value={formatCount(window.investigations_completed)} />
        <Metric label="調査失敗" value={formatCount(window.investigations_failed)} />
        <Metric label="共有参加" value={formatCount(window.shared_joins)} />
        <Metric label="検索成功率" value={formatRate(window)} />
      </View>
      <Text style={styles.footnote}>
        検索成功 {formatCount(window.search_successes)} / 失敗 {formatCount(window.search_failures)}
      </Text>
    </View>
  );
}

export default function PrivateAnalyticsScreen() {
  const auth = useAuth();
  const [dashboard, setDashboard] = useState<PrivateAnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canView = auth.status === 'admin' && auth.isAdmin;

  const refresh = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setError(null);
    try {
      setDashboard(await loadPrivateAnalytics());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '運用メトリクスを読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      await Promise.resolve();
      if (mounted) await refresh();
    })();
    return () => {
      mounted = false;
    };
  }, [refresh]);

  const windows = useMemo(
    () => [...(dashboard?.windows ?? [])].sort((left, right) => left.days - right.days),
    [dashboard],
  );

  if (auth.status === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.orange} />
        <Text style={styles.statusText}>権限を確認しています。</Text>
      </View>
    );
  }

  if (!canView) {
    return (
      <View testID="private-analytics-denied" style={styles.centered}>
        <Text style={styles.deniedTitle}>この画面は運用担当者専用です。</Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.backButton}>
          <Text style={styles.backButtonText}>トップへ戻る</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View testID="private-analytics-page" style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.kicker}>OISINT / INTERNAL</Text>
            <Text style={styles.title}>プライバシー配慮メトリクス</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>戻る</Text>
          </Pressable>
        </View>

        <Text style={styles.description}>
          DB内で再計算した集計JSONだけを表示しています。個別の行や識別子はこの画面へ渡しません。
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading && !dashboard ? <ActivityIndicator color={colors.orange} /> : null}
        {windows.map((window) => <WindowCard key={window.days} window={window} />)}
        {dashboard && windows.length === 0 ? (
          <Text style={styles.empty}>集計値はまだありません。</Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: loading }}
          disabled={loading}
          onPress={() => void refresh()}
          style={[styles.refreshButton, loading && styles.disabled]}
        >
          <Text style={styles.refreshButtonText}>{loading ? '更新中…' : '集計を更新'}</Text>
        </Pressable>
        {dashboard?.computed_at ? (
          <Text style={styles.updatedAt}>
            最終更新: {new Date(dashboard.computed_at).toLocaleString('ja-JP')}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    gap: 16,
    padding: 24,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 24,
    backgroundColor: colors.bg,
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  deniedTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  kicker: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  title: {
    marginTop: 4,
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
  },
  description: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  card: {
    gap: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '900',
  },
  cardPeriod: {
    color: colors.textTertiary,
    fontSize: 11,
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    flexGrow: 1,
    flexBasis: '30%',
    minWidth: 130,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  metricLabel: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  metricValue: {
    marginTop: 4,
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
  },
  footnote: {
    color: colors.textTertiary,
    fontSize: 11,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
  },
  empty: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  refreshButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  refreshButtonText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '800',
  },
  backButton: {
    minHeight: 42,
    minWidth: 150,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  backButtonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  backLink: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backLinkText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  updatedAt: {
    color: colors.textTertiary,
    fontSize: 11,
    textAlign: 'right',
  },
  disabled: {
    opacity: 0.6,
  },
});
