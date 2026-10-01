import { useState } from 'react';
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
import {
  SupportChoiceGroup,
  SupportField,
  SupportNotice,
  SupportPrivacyNote,
  SupportSubmitButton,
} from '@/components/SupportFormFields';
import { SupportHeader } from '@/components/SupportHeader';
import { SUPPORT_ISSUES_URL, hasConfiguredSupportEmail, handoffSupportMessage } from '@/lib/support';
import { colors, fonts, radius } from '@/theme';

const FEEDBACK_AREAS = [
  { value: 'search', label: '検索', description: '条件を入れて候補を探す' },
  { value: 'compare', label: '候補の比較', description: '条件やEvidenceを見る' },
  { value: 'share', label: '共有・投票', description: 'みんなで決める' },
  { value: 'other', label: 'その他', description: 'それ以外の体験' },
];

const RATINGS = [
  { value: 1, icon: '·', label: 'まだ困る' },
  { value: 2, icon: '⌁', label: 'もう少し' },
  { value: 3, icon: '○', label: 'ふつう' },
  { value: 4, icon: '＋', label: 'よかった' },
  { value: 5, icon: '✦', label: '最高' },
];

type FeedbackStatus = 'idle' | 'error' | 'opened' | 'copied' | 'unavailable';

export default function FeedbackScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 780;
  const [rating, setRating] = useState<number | null>(null);
  const [area, setArea] = useState(FEEDBACK_AREAS[0].value);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<FeedbackStatus>('idle');

  const handleSubmit = async () => {
    if (!rating) {
      setStatus('error');
      return;
    }

    const selectedArea = FEEDBACK_AREAS.find((option) => option.value === area);
    const selectedRating = RATINGS.find((option) => option.value === rating);
    const result = await handoffSupportMessage({
      kind: 'feedback',
      subject: `[OISINT] フィードバック / ${selectedArea?.label ?? 'その他'}`,
      fields: [
        { label: '体験した場所', value: selectedArea?.label ?? 'その他' },
        { label: '手応え', value: `${rating} / 5（${selectedRating?.label ?? ''}）` },
        { label: 'コメント', value: comment.trim() },
      ],
    });
    setStatus(result === 'opened' ? 'opened' : result === 'copied' ? 'copied' : 'unavailable');
  };

  const submitLabel = hasConfiguredSupportEmail ? 'メール作成画面を開く ↗' : '内容をコピーする';

  return (
    <View style={styles.wrapper}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.container, isWide && styles.containerWide]}>
          <SupportHeader current="feedback" />

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>フィードバック</Text>
            <Text style={styles.title}>今日のOISINTを、{ '\n' }ひとこと教えてください。</Text>
            <Text style={styles.copy}>
              1分もかかりません。よかったところも、わかりにくかったところも、次の改善に使います。
            </Text>
          </View>

          <View style={[styles.formLayout, isWide && styles.formLayoutWide]}>
            <View style={styles.formCard}>
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>今日の手応え</Text>
                <Text style={styles.fieldHint}>必須</Text>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel="今日の手応え"
                  style={styles.ratingRow}
                >
                  {RATINGS.map((option) => {
                    const active = option.value === rating;
                    return (
                      <Pressable
                        key={option.value}
                        testID={`feedback-rating-${option.value}`}
                        accessibilityRole="radio"
                        accessibilityLabel={`${option.value}、${option.label}`}
                        accessibilityState={{ checked: active }}
                        aria-checked={active}
                        onPress={() => {
                          setRating(option.value);
                          if (status === 'error') setStatus('idle');
                        }}
                        style={[styles.ratingCard, active && styles.ratingCardActive]}
                      >
                        <Text style={[styles.ratingIcon, active && styles.ratingTextActive]}>{option.icon}</Text>
                        <Text style={[styles.ratingValue, active && styles.ratingTextActive]}>{option.value}</Text>
                        <Text style={[styles.ratingLabel, active && styles.ratingTextActive]}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <SupportChoiceGroup
                label="どの場面についてですか？"
                options={FEEDBACK_AREAS}
                value={area}
                onChange={setArea}
              />
              <SupportField
                testID="feedback-comment"
                label="コメント"
                hint="任意"
                value={comment}
                onChangeText={setComment}
                placeholder="よかったところ、迷ったところ、こうなったら嬉しいこと"
                multiline
              />
              {status === 'error' ? (
                <SupportNotice tone="error">手応えを1つ選んでから送ってください。</SupportNotice>
              ) : null}
              {status === 'opened' ? (
                <SupportNotice tone="success">メール作成画面を開きました。内容を確認して送信してください。</SupportNotice>
              ) : null}
              {status === 'copied' ? (
                <View style={styles.copiedGuide}>
                  <SupportNotice tone="success">内容をコピーしました。まだ送信はされていません。GitHubのIssuesページに貼り付けて報告してください。</SupportNotice>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="OISINTのGitHub Issuesページを開く"
                    onPress={() => {
                      Linking.openURL(SUPPORT_ISSUES_URL).catch(() => {});
                    }}
                    style={styles.issuesLink}
                  >
                    <Text style={styles.issuesLinkText}>GitHub Issues を開く ↗</Text>
                  </Pressable>
                </View>
              ) : null}
              {status === 'unavailable' ? (
                <SupportNotice tone="error">この環境ではメール作成やコピーを開けません。入力内容を選択して保存してください。</SupportNotice>
              ) : null}
              <SupportSubmitButton
                testID="feedback-submit"
                label={submitLabel}
                disabled={!rating}
                onPress={() => void handleSubmit()}
              />
              <SupportPrivacyNote />
            </View>

            <View style={[styles.sideNote, isWide && styles.sideNoteWide]}>
              <Text style={styles.sideEyebrow}>伝わる書き方</Text>
              <Text style={styles.sideTitle}>短くても、具体的に。</Text>
              <Text style={styles.sideCopy}>
                「よかった」だけでも歓迎です。もし書けそうなら、どの画面で何を感じたかを一つだけ教えてください。
              </Text>
              <View style={styles.quoteCard}>
                <Text style={styles.quoteMark}>“</Text>
                <Text style={styles.quoteText}>候補の根拠が見えるので、友だちに説明しやすかった。</Text>
              </View>
              <View style={styles.sideRule} />
              <Text style={styles.sideFootnote}>個人を特定する情報は書かないでください。</Text>
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
    maxWidth: 980,
    alignSelf: 'center',
    gap: 24,
  },
  containerWide: {
    gap: 30,
  },
  intro: {
    maxWidth: 700,
    gap: 5,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.3,
    fontFamily: fonts.brand,
  },
  title: {
    color: colors.text,
    fontSize: 30,
    lineHeight: 41,
    fontWeight: '800',
    letterSpacing: -1.1,
  },
  copy: {
    marginTop: 6,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
  formLayout: {
    gap: 14,
  },
  formLayoutWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  formCard: {
    flex: 1,
    gap: 19,
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  copiedGuide: {
    gap: 8,
  },
  issuesLink: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  issuesLinkText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  fieldGroup: {
    gap: 7,
  },
  fieldLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  fieldHint: {
    position: 'absolute',
    right: 0,
    top: 1,
    color: colors.textTertiary,
    fontSize: 10,
  },
  ratingRow: {
    flexDirection: 'row',
    gap: 6,
  },
  ratingCard: {
    flex: 1,
    minHeight: 82,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  ratingCardActive: {
    borderColor: colors.orange,
    backgroundColor: colors.activeBg,
  },
  ratingIcon: {
    color: colors.textTertiary,
    fontSize: 18,
    fontWeight: '800',
  },
  ratingValue: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  ratingLabel: {
    color: colors.textSecondary,
    fontSize: 8,
  },
  ratingTextActive: {
    color: colors.orange,
  },
  sideNote: {
    width: '100%',
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.black,
  },
  sideNoteWide: {
    width: 280,
    flexShrink: 0,
  },
  sideEyebrow: {
    color: colors.amber,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: fonts.brand,
  },
  sideTitle: {
    marginTop: 6,
    color: colors.surface,
    fontSize: 20,
    fontWeight: '800',
  },
  sideCopy: {
    marginTop: 9,
    color: 'rgba(255, 255, 255, 0.62)',
    fontSize: 11,
    lineHeight: 18,
  },
  quoteCard: {
    marginTop: 20,
    padding: 13,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  quoteMark: {
    height: 18,
    color: colors.orange,
    fontSize: 28,
    lineHeight: 28,
    fontFamily: fonts.brand,
  },
  quoteText: {
    color: colors.surface,
    fontSize: 12,
    lineHeight: 20,
    fontWeight: '700',
  },
  sideRule: {
    height: 1,
    marginTop: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  sideFootnote: {
    marginTop: 10,
    color: 'rgba(255, 255, 255, 0.48)',
    fontSize: 10,
    lineHeight: 16,
  },
});
