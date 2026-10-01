import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePushNotifications } from '@/providers/PushNotificationsProvider';
import { colors, radius } from '@/theme';

export function PushNotificationSettings() {
  const push = usePushNotifications();
  const enabled = push.status === 'granted' && push.preferences.notificationsEnabled;
  const unavailable = push.status === 'unavailable';

  return (
    <View testID="push-notification-settings" style={styles.container}>
      <Text style={styles.kicker}>PUSH NOTIFICATIONS / OPTIONAL</Text>
      <Text style={styles.title}>調査が終わったときだけ知らせる</Text>
      <Text style={styles.description}>
        離れている間に調査が完了した場合、結果へ戻る通知を受け取れます。検索文、好み本文、店名、認証情報は通知本文へ送りません。拒否・停止しても全機能を利用できます。
      </Text>

      {unavailable ? (
        <Text testID="push-unavailable" style={styles.note}>
          Push通知はOneSignal設定済みのiOS / Android Development Buildで利用できます。このWeb画面やExpo Goでは通知許可を要求しません。
        </Text>
      ) : (
        <>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, enabled && styles.statusDotOn]} />
            <Text testID="push-status" style={styles.statusText}>
              {push.status === 'loading'
                ? '設定を確認中'
                : enabled
                  ? '通知を受け取る'
                  : push.status === 'denied'
                    ? 'OSの通知許可が拒否されています'
                    : '通知しない'}
            </Text>
          </View>

          <Pressable
            testID="push-toggle"
            accessibilityRole="button"
            accessibilityLabel={enabled ? 'Push通知を停止' : '説明を確認してPush通知を有効化'}
            accessibilityState={{ disabled: push.busy || push.status === 'loading' }}
            disabled={push.busy || push.status === 'loading'}
            onPress={() => void (enabled ? push.disable() : push.requestEnable())}
            style={[styles.button, (push.busy || push.status === 'loading') && styles.disabled]}
          >
            {push.busy || push.status === 'loading' ? (
              <ActivityIndicator size="small" color={colors.orange} />
            ) : (
              <Text style={styles.buttonText}>{enabled ? '通知を停止' : '通知を有効にする'}</Text>
            )}
          </Pressable>

          <Pressable
            testID="push-group-updates-toggle"
            accessibilityRole="switch"
            accessibilityLabel="参加中グループの投票・条件・順位更新通知"
            accessibilityState={{
              checked: push.preferences.groupUpdatesEnabled,
              disabled: !enabled || push.busy,
            }}
            disabled={!enabled || push.busy}
            onPress={() =>
              void push.setGroupUpdatesEnabled(!push.preferences.groupUpdatesEnabled)
            }
            style={[styles.groupToggle, (!enabled || push.busy) && styles.disabled]}
          >
            <Text style={styles.groupLabel}>グループの投票・条件・順位更新</Text>
            <Text style={styles.groupValue}>
              {push.preferences.groupUpdatesEnabled ? 'ON' : 'OFF'}
            </Text>
          </Pressable>
        </>
      )}

      {push.error ? (
        <Text accessibilityRole="alert" style={styles.error}>{push.error}</Text>
      ) : null}
      <Text style={styles.note}>
        通知先はログイン中のアカウントだけに結び付けます。ログアウトやアカウント切替時は旧通知先を解除します。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 9,
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.textTertiary,
  },
  statusDotOn: {
    backgroundColor: colors.success,
  },
  statusText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
  },
  button: {
    minHeight: 42,
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
  groupToggle: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
  },
  groupLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  groupValue: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '800',
  },
  note: {
    color: colors.textTertiary,
    fontSize: 9,
    lineHeight: 14,
  },
  error: {
    color: colors.danger,
    fontSize: 10,
    lineHeight: 15,
  },
  disabled: {
    opacity: 0.55,
  },
});
