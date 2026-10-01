import { router } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

const BRAND_LOGO = require('../../assets/branding/oisint-logo-horizontal-transparent.png');

// correction（訂正依頼 / #267）はナビには出さず、現在地の判定にのみ使う。
export type SupportPage = 'support' | 'help' | 'contact' | 'feedback' | 'correction';

const NAV_ITEMS: { id: SupportPage; label: string; path: string }[] = [
  { id: 'support', label: 'サポート', path: '/support' },
  { id: 'help', label: '使い方', path: '/help' },
  { id: 'contact', label: 'お問い合わせ', path: '/contact' },
  { id: 'feedback', label: 'フィードバック', path: '/feedback' },
];

export function SupportHeader({ current }: { current: SupportPage }) {
  const goTo = (path: string) => {
    router.replace({ pathname: path } as never);
  };

  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="OISINTのトップへ戻る"
        onPress={() => router.replace('/')}
        style={styles.brandLink}
      >
        <Text style={styles.backArrow}>←</Text>
        <Image
          source={BRAND_LOGO}
          resizeMode="contain"
          accessibilityLabel="OISINTロゴ"
          style={styles.logo}
        />
      </Pressable>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.navScroll}
      >
        {NAV_ITEMS.map((item) => {
          const active = item.id === current;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="link"
              aria-current={active ? 'page' : undefined}
              onPress={() => {
                if (!active) goTo(item.path);
              }}
              style={[styles.navItem, active && styles.navItemActive]}
            >
              <Text style={[styles.navText, active && styles.navTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 5,
  },
  brandLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 44,
    paddingRight: 2,
  },
  backArrow: {
    color: colors.textSecondary,
    fontSize: 20,
    lineHeight: 22,
  },
  logo: {
    width: 112,
    height: 36,
  },
  navScroll: {
    alignItems: 'center',
    gap: 6,
    paddingRight: 2,
  },
  navItem: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  navItemActive: {
    borderColor: colors.black,
    backgroundColor: colors.black,
  },
  navText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
  },
  navTextActive: {
    color: colors.surface,
  },
});
