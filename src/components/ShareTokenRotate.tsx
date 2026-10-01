import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { rotateShareToken } from '@/lib/api';
import { colors, radius } from '@/theme';

interface ShareTokenRotateProps {
  investigationId: string;
  /** mock provider がメンバー照合に使う現在ユーザー ID（useAuth().userId） */
  userId?: string;
  /** 再発行成功時に新 token を親へ通知する（共有リンク表示の更新用） */
  onRotated: (newToken: string) => void;
}

// share_token の再発行（rotate）導線（issue #177）。
// owner だけに表示する前提のコンポーネント（出し分けは親が行う）。
// 誤操作で全員のリンクを無効化しないよう、account.tsx の削除ボタンと同じ
// 2 段階確認（1 回目で警告、2 回目で実行）にしている。
export function ShareTokenRotate({ investigationId, userId, onRotated }: ShareTokenRotateProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handlePress = useCallback(async () => {
    setMessage('');
    setErrorMessage('');

    if (!confirming) {
      setConfirming(true);
      return;
    }

    setBusy(true);
    try {
      const newToken = await rotateShareToken(investigationId, userId);
      onRotated(newToken);
      setConfirming(false);
      setMessage('共有リンクを作り直しました。以前のリンクは使えません。');
    } catch {
      setErrorMessage('共有リンクを作り直せませんでした。権限と通信状態を確認してください。');
    } finally {
      setBusy(false);
    }
  }, [confirming, investigationId, onRotated, userId]);

  const handleCancel = useCallback(() => {
    setConfirming(false);
    setMessage('');
    setErrorMessage('');
  }, []);

  return (
    <View style={styles.container}>
      {confirming && (
        <Text testID="inv-share-rotate-warning" accessibilityRole="alert" style={styles.warning}>
          今までの共有リンクは使えなくなります。参加済みのメンバーはそのまま残ります。
        </Text>
      )}
      <View style={styles.buttonRow}>
        <Pressable
          testID="inv-share-rotate"
          accessibilityRole="button"
          accessibilityLabel={
            confirming ? '共有リンクの作り直しを確定' : '共有リンクを作り直す'
          }
          onPress={() => void handlePress()}
          disabled={busy}
          style={[styles.button, confirming && styles.buttonConfirm, busy && styles.buttonBusy]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.danger} />
          ) : (
            <Text style={[styles.buttonText, confirming && styles.buttonTextConfirm]}>
              {confirming ? '本当に作り直す' : '共有リンクを作り直す'}
            </Text>
          )}
        </Pressable>
        {confirming && !busy && (
          <Pressable
            testID="inv-share-rotate-cancel"
            accessibilityRole="button"
            accessibilityLabel="共有リンクの作り直しをやめる"
            onPress={handleCancel}
            style={styles.cancelButton}
          >
            <Text style={styles.cancelButtonText}>キャンセル</Text>
          </Pressable>
        )}
      </View>
      {message ? (
        <Text testID="inv-share-rotate-done" accessibilityLiveRegion="polite" style={styles.message}>
          {message}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text testID="inv-share-rotate-error" accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    alignItems: 'flex-start',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  button: {
    minHeight: 32,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonConfirm: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.danger,
  },
  buttonBusy: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  buttonTextConfirm: {
    color: colors.danger,
  },
  cancelButton: {
    minHeight: 32,
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.xs,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  cancelButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  warning: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.danger,
  },
  message: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  error: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.danger,
  },
});
