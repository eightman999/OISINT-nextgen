import { Link } from 'expo-router';
import Head from 'expo-router/head';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { colors, fonts, radius } from '@/theme';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal-transparent.png');

const SUMMARY_STEPS = [
  {
    index: '01',
    title: '条件を持ち寄る',
    text: '人数、予算、その日の空気。言葉にしにくい希望も、ひとつの相談にまとめます。',
  },
  {
    index: '02',
    title: '候補と理由を比べる',
    text: '候補だけでなく、条件に合う点と確認が必要な点を同じ画面で見比べます。',
  },
  {
    index: '03',
    title: 'みんなで決める',
    text: '共有した画面で条件や意見を足し、最後は自分たちの判断で一軒を選びます。',
  },
] as const;

export default function ConceptScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 900;

  return (
    <View style={styles.wrapper}>
      <Head>
        <title>コンセプト | OISINT</title>
        <meta
          name="description"
          content="OISINTで条件を持ち寄り、候補と理由を比べて決める流れを紹介します"
        />
      </Head>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.page}>
          <View style={styles.topbar}>
            <Image
              accessibilityLabel="OISINT ロゴ"
              source={BRAND_LOGO}
              resizeMode="contain"
              style={styles.logo}
            />
            <Link href="/" asChild>
              <Pressable
                testID="concept-back-home"
                accessibilityRole="link"
                accessibilityLabel="OISINTのトップへ戻る"
                style={styles.backLink}
              >
                <Text style={styles.backLinkText}>トップへ戻る ↗</Text>
              </Pressable>
            </Link>
          </View>

          <View style={[styles.hero, isWide && styles.heroWide]}>
            <View style={[styles.heroCopy, isWide && styles.heroCopyWide]}>
              <Text style={styles.eyebrow}>PRODUCT STORY</Text>
              <Text accessibilityRole="header" style={[styles.title, !isWide && styles.titleCompact]}>
                「どこ行く？」から、{ '\n' }みんなの「ここがいい」へ。
              </Text>
              <Text style={styles.lead}>
                条件を言葉にして、候補とその理由を見比べる。OISINTは、みんなで納得して一軒を選ぶためのアプリです。
              </Text>
            </View>
          </View>

          <View testID="concept-text-summary" style={styles.summarySection}>
            <View style={styles.summaryHeading}>
              <Text style={styles.eyebrow}>TEXT SUMMARY</Text>
              <Text accessibilityRole="header" style={styles.summaryTitle}>
                OISINTで店を選ぶ、3つのステップ。
              </Text>
              <Text style={styles.summaryLead}>
                希望を集めて、理由を確かめて、みんなで決めます。
              </Text>
            </View>
            <View style={[styles.stepGrid, isWide && styles.stepGridWide]}>
              {SUMMARY_STEPS.map((step) => (
                <View key={step.index} style={styles.stepCard}>
                  <Text style={styles.stepIndex}>{step.index}</Text>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepText}>{step.text}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
      <Footer />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 54,
  },
  page: {
    width: '100%',
    maxWidth: 1240,
    alignSelf: 'center',
  },
  topbar: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    marginBottom: 42,
  },
  logo: {
    width: 168,
    height: 50,
  },
  backLink: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  backLinkText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  hero: {
    gap: 34,
    marginBottom: 68,
  },
  heroWide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 50,
  },
  heroCopy: {
    gap: 18,
  },
  heroCopyWide: {
    flex: 1,
  },
  eyebrow: {
    fontFamily: fonts.brand,
    color: colors.orange,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  title: {
    color: colors.text,
    fontSize: 42,
    lineHeight: 57,
    fontWeight: '800',
    letterSpacing: -1.5,
  },
  titleCompact: {
    fontSize: 32,
    lineHeight: 45,
    letterSpacing: -1,
  },
  lead: {
    maxWidth: 520,
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 25,
  },
  summarySection: {
    gap: 22,
    paddingTop: 34,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  summaryHeading: {
    gap: 8,
  },
  summaryTitle: {
    color: colors.text,
    fontSize: 24,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  summaryLead: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
  stepGrid: {
    gap: 12,
  },
  stepGridWide: {
    flexDirection: 'row',
  },
  stepCard: {
    flex: 1,
    minHeight: 170,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  stepIndex: {
    color: colors.orange,
    fontFamily: fonts.brand,
    fontSize: 12,
    fontWeight: '800',
  },
  stepTitle: {
    marginTop: 28,
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  stepText: {
    marginTop: 8,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
});
