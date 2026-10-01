import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors } from '@/theme';

// #267: 誤情報の訂正・削除申立ての受付導線。
// 結果画面・共有ページで免責1行（DisclaimerNote / #266）に隣接して常設し、
// 対象URL（共有トークン）を訂正依頼フォームへ引き継ぐ。
export function CorrectionLink({ targetUrl }: { targetUrl: string }) {
  return (
    <Pressable
      testID="correction-link"
      accessibilityRole="link"
      accessibilityLabel="この情報の訂正を依頼する"
      onPress={() => router.push({ pathname: '/correction', params: { url: targetUrl } } as never)}
      style={styles.link}
    >
      <Text style={styles.text}>この情報の訂正を依頼する ↗</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
  text: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    color: colors.orange,
  },
});
