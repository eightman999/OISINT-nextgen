import { Link } from 'expo-router';
import Head from 'expo-router/head';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

export default function NotFoundScreen() {
  return (
    <View testID="not-found-page" style={styles.page}>
      <Head>
        <title>ページが見つかりません | OISINT</title>
      </Head>
      <View style={styles.card}>
        <Text style={styles.kicker}>404 / NOT FOUND</Text>
        <Text accessibilityRole="header" style={styles.title}>
          ページが見つかりません
        </Text>
        <Text style={styles.description}>
          URLが変更されたか、ページが削除された可能性があります。
        </Text>
        <Link href="/" asChild>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="OISINTのトップページへ戻る"
            style={styles.link}
          >
            <Text style={styles.linkText}>トップページへ戻る</Text>
          </Pressable>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.bg,
  },
  card: {
    width: '100%',
    maxWidth: 520,
    gap: 14,
    padding: 28,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  kicker: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
  },
  description: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  link: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  linkText: {
    color: colors.surface,
    fontSize: 14,
    fontWeight: '700',
  },
});
