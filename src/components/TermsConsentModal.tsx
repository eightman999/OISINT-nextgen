import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import {
  markTermsConsentRecordedLocally,
  markPendingSignInConsent,
  recordTermsConsentForAccount,
  TERMS_CONSENT_SUMMARY,
} from '@/lib/termsConsent';
import { TermsConsentNotice } from '@/components/TermsConsentNotice';
import { colors, fonts, radius } from '@/theme';

interface TermsConsentModalProps {
  visible: boolean;
  onAccept: () => void;
  onClose: () => void;
  /** 同意直後にsign-inを開始する場合だけ短命handoffを発行する。 */
  handoffToSignIn?: boolean;
}

// #272: 規約の組入れ（民法548条の2）。サインイン / 調査作成 / 招待参加の
// 各導線で、進む前に規約・プライバシーを事前表示して同意を取る。
// 同意は端末（localStorage）へ記録し、認証済みならサーバへも記録する。
export function TermsConsentModal({
  visible,
  onAccept,
  onClose,
  handoffToSignIn = false,
}: TermsConsentModalProps) {
  const [busy, setBusy] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!visible) return null;

  const handleAccept = async () => {
    if (busy || !consentChecked) return;
    setBusy(true);
    setErrorMessage(null);
    const result = await recordTermsConsentForAccount();
    if (!result.ok) {
      setErrorMessage(result.message);
      setBusy(false);
      return;
    }
    // 永続ユーザーはRPC成功後、匿名/未接続は明示同意後にlocalを確定する。
    if (result.subjectId && result.subjectKind) {
      markTermsConsentRecordedLocally(result.acceptedAt, {
        id: result.subjectId,
        kind: result.subjectKind,
      });
    } else {
      markTermsConsentRecordedLocally(result.acceptedAt);
      if (handoffToSignIn) markPendingSignInConsent(result.acceptedAt);
    }
    setBusy(false);
    setConsentChecked(false);
    onAccept();
  };

  const handleClose = () => {
    if (busy) return;
    setConsentChecked(false);
    setErrorMessage(null);
    onClose();
  };

  return (
    <View testID="terms-consent-modal" style={styles.backdrop} accessibilityViewIsModal>
      <View style={styles.card}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.eyebrow}>TERMS / PRIVACY</Text>
          <Text testID="terms-consent-title" style={styles.title}>
            利用規約への同意
          </Text>
          <Text style={styles.summary}>{TERMS_CONSENT_SUMMARY}</Text>

          <TermsConsentNotice
            testID="terms-consent"
            mode="modal"
            checked={consentChecked}
            disabled={busy}
            persistConsent={false}
            onCheckedChange={setConsentChecked}
          />

          <View style={styles.actions}>
            <Pressable
              testID="terms-consent-accept"
              accessibilityRole="button"
              accessibilityLabel="利用規約に同意して進む"
              onPress={handleAccept}
              disabled={busy || !consentChecked}
              accessibilityState={{ busy, disabled: busy || !consentChecked }}
              style={[styles.acceptButton, (busy || !consentChecked) && styles.disabledButton]}
            >
              <Text style={styles.acceptButtonText}>{busy ? '記録中…' : '同意して進む'}</Text>
              <Text style={styles.acceptButtonArrow}>→</Text>
            </Pressable>
            <Pressable
              testID="terms-consent-close"
              accessibilityRole="button"
              accessibilityLabel="同意しないで閉じる"
              onPress={handleClose}
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              style={styles.closeButton}
            >
              <Text style={styles.closeButtonText}>同意しない</Text>
            </Pressable>
          </View>
          {errorMessage ? (
            <Text testID="terms-consent-error" accessibilityRole="alert" style={styles.errorText}>
              {errorMessage}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    backgroundColor: 'rgba(29, 41, 35, 0.55)',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '86%',
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    shadowColor: colors.pureBlack,
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: 20, gap: 14 },
  eyebrow: {
    color: colors.orange,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
    fontFamily: fonts.brand,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  summary: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
  actions: { gap: 10 },
  acceptButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: colors.orange,
  },
  acceptButtonText: {
    color: colors.surface,
    fontSize: 14,
    fontWeight: '800',
  },
  disabledButton: { backgroundColor: colors.border },
  acceptButtonArrow: { color: colors.surface, fontSize: 15 },
  closeButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
  },
});
