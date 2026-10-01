import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { AgeRequirementNote } from '@/components/AgeRequirementNote';
import { Footer } from '@/components/Footer';
import { GoogleMapsImportPanel } from '@/components/GoogleMapsImportPanel';
import { PrivateAnalyticsOptOutControl } from '@/components/PrivateAnalyticsOptOutControl';
import { PushNotificationSettings } from '@/components/PushNotificationSettings';
import { TermsConsentModal } from '@/components/TermsConsentModal';
import { TermsConsentNotice } from '@/components/TermsConsentNotice';
import {
  AccountOperationError,
  deleteAccount,
  deleteStoredPreferenceProfile,
  loadStoredPreferenceProfile,
  saveAccountDisplayName,
  saveStoredPreferenceProfile,
  type StoredPreferenceProfile,
} from '@/lib/accountRepository';
import {
  clearLocalPersonalization,
  loadLocalPersonalization,
  restoreStoredPersonalizationLocally,
  saveLocalPersonalization,
  type PersonalizationSubject,
  type LocalPersonalizationSnapshot,
} from '@/lib/personalization';
import {
  PERSONALIZATION_CONSENT_LABEL,
  PERSONALIZATION_CONSENT_VERSION,
  PERSONALIZATION_RETENTION_LABEL,
} from '@/lib/personalizationConsent';
import { DATA_SOURCES_PATH } from '@/lib/dataSources';
import {
  accountDeletionRedirect,
  requiresAnonymousEmailSwitchConfirmation,
} from '@/lib/authRouting';
import {
  ensureTermsConsentForAction,
  isTermsConsentRecordedLocally,
  loadAccountTermsConsent,
  markTermsConsentRecordedLocally,
  TERMS_CONSENT_VERSION,
} from '@/lib/termsConsent';
import { useAuth, type AuthStatus } from '@/providers/AuthProvider';
import { colors, darkPanelColors, fonts, radius } from '@/theme';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal-transparent.png');

export default function AccountScreen() {
  const auth = useAuth();
  const { deletion } = useLocalSearchParams<{ deletion?: string }>();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  // #272: サインイン導線の規約同意ゲート。同意後に保留中のサインインを実行する。
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [pendingSignIn, setPendingSignIn] = useState<null | 'email' | 'google'>(null);
  const [pendingEmail, setPendingEmail] = useState<{ email: string; password: string } | null>(
    null,
  );
  const [termsError, setTermsError] = useState<string | null>(null);

  const requireTermsConsent = async (action: 'email' | 'google', email?: string, password?: string) => {
    setTermsError(null);
    const consent = await ensureTermsConsentForAction();
    if (consent.status === 'ready') {
      runSignIn(action, email, password);
      return;
    }
    if (consent.status === 'error') {
      setTermsError(consent.message);
      return;
    }
    setPendingSignIn(action);
    setPendingEmail(
      action === 'email' && email !== undefined && password !== undefined
        ? { email, password }
        : null,
    );
    setShowTermsModal(true);
  };

  const runSignIn = (action: 'email' | 'google', email?: string, password?: string) => {
    if (action === 'email' && email !== undefined && password !== undefined) {
      void auth.signInWithEmail(email, password);
    } else {
      void auth.signInWithGoogle();
    }
  };

  const handleTermsAccepted = () => {
    setTermsError(null);
    setShowTermsModal(false);
    const action = pendingSignIn;
    const emailCreds = pendingEmail;
    setPendingSignIn(null);
    setPendingEmail(null);
    if (action) runSignIn(action, emailCreds?.email, emailCreds?.password);
  };

  return (
    <View testID="account-page" style={styles.screen}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={styles.shell}>
          <AccountHeader authenticated={auth.isAuthenticated} />

          {deletion === 'local-session-warning' ? (
            <Text testID="account-deletion-local-session-warning" accessibilityRole="alert" style={styles.operationError}>
              サーバー上のアカウント削除は完了しました。端末セッションの自動破棄に失敗したため、ローカル認証情報を破棄してこの案内を表示しています。必要なら画面を再読み込みしてください。
            </Text>
          ) : null}

          {auth.status === 'loading' ? <LoadingAccount /> : null}
          {auth.isAuthenticated ? <AccountDashboard isWide={isWide} /> : null}
          {auth.status !== 'loading' && !auth.isAuthenticated ? (
            <>
              <SignInAccount
                isWide={isWide}
                status={auth.status}
                isAnonymous={auth.isAnonymous}
                authBusy={auth.authBusy}
                errorMessage={termsError || auth.errorMessage}
                onEmailSignIn={(email, password) =>
                  void requireTermsConsent('email', email, password)
                }
                onGoogleSignIn={() => void requireTermsConsent('google')}
              />
              {auth.isAnonymous ? <AnonymousAccountDeletion /> : null}
              <View testID="public-maps-import" style={styles.publicImportSection}>
                <Text style={styles.publicImportKicker}>NO LOGIN REQUIRED / OPTIONAL</Text>
                <Text style={styles.publicImportLead}>
                  Maps取込だけならGoogleログインは不要です。集約結果はこの端末だけに保存され、あとから任意で同期できます。
                </Text>
                <GoogleMapsImportPanel isAuthenticated={false} />
              </View>
            </>
          ) : null}

          <DataSourcesLink />
          <AccountDeletionLink />
        </View>
        <Footer />
      </ScrollView>
      <TermsConsentModal
        visible={showTermsModal}
        handoffToSignIn
        onAccept={handleTermsAccepted}
        onClose={() => {
          setShowTermsModal(false);
          setPendingSignIn(null);
          setPendingEmail(null);
        }}
      />
    </View>
  );
}

/** 匿名JWTでも本人が取り消し不能なアカウント削除を開始できる (#167)。 */
function AnonymousAccountDeletion() {
  const { resetLocalAuthState, userId, status } = useAuth();
  const personalizationSubject = useMemo<PersonalizationSubject | undefined>(
    () => (userId ? { id: userId, kind: 'anonymous' } : undefined),
    [userId],
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const subjectKey = `${status}:${userId ?? 'signed_out'}`;
  const identityRef = useRef({ key: subjectKey, generation: 0 });
  const [identityState, setIdentityState] = useState({ key: subjectKey, generation: 0 });
  const visibleForSubject = identityState.key === subjectKey;
  const identityGeneration = visibleForSubject
    ? identityState.generation
    : identityState.generation + 1;

  useEffect(() => {
    const generation = identityGeneration;
    identityRef.current = { key: subjectKey, generation };
    let mounted = true;
    const reset = async () => {
      await Promise.resolve();
      if (!mounted) return;
      setIdentityState({ key: subjectKey, generation });
      setConfirming(false);
      setBusy(false);
      setError('');
    };
    void reset();
    return () => {
      mounted = false;
    };
  }, [identityGeneration, subjectKey]);

  const removeAccount = async () => {
    if (busy || !visibleForSubject) return;
    if (!confirming) {
      setConfirming(true);
      setError('');
      return;
    }

    const generation = identityRef.current.generation;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    setBusy(true);
    setError('');
    try {
      const result = await deleteAccount();
      if (!isCurrent()) return;
      clearLocalPersonalization(personalizationSubject);
      resetLocalAuthState();
      // Auth削除後に匿名JWT付きURLへ戻らず、安全なトップへ遷移する。
      router.replace(accountDeletionRedirect(result.localSessionCleared) as never);
    } catch {
      if (isCurrent()) {
        setError('アカウントを削除できませんでした。権限と通信状態を確認してください。');
        setBusy(false);
      }
    }
  };

  return (
    <View testID="anonymous-account-deletion" style={styles.anonymousDeletionCard}>
      <Text style={styles.cardKicker}>ANONYMOUS ACCOUNT / DELETE</Text>
      <Text style={styles.anonymousDeletionTitle}>匿名で作成したデータを削除する</Text>
      <Text style={styles.anonymousDeletionText}>
        この操作は取り消せません。本人JWTで確認した匿名アカウント、調査、条件、投票、参加記録を削除または匿名化します。共有店舗情報と根拠は残ります。サーバー削除後の端末セッション障害時は、安全な再読み込み案内を表示します。
      </Text>
      <Pressable
        testID="account-delete-anonymous"
        accessibilityRole="button"
        accessibilityLabel={confirming ? '匿名アカウントの削除を確定する' : '匿名アカウントと個人データを削除'}
        accessibilityHint={confirming ? 'もう一度押すと匿名アカウントを削除します' : '削除確認を表示します'}
        accessibilityState={{ disabled: !visibleForSubject || busy }}
        disabled={!visibleForSubject || busy}
        onPress={() => void removeAccount()}
        style={[styles.accountDeleteButton, visibleForSubject && confirming && styles.anonymousDeleteConfirm, (!visibleForSubject || busy) && styles.disabled]}
      >
        <Text style={[styles.accountDeleteButtonText, visibleForSubject && confirming && styles.anonymousDeleteConfirmText]}>
          {busy ? '匿名アカウントを削除中…' : visibleForSubject && confirming ? '削除を確定する' : '匿名アカウントと個人データを削除'}
        </Text>
      </Pressable>
      {error ? <Text accessibilityRole="alert" style={styles.errorMessage}>{error}</Text> : null}
    </View>
  );
}

// データ提供元・ライセンス (#559)。表示義務はこのページで果たすため、
// ログイン状態に関わらず設定画面から常に到達できるようにする。
function DataSourcesLink() {
  return (
    <Pressable
      testID="account-data-sources-link"
      accessibilityRole="link"
      accessibilityLabel="データ提供元とライセンス表示のページを開く"
      onPress={() => router.push(DATA_SOURCES_PATH)}
      style={styles.dataSourcesLink}
    >
      <Text style={styles.dataSourcesLinkText}>データ提供元・ライセンス</Text>
      <Text style={styles.dataSourcesLinkArrow}>→</Text>
    </Pressable>
  );
}

// Google Playの外部アカウント削除URLへ、アカウント画面からも到達できるようにする（#641）。
function AccountDeletionLink() {
  return (
    <Pressable
      testID="account-public-deletion-link"
      accessibilityRole="link"
      accessibilityLabel="公開アカウント削除ページ（Google Play向け）を開く"
      onPress={() => router.push('/account-deletion' as never)}
      style={styles.publicDeletionLink}
    >
      <Text style={styles.publicDeletionLinkText}>公開アカウント削除ページ（Google Play向け）</Text>
      <Text style={styles.dataSourcesLinkArrow}>→</Text>
    </Pressable>
  );
}

function AccountHeader({ authenticated }: { authenticated: boolean }) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="OISINTの検索画面へ戻る"
        onPress={() => router.push('/' as never)}
        style={styles.brandLink}
      >
        <Text style={styles.brandBackArrow}>←</Text>
        <Image source={BRAND_LOGO} resizeMode="contain" style={styles.logo} />
      </Pressable>
      <View style={styles.headerRight}>
        <Pressable
          testID="account-search-link"
          accessibilityRole="button"
          accessibilityLabel="店選び・検索画面を開く"
          onPress={() => router.push('/' as never)}
          style={styles.searchLink}
        >
          <Text style={styles.searchLinkText}>店選び・検索へ</Text>
          <Text style={styles.searchLinkArrow}>→</Text>
        </Pressable>
        {authenticated ? (
          <View style={styles.connectedBadge}>
            <View style={styles.connectedDot} />
            <Text style={styles.connectedText}>ACCOUNT CONNECTED</Text>
          </View>
        ) : null}
        <Pressable
          testID="account-demo-link"
          accessibilityRole="button"
          accessibilityLabel="好み発見デモを開く"
          onPress={() => router.push('/DEMO' as never)}
          style={styles.demoLink}
        >
          <Text style={styles.demoLinkText}>好み発見デモ</Text>
          <Text style={styles.demoLinkArrow}>→</Text>
        </Pressable>
      </View>
    </View>
  );
}

function LoadingAccount() {
  return (
    <View testID="account-loading" style={styles.loadingContainer}>
      <ActivityIndicator color={colors.orange} />
      <Text style={styles.loadingText}>アカウントの状態を確認しています</Text>
    </View>
  );
}

function SignInAccount({
  isWide,
  status,
  isAnonymous,
  authBusy,
  errorMessage,
  onEmailSignIn,
  onGoogleSignIn,
}: {
  isWide: boolean;
  status: AuthStatus;
  isAnonymous: boolean;
  authBusy: boolean;
  errorMessage: string | null;
  onEmailSignIn: (email: string, password: string) => void;
  onGoogleSignIn: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmEmailSwitch, setConfirmEmailSwitch] = useState(false);
  const unavailable = status === 'mock' || status === 'disabled';
  const emailUnavailable = unavailable || !email.trim() || !password;

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (confirmEmailSwitch) setConfirmEmailSwitch(false);
  };

  const handlePasswordChange = (value: string) => {
    setPassword(value);
    if (confirmEmailSwitch) setConfirmEmailSwitch(false);
  };

  const handleEmailSignIn = () => {
    if (requiresAnonymousEmailSwitchConfirmation(isAnonymous, confirmEmailSwitch)) {
      setConfirmEmailSwitch(true);
      return;
    }
    setConfirmEmailSwitch(false);
    onEmailSignIn(email, password);
  };

  return (
    <View style={[styles.signInPage, isWide && styles.signInPageWide]}>
      <View style={[styles.signInHero, isWide && styles.signInHeroWide]}>
        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>ACCOUNT / CONTINUE YOUR ROUTE</Text>
          <View style={styles.eyebrowRule} />
        </View>
        <Text testID="account-sign-in-title" style={styles.signInTitle}>
          好みを、次の店選びまで{`\n`}持っていく。
        </Text>
        <Text style={styles.signInLead}>
          メールまたはGoogleアカウントでログインすると、端末を越えて好みを引き継げます。Google Mapsの保存リストや位置履歴へ、ログインだけでアクセスすることはありません。
        </Text>

        {isAnonymous ? (
          <View style={styles.anonymousNotice}>
            <Text style={styles.anonymousNoticeMark}>↗</Text>
            <Text style={styles.anonymousNoticeText}>
              現在は匿名で利用中です。Google連携では匿名ユーザーIDを維持できます。メールログインは既存アカウントへ切り替わります。端末変更やストレージ消去後に匿名IDを復旧できる保証はないため、引き継ぐ場合は先にGoogle連携を完了してください。
            </Text>
          </View>
        ) : null}

        {status === 'signed_out' ? (
          <View testID="anonymous-recovery-notice" style={styles.anonymousNotice}>
            <Text style={styles.anonymousNoticeMark}>!</Text>
            <Text style={styles.anonymousNoticeText}>
              匿名利用のデータは端末の認証セッションに結び付いています。ストレージ消去・シークレットウィンドウ・別端末から匿名IDを復旧する機能はありません。今後の引き継ぎには、利用中にGoogle連携を完了してください。
            </Text>
          </View>
        ) : null}

        {/* 対象年齢の表示（#273）。Gemini API Additional Terms の年齢要件に基づき、サインイン導線へ常設する。 */}
        <AgeRequirementNote testID="account-age-requirement" style={styles.ageRequirement} />
        <TermsConsentNotice testID="terms-consent-sign-in" />

        <View style={styles.emailAuthForm}>
          <Text style={styles.fieldLabel}>メール</Text>
          <TextInput
            testID="email-sign-in-mail"
            accessibilityLabel="メール"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={handleEmailChange}
            placeholder="メールアドレス"
            placeholderTextColor={colors.textTertiary}
            style={styles.emailAuthInput}
          />
          <Text style={styles.fieldLabel}>パスワード</Text>
          <TextInput
            testID="email-sign-in-password"
            accessibilityLabel="パスワード"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={password}
            onChangeText={handlePasswordChange}
            placeholder="パスワード"
            placeholderTextColor={colors.textTertiary}
            style={styles.emailAuthInput}
          />
          <Pressable
            testID="email-sign-in"
            accessibilityRole="button"
            accessibilityLabel={isAnonymous && confirmEmailSwitch ? 'メールアカウントへ切り替えることを確認してログイン' : 'メールでログイン'}
            accessibilityState={{ disabled: authBusy || emailUnavailable }}
            disabled={authBusy || emailUnavailable}
            onPress={handleEmailSignIn}
            style={[styles.emailAuthButton, (authBusy || emailUnavailable) && styles.disabled]}
          >
            <Text style={styles.emailAuthButtonText}>
              {authBusy
                ? 'ログイン中…'
                : isAnonymous && confirmEmailSwitch
                  ? '切り替えてメールログインする'
                  : 'メールでログイン'}
            </Text>
          </Pressable>
          {isAnonymous && confirmEmailSwitch ? (
            <Text testID="anonymous-email-switch-warning" style={styles.accountSwitchWarning}>
              メールログインは現在の匿名IDを引き継がず、別のアカウントへ切り替えます。匿名IDを維持する場合はGoogle連携を使ってください。
            </Text>
          ) : null}
        </View>

        <View style={styles.authDivider}>
          <View style={styles.authDividerLine} />
          <Text style={styles.authDividerText}>または</Text>
          <View style={styles.authDividerLine} />
        </View>

        <Pressable
          testID="google-sign-in"
          accessibilityRole="button"
          accessibilityLabel="Googleでログイン"
          accessibilityState={{ disabled: authBusy || unavailable }}
          disabled={authBusy || unavailable}
          onPress={onGoogleSignIn}
          style={[styles.googleButton, (authBusy || unavailable) && styles.disabled]}
        >
          <View style={styles.googleMark}>
            <Text style={styles.googleMarkText}>G</Text>
          </View>
          <Text style={styles.googleButtonText}>{authBusy ? '処理中…' : 'Googleで続ける'}</Text>
          <Text style={styles.googleArrow}>→</Text>
        </Pressable>

        <Pressable
          testID="account-guest-search"
          accessibilityRole="button"
          accessibilityLabel="ログインせずに店選び・検索画面へ進む"
          onPress={() => router.push('/' as never)}
          style={styles.guestSearchButton}
        >
          <Text style={styles.guestSearchButtonText}>ログインせずに店選び・検索画面へ</Text>
          <Text style={styles.guestSearchArrow}>→</Text>
        </Pressable>

        {unavailable ? (
          <Text testID="auth-unavailable" style={styles.configNote}>
            このプレビュー環境では認証が未接続です。本番Supabase設定後に有効になります。
          </Text>
        ) : null}
        {errorMessage && !unavailable ? (
          <Text accessibilityRole="alert" style={styles.errorMessage}>{errorMessage}</Text>
        ) : null}
      </View>

      <View style={[styles.trustPanel, isWide && styles.trustPanelWide]}>
        <Text style={styles.trustKicker}>WHAT WE ASK / WHAT WE DO NOT</Text>
        <Text style={styles.trustTitle}>ログインと、地図データは別の同意です。</Text>
        <View style={styles.permissionList}>
          <PermissionRow mark="✓" title="基本プロフィール" text="メールアドレス・表示名・プロフィール画像" />
          <PermissionRow mark="✓" title="好みの同期" text="明示的に保存した集約タグと6軸スコア" />
          <PermissionRow mark="×" title="Mapsへの自動アクセス" text="保存リスト・履歴のOAuth権限は要求しません" negative />
          <PermissionRow mark="×" title="位置履歴の保存" text="タイムライン・座標・生ファイルは対象外です" negative />
        </View>
        <View style={styles.auditNote}>
          <Text style={styles.auditNumber}>02</Text>
          <Text style={styles.auditText}>
            認証操作はSupabase Auth監査ログ、好みの保存・削除は製品監査ログへ分離して記録します。
          </Text>
        </View>
      </View>
    </View>
  );
}

function PermissionRow({
  mark,
  title,
  text,
  negative = false,
}: {
  mark: string;
  title: string;
  text: string;
  negative?: boolean;
}) {
  return (
    <View style={styles.permissionRow}>
      <Text style={[styles.permissionMark, negative && styles.permissionMarkNegative]}>{mark}</Text>
      <View style={styles.permissionCopy}>
        <Text style={styles.permissionTitle}>{title}</Text>
        <Text style={styles.permissionText}>{text}</Text>
      </View>
    </View>
  );
}

export function AccountDashboard({ isWide }: { isWide: boolean }) {
  const {
    userId,
    status,
    displayName,
    email,
    avatarUrl,
    authBusy,
    errorMessage: authError,
    setDisplayName,
    signOut,
    resetLocalAuthState,
  } = useAuth();
  const subjectKey = `${status}:${userId ?? 'signed_out'}`;
  const personalizationSubject = useMemo<PersonalizationSubject | undefined>(
    () => (userId && (status === 'authenticated' || status === 'admin')
      ? { id: userId, kind: 'permanent' }
      : undefined),
    [status, userId],
  );
  const [nameInput, setNameInput] = useState(displayName ?? '');
  const [localProfile, setLocalProfile] = useState<LocalPersonalizationSnapshot | null>(() =>
    personalizationSubject ? loadLocalPersonalization(personalizationSubject) : null,
  );
  const [storedProfile, setStoredProfile] = useState<StoredPreferenceProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAccountDelete, setConfirmAccountDelete] = useState(false);
  const identityRef = useRef({ key: subjectKey, generation: 0 });
  const [identityState, setIdentityState] = useState({ key: subjectKey, generation: 0 });
  // identityStateのkey mismatchはeffectを待たずに旧subjectの個人情報を隠す。
  const identityMatchesRender = identityState.key === subjectKey;
  const identityGeneration = identityMatchesRender
    ? identityState.generation
    : identityState.generation + 1;
  const [loadedSubjectKey, setLoadedSubjectKey] = useState(subjectKey);
  const visibleForSubject = identityMatchesRender && loadedSubjectKey === subjectKey;
  const visibleDisplayName = visibleForSubject ? displayName : null;
  const visibleEmail = visibleForSubject ? email : null;
  const visibleAvatarUrl = visibleForSubject ? avatarUrl : null;
  const visibleNameInput = visibleForSubject ? nameInput : '';
  const visibleStoredProfile = visibleForSubject ? storedProfile : null;
  const visibleLoadingProfile = visibleForSubject ? loadingProfile : true;
  const visibleMessage = visibleForSubject ? message : '';
  const visibleOperationError = visibleForSubject ? operationError : '';
  const visibleBusy = visibleForSubject ? busy : false;

  // #272: サーバ側の同意記録があれば端末にも反映し、モーダルを二度出さない。
  useEffect(() => {
    identityRef.current = { key: subjectKey, generation: identityGeneration };
  }, [identityGeneration, subjectKey]);

  useEffect(() => {
    let mounted = true;
    const generation = identityRef.current.generation;
    const isCurrent = () =>
      mounted &&
      identityRef.current.key === subjectKey &&
      identityRef.current.generation === generation;
    if (!userId || (status !== 'authenticated' && status !== 'admin')) return undefined;
    if (isTermsConsentRecordedLocally({ id: userId, kind: 'permanent' })) return undefined;
    void loadAccountTermsConsent().then((consent) => {
      if (isCurrent() && consent && consent.termsVersion === TERMS_CONSENT_VERSION) {
        markTermsConsentRecordedLocally(consent.termsAcceptedAt, {
          id: userId,
          kind: 'permanent',
        });
      }
    });
    return () => {
      mounted = false;
    };
  }, [status, subjectKey, userId]);

  useEffect(() => {
    let mounted = true;
    const generation = identityGeneration;
    const isCurrent = () =>
      mounted &&
      identityRef.current.key === subjectKey &&
      identityRef.current.generation === generation;
    const load = async () => {
      await Promise.resolve();
      if (!isCurrent()) return;
      setIdentityState({ key: subjectKey, generation });
      setLoadedSubjectKey('');
      setLocalProfile(
        personalizationSubject ? loadLocalPersonalization(personalizationSubject) : null,
      );
      setStoredProfile(null);
      setLoadingProfile(true);
      setBusy(false);
      setMessage('');
      setOperationError('');
      setConfirmDelete(false);
      setConfirmAccountDelete(false);
      setNameInput(displayName ?? '');
      void loadStoredPreferenceProfile()
      .then((profile) => {
        if (isCurrent()) setStoredProfile(profile);
      })
      .catch((error) => {
        if (isCurrent()) {
          setOperationError(
            error instanceof Error ? error.message : '保存済みプロフィールを読み込めませんでした。',
          );
        }
      })
      .finally(() => {
        if (isCurrent()) {
          setLoadingProfile(false);
          setLoadedSubjectKey(subjectKey);
        }
      });
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [displayName, identityGeneration, personalizationSubject, subjectKey]);

  const saveName = async () => {
    if (!visibleForSubject) return;
    const generation = identityRef.current.generation;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    setBusy(true);
    clearMessages();
    try {
      const normalized = await saveAccountDisplayName(nameInput, avatarUrl);
      if (!isCurrent()) return;
      setDisplayName(normalized);
      setMessage('表示名を保存しました。');
    } catch (error) {
      if (isCurrent()) setOperationError(getOperationMessage(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const syncLocalProfile = async () => {
    if (!localProfile || !visibleForSubject || visibleLoadingProfile) return;
    const generation = identityRef.current.generation;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    setBusy(true);
    clearMessages();
    try {
      await saveStoredPreferenceProfile(localProfile, {
        profileExists: visibleStoredProfile !== null,
        updatedAt: visibleStoredProfile?.updatedAt ?? null,
      });
      const profile = await loadStoredPreferenceProfile();
      if (!isCurrent()) return;
      setStoredProfile(profile);
      setMessage('この端末の好みをアカウントへ保存しました。');
    } catch (error) {
      if (isCurrent()) setOperationError(getOperationMessage(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const useStoredProfileOnDevice = () => {
    if (!storedProfile || !visibleForSubject) return;
    const generation = identityRef.current.generation;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    setBusy(true);
    clearMessages();
    try {
      const restored = restoreStoredPersonalizationLocally(storedProfile, personalizationSubject);
      if (!isCurrent()) return;
      setLocalProfile(restored);
      setMessage('アカウントの好みをこの端末へ反映しました。端末内のアレルギー・健康目的は変更していません。');
    } catch (error) {
      if (isCurrent()) setOperationError(getOperationMessage(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const deletePreferences = async () => {
    if (!visibleForSubject) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setMessage('もう一度押すと、端末とアカウントの好みプロフィールを削除します。');
      return;
    }

    const generation = identityRef.current.generation;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    setBusy(true);
    clearMessages();
    try {
      await deleteStoredPreferenceProfile();
      if (!isCurrent()) return;
      clearLocalPersonalization(personalizationSubject);
      setLocalProfile(null);
      setStoredProfile(null);
      setConfirmDelete(false);
      setMessage('好みプロフィールを削除しました。認証アカウントと調査データは残っています。');
    } catch (error) {
      if (isCurrent()) setOperationError(getOperationMessage(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const removeAccount = async () => {
    if (!visibleForSubject) return;
    if (!confirmAccountDelete) {
      setConfirmAccountDelete(true);
      setMessage('もう一度押すと、アカウントと個人データを削除します。共有店舗情報は残る場合があります。');
      return;
    }

    const generation = identityRef.current.generation;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    setBusy(true);
    clearMessages();
    try {
      const result = await deleteAccount();
      if (!isCurrent()) return;
      clearLocalPersonalization(personalizationSubject);
      resetLocalAuthState();
      setLocalProfile(null);
      setStoredProfile(null);
      setConfirmAccountDelete(false);
      setMessage(
        result.localSessionCleared
          ? 'アカウントと個人データを削除しました。'
          : 'サーバー上のアカウントと個人データを削除しました。端末セッションの破棄に失敗したため再読み込み案内を表示します。',
      );
      // Auth削除後に個人用URLへ戻らず、削除済みユーザーでも安全なトップへ遷移する。
      router.replace(accountDeletionRedirect(result.localSessionCleared) as never);
    } catch (error) {
      if (isCurrent()) setOperationError(getOperationMessage(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const handleMapsApplied = (snapshot: LocalPersonalizationSnapshot) => {
    const generation = identityRef.current.generation;
    if (!visibleForSubject) return;
    const isCurrent = () =>
      identityRef.current.key === subjectKey && identityRef.current.generation === generation;
    const ownedSnapshot = personalizationSubject
      ? {
          ...snapshot,
          subjectId: personalizationSubject.id,
          subjectKind: personalizationSubject.kind,
        }
      : snapshot;
    saveLocalPersonalization(ownedSnapshot, personalizationSubject);
    setLocalProfile(ownedSnapshot);
    void loadStoredPreferenceProfile().then((profile) => {
      if (isCurrent()) {
        setStoredProfile(profile);
      }
    }).catch(() => undefined);
  };

  const clearMessages = () => {
    setMessage('');
    setOperationError('');
    setConfirmDelete(false);
    setConfirmAccountDelete(false);
  };

  return (
    <View style={styles.dashboard}>
      <View style={styles.dashboardIntro}>
        <View>
          <Text style={styles.eyebrow}>ACCOUNT / PRIVATE ROUTE</Text>
          <Text testID="account-dashboard-title" style={styles.dashboardTitle}>
            おかえりなさい、{visibleDisplayName || '名前のない旅人'}さん。
          </Text>
          <Text style={styles.dashboardLead}>
            ここで管理するのは、あなたが明示的に保存した好みだけです。
          </Text>
        </View>
        <View style={styles.onboardingPath}>
          <PathStep number="01" label="デモで発見" completed={!!(visibleForSubject && localProfile) || !!visibleStoredProfile} />
          <View style={styles.pathLine} />
          <PathStep number="02" label="Googleで同期" completed />
          <View style={styles.pathLine} />
          <PathStep number="03" label="必要なら補強" completed={visibleStoredProfile?.sourceKinds.includes('maps_takeout') ?? false} />
        </View>
      </View>

      <Pressable
        testID="account-plus-link"
        accessibilityRole="button"
        accessibilityLabel="OISINT Plusのプランを確認する"
        onPress={() => router.push('/paywall' as never)}
        style={styles.plusLink}
      >
        <Text style={styles.plusLinkKicker}>OISINT PLUS</Text>
        <Text style={styles.plusLinkText}>無料プランとPlusの状態を確認する →</Text>
      </Pressable>

      {(visibleMessage || visibleOperationError || (visibleForSubject && authError)) ? (
        <Text
          testID="account-operation-message"
          accessibilityRole="alert"
          style={[styles.operationMessage, !!(visibleOperationError || (visibleForSubject && authError)) && styles.operationError]}
        >
          {visibleOperationError || (visibleForSubject ? authError : null) || `✓ ${visibleMessage}`}
        </Text>
      ) : null}

      <View style={[styles.accountGrid, isWide && styles.accountGridWide]}>
        <View style={styles.identityCard}>
          <Text style={styles.cardKicker}>01 / IDENTITY</Text>
          <View style={styles.identityTop}>
            {visibleAvatarUrl ? (
              <Image source={{ uri: visibleAvatarUrl }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarFallbackText}>{(visibleDisplayName || visibleEmail || 'O').slice(0, 1).toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.identityMeta}>
              <Text style={styles.identityName}>{visibleDisplayName || '表示名未設定'}</Text>
              <Text numberOfLines={1} style={styles.identityEmail}>{visibleEmail || 'メール非公開'}</Text>
            </View>
          </View>

          <Text style={styles.fieldLabel}>表示名</Text>
          <TextInput
            testID="account-display-name"
            accessibilityLabel="表示名"
            value={visibleNameInput}
            maxLength={60}
            onChangeText={setNameInput}
            placeholder="表示名を入力"
            placeholderTextColor={colors.textTertiary}
            style={styles.nameInput}
          />
          <Pressable
            testID="account-save-name"
            accessibilityRole="button"
            accessibilityState={{ disabled: visibleBusy || !visibleNameInput.trim() }}
            disabled={visibleBusy || !visibleNameInput.trim()}
            onPress={() => void saveName()}
            style={[styles.darkButton, (visibleBusy || !visibleNameInput.trim()) && styles.disabled]}
          >
            <Text style={styles.darkButtonText}>表示名を保存</Text>
          </Pressable>
          <Text style={styles.identityFootnote}>メールアドレスは店探しや共有画面には表示しません。</Text>
        </View>

        <View style={styles.preferenceCard}>
          <View style={styles.preferenceHeader}>
            <View>
              <Text style={styles.cardKicker}>02 / PERSONALIZATION</Text>
              <Text style={styles.cardTitle}>好みプロフィール</Text>
            </View>
            <View style={[styles.syncBadge, visibleStoredProfile ? styles.syncBadgeOn : styles.syncBadgeOff]}>
              <Text style={styles.syncBadgeText}>{visibleStoredProfile ? '同期済み' : '未同期'}</Text>
            </View>
          </View>

          {visibleLoadingProfile ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={styles.inlineLoadingText}>保存状態を確認中</Text>
            </View>
          ) : (
            <>
              <View style={styles.profileSources}>
                <ProfileSource
                  label="この端末"
                  available={!!(visibleForSubject && localProfile)}
                  detail={visibleForSubject && localProfile ? `${localProfile.likes.length}件の好きな傾向` : 'デモを試すと作成されます'}
                />
                <ProfileSource
                  label="アカウント"
                  available={!!visibleStoredProfile}
                  detail={visibleStoredProfile ? `最終更新 ${formatDate(visibleStoredProfile.updatedAt)}` : 'まだ保存されていません'}
                />
                <ProfileSource
                  label="行動からの仮説"
                  available={
                    ((visibleForSubject ? localProfile?.learningState.interactionCount : undefined) ??
                      visibleStoredProfile?.learningState.interactionCount ??
                      0) > 0
                  }
                  detail={
                    (((visibleForSubject ? localProfile?.learningState.interactionCount : undefined) ?? visibleStoredProfile?.learningState.interactionCount ?? 0) > 0)
                      ? `${(visibleForSubject ? localProfile?.learningState.interactionCount : undefined) ?? visibleStoredProfile?.learningState.interactionCount ?? 0}件の選択を集約`
                      : '行動を一度だけで好みと決めません'
                  }
                />
              </View>

              <View style={styles.profileTags}>
                {((visibleForSubject ? localProfile?.likes : undefined) ?? visibleStoredProfile?.likes ?? []).slice(0, 8).map((tag) => (
                  <View key={tag} style={styles.profileTag}>
                    <Text style={styles.profileTagText}>{tag}</Text>
                  </View>
                ))}
                {!(visibleForSubject && localProfile) && !visibleStoredProfile ? (
                  <Text style={styles.emptyProfile}>まずは2分の好み発見デモから始められます。</Text>
                ) : null}
              </View>

              {visibleStoredProfile ? (
                <View testID="account-consent-record" style={styles.consentRecord}>
                  <Text style={styles.consentRecordLabel}>CONSENT / {visibleStoredProfile.consentVersion}</Text>
                  <Text style={styles.consentRecordText}>
                    {PERSONALIZATION_CONSENT_LABEL}ことに同意済み（{formatDate(visibleStoredProfile.consentedAt)}）
                  </Text>
                </View>
              ) : null}

              <View style={styles.preferenceActions}>
                <Pressable
                  testID="account-search-button"
                  accessibilityRole="button"
                  accessibilityLabel="この好みで検索画面を開く"
                  onPress={() => router.push('/' as never)}
                  style={styles.searchButton}
                >
                  <Text style={styles.searchButtonText}>この好みで店を探す（検索画面へ）</Text>
                  <Text style={styles.searchButtonArrow}>→</Text>
                </Pressable>
                {visibleStoredProfile ? (
                  <Pressable
                    testID="account-use-stored-profile"
                    accessibilityRole="button"
                    disabled={visibleBusy}
                    onPress={useStoredProfileOnDevice}
                    style={[styles.restoreButton, visibleBusy && styles.disabled]}
                  >
                    <Text style={styles.restoreButtonText}>
                      {visibleForSubject && localProfile ? 'アカウント版をこの端末へ反映' : 'アカウントの好みをこの端末で使う'}
                    </Text>
                  </Pressable>
                ) : null}
                {visibleForSubject && localProfile ? (
                  <Pressable
                    testID="account-sync-profile"
                    accessibilityRole="button"
                    disabled={visibleBusy || visibleLoadingProfile}
                    onPress={() => void syncLocalProfile()}
                    style={[styles.orangeButton, (visibleBusy || visibleLoadingProfile) && styles.disabled]}
                  >
                    <Text style={styles.orangeButtonText}>同意してこの端末の好みを同期</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push('/DEMO' as never)}
                    style={styles.orangeButton}
                  >
                    <Text style={styles.orangeButtonText}>好み発見デモを試す</Text>
                  </Pressable>
                )}
                <Pressable
                  testID="account-delete-preferences"
                  accessibilityRole="button"
                  disabled={visibleBusy || (!(visibleForSubject && localProfile) && !visibleStoredProfile)}
                  onPress={() => void deletePreferences()}
                  style={[
                    styles.deleteButton,
                    confirmDelete && styles.deleteButtonConfirm,
                    (visibleBusy || (!(visibleForSubject && localProfile) && !visibleStoredProfile)) && styles.disabled,
                  ]}
                >
                  <Text style={[styles.deleteButtonText, confirmDelete && styles.deleteButtonTextConfirm]}>
                    {confirmDelete ? '本当に削除する' : '好みだけ削除'}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>

      <View style={styles.importSection}>
        <Text style={styles.sectionNumber}>03</Text>
        <View style={styles.sectionCopy}>
          <Text style={styles.sectionKicker}>OPTIONAL SIGNALS</Text>
          <Text style={styles.sectionTitle}>知っている好みを、少しだけ足す。</Text>
          <Text style={styles.sectionLead}>使わなくてもOISINTは利用できます。必要な人だけ、明示的に追加してください。</Text>
        </View>
      </View>
      <GoogleMapsImportPanel
        isAuthenticated
        subject={personalizationSubject}
        baseProfile={visibleStoredProfile}
        baseProfileLoaded={!visibleLoadingProfile}
        onApplied={handleMapsApplied}
      />

      <View style={[styles.securityCard, isWide && styles.securityCardWide]}>
        <View style={styles.securityCopy}>
          <Text style={styles.cardKicker}>DATA & AUDIT BOUNDARY</Text>
          <Text style={styles.securityTitle}>保存するものを、小さく保つ。</Text>
          <Text style={styles.securityText}>
            好みプロフィールには集約タグ、6軸スコア、確信度と観測回数だけを保存します。検索文、店名、個別の行動ID、デモの回答文、アレルギー、位置履歴、座標、Takeoutファイル、Googleのアクセストークンは保存対象外です。
          </Text>
          <Text style={styles.retentionText}>
            {PERSONALIZATION_RETENTION_LABEL} 同意記録は {PERSONALIZATION_CONSENT_VERSION} と利用目的だけを保持します。
          </Text>
          <PrivateAnalyticsOptOutControl />
          <PushNotificationSettings />
        </View>
        <View style={styles.securityActions}>
          <Pressable
            testID="account-sign-out"
            accessibilityRole="button"
            disabled={authBusy}
            onPress={() => void signOut()}
            style={[styles.logoutButton, authBusy && styles.disabled]}
          >
            <Text style={styles.logoutButtonText}>{authBusy ? 'ログアウト中…' : 'ログアウト'}</Text>
          </Pressable>
          <Text style={styles.logoutNote}>ログアウトしても、この端末のローカル設定は自動削除しません。</Text>
          <Pressable
            testID="account-delete-account"
            accessibilityRole="button"
            disabled={authBusy || visibleBusy}
            onPress={() => void removeAccount()}
            style={[styles.accountDeleteButton, (authBusy || visibleBusy) && styles.disabled]}
          >
            <Text style={styles.accountDeleteButtonText}>
              {confirmAccountDelete ? '本当にアカウントを削除する' : 'アカウントと個人データを削除'}
            </Text>
          </Pressable>
          <Text style={styles.accountDeleteNote}>
            個人属性ベクトル、好み、調査・投票・参加記録を削除または匿名化します。店舗の共有資産は対象外です。サーバー削除後の端末セッション障害時は、安全な再読み込み案内を表示します。
          </Text>
          <Text style={styles.accountDeleteNote} testID="account-subscription-delete-note">
            App Store / Google Play等のサブスクリプションはアカウント削除では解約されません。先に各ストアで管理・解約してください。
          </Text>
        </View>
      </View>
    </View>
  );
}

function PathStep({ number, label, completed }: { number: string; label: string; completed: boolean }) {
  return (
    <View style={styles.pathStep}>
      <View style={[styles.pathCircle, completed && styles.pathCircleComplete]}>
        <Text style={[styles.pathNumber, completed && styles.pathNumberComplete]}>{completed ? '✓' : number}</Text>
      </View>
      <Text style={styles.pathLabel}>{label}</Text>
    </View>
  );
}

function ProfileSource({ label, available, detail }: { label: string; available: boolean; detail: string }) {
  return (
    <View style={styles.profileSource}>
      <View style={[styles.profileSourceDot, available && styles.profileSourceDotOn]} />
      <View>
        <Text style={styles.profileSourceLabel}>{label}</Text>
        <Text style={styles.profileSourceDetail}>{detail}</Text>
      </View>
    </View>
  );
}

function getOperationMessage(error: unknown): string {
  if (error instanceof AccountOperationError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '操作を完了できませんでした。時間をおいて再度お試しください。';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日時不明';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium' }).format(date);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scrollView: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  shell: {
    width: '100%',
    maxWidth: 1180,
    marginHorizontal: 'auto',
    paddingHorizontal: 24,
    paddingBottom: 72,
  },
  header: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  brandBackArrow: {
    color: colors.textSecondary,
    fontSize: 18,
    fontWeight: '700',
  },
  logo: { width: 118, height: 36 },
  headerRight: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  searchLink: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.orange,
    borderRadius: radius.pill,
    backgroundColor: colors.orangeFaint,
  },
  searchLinkText: { color: colors.orange, fontSize: 10, fontWeight: '800' },
  searchLinkArrow: { color: colors.orange, fontSize: 12, fontWeight: '800' },
  connectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: radius.pill,
  },
  connectedDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.success },
  connectedText: { color: colors.success, fontFamily: fonts.brand, fontSize: 7, fontWeight: '800', letterSpacing: 0.8 },
  demoLink: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.text,
    borderRadius: radius.pill,
  },
  demoLinkText: { color: colors.text, fontSize: 10, fontWeight: '700' },
  demoLinkArrow: { color: colors.orange, fontSize: 12, fontWeight: '800' },
  loadingContainer: { minHeight: 540, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: colors.textSecondary, fontSize: 11 },
  signInPage: { gap: 54, paddingVertical: 64 },
  signInPageWide: { flexDirection: 'row', alignItems: 'flex-start', gap: 58 },
  publicImportSection: { marginTop: 12, paddingTop: 34, borderTopWidth: 1, borderTopColor: colors.border },
  publicImportKicker: { color: colors.info, fontFamily: fonts.brand, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  publicImportLead: { maxWidth: 720, marginTop: 7, marginBottom: 16, color: colors.textSecondary, fontSize: 10, lineHeight: 18 },
  anonymousDeletionCard: { maxWidth: 720, marginTop: 24, padding: 22, borderWidth: 1, borderColor: colors.red, borderRadius: radius.md, backgroundColor: colors.surface },
  anonymousDeletionTitle: { marginTop: 7, color: colors.text, fontSize: 18, fontWeight: '800' },
  anonymousDeletionText: { marginTop: 8, color: colors.textSecondary, fontSize: 10, lineHeight: 18 },
  anonymousDeleteConfirm: { backgroundColor: colors.red },
  anonymousDeleteConfirmText: { color: colors.surface },
  signInHero: { maxWidth: 720 },
  signInHeroWide: { flex: 1, maxWidth: 620 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eyebrow: { color: colors.orange, fontFamily: fonts.brand, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  eyebrowRule: { width: 60, height: 1, backgroundColor: colors.orange },
  signInTitle: { marginTop: 20, color: colors.text, fontSize: 42, fontWeight: '800', lineHeight: 58, letterSpacing: -1.5 },
  signInLead: { maxWidth: 650, marginTop: 19, color: colors.textSecondary, fontSize: 13, lineHeight: 25 },
  anonymousNotice: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 22,
    padding: 14,
    borderLeftWidth: 2,
    borderLeftColor: colors.info,
    backgroundColor: colors.infoSoft,
  },
  anonymousNoticeMark: { color: colors.info, fontSize: 16, fontWeight: '800' },
  anonymousNoticeText: { flex: 1, color: colors.textSecondary, fontSize: 9, lineHeight: 17 },
  emailAuthForm: { width: '100%', maxWidth: 430, gap: 7, marginTop: 28 },
  emailAuthInput: { minHeight: 46, marginBottom: 5, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, color: colors.text, fontSize: 11 },
  emailAuthButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 3, borderRadius: radius.sm, backgroundColor: colors.text },
  emailAuthButtonText: { color: colors.surface, fontSize: 11, fontWeight: '800' },
  accountSwitchWarning: { color: colors.warning, fontSize: 9, lineHeight: 16 },
  authDivider: { width: '100%', maxWidth: 430, flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 18 },
  authDividerLine: { flex: 1, height: 1, backgroundColor: colors.borderSoft },
  authDividerText: { color: colors.textTertiary, fontSize: 8 },
  googleButton: {
    width: '100%',
    maxWidth: 430,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  googleMark: { width: 33, height: 33, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.googleSoft },
  googleMarkText: { color: colors.googleBlue, fontFamily: fonts.brand, fontSize: 16, fontWeight: '800' },
  googleButtonText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: '800' },
  googleArrow: { color: colors.orange, fontFamily: fonts.brand, fontSize: 16, fontWeight: '800' },
  guestSearchButton: {
    width: '100%',
    maxWidth: 430,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  guestSearchButtonText: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  guestSearchArrow: { color: colors.orange, fontSize: 13, fontWeight: '800' },
  ageRequirement: { maxWidth: 430, marginTop: 18 },
  configNote: { maxWidth: 430, marginTop: 11, color: colors.textTertiary, fontSize: 8, lineHeight: 15 },
  errorMessage: { maxWidth: 430, marginTop: 11, padding: 10, borderRadius: radius.sm, backgroundColor: colors.dangerSoft, color: colors.danger, fontSize: 9, fontWeight: '700' },
  dataSourcesLink: {
    marginTop: 24,
    paddingVertical: 14,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  dataSourcesLinkText: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  dataSourcesLinkArrow: { color: colors.orange, fontSize: 13, fontWeight: '800' },
  publicDeletionLink: {
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  publicDeletionLinkText: { color: colors.textSecondary, fontSize: 10, fontWeight: '700' },
  trustPanel: { padding: 28, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  trustPanelWide: { flex: 1, maxWidth: 510 },
  trustKicker: { color: colors.info, fontFamily: fonts.brand, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  trustTitle: { marginTop: 7, color: colors.text, fontSize: 20, fontWeight: '800' },
  permissionList: { marginTop: 20, borderTopWidth: 1, borderTopColor: colors.borderSoft },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.borderSoft },
  permissionMark: { width: 20, color: colors.success, fontFamily: fonts.brand, fontSize: 15, fontWeight: '800' },
  permissionMarkNegative: { color: colors.red },
  permissionCopy: { flex: 1 },
  permissionTitle: { color: colors.text, fontSize: 10, fontWeight: '800' },
  permissionText: { marginTop: 2, color: colors.textTertiary, fontSize: 8 },
  auditNote: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 20, padding: 15, borderRadius: radius.sm, backgroundColor: colors.canvas },
  auditNumber: { color: colors.orange, fontFamily: fonts.brand, fontSize: 18, fontWeight: '800' },
  auditText: { flex: 1, color: colors.textSecondary, fontSize: 8, lineHeight: 15 },
  disabled: { opacity: 0.38 },
  dashboard: { paddingTop: 54 },
  dashboardIntro: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 26, marginBottom: 28 },
  dashboardTitle: { marginTop: 10, color: colors.text, fontSize: 31, fontWeight: '800', lineHeight: 43 },
  dashboardLead: { marginTop: 8, color: colors.textSecondary, fontSize: 11 },
  plusLink: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', marginBottom: 20, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.orange, borderRadius: radius.sm, backgroundColor: colors.orangeFaint },
  plusLinkKicker: { color: colors.orange, fontSize: 8, fontWeight: '800', letterSpacing: 1.3 },
  plusLinkText: { marginTop: 4, color: colors.text, fontSize: 12, fontWeight: '800' },
  onboardingPath: { flexDirection: 'row', alignItems: 'flex-start' },
  pathStep: { width: 74, alignItems: 'center' },
  pathCircle: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, backgroundColor: colors.canvas },
  pathCircleComplete: { borderColor: colors.success, backgroundColor: colors.successSoft },
  pathNumber: { color: colors.textTertiary, fontFamily: fonts.brand, fontSize: 8, fontWeight: '800' },
  pathNumberComplete: { color: colors.success },
  pathLabel: { marginTop: 6, color: colors.textTertiary, fontSize: 7, fontWeight: '700', textAlign: 'center' },
  pathLine: { width: 28, height: 1, marginTop: 13, backgroundColor: colors.border },
  operationMessage: { marginBottom: 18, padding: 12, borderRadius: radius.sm, backgroundColor: colors.successSoft, color: colors.success, fontSize: 9, fontWeight: '700' },
  operationError: { backgroundColor: colors.dangerSoft, color: colors.danger },
  accountGrid: { gap: 16 },
  accountGridWide: { flexDirection: 'row', alignItems: 'stretch' },
  identityCard: { flex: 0.82, minWidth: 280, maxWidth: '100%', padding: 24, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  cardKicker: { color: colors.orange, fontFamily: fonts.brand, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  identityTop: { flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 20, marginBottom: 22 },
  avatar: { width: 48, height: 48, borderRadius: radius.pill },
  avatarFallback: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.text },
  avatarFallbackText: { color: colors.surface, fontFamily: fonts.brand, fontSize: 18, fontWeight: '800' },
  identityMeta: { flex: 1 },
  identityName: { color: colors.text, fontSize: 15, fontWeight: '800' },
  identityEmail: { marginTop: 4, color: colors.textTertiary, fontSize: 8 },
  fieldLabel: { color: colors.textSecondary, fontSize: 9, fontWeight: '700' },
  nameInput: { minHeight: 44, marginTop: 7, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.canvas, color: colors.text, fontSize: 11 },
  darkButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', marginTop: 10, borderRadius: radius.sm, backgroundColor: colors.text },
  darkButtonText: { color: colors.surface, fontSize: 10, fontWeight: '800' },
  identityFootnote: { marginTop: 13, color: colors.textTertiary, fontSize: 7, lineHeight: 13 },
  preferenceCard: { flex: 1.35, minWidth: 300, maxWidth: '100%', padding: 24, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.canvas },
  preferenceHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  cardTitle: { marginTop: 6, color: colors.text, fontSize: 18, fontWeight: '800' },
  syncBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  syncBadgeOn: { backgroundColor: colors.successSoft },
  syncBadgeOff: { backgroundColor: colors.surfaceSoft },
  syncBadgeText: { color: colors.textSecondary, fontSize: 8, fontWeight: '700' },
  inlineLoading: { minHeight: 150, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  inlineLoadingText: { color: colors.textSecondary, fontSize: 9 },
  profileSources: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20 },
  profileSource: { minWidth: 180, maxWidth: '100%', flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radius.sm, backgroundColor: colors.surface },
  profileSourceDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.border },
  profileSourceDotOn: { backgroundColor: colors.success },
  profileSourceLabel: { color: colors.text, fontSize: 9, fontWeight: '800' },
  profileSourceDetail: { marginTop: 2, color: colors.textTertiary, fontSize: 7 },
  profileTags: { minHeight: 56, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 6, marginTop: 18 },
  profileTag: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surface },
  profileTagText: { color: colors.textSecondary, fontSize: 8, fontWeight: '700' },
  emptyProfile: { color: colors.textTertiary, fontSize: 9, lineHeight: 17 },
  consentRecord: { marginTop: 13, padding: 11, borderLeftWidth: 2, borderLeftColor: colors.info, backgroundColor: colors.infoSoft },
  consentRecordLabel: { color: colors.info, fontFamily: fonts.brand, fontSize: 7, fontWeight: '800', letterSpacing: 0.7 },
  consentRecordText: { marginTop: 4, color: colors.textSecondary, fontSize: 8, lineHeight: 14 },
  preferenceActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  searchButton: {
    minHeight: 44,
    flexBasis: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    backgroundColor: colors.text,
  },
  searchButtonText: { color: colors.surface, fontSize: 10, fontWeight: '800' },
  searchButtonArrow: { color: colors.orange, fontSize: 12, fontWeight: '800' },
  restoreButton: { minHeight: 42, flexBasis: '100%', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderWidth: 1, borderColor: colors.info, borderRadius: radius.sm, backgroundColor: colors.infoSoft },
  restoreButtonText: { color: colors.info, fontSize: 9, fontWeight: '800' },
  orangeButton: { minHeight: 42, flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.sm, backgroundColor: colors.orange },
  orangeButtonText: { color: colors.surface, fontSize: 9, fontWeight: '800' },
  deleteButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  deleteButtonConfirm: { borderColor: colors.danger, backgroundColor: colors.danger },
  deleteButtonText: { color: colors.textSecondary, fontSize: 9, fontWeight: '700' },
  deleteButtonTextConfirm: { color: colors.surface },
  importSection: { flexDirection: 'row', alignItems: 'flex-start', gap: 18, marginTop: 44, marginBottom: 17 },
  sectionNumber: { color: colors.info, fontFamily: fonts.brand, fontSize: 28, fontWeight: '800' },
  sectionCopy: { flex: 1 },
  sectionKicker: { color: colors.info, fontFamily: fonts.brand, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  sectionTitle: { marginTop: 5, color: colors.text, fontSize: 20, fontWeight: '800' },
  sectionLead: { marginTop: 5, color: colors.textSecondary, fontSize: 9, lineHeight: 16 },
  securityCard: { gap: 22, marginTop: 26, padding: 25, borderWidth: 1, borderColor: colors.text, borderRadius: radius.md, backgroundColor: colors.text },
  securityCardWide: { flexDirection: 'row', alignItems: 'center' },
  securityCopy: { flex: 1 },
  securityTitle: { marginTop: 7, color: colors.surface, fontSize: 18, fontWeight: '800' },
  securityText: { maxWidth: 700, marginTop: 8, color: darkPanelColors.body, fontSize: 9, lineHeight: 17 },
  retentionText: { maxWidth: 700, marginTop: 8, color: darkPanelColors.bodyMuted, fontSize: 8, lineHeight: 15 },
  securityActions: { minWidth: 190, maxWidth: '100%' },
  logoutButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: darkPanelColors.accountActionBorder, borderRadius: radius.sm },
  logoutButtonText: { color: colors.surface, fontSize: 10, fontWeight: '800' },
  logoutNote: { maxWidth: 210, marginTop: 7, color: darkPanelColors.bodyMuted, fontSize: 7, lineHeight: 13, textAlign: 'center' },
  accountDeleteButton: { minHeight: 38, alignItems: 'center', justifyContent: 'center', marginTop: 16, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.red, borderRadius: radius.sm },
  accountDeleteButtonText: { color: colors.red, fontSize: 9, fontWeight: '800', textAlign: 'center' },
  accountDeleteNote: { maxWidth: 220, marginTop: 7, color: darkPanelColors.bodyMuted, fontSize: 7, lineHeight: 13, textAlign: 'center' },
});
