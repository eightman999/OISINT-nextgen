import { StyleSheet, Text } from 'react-native';

import { colors } from '@/theme';

// #269: ランキングの性質開示。結果画面・共有ページに常設する（景表法5条の誤認対策）。
// 順位の実装は supabase/functions/_shared/ranking.ts（spec §17）。文言は実装事実と一致させる。
// スコア構成要素と重みの詳細は app/help.tsx の「順位（おすすめ順）の決まり方」で開示する。
// 収益化（広告・スポンサー枠）を導入する場合は #270 の広告表示仕様に従って文面を更新する。
export function RankingDisclosure() {
  return (
    <Text testID="ranking-disclosure" style={styles.note}>
      順位は入力した条件への適合度を示すもので、店舗の一般的な優劣や人気の順位ではありません。メンバーの投票も順位に反映されます。掲載順位について店舗等から金銭を受け取っていません。
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
