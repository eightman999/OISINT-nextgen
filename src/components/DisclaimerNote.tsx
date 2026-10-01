import { StyleSheet, Text } from 'react-native';

import { colors } from '@/theme';

// #266: 店舗情報の限界表示（免責1行）。候補カード一覧・結果画面・共有ページに常設する。
// 文面は #230（規約・免責の成果物）の確定時に同期する。owner の文面承認後に修正可。
export function DisclaimerNote() {
  return (
    <Text testID="disclaimer-note" style={styles.note}>
      店舗情報は外部情報の自動収集であり正確性を保証しません。最終確認は店舗へお願いします。
    </Text>
  );
}

const styles = StyleSheet.create({
  note: {
    alignSelf: 'stretch',
    fontSize: 11,
    lineHeight: 16,
    color: colors.textTertiary,
  },
});
