import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '@/theme';

// #273: 対象年齢の表示。Google Gemini API Additional Terms が API 利用者に
// 18歳以上の年齢要件を課すため、サインイン導線（app/account.tsx）とヘルプ（app/help.tsx）へ常設する。
// 利用規約本文への明記は #268（規約本文の作成）、対象年齢方針の最終決定は owner 判断（#273）。
export function AgeRequirementNote({
  testID,
  style,
}: {
  testID: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text testID={testID} style={[styles.note, style]}>
      本サービスは18歳以上の方を対象としています。
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
