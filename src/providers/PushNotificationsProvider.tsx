import { router } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { isLiveDataProvider } from '@/lib/api';
import {
  canUseNativePush,
  createNativePushProvider,
  type NativePushProvider,
} from '@/lib/onesignalPushProvider';
import {
  DEFAULT_PUSH_PREFERENCES,
  PushIdentityController,
  type PushPreferences,
} from '@/lib/pushNotifications';
import {
  loadPushPreferences,
  recordPushOpen,
  savePushPreferences,
} from '@/lib/pushNotificationRepository';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type PushRuntimeStatus =
  | 'loading'
  | 'unavailable'
  | 'disabled'
  | 'granted'
  | 'denied'
  | 'error';

interface PushNotificationsContextValue {
  status: PushRuntimeStatus;
  preferences: PushPreferences;
  busy: boolean;
  error: string | null;
  requestEnable(): Promise<void>;
  disable(): Promise<void>;
  setGroupUpdatesEnabled(enabled: boolean): Promise<void>;
}

const PushNotificationsContext = createContext<PushNotificationsContextValue | null>(null);

export function PushNotificationsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [status, setStatus] = useState<PushRuntimeStatus>('loading');
  const [preferences, setPreferences] = useState<PushPreferences>(DEFAULT_PUSH_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState(false);
  const providerRef = useRef<NativePushProvider | null>(null);
  const identityRef = useRef<PushIdentityController | null>(null);
  const generationRef = useRef(0);
  const eligible =
    isLiveDataProvider &&
    isSupabaseConfigured &&
    auth.userId !== null &&
    !auth.isAnonymous &&
    (auth.status === 'authenticated' || auth.status === 'admin');

  const failClosed = useCallback(async (message?: string) => {
    const provider = providerRef.current;
    try {
      await provider?.setSubscriptionEnabled(false);
      await identityRef.current?.sync(null);
      await provider?.setConsentGiven(false);
    } catch {
      // 外部SDK停止失敗を成功扱いにはしないが、元の例外本文もUI/ログへ出さない。
    }
    if (message) {
      setError(message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let removeClickListener: (() => void) | undefined;
    void (async () => {
      if (!canUseNativePush()) {
        if (mounted) setStatus('unavailable');
        return;
      }
      try {
        const provider = await createNativePushProvider();
        if (!mounted || !provider) return;
        await provider.initialize();
        providerRef.current = provider;
        identityRef.current = new PushIdentityController(provider);
        removeClickListener = provider.addClickListener((data) => {
          // DB側はrecipient本人だけ更新可。失敗しても通知からの遷移は妨げない。
          void recordPushOpen(data.notificationId, 'notification_opened').catch(() => undefined);
          router.push(data.route as never);
          void recordPushOpen(data.notificationId, 'deep_link_opened').catch(() => undefined);
        });
        if (mounted) {
          setProviderReady(true);
          setStatus('disabled');
        }
      } catch {
        if (mounted) {
          setProviderReady(false);
          setError('Push通知を初期化できませんでした。アプリ本体はそのまま利用できます。');
          setStatus('error');
        }
      }
    })();
    return () => {
      mounted = false;
      removeClickListener?.();
    };
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let mounted = true;
    const isCurrent = () => mounted && generationRef.current === generation;

    void (async () => {
      // account/provider世代が変わった際、旧操作のbusyを次microtaskで解除する。
      await Promise.resolve();
      if (isCurrent()) setBusy(false);
      const provider = providerRef.current;
      const identity = identityRef.current;
      if (!providerReady || !provider || !identity) {
        if (!canUseNativePush() && isCurrent()) setStatus('unavailable');
        return;
      }

      if (!eligible || !auth.userId) {
        await failClosed();
        if (isCurrent()) {
          setPreferences(DEFAULT_PUSH_PREFERENCES);
          setError(null);
          setStatus('disabled');
        }
        return;
      }

      setStatus('loading');
      setError(null);
      try {
        const loaded = await loadPushPreferences();
        if (!isCurrent()) return;
        setPreferences(loaded);
        if (!loaded.notificationsEnabled) {
          await failClosed();
          if (isCurrent()) setStatus(loaded.permissionStatus === 'denied' ? 'denied' : 'disabled');
          return;
        }

        await provider.setConsentGiven(true);
        const granted = await provider.getPermission();
        if (!granted) {
          const denied = await savePushPreferences({
            ...loaded,
            notificationsEnabled: false,
            permissionStatus: 'denied',
          });
          await failClosed();
          if (isCurrent()) {
            setPreferences(denied);
            setStatus('denied');
          }
          return;
        }

        await identity.sync(auth.userId);
        await provider.setSubscriptionEnabled(true);
        if (isCurrent()) setStatus('granted');
      } catch {
        await failClosed();
        if (isCurrent()) {
          setError('Push通知設定を同期できませんでした。通知は安全のため停止しています。');
          setStatus('error');
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [auth.userId, eligible, failClosed, providerReady]);

  const requestEnable = useCallback(async () => {
    const provider = providerRef.current;
    const identity = identityRef.current;
    const subject = auth.userId;
    if (!provider || !identity || !eligible || !subject || busy) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      await provider.setConsentGiven(true);
      const granted = await provider.requestPermission();
      if (!granted) {
        const denied = await savePushPreferences({
          ...preferences,
          notificationsEnabled: false,
          permissionStatus: 'denied',
        });
        await failClosed();
        if (generationRef.current === generation) {
          setPreferences(denied);
          setStatus('denied');
        }
        return;
      }

      await identity.sync(subject);
      await provider.setSubscriptionEnabled(true);
      const saved = await savePushPreferences({
        ...preferences,
        notificationsEnabled: true,
        permissionStatus: 'granted',
      });
      if (generationRef.current === generation) {
        setPreferences(saved);
        setStatus('granted');
      }
    } catch {
      await failClosed();
      if (generationRef.current === generation) {
        setError('通知を有効にできませんでした。アプリ本体はそのまま利用できます。');
        setStatus('error');
      }
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [auth.userId, busy, eligible, failClosed, preferences]);

  const disable = useCallback(async () => {
    if (!eligible || busy) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      // server側を先に止め、停止操作中に新しいoutboxが作られないようにする。
      const saved = await savePushPreferences({
        ...preferences,
        notificationsEnabled: false,
      });
      await failClosed();
      if (generationRef.current === generation) {
        setPreferences(saved);
        setStatus(saved.permissionStatus === 'denied' ? 'denied' : 'disabled');
      }
    } catch {
      await failClosed();
      if (generationRef.current === generation) {
        setError('通知の停止状態をサーバーへ同期できませんでした。端末の通知先は解除しました。');
        setStatus('error');
      }
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [busy, eligible, failClosed, preferences]);

  const setGroupUpdatesEnabled = useCallback(async (enabled: boolean) => {
    if (!eligible || busy) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      const saved = await savePushPreferences({
        ...preferences,
        groupUpdatesEnabled: enabled,
      });
      if (generationRef.current === generation) setPreferences(saved);
    } catch {
      if (generationRef.current === generation) {
        setError('グループ更新通知の設定を保存できませんでした。');
      }
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [busy, eligible, preferences]);

  const value = useMemo<PushNotificationsContextValue>(() => ({
    status,
    preferences,
    busy,
    error,
    requestEnable,
    disable,
    setGroupUpdatesEnabled,
  }), [busy, disable, error, preferences, requestEnable, setGroupUpdatesEnabled, status]);

  return (
    <PushNotificationsContext.Provider value={value}>
      {children}
    </PushNotificationsContext.Provider>
  );
}

export function usePushNotifications(): PushNotificationsContextValue {
  const value = useContext(PushNotificationsContext);
  if (!value) throw new Error('usePushNotifications must be used inside PushNotificationsProvider');
  return value;
}
