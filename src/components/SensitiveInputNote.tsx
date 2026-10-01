import { StyleSheet, Text } from 'react-native';

import { colors } from '@/theme';

// #280: APPI 法20条2項（要配慮個人情報の取得制限）への注意喚起1行。
// Gemini へ渡る自由文入力欄（ホームの自然文入力・調査画面の条件追加）の近傍に常設する。
// UIコピーのみでロジックは変更しない。「同意取得して受け入れる」か「入力させない」かの
// 方針判断は owner 待ち（#280）。確定後に検出・同意取得の実装可否を再判断する。
export function SensitiveInputNote() {
  return (
    <Text testID="sensitive-input-note" style={styles.note}>
      持病・アレルギーなどの要配慮個人情報は入力しないでください。
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
