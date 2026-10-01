import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, guideColors, radius } from '@/theme';

const BRAND_LOGO = require('../../assets/branding/oisint-logo-horizontal-transparent.png');

export type HelpScreenshotKind = 'home' | 'results' | 'vote';

interface HelpScreenshotProps {
  kind: HelpScreenshotKind;
  step: string;
  title: string;
  description: string;
}

/**
 * A compact, platform-neutral view of the real OISINT screens.
 * Keeping the guide visuals in React Native makes them readable on both web
 * and the eventual native app without shipping a stale browser screenshot.
 */
export function HelpScreenshot({ kind, step, title, description }: HelpScreenshotProps) {
  return (
    <View style={styles.figure}>
      <View style={styles.phone} testID={`help-screenshot-${kind}`}>
        <View style={styles.phoneTop}>
          <Text style={styles.time}>9:41</Text>
          <View style={styles.statusIcons}>
            <Text style={styles.statusIcon}>▮▮▮</Text>
            <Text style={styles.statusIcon}>▰</Text>
            <Text style={styles.statusIcon}>●</Text>
          </View>
        </View>
        <View style={styles.screen}>{renderScreen(kind)}</View>
        <View style={styles.homeIndicator} />
      </View>

      <View style={styles.caption}>
        <View style={styles.stepBadge}>
          <Text style={styles.stepText}>{step}</Text>
        </View>
        <View style={styles.captionBody}>
          <Text style={styles.captionTitle}>{title}</Text>
          <Text style={styles.captionDescription}>{description}</Text>
        </View>
      </View>
    </View>
  );
}

function renderScreen(kind: HelpScreenshotKind) {
  if (kind === 'home') return <HomeScreen />;
  if (kind === 'results') return <ResultsScreen />;
  return <VoteScreen />;
}

function ScreenHeader({ right }: { right?: string }) {
  return (
    <View style={styles.screenHeader}>
      <View style={styles.miniBrand}>
        <Image source={BRAND_LOGO} resizeMode="contain" style={styles.miniLogoImage} />
      </View>
      {right ? <Text style={styles.headerAction}>{right}</Text> : null}
    </View>
  );
}

function HomeScreen() {
  return (
    <>
      <ScreenHeader right="ヘルプ" />
      <Text style={styles.screenEyebrow}>ここから調べる</Text>
      <Text style={styles.screenTitle}>新しいリサーチ</Text>
      <View style={styles.locationPill}>
        <Text style={styles.locationPin}>⌖</Text>
        <Text style={styles.locationText}>池袋駅付近</Text>
        <Text style={styles.locationChange}>変更</Text>
      </View>
      <View style={styles.searchMock}>
        <Text style={styles.searchMockText}>池袋で3人。3000円くらい。肉。</Text>
        <Text style={styles.searchCursor}>|</Text>
      </View>
      <View style={styles.miniChipRow}>
        <MiniChip label="カード可" active />
        <MiniChip label="静か" />
        <MiniChip label="個室" />
      </View>
      <View style={styles.blackButton}>
        <Text style={styles.blackButtonText}>⌕  検索する</Text>
      </View>
      <Text style={styles.screenHint}>場所と条件はあとから追加できます</Text>
    </>
  );
}

function ResultsScreen() {
  return (
    <>
      <ScreenHeader right="共有" />
      <Text style={styles.screenEyebrow}>調査の結果</Text>
      <View style={styles.resultTitleRow}>
        <Text style={styles.screenTitle}>池袋で3人</Text>
        <Text style={styles.resultCount}>3件</Text>
      </View>
      <View style={styles.progressLine}>
        <View style={styles.progressDot} />
        <Text style={styles.progressText}>根拠を集めて比較しました</Text>
      </View>
      <ResultCard rank="1" title="炭火ビストロ 池袋店" color={guideColors.resultPrimary} state="○" />
      <ResultCard rank="2" title="肉とワインの食堂" color={guideColors.resultSecondary} state="△" />
      <ResultCard rank="3" title="駅前グリル" color={guideColors.resultUnknown} state="?" />
      <View style={styles.evidenceHint}>
        <Text style={styles.evidenceMark}>✦</Text>
        <Text style={styles.evidenceText}>候補をタップすると、条件と出典を確認できます</Text>
      </View>
    </>
  );
}

function VoteScreen() {
  return (
    <>
      <ScreenHeader right="共有" />
      <Text style={styles.screenEyebrow}>共有と投票</Text>
      <Text style={styles.screenTitle}>みんなで決める</Text>
      <Text style={styles.screenSubcopy}>候補ごとに、行きたい気持ちを教えてください。</Text>
      <View style={styles.selectedPlace}>
        <View style={[styles.placeImage, { backgroundColor: guideColors.resultPrimary }]}>
          <Text style={styles.placeImageText}>肉</Text>
        </View>
        <View style={styles.placeCopy}>
          <Text style={styles.placeRank}>候補 1</Text>
          <Text style={styles.placeName}>炭火ビストロ 池袋店</Text>
          <Text style={styles.placeMeta}>予算 3,000円 / 人　徒歩4分</Text>
        </View>
      </View>
      <Text style={styles.voteLabel}>あなたの気持ち</Text>
      <View style={styles.voteRow}>
        <VoteChoice icon="↑" label="行きたい" active />
        <VoteChoice icon="—" label="どちらでも" />
        <VoteChoice icon="↓" label="行きたくない" />
      </View>
      <View style={styles.shareHint}>
        <Text style={styles.shareIcon}>↗</Text>
        <Text style={styles.shareHintText}>共有URLを送ると、同じ候補を見られます</Text>
      </View>
    </>
  );
}

function MiniChip({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <View style={[styles.miniChip, active && styles.miniChipActive]}>
      <Text style={[styles.miniChipText, active && styles.miniChipTextActive]}>{label}</Text>
    </View>
  );
}

function ResultCard({
  rank,
  title,
  color,
  state,
}: {
  rank: string;
  title: string;
  color: string;
  state: string;
}) {
  return (
    <View style={styles.resultCard}>
      <View style={[styles.resultImage, { backgroundColor: color }]}>
        <Text style={styles.resultImageText}>肉</Text>
        <Text style={styles.rankBadge}>{rank}</Text>
      </View>
      <View style={styles.resultBody}>
        <View style={styles.resultTextGroup}>
          <Text style={styles.resultName}>{title}</Text>
          <Text style={styles.resultMeta}>肉料理　徒歩4分　3,000円</Text>
          <Text style={styles.resultEvidence}>✦ 根拠 2件を見る</Text>
        </View>
        <Text style={[styles.resultState, state === '?' && styles.resultStateUnknown]}>{state}</Text>
      </View>
    </View>
  );
}

function VoteChoice({ icon, label, active = false }: { icon: string; label: string; active?: boolean }) {
  return (
    <View style={[styles.voteChoice, active && styles.voteChoiceActive]}>
      <Text style={[styles.voteIcon, active && styles.voteTextActive]}>{icon}</Text>
      <Text style={[styles.voteChoiceLabel, active && styles.voteTextActive]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  figure: {
    gap: 14,
  },
  phone: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 320,
    minHeight: 492,
    backgroundColor: colors.black,
    borderRadius: 28,
    padding: 8,
  },
  phoneTop: {
    height: 24,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  time: {
    color: colors.white,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: fonts.brand,
  },
  statusIcons: {
    flexDirection: 'row',
    gap: 4,
  },
  statusIcon: {
    color: colors.white,
    fontSize: 7,
    opacity: 0.8,
  },
  screen: {
    flex: 1,
    minHeight: 444,
    padding: 16,
    borderRadius: 21,
    backgroundColor: colors.surface,
    gap: 10,
  },
  homeIndicator: {
    alignSelf: 'center',
    width: 74,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    marginTop: 7,
    opacity: 0.7,
  },
  screenHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  miniBrand: {
    width: 86,
    height: 25,
  },
  miniLogoImage: {
    width: '100%',
    height: '100%',
  },
  headerAction: {
    color: colors.orange,
    fontSize: 10,
    fontWeight: '700',
  },
  screenEyebrow: {
    color: colors.orange,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: fonts.brand,
  },
  screenTitle: {
    color: colors.text,
    fontSize: 21,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  screenSubcopy: {
    color: colors.textSecondary,
    fontSize: 9,
    lineHeight: 15,
  },
  locationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 9,
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.pill,
  },
  locationPin: {
    color: colors.orange,
    fontSize: 12,
  },
  locationText: {
    color: colors.text,
    fontSize: 9,
    fontWeight: '700',
  },
  locationChange: {
    color: colors.textTertiary,
    fontSize: 8,
    marginLeft: 2,
  },
  searchMock: {
    minHeight: 82,
    padding: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    justifyContent: 'space-between',
  },
  searchMockText: {
    color: colors.text,
    fontSize: 11,
    lineHeight: 18,
  },
  searchCursor: {
    color: colors.orange,
    fontSize: 14,
    lineHeight: 12,
  },
  miniChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  miniChip: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.chipBg,
  },
  miniChipActive: {
    borderColor: colors.orange,
    backgroundColor: colors.activeBg,
  },
  miniChipText: {
    color: colors.textSecondary,
    fontSize: 8,
  },
  miniChipTextActive: {
    color: colors.orange,
    fontWeight: '700',
  },
  blackButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
    marginTop: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.black,
  },
  blackButtonText: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  screenHint: {
    color: colors.textTertiary,
    fontSize: 8,
    textAlign: 'center',
  },
  resultTitleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  resultCount: {
    color: colors.textSecondary,
    fontSize: 9,
  },
  progressLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: radius.xs,
    backgroundColor: colors.successSoft,
  },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
  progressText: {
    color: colors.success,
    fontSize: 8,
    fontWeight: '700',
  },
  resultCard: {
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  resultImage: {
    width: 58,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultImageText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '800',
  },
  rankBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    paddingVertical: 3,
    paddingHorizontal: 6,
    color: colors.surface,
    backgroundColor: 'rgba(16, 18, 20, 0.42)',
    fontSize: 9,
    fontWeight: '800',
  },
  resultBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 9,
    gap: 5,
  },
  resultTextGroup: {
    flex: 1,
    gap: 3,
  },
  resultName: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '800',
  },
  resultMeta: {
    color: colors.textSecondary,
    fontSize: 8,
  },
  resultEvidence: {
    color: colors.info,
    fontSize: 8,
    fontWeight: '700',
  },
  resultState: {
    color: colors.success,
    fontSize: 22,
    fontWeight: '800',
  },
  resultStateUnknown: {
    color: colors.textTertiary,
  },
  evidenceHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingTop: 5,
  },
  evidenceMark: {
    color: colors.orange,
    fontSize: 12,
  },
  evidenceText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 8,
    lineHeight: 13,
  },
  selectedPlace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  placeImage: {
    width: 50,
    height: 50,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeImageText: {
    color: colors.surface,
    fontSize: 15,
    fontWeight: '800',
  },
  placeCopy: {
    flex: 1,
    gap: 3,
  },
  placeRank: {
    color: colors.orange,
    fontSize: 8,
    fontWeight: '800',
  },
  placeName: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '800',
  },
  placeMeta: {
    color: colors.textSecondary,
    fontSize: 8,
  },
  voteLabel: {
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: '700',
    marginTop: 4,
  },
  voteRow: {
    flexDirection: 'row',
    gap: 5,
  },
  voteChoice: {
    flex: 1,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.xs,
    backgroundColor: colors.chipBg,
  },
  voteChoiceActive: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  voteIcon: {
    color: colors.textSecondary,
    fontSize: 18,
    fontWeight: '800',
  },
  voteChoiceLabel: {
    color: colors.textSecondary,
    fontSize: 7,
    fontWeight: '700',
  },
  voteTextActive: {
    color: colors.surface,
  },
  shareHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 9,
    borderRadius: radius.xs,
    backgroundColor: colors.activeBg,
  },
  shareIcon: {
    color: colors.orange,
    fontSize: 14,
    fontWeight: '800',
  },
  shareHintText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 8,
    lineHeight: 13,
  },
  caption: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 2,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.black,
  },
  stepText: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  captionBody: {
    flex: 1,
    gap: 2,
  },
  captionTitle: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '800',
  },
  captionDescription: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
});
