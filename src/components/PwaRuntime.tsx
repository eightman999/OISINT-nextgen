import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

const SERVICE_WORKER_SCOPE = '/';

export type PwaRegistrationEnvironment = {
  platform: string;
  nodeEnv: string | undefined;
  protocol: string;
  hostname: string;
  hasServiceWorker: boolean;
};

/** production WebのHTTPS（またはローカル検証用loopback）だけを登録対象にする。 */
export function isPwaRegistrationAllowed(environment: PwaRegistrationEnvironment): boolean {
  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(environment.hostname);
  const isSecureOrigin =
    environment.protocol === 'https:' ||
    (environment.protocol === 'http:' && isLoopback);

  return (
    environment.platform === 'web' &&
    environment.nodeEnv === 'production' &&
    isSecureOrigin &&
    environment.hasServiceWorker
  );
}

type ServiceWorkerContainerLike = Pick<
  ServiceWorkerContainer,
  'getRegistration' | 'register'
>;

/** 既存のscopeを優先し、同一originへ二重登録しない。 */
export async function registerPwaServiceWorker(
  serviceWorker: ServiceWorkerContainerLike,
): Promise<ServiceWorkerRegistration> {
  const existing = await serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  return existing ?? serviceWorker.register('/sw.js', { scope: SERVICE_WORKER_SCOPE });
}

function currentEnvironment(): PwaRegistrationEnvironment {
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';

  return {
    platform: Platform.OS,
    nodeEnv: process.env.NODE_ENV,
    protocol: hasWindow ? window.location.protocol : '',
    hostname: hasWindow ? window.location.hostname : '',
    hasServiceWorker: hasNavigator && 'serviceWorker' in navigator,
  };
}

function observeServiceWorkerUpdates(
  registration: ServiceWorkerRegistration,
  serviceWorker: ServiceWorkerContainer,
  onUpdateAvailable: () => void,
): () => void {
  const installingWorkers = new Map<ServiceWorker, () => void>();

  const watchInstallingWorker = () => {
    const worker = registration.installing;
    if (!worker || installingWorkers.has(worker)) return;

    const onStateChange = () => {
      if (worker.state === 'installed' && serviceWorker.controller) onUpdateAvailable();
    };
    installingWorkers.set(worker, onStateChange);
    worker.addEventListener('statechange', onStateChange);
  };

  const onUpdateFound = () => watchInstallingWorker();
  registration.addEventListener('updatefound', onUpdateFound);
  if (registration.waiting) onUpdateAvailable();

  return () => {
    registration.removeEventListener('updatefound', onUpdateFound);
    for (const [worker, listener] of installingWorkers) {
      worker.removeEventListener('statechange', listener);
    }
    installingWorkers.clear();
  };
}

export function PwaRuntime() {
  const [isOffline, setIsOffline] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const reloadAfterUpdate = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    const updateOnlineState = () => setIsOffline(navigator.onLine === false);
    const onControllerChange = () => {
      if (reloadAfterUpdate.current) window.location.reload();
    };

    updateOnlineState();
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);

    const environment = currentEnvironment();
    if (!isPwaRegistrationAllowed(environment)) {
      return () => {
        window.removeEventListener('online', updateOnlineState);
        window.removeEventListener('offline', updateOnlineState);
      };
    }

    const serviceWorker = navigator.serviceWorker;
    let disposed = false;
    let cleanupServiceWorker: (() => void) | undefined;

    serviceWorker.addEventListener('controllerchange', onControllerChange);
    void registerPwaServiceWorker(serviceWorker)
      .then((nextRegistration) => {
        if (disposed) return;
        setRegistration(nextRegistration);
        cleanupServiceWorker = observeServiceWorkerUpdates(
          nextRegistration,
          serviceWorker,
          () => setUpdateAvailable(true),
        );
      })
      // 登録不能な環境でもアプリ自体は利用可能にし、内部エラーは表示しない。
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanupServiceWorker?.();
      serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  const retry = () => {
    if (typeof navigator === 'undefined' || navigator.onLine === false) {
      setIsOffline(true);
      return;
    }
    if (typeof window !== 'undefined') window.location.reload();
  };

  const applyUpdate = () => {
    const waiting = registration?.waiting;
    if (!waiting) return;
    reloadAfterUpdate.current = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setUpdateAvailable(false);
  };

  return (
    <>
      {isOffline ? (
        <View
          testID="pwa-offline-notice"
          accessibilityRole="alert"
          style={styles.offlineBanner}
        >
          <Text style={styles.title}>オフラインです</Text>
          <Text style={styles.message}>
            新しい調査データは取得できません。接続を確認して再試行してください。
          </Text>
          <Pressable
            testID="pwa-offline-retry"
            accessibilityRole="button"
            accessibilityLabel="接続を再試行"
            onPress={retry}
            style={styles.button}
          >
            <Text style={styles.buttonText}>再試行</Text>
          </Pressable>
        </View>
      ) : null}
      {updateAvailable ? (
        <View testID="pwa-update-notice" accessibilityRole="alert" style={styles.updateBanner}>
          <Text style={styles.updateMessage}>新しいバージョンを利用できます。</Text>
          <Pressable
            testID="pwa-update-apply"
            accessibilityRole="button"
            accessibilityLabel="新しいバージョンを適用"
            onPress={applyUpdate}
            style={styles.button}
          >
            <Text style={styles.buttonText}>更新を適用</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  offlineBanner: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    bottom: 16,
    zIndex: 1000,
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerSoft,
  },
  updateBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    zIndex: 999,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.sm,
    backgroundColor: colors.infoSoft,
  },
  title: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  message: {
    marginTop: 4,
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  updateMessage: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  button: {
    alignSelf: 'flex-start',
    minHeight: 36,
    marginTop: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  buttonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '700',
  },
});
