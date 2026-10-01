import { router } from 'expo-router';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import { SupportHeader } from '@/components/SupportHeader';
import { SUPPORT_ISSUES_URL, configuredSupportEmail, hasConfiguredSupportEmail } from '@/lib/support';
import { colors, fonts, radius, supportColors } from '@/theme';

export default function SupportScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 780;

  return (
    <View style={styles.wrapper}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.container, isWide && styles.containerWide]}>
          <SupportHeader current="support" />

          <View style={styles.hero}>
            <View style={styles.heroMark}>
              <Text style={styles.heroMarkText}>?</Text>
            </View>
            <Text style={styles.heroEyebrow}>OISINTのサポート</Text>
            <Text style={styles.heroTitle}>困ったときも、{ '\n' }ひとりにしない。</Text>
            <Text style={styles.heroCopy}>
              使い方を知りたいときも、うまく動かなかったときも、{ '\n' }今の状況に合う入口から進めます。
            </Text>
            <View style={styles.heroRule} />
            <Text style={styles.heroNote}>まずは「使い方ガイド」を見ると、解決が早いことがあります。</Text>
          </View>

          <View style={styles.sectionIntro}>
            <View>
              <Text style={styles.eyebrow}>次の一歩</Text>
              <Text style={styles.sectionTitle}>用件に合う入口を選ぶ</Text>
            </View>
            <Text style={styles.sectionHint}>すべてスマートフォンから送れます</Text>
          </View>

          <View style={[styles.actionGrid, isWide && styles.actionGridWide]}>
            <SupportActionCard
              number="01"
              accent={colors.orange}
              label="使い方を知りたい"
              title="使い方ガイド"
              copy="場所の選び方、候補の見方、共有と投票までを画面で案内します。"
              action="ガイドを見る"
              onPress={() => router.replace({ pathname: '/help' } as never)}
            />
            <SupportActionCard
              number="02"
              accent={supportColors.replyAccent}
              label="返信が必要な相談"
              title="お問い合わせ"
              copy="使えない、共有できない、確認したい。状況を整理して送れます。"
              action="相談を書く"
              onPress={() => router.replace({ pathname: '/contact' } as never)}
            />
            <SupportActionCard
              number="03"
              accent={colors.amber}
              label="体験をよくしたい"
              title="フィードバック"
              copy="よかったところも、わかりにくかったところも、短く教えてください。"
              action="一言を送る"
              onPress={() => router.replace({ pathname: '/feedback' } as never)}
            />
          </View>

          <View style={styles.quickPanel}>
            <View style={styles.quickHeader}>
              <View>
                <Text style={styles.eyebrow}>すぐわかる答え</Text>
                <Text style={styles.quickTitle}>よくあるつまずき</Text>
              </View>
              <Text style={styles.quickHint}>ガイド内を検索できます</Text>
            </View>
            <View style={styles.quickList}>
              <QuickAnswer index="A" title="GPSを許可しなくても使えますか？" copy="場所を文字で入力する手動ルートがあります。" />
              <QuickAnswer index="B" title="候補の ○ △ × ? は何ですか？" copy="条件に合う／確認が必要／合わない／まだ不明です。" />
              <QuickAnswer index="C" title="友だちをどう招待しますか？" copy="候補が出たら共有URLをコピーして送ります。" />
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace({ pathname: '/help' } as never)}
              style={styles.quickCta}
            >
              <Text style={styles.quickCtaText}>すべての使い方を見る  ↗</Text>
            </Pressable>
          </View>

          <View style={styles.channelPanel}>
            <Text style={styles.eyebrow}>連絡手段</Text>
            <Text style={styles.channelTitle}>受付窓口</Text>
            <Text style={styles.channelCopy}>
              {hasConfiguredSupportEmail
                ? `お問い合わせとフィードバックは、メール（${configuredSupportEmail}）で受け付けています。各フォームの「メール作成画面を開く」からそのまま送信できます。`
                : 'お問い合わせとフィードバックは、GitHubのIssuesページで受け付けています。各フォームでコピーした内容を、Issueに貼り付けて報告してください。'}
            </Text>
            {hasConfiguredSupportEmail ? null : (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="OISINTのGitHub Issuesページを開く"
                onPress={() => {
                  Linking.openURL(SUPPORT_ISSUES_URL).catch(() => {});
                }}
                style={styles.channelLink}
              >
                <Text style={styles.channelLinkText}>GitHub Issues を開く ↗</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.trustNote}>
            <Text style={styles.trustIcon}>✓</Text>
            <View style={styles.trustBody}>
              <Text style={styles.trustTitle}>送信前に、個人情報を確認してください</Text>
              <Text style={styles.trustCopy}>
                パスワード、カード番号、位置情報などの秘密情報は入力しないでください。必要な場合だけ、返信先のメールアドレスを入力します。
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
      <Footer />
    </View>
  );
}

function SupportActionCard({
  number,
  accent,
  label,
  title,
  copy,
  action,
  onPress,
}: {
  number: string;
  accent: string;
  label: string;
  title: string;
  copy: string;
  action: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
    >
      <View style={styles.actionTopline}>
        <View style={[styles.actionNumber, { backgroundColor: accent }]}>
          <Text style={styles.actionNumberText}>{number}</Text>
        </View>
        <Text style={styles.actionLabel}>{label}</Text>
      </View>
      <Text style={styles.actionTitle}>{title}</Text>
      <Text style={styles.actionCopy}>{copy}</Text>
      <View style={styles.actionBottomline}>
        <Text style={[styles.actionButtonText, { color: accent }]}>{action}</Text>
        <Text style={[styles.actionArrow, { color: accent }]}>↗</Text>
      </View>
    </Pressable>
  );
}

function QuickAnswer({ index, title, copy }: { index: string; title: string; copy: string }) {
  return (
    <View style={styles.quickItem}>
      <Text style={styles.quickIndex}>{index}</Text>
      <View style={styles.quickItemBody}>
        <Text style={styles.quickItemTitle}>{title}</Text>
        <Text style={styles.quickItemCopy}>{copy}</Text>
      </View>
      <Text style={styles.quickItemArrow}>→</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 32,
  },
  container: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    gap: 24,
  },
  containerWide: {
    gap: 30,
  },
  hero: {
    minHeight: 330,
    padding: 25,
    borderRadius: 20,
    backgroundColor: colors.black,
  },
  heroMark: {
    width: 45,
    height: 45,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.orange,
  },
  heroMarkText: {
    color: colors.surface,
    fontSize: 25,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  heroEyebrow: {
    marginTop: 22,
    color: colors.amber,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: fonts.brand,
  },
  heroTitle: {
    marginTop: 7,
    color: colors.surface,
    fontSize: 35,
    lineHeight: 45,
    fontWeight: '800',
    letterSpacing: -1.5,
  },
  heroCopy: {
    marginTop: 12,
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 12,
    lineHeight: 21,
  },
  heroRule: {
    height: 1,
    marginTop: 23,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  heroNote: {
    marginTop: 12,
    color: 'rgba(255, 255, 255, 0.52)',
    fontSize: 10,
    lineHeight: 16,
  },
  sectionIntro: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: fonts.brand,
  },
  sectionTitle: {
    marginTop: 4,
    color: colors.text,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  sectionHint: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  actionGrid: {
    gap: 10,
  },
  actionGridWide: {
    flexDirection: 'row',
  },
  actionCard: {
    flex: 1,
    minHeight: 215,
    justifyContent: 'space-between',
    padding: 16,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  actionCardPressed: {
    opacity: 0.76,
    transform: [{ translateY: 1 }],
  },
  actionTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  actionNumber: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  actionNumberText: {
    color: colors.surface,
    fontSize: 9,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  actionLabel: {
    flex: 1,
    color: colors.textTertiary,
    fontSize: 10,
  },
  actionTitle: {
    marginTop: 25,
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  actionCopy: {
    marginTop: 7,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
  actionBottomline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  actionButtonText: {
    fontSize: 11,
    fontWeight: '800',
  },
  actionArrow: {
    fontSize: 18,
    fontWeight: '700',
  },
  quickPanel: {
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  quickHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  quickTitle: {
    marginTop: 4,
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  quickHint: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  quickList: {
    gap: 8,
    marginTop: 14,
  },
  quickItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  quickIndex: {
    width: 22,
    color: colors.orange,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  quickItemBody: {
    flex: 1,
    gap: 3,
  },
  quickItemTitle: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  quickItemCopy: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 16,
  },
  quickItemArrow: {
    color: colors.textTertiary,
    fontSize: 15,
  },
  quickCta: {
    minHeight: 42,
    marginTop: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.black,
  },
  quickCtaText: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  channelPanel: {
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  channelTitle: {
    marginTop: 4,
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  channelCopy: {
    marginTop: 7,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
  channelLink: {
    minHeight: 44,
    marginTop: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.black,
  },
  channelLinkText: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  trustNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    paddingHorizontal: 2,
  },
  trustIcon: {
    color: colors.success,
    fontSize: 16,
    fontWeight: '800',
  },
  trustBody: {
    flex: 1,
    gap: 3,
  },
  trustTitle: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  trustCopy: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 17,
  },
});
