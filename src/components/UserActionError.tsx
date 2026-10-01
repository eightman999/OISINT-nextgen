import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

interface UserActionErrorProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  testID?: string;
}

/**
 * ユーザー操作の失敗を画面へ返す共通表示。
 * 詳細な例外やサーバー応答は受け取らず、呼び出し側が安全な文言へ変換して渡す。
 */
export function UserActionError({
  message,
  onRetry,
  retryLabel = 'もう一度試す',
  testID,
}: UserActionErrorProps) {
  return (
    <View
      testID={testID ? `${testID}-container` : undefined}
      accessibilityLiveRegion="polite"
      style={styles.container}
    >
      <Text
        testID={testID}
        accessibilityRole="alert"
        style={styles.message}
      >
        {message}
      </Text>
      {onRetry ? (
        <Pressable
          testID={testID ? `${testID}-retry` : undefined}
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
          onPress={onRetry}
          style={styles.retryButton}
        >
          <Text style={styles.retryText}>{retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  message: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 20,
  },
  retryButton: {
    alignSelf: 'flex-start',
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  retryText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '700',
  },
});
