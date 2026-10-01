import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { z } from 'zod';

import type { PushIdentityProvider, PushNotificationData } from '@/lib/pushNotifications';
import { parsePushNotificationData } from '@/lib/pushNotifications';

export interface NativePushProvider extends PushIdentityProvider {
  initialize(): Promise<void>;
  setConsentGiven(granted: boolean): Promise<void>;
  getPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  setSubscriptionEnabled(enabled: boolean): Promise<void>;
  addClickListener(listener: (data: PushNotificationData) => void): () => void;
}

const appIdSchema = z.string().uuid();

function configuredAppId(): string | null {
  const value = Constants.expoConfig?.extra?.oneSignalAppId;
  const parsed = appIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function canUseNativePush(): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'android') && configuredAppId() !== null;
}

export async function createNativePushProvider(): Promise<NativePushProvider | null> {
  const appId = configuredAppId();
  if ((Platform.OS !== 'ios' && Platform.OS !== 'android') || !appId) return null;

  const { OneSignal } = await import('react-native-onesignal');
  let initialized = false;

  return {
    async initialize() {
      if (initialized) return;
      // SDK初期化前に同意必須を設定し、設定画面で許可するまで外部送信しない。
      OneSignal.setConsentRequired(true);
      OneSignal.initialize(appId);
      initialized = true;
    },
    async setConsentGiven(granted) {
      OneSignal.setConsentGiven(granted);
    },
    async getPermission() {
      return OneSignal.Notifications.getPermissionAsync();
    },
    async requestPermission() {
      return OneSignal.Notifications.requestPermission(false);
    },
    async setSubscriptionEnabled(enabled) {
      if (enabled) OneSignal.User.pushSubscription.optIn();
      else OneSignal.User.pushSubscription.optOut();
    },
    async login(externalId) {
      OneSignal.login(externalId);
    },
    async logout() {
      OneSignal.logout();
    },
    addClickListener(listener) {
      const clickListener = (event: { notification: { additionalData?: object } }) => {
        const data = parsePushNotificationData(event.notification.additionalData);
        if (data) listener(data);
      };
      OneSignal.Notifications.addEventListener('click', clickListener);
      return () => OneSignal.Notifications.removeEventListener('click', clickListener);
    },
  };
}
