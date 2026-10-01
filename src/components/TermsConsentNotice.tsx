import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import {
  markTermsConsentRecordedLocally,
  recordTermsConsentForAccount,
  TERMS_CONSENT_LABEL,
} from '@/lib/termsConsent';
import { colors, radius } from '@/theme';

interface TermsConsentNoticeProps {
  testID: string;
  mode?: 'notice' | 'modal';
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** noticeではチェック時に正式な同意記録まで完了させる。modalは親のacceptで記録する。 */
  persistConsent?: boolean;
}

/** 同意操作の前に常時表示する規約・プライバシーへの到達点。 */
export function TermsConsentNotice({
  testID,
  mode = 'notice',
  checked,
  disabled = false,
  onCheckedChange,
  persistConsent,
}: TermsConsentNoticeProps) {
  const [uncontrolledChecked, setUncontrolledChecked] = useState(false);
  const [recording, setRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isChecked = checked ?? uncontrolledChecked;
  const shouldPersistConsent = persistConsent ?? mode === 'notice';
  const isDisabled = disabled || recording;

  const handleCheckedChange = async () => {
    if (isDisabled) return;
    const nextChecked = !isChecked;
    // 一度記録した同意をこのチェックボックスの解除で取り消すことはできない。
    if (!nextChecked && shouldPersistConsent) return;

    if (!shouldPersistConsent || checked !== undefined) {
      if (checked === undefined) setUncontrolledChecked(nextChecked);
      onCheckedChange?.(nextChecked);
      return;
    }

    setRecording(true);
    setErrorMessage(null);
    const result = await recordTermsConsentForAccount();
    if (!result.ok) {
      setErrorMessage(result.message);
      setRecording(false);
      return;
    }

    if (result.subjectId && result.subjectKind) {
      markTermsConsentRecordedLocally(result.acceptedAt, {
        id: result.subjectId,
        kind: result.subjectKind,
      });
    } else {
      markTermsConsentRecordedLocally(result.acceptedAt);
    }
    setUncontrolledChecked(true);
    setRecording(false);
  };

  return (
    <View testID={testID} style={styles.container}>
      <Text testID={`${testID}-text`} style={styles.text}>
        {mode === 'modal'
          ? '利用規約・プライバシーポリシーを確認し、下のボタンで明示的に同意してください。'
          : '同意が必要な操作では、未同意の場合に確認画面が表示されます。利用規約とプライバシーポリシーを確認できます。'}
      </Text>
      <View style={styles.links}>
        <Pressable
          testID={`${testID}-terms-link`}
          accessibilityRole="link"
          accessibilityLabel="利用規約のページを開く"
          onPress={() => router.push({ pathname: '/terms' } as never)}
          style={styles.link}
        >
          <Text style={styles.linkText}>利用規約を読む</Text>
        </Pressable>
        <Pressable
          testID={`${testID}-privacy-link`}
          accessibilityRole="link"
          accessibilityLabel="プライバシーポリシーのページを開く"
          onPress={() => router.push({ pathname: '/privacy' } as never)}
          style={styles.link}
        >
          <Text style={styles.linkText}>プライバシーポリシーを読む</Text>
        </Pressable>
      </View>
      <Pressable
        testID={`${testID}-consent`}
        accessibilityRole="checkbox"
        accessibilityLabel={TERMS_CONSENT_LABEL}
        accessibilityState={{ checked: isChecked, disabled: isDisabled, busy: recording }}
        aria-checked={isChecked}
        disabled={isDisabled}
        onPress={() => void handleCheckedChange()}
        style={[styles.consentRow, isDisabled && styles.disabledConsent]}
      >
        <View style={[styles.checkbox, isChecked && styles.checkboxChecked]}>
          {isChecked ? <Text style={styles.checkmark}>✓</Text> : null}
        </View>
        <Text style={styles.consentText}>{TERMS_CONSENT_LABEL}</Text>
      </Pressable>
      {errorMessage ? (
        <Text testID={`${testID}-consent-error`} accessibilityRole="alert" style={styles.errorText}>
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceQuiet,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  text: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  link: {
    minHeight: 28,
    justifyContent: 'center',
  },
  linkText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '700',
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    minHeight: 28,
    paddingTop: 2,
  },
  disabledConsent: { opacity: 0.6 },
  checkbox: {
    width: 19,
    height: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  checkboxChecked: {
    borderColor: colors.orange,
    backgroundColor: colors.orange,
  },
  checkmark: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  consentText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
  },
});
