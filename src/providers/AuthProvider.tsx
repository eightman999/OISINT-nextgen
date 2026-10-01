import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as ExpoLinking from 'expo-linking';
import { Linking, Platform } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';

import { isLiveDataProvider } from '@/lib/api';
import {
  buildWebAuthRedirect,
  googleAuthFlowFor,
  isAllowedAuthRedirect,
  normalizeEmailLogin,
} from '@/lib/authRouting';
import { clearPersistedAuthSession } from '@/lib/authStorage';
import { clearResearchAgainPrefill } from '@/lib/researchPrefill';
import { syncLocalTermsConsentForAccount } from '@/lib/termsConsent';
import { isTrustedSupabaseOrigin } from '@/lib/trustedOrigins';
import { getOrCreateMockUserId } from '@/lib/mockIdentity';
import {
  clearPendingAccountHandoff,
  completePendingAccountHandoff,
  prepareGoogleAccountHandoff,
} from '@/lib/accountHandoff';

export type AuthStatus =
  | 'loading'
  | 'mock'
  | 'signed_out'
  | 'anonymous'
  | 'authenticated'
  | 'admin'
  | 'disabled'
  | 'error';

interface AuthState {
  userId: string | null;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  status: AuthStatus;
  isAnonymous: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  resetLocalAuthState: () => void;
  authBusy: boolean;
  errorMessage: string | null;
  setDisplayName: (name: string) => void;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  userId: null,
  displayName: null,
  email: null,
  avatarUrl: null,
  status: 'loading',
  isAnonymous: false,
  isAuthenticated: false,
  isAdmin: false,
  resetLocalAuthState: () => {},
  authBusy: false,
  errorMessage: null,
  setDisplayName: () => {},
  signInWithGoogle: async () => {},
  signInWithEmail: async () => {},
  signOut: async () => {},
});

interface AuthProviderProps {
  children: React.ReactNode;
  autoCreateAnonymousSession?: boolean;
}

export function AuthProvider({
  children,
  autoCreateAnonymousSession = true,
}: AuthProviderProps) {
  const authConfigured = isLiveDataProvider && hasSupabaseConfig();
  // Mock UIでも subject-scoped storage と owner 操作を同一ブラウザ内で再現する。
  // リロードごとに別subjectへ変わると、本人の個人化・規約・調査ownerが復元できない。
  const mockUserId = useMemo(() => getOrCreateMockUserId(), []);
  const displayNameSubjectRef = useRef<string | null>(null);
  const authSubjectRef = useRef<{ id: string; kind: 'anonymous' | 'permanent' } | null>(null);
  const [displayName, setDisplayNameState] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [status, setStatus] = useState<AuthStatus>(() =>
    !isLiveDataProvider ? 'mock' : authConfigured ? 'loading' : 'disabled',
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    isLiveDataProvider && !authConfigured
      ? 'ログイン機能は現在設定されていません。'
      : null,
  );

  const applySession = useCallback((session: Session | null) => {
    const user = session?.user ?? null;
    if (!user) {
      clearResearchAgainPrefill();
      displayNameSubjectRef.current = null;
      authSubjectRef.current = null;
      setUserId(null);
      setEmail(null);
      setAvatarUrl(null);
      setDisplayNameState(null);
      setIsAdmin(false);
      setStatus('signed_out');
      return;
    }

    const anonymous = user.is_anonymous === true;
    const nextSubject = { id: user.id, kind: anonymous ? ('anonymous' as const) : ('permanent' as const) };
    const preservesIdentityLink = authSubjectRef.current?.id === nextSubject.id;
    if (!preservesIdentityLink) clearResearchAgainPrefill();
    authSubjectRef.current = nextSubject;
    const sameSubject = displayNameSubjectRef.current === user.id;
    const nextDisplayName = anonymous
      ? null
      : readUserMetadata(user, 'display_name', 'full_name', 'name');
    displayNameSubjectRef.current = user.id;
    setUserId(user.id);
    setEmail(anonymous ? null : user.email ?? null);
    setAvatarUrl(anonymous ? null : readUserMetadata(user, 'avatar_url', 'picture'));
    setDisplayNameState((current) => (sameSubject ? current ?? nextDisplayName : nextDisplayName));
    setStatus(anonymous ? 'anonymous' : 'authenticated');
    setIsAdmin(false);
    setErrorMessage(null);
  }, []);

  // 管理者判定はクライアント入力・metadata・JWTの任意claimを信用せず、
  // DBのserver-side allow-list RPCだけで行う。判定不能時は一般ユーザーのままにする。
  useEffect(() => {
    if (!authConfigured || !userId || (status !== 'authenticated' && status !== 'admin')) {
      return undefined;
    }

    let mounted = true;
    void (async () => {
      try {
        const { supabase } = await import('@/lib/supabase');
        const { data, error } = await supabase.rpc('current_user_is_admin');
        if (!mounted || error || data !== true) return;
        setIsAdmin(true);
        setStatus('admin');
      } catch {
        // migration未適用/一時障害でも、権限をfail-openしない。
      }
    })();

    return () => {
      mounted = false;
    };
  }, [authConfigured, status, userId]);

  useEffect(() => {
    if (!isLiveDataProvider || !authConfigured) return undefined;

    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { supabase } = await import('@/lib/supabase');
        if (!mounted) return;

        const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
          if (mounted) applySession(session);
        });
        unsubscribe = () => listener.subscription.unsubscribe();

        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!mounted) return;

        if (data.session) {
          applySession(data.session);
          return;
        }

        if (!autoCreateAnonymousSession) {
          applySession(null);
          return;
        }

        const { data: anonymousData, error: anonymousError } =
          await supabase.auth.signInAnonymously();
        if (anonymousError || !anonymousData.session) {
          throw anonymousError ?? new Error('anonymous session unavailable');
        }
        if (mounted) applySession(anonymousData.session);
      } catch {
        if (!mounted) return;
        // 認証確認に失敗した場合も、直前subjectの個人情報を残さない。
        // userId/status/errorだけを更新すると、Aの表示名・メール・avatar・管理者権限が
        // error画面へ持ち越されるため、全て同じ失敗境界で消去する。
        displayNameSubjectRef.current = null;
        authSubjectRef.current = null;
        clearResearchAgainPrefill();
        setUserId(null);
        setEmail(null);
        setAvatarUrl(null);
        setDisplayNameState(null);
        setIsAdmin(false);
        setAuthBusy(false);
        setStatus('error');
        setErrorMessage('認証状態を確認できませんでした。時間をおいて再度お試しください。');
      }
    })();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [applySession, authConfigured, autoCreateAnonymousSession]);

  // OAuth redirect後はProviderが再マウントされ、匿名→恒久の遷移を同じ
  // applySession呼出しで観測できない場合がある。pending操作を現在JWT subject
  // にだけ送信し、別subjectへは一切持ち越さない。
  useEffect(() => {
    if (
      !authConfigured ||
      !userId ||
      (status !== 'authenticated' && status !== 'admin')
    ) {
      return undefined;
    }

    let mounted = true;
    void completePendingAccountHandoff(userId).catch(() => {
      if (mounted) {
        setErrorMessage('アカウントの引き継ぎを確認できませんでした。通信状態を確認してください。');
      }
    });
    return () => {
      mounted = false;
    };
  }, [authConfigured, status, userId]);

  // 匿名中に同意した端末は、永続アカウントへ接続した直後にserver正本へ同期する。
  // 同期失敗を成功扱いにせず、次の規約保護操作もTerms gateで停止できるよう可視化する。
  useEffect(() => {
    if (
      !authConfigured ||
      !userId ||
      (status !== 'authenticated' && status !== 'admin')
    ) {
      return undefined;
    }

    let mounted = true;
    void syncLocalTermsConsentForAccount().catch(() => {
      if (mounted) {
        setErrorMessage('利用規約の同意をサーバーへ同期できませんでした。通信状態を確認してください。');
      }
    });
    return () => {
      mounted = false;
    };
  }, [authConfigured, status, userId]);

  const setDisplayName = useCallback((name: string) => {
    setDisplayNameState(name.trim() || null);
  }, []);

  const resetLocalAuthState = useCallback(() => {
    clearPersistedAuthSession();
    applySession(null);
  }, [applySession]);

  const signInWithGoogle = useCallback(async () => {
    if (!isLiveDataProvider || !hasSupabaseConfig()) {
      setErrorMessage('GoogleログインはSupabaseの本番設定後に利用できます。');
      return;
    }

    setAuthBusy(true);
    setErrorMessage(null);
    const shouldLinkIdentity = googleAuthFlowFor(status) === 'link_identity';
    try {
      if (shouldLinkIdentity) {
        if (!userId || !(await prepareGoogleAccountHandoff(userId))) {
          throw new Error('account handoff preparation unavailable');
        }
      }
      const { supabase } = await import('@/lib/supabase');
      const redirectTo = getGoogleRedirectUrl();
      const credentials = {
        provider: 'google' as const,
        options: {
          redirectTo,
          scopes: 'openid email profile',
          skipBrowserRedirect: Platform.OS !== 'web',
        },
      };
      const response =
        shouldLinkIdentity
          ? await supabase.auth.linkIdentity(credentials)
          : await supabase.auth.signInWithOAuth(credentials);

      if (response.error) {
        if (shouldLinkIdentity) clearPendingAccountHandoff();
        throw response.error;
      }
      if (Platform.OS !== 'web' && response.data.url) {
        await Linking.openURL(response.data.url);
      }
    } catch {
      if (shouldLinkIdentity) clearPendingAccountHandoff();
      setErrorMessage('Googleログインを開始できませんでした。設定を確認して再度お試しください。');
    } finally {
      setAuthBusy(false);
    }
  }, [status, userId]);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    if (!isLiveDataProvider || !hasSupabaseConfig()) {
      setErrorMessage('メールログインはSupabaseの本番設定後に利用できます。');
      return;
    }

    setAuthBusy(true);
    setErrorMessage(null);
    try {
      const { supabase } = await import('@/lib/supabase');
      const { error } = await supabase.auth.signInWithPassword({
        email: normalizeEmailLogin(email),
        password,
      });
      if (error) throw error;
    } catch {
      setErrorMessage('メールまたはパスワードが正しくありません。');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (!isLiveDataProvider || !hasSupabaseConfig()) {
      setUserId(null);
      setDisplayNameState(null);
      setIsAdmin(false);
      setStatus(!isLiveDataProvider ? 'mock' : 'disabled');
      return;
    }

    setAuthBusy(true);
    setErrorMessage(null);
    try {
      const { supabase } = await import('@/lib/supabase');
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      applySession(null);
    } catch {
      setErrorMessage('ログアウトできませんでした。通信状態を確認して再度お試しください。');
    } finally {
      setAuthBusy(false);
    }
  }, [applySession]);

  const value = useMemo(
    () => ({
      userId:
        !isLiveDataProvider
          ? autoCreateAnonymousSession
            ? mockUserId
            : null
          : userId,
      displayName,
      email,
      avatarUrl,
      status,
      isAnonymous: status === 'anonymous',
      isAuthenticated: status === 'authenticated' || status === 'admin',
      isAdmin,
      resetLocalAuthState,
      authBusy,
      errorMessage,
      setDisplayName,
      signInWithGoogle,
      signInWithEmail,
      signOut,
    }),
    [
      userId,
      autoCreateAnonymousSession,
      mockUserId,
      displayName,
      email,
      avatarUrl,
      status,
      isAdmin,
      resetLocalAuthState,
      authBusy,
      errorMessage,
      setDisplayName,
      signInWithGoogle,
      signInWithEmail,
      signOut,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function hasSupabaseConfig(): boolean {
  return !!process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY &&
    isTrustedSupabaseOrigin(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '');
}

function getGoogleRedirectUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return buildWebAuthRedirect(window.location.origin);
  }
  const nativeRedirect = ExpoLinking.createURL('/account');
  return isAllowedAuthRedirect(nativeRedirect) ? nativeRedirect : 'oisint://account';
}

function readUserMetadata(user: User, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = user.user_metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function useAuth() {
  return useContext(AuthContext);
}
