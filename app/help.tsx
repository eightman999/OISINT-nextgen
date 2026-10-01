import { router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Image,
  useWindowDimensions,
  View,
} from 'react-native';

import { AgeRequirementNote } from '@/components/AgeRequirementNote';
import { HelpScreenshot } from '@/components/HelpScreenshot';
import { Footer } from '@/components/Footer';
import { colors, fonts, guideColors, radius } from '@/theme';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal-transparent.png');

type HelpSectionId = 'start' | 'read' | 'share' | 'faq';

const TOPICS: { id: HelpSectionId; label: string; note: string }[] = [
  { id: 'start', label: 'まずはここから', note: '最初の3分' },
  { id: 'read', label: '結果の読み方', note: '○ △ × ?' },
  { id: 'share', label: 'みんなで決める', note: '共有・投票' },
  { id: 'faq', label: '困ったとき', note: 'よくある質問' },
];

// #269: ランキングのスコア構成要素と重みの開示。
// 値は supabase/functions/_shared/ranking.ts（spec §17 の実装）と一致させること。捏造・概算での更新禁止。
const RANKING_FACTORS: { name: string; weight: string; note: string }[] = [
  { name: '条件一致', weight: '0.55', note: '入力条件とEvidenceの一致度。優先度の高い条件ほど重視します。' },
  { name: '意味的近さ', weight: '0.15', note: '要望文と候補の意味的な近さです。' },
  { name: 'Evidenceの質', weight: '0.10', note: '出典の信頼性（上位3件の平均）です。' },
  { name: '新しさ', weight: '0.10', note: '確認できた情報の新しさです。' },
  { name: 'グループ投票', weight: '0.10', note: 'メンバーの投票。投票が無い間は中立値で扱います。' },
  { name: '過去の高評価加点', weight: '最大+0.05', note: '過去の類似調査でメンバーに高評価だった店への加点です。' },
];

const FAQS = [
  {
    category: '検索',
    question: '場所を入力しないと検索できませんか？',
    answer:
      '現在地の利用を許可しなくても大丈夫です。「池袋駅」「渋谷スクランブルスクエア」など、探したい場所を入力してから検索できます。',
    tags: ['場所', 'GPS', '検索'],
  },
  {
    category: '検索',
    question: '条件はどのくらい詳しく書けばいいですか？',
    answer:
      '一文だけで始められます。「池袋で3人。3000円くらい。肉。」のように、場所・人数・予算・食べたいものを書けばOKです。検索後に条件を追加することもできます。',
    tags: ['条件', '検索', 'はじめ方'],
  },
  {
    category: '結果',
    question: '○・△・×・? は何を表していますか？',
    answer:
      '○は条件に合う、△は一部確認が必要、×は合わない、? は情報が見つからず判断できない状態です。? を無理に○とみなさないことが、OISINTの大事な特徴です。',
    tags: ['結果', 'Evidence', '不明'],
  },
  {
    category: '共有',
    question: '友だちはアカウントを作らないと参加できませんか？',
    answer:
      '共有URLを開いて表示名を入力するだけで参加できます。候補を見てから、行きたい・どちらでも・行きたくないの投票を送れます。',
    tags: ['共有', '投票', '参加'],
  },
  {
    category: '結果',
    question: '候補の情報はどこから来ていますか？',
    answer:
      '候補の詳細には、参照したページと確認できた内容を表示します。出典を開いて自分でも確認できるので、重要な条件はお店への確認も組み合わせてください。',
    tags: ['出典', 'Evidence', '結果'],
  },
  {
    category: '困ったとき',
    question: '候補が少ない・見つからないときは？',
    answer:
      '場所を少し広げる、予算を「くらい」にする、こだわり条件を一つ外す、の順で試してください。最初の条件を勝手に変更するのではなく、追加・変更した内容を画面に残して比較できます。',
    tags: ['候補', '検索', '条件'],
  },
];

export default function HelpScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 820;
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsets = useRef<Partial<Record<HelpSectionId, number>>>({});
  const [faqQuery, setFaqQuery] = useState('');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const scrollToSection = (id: HelpSectionId) => {
    const y = sectionOffsets.current[id];
    if (typeof y === 'number') {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 14), animated: true });
    }
  };

  const normalizedQuery = faqQuery.trim().toLocaleLowerCase();
  const visibleFaqs = FAQS.filter((faq) => {
    if (!normalizedQuery) return true;
    const searchable = [faq.category, faq.question, faq.answer, ...faq.tags]
      .join(' ')
      .toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  });

  return (
    <View style={styles.wrapper}>
      <ScrollView
        ref={scrollRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.container, isWide && styles.containerWide]}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="OISINTのトップへ戻る"
              onPress={() => router.replace('/')}
              style={styles.backButton}
            >
              <Text style={styles.backArrow}>←</Text>
              <Image
                source={BRAND_LOGO}
                resizeMode="contain"
                accessibilityLabel="OISINTロゴ"
                style={styles.topLogoImage}
              />
            </Pressable>
            <Pressable
              testID="help-support"
              accessibilityRole="button"
              accessibilityLabel="サポートを開く"
              onPress={() => router.replace({ pathname: '/support' } as never)}
              style={styles.helpLabel}
            >
              <Text style={styles.helpLabelText}>サポートへ ↗</Text>
            </Pressable>
          </View>

          <View style={styles.hero}>
            <View style={styles.heroGlow} />
            <View style={styles.heroMark}>
              <Text style={styles.heroMarkText}>◉</Text>
            </View>
            <Text style={styles.heroOverline}>OISINTの使い方ガイド</Text>
            <Text style={styles.heroTitle}>迷ったら、ここから。</Text>
            <Text style={styles.heroCopy}>
              場所と好みを入れて、候補を比べて、みんなで決める。
              {'\n'}はじめてでも迷わないように、画面の見方を順番に案内します。
            </Text>
            <View style={styles.heroRoute}>
              <RouteItem index="01" label="探す" color={colors.amber} />
              <View style={styles.routeLine} />
              <RouteItem index="02" label="比べる" color={colors.orange} />
              <View style={styles.routeLine} />
              <RouteItem index="03" label="決める" color={guideColors.decision} />
            </View>
          </View>

          <View style={styles.topicPanel}>
            <View style={styles.topicHeadingRow}>
              <View>
                <Text style={styles.topicEyebrow}>もくじ</Text>
                <Text style={styles.topicHeading}>知りたいところへ</Text>
              </View>
              <Text style={styles.topicHeadingNote}>タップで移動</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.topicScroll}
            >
              {TOPICS.map((topic) => (
                <Pressable
                  key={topic.id}
                  accessibilityRole="button"
                  onPress={() => scrollToSection(topic.id)}
                  style={styles.topicCard}
                >
                  <Text style={styles.topicCardLabel}>{topic.label}</Text>
                  <Text style={styles.topicCardNote}>{topic.note}</Text>
                  <Text style={styles.topicCardArrow}>↘</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          <View
            onLayout={(event) => {
              sectionOffsets.current.start = event.nativeEvent.layout.y;
            }}
            style={styles.section}
          >
            <SectionHeading
              number="01"
              eyebrow="はじめに"
              title="最初の3分で、使い方がわかる"
              copy="OISINTは、検索サイトというより「みんなの条件をそろえて決める」ための調査ノートです。"
            />
            <View style={[styles.screenshotGrid, isWide && styles.screenshotGridWide]}>
              <HelpScreenshot
                kind="home"
                step="01"
                title="場所と条件を一文で"
                description="現在地または場所を選び、人数・予算・食べたいものを書いて検索します。"
              />
              <HelpScreenshot
                kind="results"
                step="02"
                title="候補を根拠つきで比べる"
                description="店名だけで決めず、条件の判定と出典を開いて確認します。"
              />
              <HelpScreenshot
                kind="vote"
                step="03"
                title="共有して、みんなで決める"
                description="共有URLを送り、参加者の投票を集めます。決定文も作れます。"
              />
            </View>
          </View>

          <View
            onLayout={(event) => {
              sectionOffsets.current.read = event.nativeEvent.layout.y;
            }}
            style={[styles.section, styles.readSection]}
          >
            <SectionHeading
              number="02"
              eyebrow="結果の読み方"
              title="おすすめの理由を、画面で確かめる"
              copy="OISINTは、わからないことをわからないまま表示します。記号と出典を見れば、次に確認することがすぐわかります。"
            />
            <View style={[styles.legendGrid, isWide && styles.legendGridWide]}>
              <LegendItem symbol="○" color={colors.success} title="条件に合う" copy="確認できた情報が条件に合っています。" />
              <LegendItem symbol="△" color={colors.warning} title="一部確認が必要" copy="おおむね合うけれど、店への確認がおすすめです。" />
              <LegendItem symbol="×" color={colors.danger} title="条件に合わない" copy="必須条件と合わない情報が見つかっています。" />
              <LegendItem symbol="?" color={colors.textTertiary} title="まだ不明" copy="情報がなく、OISINTが断定していません。" />
            </View>
            <View style={styles.evidenceCallout}>
              <View style={styles.evidenceCalloutMark}>
                <Text style={styles.evidenceCalloutMarkText}>✦</Text>
              </View>
              <View style={styles.evidenceCalloutBody}>
                <Text style={styles.evidenceCalloutTitle}>「Evidence」を開くと、出典まで見られます</Text>
                <Text style={styles.evidenceCalloutCopy}>
                  条件の判定だけでなく、参照したページ・引用・確認時点を表示します。重要なことは、最後にお店へ直接確認してください。
                </Text>
              </View>
            </View>
            {/* ランキングの性質とスコア構成要素の開示（#269）。値は ranking.ts の実装と一致させる。 */}
            <View testID="help-ranking-disclosure" style={styles.rankingCard}>
              <Text style={styles.rankingEyebrow}>順位の開示</Text>
              <Text style={styles.rankingTitle}>順位（おすすめ順）の決まり方</Text>
              <Text style={styles.rankingCopy}>
                順位は入力した条件への適合度を示すもので、店舗の一般的な優劣や人気の順位ではありません。スコアは次の要素を組み合わせて計算します（かっこ内は重み。スコアは0〜1の範囲）。
              </Text>
              <View style={styles.rankingFactorList}>
                {RANKING_FACTORS.map((factor) => (
                  <View key={factor.name} style={styles.rankingFactorRow}>
                    <View style={styles.rankingFactorHead}>
                      <Text style={styles.rankingFactorName}>{factor.name}</Text>
                      <Text style={styles.rankingFactorWeight}>（{factor.weight}）</Text>
                    </View>
                    <Text style={styles.rankingFactorNote}>{factor.note}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.rankingCopy}>
                必須条件に合わないことが確認された候補は、1件につき0.40の大きな減点をします。同点の場合は、先に登録された候補を上に表示します。
              </Text>
              <Text style={styles.rankingCopy}>
                掲載順位について店舗等から金銭を受け取っていません。今後、広告を掲載する場合は、広告であることがわかる表示を行います。
              </Text>
            </View>
          </View>

          <View
            onLayout={(event) => {
              sectionOffsets.current.share = event.nativeEvent.layout.y;
            }}
            style={[styles.section, styles.shareSection]}
          >
            <SectionHeading
              number="03"
              eyebrow="みんなで決める"
              title="幹事も、参加者も、同じ画面で"
              copy="ひとりで候補を探して終わりではありません。URLを送って、みんなの気持ちを集めます。"
            />
            <View style={[styles.roleGrid, isWide && styles.roleGridWide]}>
              <RoleCard
                role="幹事"
                label="候補をつくる人"
                accent={colors.orange}
                steps={['場所・好み・予算を入力', '候補とEvidenceを確認', '共有URLをコピー']}
              />
              <RoleCard
                role="参加者"
                label="一緒に決める人"
                accent={guideColors.participant}
                steps={['共有URLを開く', '候補を見て条件を追加', '行きたい店に投票']}
              />
            </View>
            <View style={styles.votingNote}>
              <Text style={styles.votingNoteIcon}>✓</Text>
              <Text style={styles.votingNoteText}>
                投票は「決定」ではありません。票だけで順位を決めず、条件と根拠を見ながら最後に相談できます。
              </Text>
            </View>
          </View>

          <View
            onLayout={(event) => {
              sectionOffsets.current.faq = event.nativeEvent.layout.y;
            }}
            style={[styles.section, styles.faqSection]}
          >
            <SectionHeading
              number="04"
              eyebrow="よくある質問"
              title="困ったときは、ここを検索"
              copy="画面で起きていることをそのまま入力してください。よくあるつまずきを短くまとめています。"
            />
            <View style={styles.faqSearchBox}>
              <Text style={styles.faqSearchIcon}>⌕</Text>
              <TextInput
                value={faqQuery}
                onChangeText={setFaqQuery}
                placeholder="例：GPS、共有、候補が少ない"
                placeholderTextColor={colors.textTertiary}
                accessibilityLabel="ヘルプを検索"
                style={styles.faqSearchInput}
              />
              {faqQuery ? (
                <Pressable onPress={() => setFaqQuery('')} style={styles.clearSearch}>
                  <Text style={styles.clearSearchText}>×</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.faqList}>
              {visibleFaqs.map((faq, index) => {
                const originalIndex = FAQS.indexOf(faq);
                const isOpen = openFaq === originalIndex;
                return (
                  <Pressable
                    key={faq.question}
                    accessibilityRole="button"
                    onPress={() => setOpenFaq(isOpen ? null : originalIndex)}
                    style={[styles.faqItem, isOpen && styles.faqItemOpen]}
                  >
                    <View style={styles.faqQuestionRow}>
                      <View style={styles.faqCategory}>
                        <Text style={styles.faqCategoryText}>{faq.category}</Text>
                      </View>
                      <Text style={styles.faqQuestion}>{faq.question}</Text>
                      <Text style={styles.faqToggle}>{isOpen ? '−' : '+'}</Text>
                    </View>
                    {isOpen ? <Text style={styles.faqAnswer}>{faq.answer}</Text> : null}
                  </Pressable>
                );
              })}
              {visibleFaqs.length === 0 ? (
                <View style={styles.noFaq}>
                  <Text style={styles.noFaqTitle}>その言葉の質問はまだありません</Text>
                  <Text style={styles.noFaqCopy}>「検索」「共有」「?」のように短い言葉でも試せます。</Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.endCard}>
            <View style={styles.endMark}>
              <Text style={styles.endMarkText}>◉</Text>
            </View>
            <Text style={styles.endTitle}>準備ができたら、まず一文。</Text>
            <Text style={styles.endCopy}>場所と「こんな時間にしたい」を書けば、OISINTが次の一歩を案内します。</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace('/')}
              style={styles.startButton}
            >
              <Text style={styles.startButtonText}>OISINTをはじめる  →</Text>
            </Pressable>
            {/* 対象年齢の表示（#273）。Gemini API Additional Terms の年齢要件に基づき、利用開始導線へ常設する。 */}
            <AgeRequirementNote testID="help-age-requirement" style={styles.ageNote} />
          </View>
        </View>
      </ScrollView>
      <Footer />
    </View>
  );
}

function RouteItem({ index, label, color }: { index: string; label: string; color: string }) {
  return (
    <View style={styles.routeItem}>
      <View style={[styles.routeDot, { backgroundColor: color }]}>
        <Text style={styles.routeIndex}>{index}</Text>
      </View>
      <Text style={styles.routeLabel}>{label}</Text>
    </View>
  );
}

function SectionHeading({
  number,
  eyebrow,
  title,
  copy,
}: {
  number: string;
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionNumber}>
        <Text style={styles.sectionNumberText}>{number}</Text>
      </View>
      <View style={styles.sectionHeadingBody}>
        <Text style={styles.sectionEyebrow}>{eyebrow}</Text>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCopy}>{copy}</Text>
      </View>
    </View>
  );
}

function LegendItem({
  symbol,
  color,
  title,
  copy,
}: {
  symbol: string;
  color: string;
  title: string;
  copy: string;
}) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSymbol, { borderColor: color }]}>
        <Text style={[styles.legendSymbolText, { color }]}>{symbol}</Text>
      </View>
      <View style={styles.legendBody}>
        <Text style={styles.legendTitle}>{title}</Text>
        <Text style={styles.legendCopy}>{copy}</Text>
      </View>
    </View>
  );
}

function RoleCard({
  role,
  label,
  accent,
  steps,
}: {
  role: string;
  label: string;
  accent: string;
  steps: string[];
}) {
  return (
    <View style={styles.roleCard}>
      <View style={styles.roleTop}>
        <View style={[styles.roleDot, { backgroundColor: accent }]} />
        <Text style={styles.roleName}>{role}</Text>
        <Text style={styles.roleLabel}>{label}</Text>
      </View>
      <View style={styles.roleSteps}>
        {steps.map((step, index) => (
          <View key={step} style={styles.roleStep}>
            <Text style={[styles.roleStepNumber, { color: accent }]}>{String(index + 1).padStart(2, '0')}</Text>
            <Text style={styles.roleStepText}>{step}</Text>
          </View>
        ))}
      </View>
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
    paddingBottom: 28,
  },
  container: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    gap: 22,
  },
  containerWide: {
    gap: 28,
  },
  topBar: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 42,
    paddingRight: 8,
  },
  backArrow: {
    color: colors.textSecondary,
    fontSize: 20,
    lineHeight: 22,
  },
  topLogoImage: {
    width: 112,
    height: 34,
  },
  helpLabel: {
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  helpLabelText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
  },
  hero: {
    position: 'relative',
    overflow: 'hidden',
    minHeight: 310,
    padding: 24,
    borderRadius: 22,
    backgroundColor: colors.black,
  },
  heroGlow: {
    position: 'absolute',
    width: 230,
    height: 230,
    right: -58,
    top: -72,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(244, 81, 30, 0.2)',
    transform: [{ rotate: '28deg' }],
  },
  heroMark: {
    width: 46,
    height: 46,
    marginBottom: 22,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.orange,
  },
  heroMarkText: {
    color: colors.surface,
    fontSize: 20,
    fontWeight: '800',
  },
  heroOverline: {
    color: colors.amber,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: fonts.brand,
  },
  heroTitle: {
    maxWidth: 500,
    marginTop: 8,
    color: colors.surface,
    fontSize: 36,
    lineHeight: 46,
    fontWeight: '800',
    letterSpacing: -1.7,
  },
  heroCopy: {
    maxWidth: 530,
    marginTop: 12,
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 12,
    lineHeight: 21,
  },
  heroRoute: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 360,
    marginTop: 26,
  },
  routeItem: {
    alignItems: 'center',
    gap: 5,
  },
  routeDot: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeIndex: {
    color: colors.black,
    fontSize: 8,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  routeLabel: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '700',
  },
  routeLine: {
    flex: 1,
    height: 1,
    marginHorizontal: 10,
    marginBottom: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
  },
  topicPanel: {
    paddingVertical: 17,
    paddingHorizontal: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  topicHeadingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  topicEyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
    fontFamily: fonts.brand,
  },
  topicHeading: {
    marginTop: 3,
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  topicHeadingNote: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  topicScroll: {
    gap: 8,
    paddingTop: 13,
    paddingBottom: 2,
  },
  topicCard: {
    position: 'relative',
    width: 142,
    minHeight: 76,
    justifyContent: 'space-between',
    padding: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  topicCardLabel: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  topicCardNote: {
    color: colors.textSecondary,
    fontSize: 9,
  },
  topicCardArrow: {
    position: 'absolute',
    right: 10,
    bottom: 9,
    color: colors.orange,
    fontSize: 15,
    fontWeight: '700',
  },
  section: {
    gap: 18,
    paddingTop: 6,
  },
  readSection: {
    paddingTop: 20,
  },
  shareSection: {
    paddingTop: 20,
  },
  faqSection: {
    paddingTop: 20,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 2,
  },
  sectionNumber: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.orange,
  },
  sectionNumberText: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  sectionHeadingBody: {
    flex: 1,
    gap: 4,
  },
  sectionEyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
    fontFamily: fonts.brand,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 31,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  sectionCopy: {
    maxWidth: 680,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
  screenshotGrid: {
    gap: 28,
  },
  screenshotGridWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  legendGrid: {
    gap: 8,
  },
  legendGridWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  legendItem: {
    flex: 1,
    minWidth: 190,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  legendSymbol: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    backgroundColor: colors.surface,
  },
  legendSymbolText: {
    fontSize: 18,
    fontWeight: '800',
  },
  legendBody: {
    flex: 1,
    gap: 3,
  },
  legendTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  legendCopy: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 16,
  },
  evidenceCallout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.activeBg,
    borderWidth: 1,
    borderColor: guideColors.evidenceBorder,
  },
  evidenceCalloutMark: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.orange,
  },
  evidenceCalloutMarkText: {
    color: colors.surface,
    fontSize: 14,
  },
  evidenceCalloutBody: {
    flex: 1,
    gap: 4,
  },
  evidenceCalloutTitle: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '800',
  },
  evidenceCalloutCopy: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 17,
  },
  rankingCard: {
    gap: 8,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  rankingEyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
    fontFamily: fonts.brand,
  },
  rankingTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  rankingCopy: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
  rankingFactorList: {
    gap: 7,
    paddingVertical: 2,
  },
  rankingFactorRow: {
    gap: 1,
  },
  rankingFactorHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  rankingFactorName: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
  },
  rankingFactorWeight: {
    color: colors.orange,
    fontSize: 10,
    fontWeight: '700',
  },
  rankingFactorNote: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  roleGrid: {
    gap: 10,
  },
  roleGridWide: {
    flexDirection: 'row',
  },
  roleCard: {
    flex: 1,
    padding: 15,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  roleTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingBottom: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  roleDot: {
    width: 9,
    height: 9,
    borderRadius: radius.pill,
  },
  roleName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  roleLabel: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  roleSteps: {
    paddingTop: 10,
    gap: 9,
  },
  roleStep: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  roleStepNumber: {
    width: 20,
    fontSize: 9,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  roleStepText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 17,
  },
  votingNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    paddingHorizontal: 2,
  },
  votingNoteIcon: {
    color: colors.success,
    fontSize: 16,
    fontWeight: '800',
  },
  votingNoteText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
  faqSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 13,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  faqSearchIcon: {
    color: colors.orange,
    fontSize: 21,
    lineHeight: 22,
    marginRight: 8,
  },
  faqSearchInput: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 0,
    color: colors.text,
    fontSize: 13,
  },
  clearSearch: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
  },
  clearSearchText: {
    color: colors.textSecondary,
    fontSize: 17,
    lineHeight: 19,
  },
  faqList: {
    gap: 8,
  },
  faqItem: {
    padding: 13,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  faqItemOpen: {
    borderColor: guideColors.faqBorder,
    backgroundColor: guideColors.faqSurface,
  },
  faqQuestionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  faqCategory: {
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.activeBg,
  },
  faqCategoryText: {
    color: colors.orange,
    fontSize: 8,
    fontWeight: '800',
  },
  faqQuestion: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  faqToggle: {
    width: 20,
    color: colors.orange,
    fontSize: 20,
    lineHeight: 18,
    textAlign: 'right',
  },
  faqAnswer: {
    marginTop: 11,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: guideColors.faqRule,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 19,
  },
  noFaq: {
    padding: 20,
    alignItems: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  noFaqTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  noFaqCopy: {
    marginTop: 5,
    color: colors.textSecondary,
    fontSize: 10,
  },
  endCard: {
    alignItems: 'center',
    padding: 24,
    borderRadius: 20,
    backgroundColor: guideColors.closingSurface,
    borderWidth: 1,
    borderColor: guideColors.evidenceBorder,
  },
  endMark: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.black,
  },
  endMarkText: {
    color: colors.surface,
    fontSize: 18,
    fontWeight: '800',
  },
  endTitle: {
    marginTop: 12,
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  endCopy: {
    maxWidth: 440,
    marginTop: 7,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
    textAlign: 'center',
  },
  startButton: {
    minHeight: 44,
    marginTop: 16,
    paddingHorizontal: 18,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.black,
  },
  startButtonText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '800',
  },
  ageNote: {
    marginTop: 14,
    textAlign: 'center',
  },
});
