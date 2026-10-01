import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

interface InvestigationDeleteControlProps {
  canDelete: boolean;
  busy?: boolean;
  onDelete: () => Promise<void>;
}

/** 調査所有者だけに表示する、取り消し不能操作の明示確認（#167）。 */
export function InvestigationDeleteControl({
  canDelete,
  busy = false,
  onDelete,
}: InvestigationDeleteControlProps) {
  const [confirming, setConfirming] = useState(false);

  if (!canDelete) return null;

  const handlePress = async () => {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    await onDelete();
  };

  return (
    <View testID="inv-delete-control" style={styles.container}>
      <Text style={styles.kicker}>OWNER ONLY / DELETE</Text>
      <Text style={styles.note}>
        この操作は取り消せません。調査本文・条件・投票・進行記録を削除します。共有店舗情報と根拠は残ります。
      </Text>
      <Pressable
        testID="inv-delete-investigation"
        accessibilityRole="button"
        accessibilityLabel={confirming ? '調査の削除を確定する' : 'この調査を削除'}
        accessibilityHint={confirming ? 'もう一度押すと調査を削除します' : '削除確認を表示します'}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => void handlePress()}
        style={[styles.button, confirming && styles.confirmButton, busy && styles.disabled]}
      >
        <Text style={[styles.buttonText, confirming && styles.confirmButtonText]}>
          {busy ? '調査を削除中…' : confirming ? '削除を確定する' : 'この調査を削除'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  kicker: {
    color: colors.danger,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  note: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 16,
  },
  button: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.sm,
  },
  confirmButton: {
    backgroundColor: colors.danger,
  },
  buttonText: {
    color: colors.danger,
    fontSize: 10,
    fontWeight: '800',
  },
  confirmButtonText: {
    color: colors.surface,
  },
  disabled: {
    opacity: 0.6,
  },
});
