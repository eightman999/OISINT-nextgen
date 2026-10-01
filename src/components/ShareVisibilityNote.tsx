import { StyleSheet, Text } from 'react-native';

import { colors } from '@/theme';

// #275: 共有調査で「誰に何が見えるか」を共有前に明示する（電気通信事業法4条・通信の秘密）。
// 共有ボタン・共有URL表示の近傍に常設する。文言は Issue #275 の是正案（監査レポート §7.2 案）に従う。
// 参加経路は share_token のみ（supabase/functions/join-investigation）で、参加者は
// raw_query 由来の条件文・候補・投票を閲覧できるため、共有前にその事実を利用者へ知らせる。
// 注意: visibility='public' 切替 UI をフロントへ実装する際は、本注意文の掲出と
// 確認ダイアログ（public 化で member 以外にも公開される旨）を必須とする（#275）。
export function ShareVisibilityNote() {
  return (
    <Text testID="share-visibility-note" style={styles.note}>
      共有リンクを知っている人は、この調査に参加して、あなたが入力した条件の文章・候補・投票を見ることができます。個人が特定される情報や秘密の情報は入力しないでください。
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
