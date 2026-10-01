import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  loadPrivateAnalyticsOptOut,
  setPrivateAnalyticsOptOut,
} from '@/lib/privateAnalytics';
import { isLiveDataProvider } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';
import { colors, radius } from '@/theme';

export function PrivateAnalyticsOptOutControl() {
  const auth = useAuth();
  const [optedOut, setOptedOut] = useState<boolean | null>(null);
  const [loadedForUserId, setLoadedForUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible =
    isLiveDataProvider &&
    isSupabaseConfigured &&
    auth.isAuthenticated &&
    !auth.isAnonymous &&
    auth.userId !== null;
  const userId = auth.userId;

  useEffect(() => {
    if (!eligible) {
      return undefined;
    }

    let mounted = true;
    void loadPrivateAnalyticsOptOut()
      .then((value) => {
        if (mounted) {
          setOptedOut(value);
          setError(null);
          setLoadedForUserId(userId);
        }
      })
      .catch((cause: unknown) => {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : '集計設定を読み込めませんでした。');
        }
      });
    return () => {
      mounted = false;
    };
  }, [eligible, userId]);

  if (!eligible) return null;

  const handleToggle = async () => {
    const ready = optedOut !== null && loadedForUserId === userId;
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      setOptedOut(await setPrivateAnalyticsOptOut(!optedOut));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '集計設定を更新できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const ready = optedOut !== null && loadedForUserId === userId;

  return (
    <View testID="private-analytics-opt-out" style={styles.container}>
      <Text style={styles.kicker}>OPERATIONAL METRICS</Text>
      <Text style={styles.title}>利用状況の集計への協力</Text>
      <Text style={styles.description}>
        個人を識別しない集計値の作成に参加します。停止してもサービスの利用には影響しません。
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !ready }}
        disabled={busy || !ready}
        onPress={() => void handleToggle()}
        style={[styles.button, (busy || !ready) && styles.disabled]}
      >
        {busy || !ready ? (
          <ActivityIndicator size="small" color={colors.orange} />
        ) : (
          <Text style={styles.buttonText}>
            {optedOut ? '集計への参加を戻す' : '集計から外す'}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    marginTop: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  kicker: {
    color: colors.textTertiary,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  description: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 17,
  },
  error: {
    color: colors.danger,
    fontSize: 11,
    lineHeight: 16,
  },
  button: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.orange,
    borderRadius: radius.sm,
  },
  buttonText: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.55,
  },
});
