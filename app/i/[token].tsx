import { useLocalSearchParams, router } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CorrectionLink } from '@/components/CorrectionLink';
import { DisclaimerNote } from '@/components/DisclaimerNote';
import { Footer } from '@/components/Footer';
import { RankingDisclosure } from '@/components/RankingDisclosure';
import { TermsConsentModal } from '@/components/TermsConsentModal';
import { TermsConsentNotice } from '@/components/TermsConsentNotice';
import { UserActionError } from '@/components/UserActionError';
import { getInvestigationPreviewByShareToken, joinInvestigation } from '@/lib/api';
import { recordGrowthShareOpen } from '@/lib/growthLoop';
import { ensureTermsConsentForAction } from '@/lib/termsConsent';
import { classifyJoinError, joinErrorMessage, type JoinErrorKind } from '@/lib/userFacingErrors';
import { useAuth } from '@/providers/AuthProvider';
import { colors, radius } from '@/theme';
import type { InvestigationPreview } from '@/types';

function isWellFormedShareToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
}

type JoinUiState = {
  subjectKey: string;
  localName: string;
  loading: boolean;
  errorMessage: string;
  showTermsModal: boolean;
  pendingJoinAfterConsent: boolean;
};

function emptyJoinUi(subjectKey: string, localName = ''): JoinUiState {
  return {
    subjectKey,
    localName,
    loading: false,
    errorMessage: '',
    showTermsModal: false,
    pendingJoinAfterConsent: false,
  };
}

export default function JoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const {
    userId,
    displayName,
    setDisplayName,
    status: authStatus,
    isAnonymous,
  } = useAuth();
  const subjectKey = `${authStatus}:${isAnonymous ? `anonymous:${userId ?? 'unknown'}` : userId ?? 'signed_out'}`;
  const [uiState, setUiState] = useState<JoinUiState>(() => emptyJoinUi(subjectKey, displayName ?? ''));
  const [preview, setPreview] = useState<InvestigationPreview | null>(null);
  const [previewErrorToken, setPreviewErrorToken] = useState<string | null>(null);
  const joinInFlightRef = useRef<{ subjectKey: string; generation: number } | null>(null);
  const growthOpenKeysRef = useRef(new Set<string>());
  const subjectGenerationRef = useRef(0);
  const currentSubjectKeyRef = useRef(subjectKey);
  // #272: 規約同意ゲート。未同意なら参加前にモーダルを出す。

  useEffect(() => {
    currentSubjectKeyRef.current = subjectKey;
    subjectGenerationRef.current += 1;
    // Aのjoin promiseはキャンセルできない場合があるため、Bが操作できるよう
    // owner tokenだけを切り替え、Aの完了処理はisCurrentで破棄する。
    joinInFlightRef.current = null;
  }, [subjectKey]);

  const currentUi = uiState.subjectKey === subjectKey ? uiState : emptyJoinUi(subjectKey);
  const updateUi = (update: Partial<JoinUiState>) => {
    setUiState((previous) => ({
      ...(previous.subjectKey === subjectKey ? previous : emptyJoinUi(subjectKey)),
      ...update,
      subjectKey,
    }));
  };

  // 参加前プレビューは §33 の安全な最小集合（タイトル・status・参加人数）のみ。
  // 候補・条件・投票はメンバーになるまで取得しない（issue #335）。
  useEffect(() => {
    if (!isWellFormedShareToken(token)) return undefined;
    let cancelled = false;
    getInvestigationPreviewByShareToken(token)
      .then((result) => {
        if (!cancelled) {
          setPreview(result ?? null);
          setPreviewErrorToken(null);
        }
      })
      .catch(() => {
        // unknown token は undefined、通信障害だけは再試行可能な状態として知らせる。
        if (!cancelled) {
          setPreview(null);
          setPreviewErrorToken(token);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // DBにはshare tokenを保存せず、RPC内で一致した調査×匿名subjectの初回閲覧だけを
  // 最小状態へ圧縮する。計測失敗で参加導線は止めない。
  useEffect(() => {
    if (!preview || !isWellFormedShareToken(token)) return;
    const key = `${subjectKey}:${token}`;
    if (growthOpenKeysRef.current.has(key)) return;
    growthOpenKeysRef.current.add(key);
    void recordGrowthShareOpen(token).catch(() => {
      growthOpenKeysRef.current.delete(key);
    });
  }, [preview, subjectKey, token]);

  // share_token は 16 byte の hex（migrations/0002_tables.sql:28）。形式が違えば
  // join-investigation は必ず 404 を返すため、参加操作を待たずに知らせる（§25.4）。
  const isTokenWellFormed = isWellFormedShareToken(token);
  const tokenFormatError =
    token !== undefined && !isTokenWellFormed
      ? joinErrorMessage('invalid')
      : '';
  const displayedError =
    currentUi.errorMessage ||
    tokenFormatError ||
    (previewErrorToken === token ? joinErrorMessage('network') : '');

  const visibleLocalName = currentUi.localName || displayName || '';

  const handleJoin = async () => {
    const name = visibleLocalName.trim() || 'ゲスト';
    const generation = subjectGenerationRef.current;
    const requestSubjectKey = subjectKey;
    const isCurrent = () =>
      subjectGenerationRef.current === generation &&
      currentSubjectKeyRef.current === requestSubjectKey;
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = { subjectKey: requestSubjectKey, generation };
    updateUi({ errorMessage: '' });
    if (!token) {
      if (isCurrent()) updateUi({ errorMessage: '共有URLに参加用トークンがありません。URLをもう一度開いてください。' });
      joinInFlightRef.current = null;
      return;
    }

    try {
      if (!isTokenWellFormed) {
        if (isCurrent()) updateUi({ errorMessage: joinErrorMessage('invalid') });
        return;
      }

      // #272: 永続ユーザーはserver正本を確認してから、未同意ならモーダルで中断する。
      const consent = await ensureTermsConsentForAction();
      if (!isCurrent()) return;
      if (consent.status === 'needs-consent') {
        updateUi({ pendingJoinAfterConsent: true, showTermsModal: true });
        return;
      }
      if (consent.status === 'error') {
        updateUi({ errorMessage: consent.message });
        return;
      }

      if (!isCurrent()) return;
      setDisplayName(name);
      updateUi({ loading: true });
      const { investigationId } = await joinInvestigation({
        shareToken: token,
        displayName: name,
        userId: userId ?? undefined,
      });
      if (!isCurrent()) return;

      router.push({
        pathname: '/investigations/[id]',
        params: { id: investigationId, shareToken: token, joined: '1' },
      });
    } catch (error) {
      if (!isCurrent()) return;
      const kind: JoinErrorKind = classifyJoinError(error);
      updateUi({ errorMessage: joinErrorMessage(kind) });
    } finally {
      if (isCurrent()) {
        updateUi({ loading: false });
        if (joinInFlightRef.current?.generation === generation) {
          joinInFlightRef.current = null;
        }
      }
    }
  };

  const handleTermsAccepted = () => {
    const shouldJoin = currentUi.pendingJoinAfterConsent;
    updateUi({ showTermsModal: false, pendingJoinAfterConsent: false });
    if (shouldJoin) {
      void handleJoin();
    }
  };

  return (
    <View style={styles.wrapper}>
      {/* share_token 付きURLを検索エンジンへ露出させない（#179 / spec.md §8, §33） */}
      <Head>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <ScrollView
        testID="join-landing"
        style={styles.scrollView}
        contentContainerStyle={styles.container}
      >
        {token && preview ? (
          <View testID="join-preview" style={styles.previewSection}>
            <Text testID="join-context-preview" style={styles.previewTitle}>{preview.title}</Text>
            <Text testID="join-member-count" style={styles.previewMembers}>
              現在 {preview.memberCount}人が参加しています。
            </Text>
            <Text style={styles.previewDescription}>
              参加すると候補と根拠を確認できます。表示名は投票や条件追加のときに使います。
            </Text>

            <Text testID="impulse-exit" style={styles.previewHint}>
              今すぐ決めなくても大丈夫です。参加後に候補と根拠を見てから決められます。
            </Text>
          </View>
        ) : null}

        <Text style={styles.title}>この調査に参加</Text>
        <Text style={styles.description}>
          参加すると候補を確認できます。必要なら表示名を設定できます。
        </Text>
        <View testID="join-first-action-guide" style={styles.firstActionGuide}>
          <Text style={styles.firstActionTitle}>参加後は、まず1票だけでOK</Text>
          <Text style={styles.firstActionText}>
            1. 気になる候補を開いて投票　2. 必要なら条件を追加　3. 更新されたランキングを全員で確認
          </Text>
        </View>
        <TermsConsentNotice testID="terms-consent-join" />

        <Text style={styles.label}>表示名</Text>
        <TextInput
          testID="join-name"
          accessibilityLabel="表示名"
          accessibilityHint="任意です。未入力の場合はゲストとして参加します"
          style={styles.input}
          value={visibleLocalName}
          onChangeText={(value) => updateUi({ localName: value })}
          placeholder="任意（未入力はゲスト）"
          placeholderTextColor={colors.placeholder}
        />

        <Pressable
          testID="join-button"
          accessibilityRole="button"
          accessibilityLabel={currentUi.loading ? '調査に参加中' : '調査に参加'}
          onPress={handleJoin}
          disabled={currentUi.loading}
          style={[
            styles.button,
            currentUi.loading && styles.disabledButton,
          ]}
        >
          {currentUi.loading ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.buttonText}>参加</Text>
          )}
        </Pressable>
        {displayedError ? (
          <UserActionError
            testID="join-error"
            message={displayedError}
            onRetry={isTokenWellFormed ? () => void handleJoin() : undefined}
            retryLabel="参加をもう一度試す"
          />
        ) : null}
        <Pressable
          testID="join-back"
          accessibilityRole="button"
          accessibilityLabel="ホームへ戻る"
          onPress={() => router.replace('/')}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>ホームへ戻る</Text>
        </Pressable>

        {/* 情報の限界表示（#266）: 共有ページに常設（プレビューの有無に依らず表示） */}
        <DisclaimerNote />
        {/* ランキングの性質開示（#269）: 共有ページにも常設（プレビューの有無に依らず表示） */}
        <RankingDisclosure />
        {/* 誤情報の訂正・削除申立て導線（#267）: 免責1行に隣接して常設 */}
        <CorrectionLink targetUrl={token ? `https://oisint.com/i/${token}` : 'https://oisint.com'} />
      </ScrollView>
      <TermsConsentModal
        visible={currentUi.showTermsModal}
        onAccept={handleTermsAccepted}
        onClose={() => {
          updateUi({ showTermsModal: false, pendingJoinAfterConsent: false });
        }}
      />
      <Footer />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 24,
    gap: 12,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  scrollView: {
    flex: 1,
  },
  previewSection: {
    width: '100%',
    gap: 10,
    marginBottom: 12,
  },
  previewTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
  },
  previewMembers: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  previewDescription: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  previewHint: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textTertiary,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    letterSpacing: -0.5,
    color: colors.text,
    marginBottom: 4,
  },
  label: {
    alignSelf: 'flex-start',
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.textSecondary,
  },
  description: {
    alignSelf: 'flex-start',
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  firstActionGuide: {
    width: '100%',
    gap: 5,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  firstActionTitle: {
    color: colors.orange,
    fontSize: 13,
    fontWeight: '700',
  },
  firstActionText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 19,
  },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  button: {
    width: '100%',
    backgroundColor: colors.orange,
    paddingVertical: 14,
    borderRadius: radius.sm,
    alignItems: 'center',
    marginTop: 8,
  },
  disabledButton: {
    backgroundColor: colors.border,
  },
  buttonText: {
    color: colors.surface,
    fontSize: 15,
    fontWeight: '700',
  },
  errorText: {
    alignSelf: 'flex-start',
    fontSize: 12,
    lineHeight: 18,
    color: colors.danger,
  },
  backButton: {
    alignSelf: 'center',
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  backButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
});
