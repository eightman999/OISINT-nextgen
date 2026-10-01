import { Stack, usePathname } from 'expo-router';
import Head from 'expo-router/head';
import { Component, type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HelpLauncher } from '@/components/HelpLauncher';
import { PwaRuntime } from '@/components/PwaRuntime';
import { AuthProvider } from '@/providers/AuthProvider';
import { EntitlementProvider } from '@/providers/EntitlementProvider';
import { PushNotificationsProvider } from '@/providers/PushNotificationsProvider';
import { shouldAutoCreateAnonymousSession } from '@/lib/authRouting';
import { colors, radius } from '@/theme';
import '@/global.css';

const subscribeClientReady = () => () => {};
const getClientReadySnapshot = () => true;
const getServerReadySnapshot = () => false;

export default function RootLayout() {
  const pathname = usePathname();
  const clientReady = useSyncExternalStore(
    subscribeClientReady,
    getClientReadySnapshot,
    getServerReadySnapshot,
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-oisint-client-ready', 'true');

    return () => {
      document.documentElement.removeAttribute('data-oisint-client-ready');
    };
  }, []);

  return (
    <RootErrorBoundary>
      <Head>
        <title>OISINT | 根拠で選ぶレストラン調査</title>
        <meta
          name="description"
          content="公開情報と根拠を比べ、みんなでレストランを決める調査サービス"
        />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <View
        testID={clientReady ? 'app-client-ready' : undefined}
        accessibilityState={{ busy: !clientReady }}
        style={[styles.appRoot, !clientReady && styles.appRootPending]}
      >
        <SafeAreaProvider>
          <AuthProvider autoCreateAnonymousSession={shouldAutoCreateAnonymousSession(pathname)}>
            <PushNotificationsProvider>
              <EntitlementProvider>
                <Stack screenOptions={{ headerShown: false }} />
                <HelpLauncher />
                <PwaRuntime />
              </EntitlementProvider>
            </PushNotificationsProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </View>
    </RootErrorBoundary>
  );
}

interface RootErrorBoundaryState {
  hasError: boolean;
}

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true };
  }

  handleRetry = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View testID="root-error-boundary" style={styles.errorContainer}>
          <Text accessibilityRole="alert" style={styles.errorTitle}>
            画面を表示できませんでした
          </Text>
          <Text style={styles.errorMessage}>
            一時的な問題が発生しました。再読み込みしてもう一度お試しください。
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="画面を再読み込み"
            onPress={this.handleRetry}
            style={styles.retryButton}
          >
            <Text style={styles.retryButtonText}>再読み込み</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  appRoot: {
    flex: 1,
  },
  appRootPending: {
    pointerEvents: 'none',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: colors.bg,
  },
  errorTitle: {
    color: colors.danger,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorMessage: {
    maxWidth: 420,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: 40,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  retryButtonText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '700',
  },
});
