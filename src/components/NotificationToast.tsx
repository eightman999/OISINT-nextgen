import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';
import type { InAppNotification } from '@/hooks/useInvestigationNotifications';

interface NotificationToastProps {
  notifications: InAppNotification[];
  onDismiss: (id: string) => void;
}

// in-app 通知トースト（issue #114 / §3 P1）。Push 通知には踏み込まない。
// 画面下部に固定表示し、個別に閉じられる。
export function NotificationToast({ notifications, onDismiss }: NotificationToastProps) {
  if (notifications.length === 0) return null;

  return (
    <View testID="in-app-notifications" accessibilityLiveRegion="polite" style={styles.container}>
      {notifications.map((notification) => (
        <View key={notification.id} style={styles.toast}>
          <Text style={styles.message}>{notification.message}</Text>
          <Pressable
            testID={`notification-dismiss-${notification.id}`}
            accessibilityRole="button"
            accessibilityLabel="通知を閉じる"
            onPress={() => onDismiss(notification.id)}
            style={styles.dismiss}
          >
            <Text style={styles.dismissText}>×</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    left: 16,
    gap: 8,
    zIndex: 50,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.black,
    shadowColor: colors.pureBlack,
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  message: {
    flex: 1,
    color: colors.surface,
    fontSize: 13,
    lineHeight: 18,
  },
  dismiss: {
    minWidth: 26,
    minHeight: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  dismissText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '700',
  },
});
