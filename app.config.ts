import type { ConfigContext, ExpoConfig } from 'expo/config';

import appJson from './app.json';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`OneSignal build requires ${name}`);
  }
  return value;
}

function oneSignalMode(): 'development' | 'production' {
  const value = process.env.OISINT_ONESIGNAL_APS_ENV?.trim() || 'development';
  if (value !== 'development' && value !== 'production') {
    throw new Error('OISINT_ONESIGNAL_APS_ENV must be development or production');
  }
  return value;
}

export default function defineExpoConfig(_context: ConfigContext): ExpoConfig {
  const base = appJson.expo as ExpoConfig;
  if (process.env.OISINT_ENABLE_ONESIGNAL !== '1') return base;

  const appId = requiredEnvironment('EXPO_PUBLIC_ONESIGNAL_APP_ID');
  const iosBundleIdentifier = requiredEnvironment('OISINT_IOS_BUNDLE_ID');
  const androidPackage = requiredEnvironment('OISINT_ANDROID_PACKAGE');
  const mode = oneSignalMode();

  return {
    ...base,
    ios: {
      ...base.ios,
      bundleIdentifier: iosBundleIdentifier,
      infoPlist: {
        ...base.ios?.infoPlist,
        UIBackgroundModes: ['remote-notification'],
      },
      entitlements: {
        ...base.ios?.entitlements,
        'aps-environment': mode,
      },
    },
    android: {
      ...base.android,
      package: androidPackage,
    },
    extra: {
      ...base.extra,
      oneSignalAppId: appId,
    },
    plugins: [
      [
        'onesignal-expo-plugin',
        {
          mode,
          disableLocation: true,
        },
      ],
      ...(base.plugins ?? []),
    ],
  };
}
