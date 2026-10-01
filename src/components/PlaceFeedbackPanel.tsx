import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatPlaceFeedbackRating,
  hasDisplayablePlaceFeedbackSummary,
  placeFeedbackAspectLabel,
  placeFeedbackValueLabel,
  PLACE_FEEDBACK_ASPECTS,
  PLACE_FEEDBACK_VALUE_OPTIONS,
  isCanonicalPlaceFeedbackValue,
} from '@/lib/placeFeedback';
import type { FeedbackLearningReason } from '@/lib/preferenceLearningFeedback';
import { colors, radius } from '@/theme';
import type {
  PlaceFeedback,
  PlaceFeedbackAspect,
  PlaceFeedbackInput,
  PlaceFeedbackRating,
  PlaceFeedbackSummary,
} from '@/types';

export interface PlaceFeedbackPanelProps {
  /** 本人と店舗が変わったら、未保存の入力も破棄する。実画面はhookのformKeyを渡す。 */
  formKey?: string;
  feedback?: PlaceFeedback;
  summary?: PlaceFeedbackSummary;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  onSave: (input: PlaceFeedbackInput) => Promise<void>;
  /** #515: 保存後に本人が明示した場合だけプロフィールへ反映する。 */
  personalizationApplied?: boolean;
  personalizationSaving?: boolean;
  personalizationError?: string | null;
  personalizationReasons?: FeedbackLearningReason[];
  applyFeedbackToPersonalization?: () => Promise<void>;
}

export function PlaceFeedbackPanel(props: PlaceFeedbackPanelProps) {
  const feedbackKey = [
    props.formKey ?? '',
    props.feedback?.id ?? 'new',
    props.feedback?.visitedAt ?? '',
    props.feedback?.rating ?? '',
    props.feedback?.aspect ?? '',
    props.feedback?.aspectValue ?? '',
  ].join(':');
  return <PlaceFeedbackForm key={feedbackKey} {...props} />;
}

function PlaceFeedbackForm({
  feedback,
  summary,
  loading = false,
  saving = false,
  error,
  onSave,
  personalizationApplied = false,
  personalizationSaving = false,
  personalizationError,
  personalizationReasons = [],
  applyFeedbackToPersonalization,
}: PlaceFeedbackPanelProps) {
  const [visitedAt, setVisitedAt] = useState(feedback?.visitedAt ?? '');
  const [rating, setRating] = useState<PlaceFeedbackRating | undefined>(feedback?.rating);
  const [aspect, setAspect] = useState<PlaceFeedbackAspect | undefined>(feedback?.aspect);
  const [aspectValue, setAspectValue] = useState(
    feedback?.aspectValue && isCanonicalPlaceFeedbackValue(feedback.aspect, feedback.aspectValue)
      ? feedback.aspectValue
      : '',
  );
  const hasInput = Boolean(visitedAt.trim() || rating !== undefined || aspect || aspectValue.trim());

  const handleSave = async () => {
    try {
      await onSave({
        ...(visitedAt.trim() ? { visitedAt: visitedAt.trim() } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(aspect ? { aspect } : {}),
        ...(aspectValue.trim() ? { aspectValue: aspectValue.trim() } : {}),
      });
    } catch {
      // hook/serviceが利用者向け固定文言を表示する。内部エラーはUIへ漏らさない。
    }
  };

  return (
    <View testID="place-feedback" style={styles.container}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.heading}>来店後フィードバック</Text>
          <Text style={styles.description}>
            行った店の記録を残せます。店舗情報の集計には使いますが、個人の好みには自動反映しません。
          </Text>
        </View>
        {feedback ? <Text testID="place-feedback-owned" style={styles.owned}>あなたの記録</Text> : null}
      </View>

      {loading ? <Text style={styles.status}>記録を読み込んでいます…</Text> : null}
      {feedback?.visitedAt ? (
        <Text testID="place-feedback-visited-status" style={styles.visitedStatus}>
          来店済み：{feedback.visitedAt}
        </Text>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>来店日（任意）</Text>
        <View style={styles.visitRow}>
          <TextInput
            testID="place-feedback-visited-at"
            accessibilityLabel="来店日"
            value={visitedAt}
            onChangeText={setVisitedAt}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.placeholder}
            style={styles.input}
            maxLength={10}
          />
          <Pressable
            testID="place-feedback-visited"
            accessibilityRole="button"
            accessibilityLabel="行ったと記録する"
            onPress={() => setVisitedAt((current) => current || today())}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>行った</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>全体の評価（任意）</Text>
        <View style={styles.choiceRow}>
          {([
            [-1, '気になった'],
            [0, 'どちらでもない'],
            [1, 'よかった'],
          ] as const).map(([value, label]) => (
            <Pressable
              key={value}
              testID={`place-feedback-rating-${value}`}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ checked: rating === value }}
              aria-checked={rating === value}
              onPress={() => setRating(value)}
              style={[styles.choice, rating === value && styles.choiceSelected]}
            >
              <Text style={[styles.choiceText, rating === value && styles.choiceTextSelected]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        {feedback?.rating !== undefined ? (
          <Text style={styles.currentValue}>現在の評価：{formatPlaceFeedbackRating(feedback.rating)}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>店舗の様子（任意）</Text>
        <View style={styles.choiceRow}>
          {PLACE_FEEDBACK_ASPECTS.map((option) => (
            <Pressable
              key={option.value}
              testID={`place-feedback-aspect-choice-${option.value}`}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: aspect === option.value }}
              aria-checked={aspect === option.value}
              onPress={() => {
                setAspect(option.value);
                setAspectValue((current) =>
                  isCanonicalPlaceFeedbackValue(option.value, current) ? current : '',
                );
              }}
              style={[styles.choice, aspect === option.value && styles.choiceSelected]}
            >
              <Text style={[styles.choiceText, aspect === option.value && styles.choiceTextSelected]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {aspect ? (
          <View style={styles.choiceRow}>
            {PLACE_FEEDBACK_VALUE_OPTIONS[aspect].map((option) => (
              <Pressable
                key={option.value}
                testID={`place-feedback-aspect-value-choice-${aspect}-${option.value}`}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: aspectValue === option.value }}
                aria-checked={aspectValue === option.value}
                onPress={() => setAspectValue(option.value)}
                style={[styles.choice, aspectValue === option.value && styles.choiceSelected]}
              >
                <Text style={[styles.choiceText, aspectValue === option.value && styles.choiceTextSelected]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.currentValue}>項目を選ぶと選択肢が表示されます</Text>
        )}
      </View>

      {error ? (
        <Text testID="place-feedback-error" accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Pressable
        testID="place-feedback-save"
        accessibilityRole="button"
        accessibilityLabel={feedback ? '来店後フィードバックを更新' : '来店後フィードバックを保存'}
        onPress={() => void handleSave()}
        disabled={!hasInput || saving || loading}
        style={[styles.saveButton, (!hasInput || saving || loading) && styles.disabled]}
      >
        <Text style={styles.saveButtonText}>{saving ? '保存中…' : feedback ? '記録を更新' : '記録を保存'}</Text>
      </Pressable>

      {feedback && applyFeedbackToPersonalization && !personalizationApplied ? (
        <View testID="place-feedback-personalization" style={styles.personalizationPrompt}>
          <Text style={styles.personalizationHeading}>この感想を今後のおすすめに反映する</Text>
          <Text style={styles.personalizationDescription}>
            既定では反映しません。あなたが下のボタンを押した時だけ、評価と安全な項目名を好みプロフィールへ追加します。アレルギーなどの制約や自由記述本文は対象外です。
          </Text>
          <Pressable
            testID="place-feedback-personalization-apply"
            accessibilityRole="button"
            accessibilityLabel="この感想を今後のおすすめに反映する"
            onPress={() => void applyFeedbackToPersonalization()}
            disabled={personalizationSaving}
            style={[styles.personalizationButton, personalizationSaving && styles.disabled]}
          >
            <Text style={styles.personalizationButtonText}>
              {personalizationSaving ? '反映中…' : 'おすすめに反映する'}
            </Text>
          </Pressable>
          {personalizationError ? (
            <Text testID="place-feedback-personalization-error" accessibilityRole="alert" style={styles.error}>
              {personalizationError}
            </Text>
          ) : null}
        </View>
      ) : null}

      {feedback && personalizationApplied ? (
        <View testID="place-feedback-personalization-applied" style={styles.personalizationApplied}>
          <Text style={styles.personalizationHeading}>おすすめへの反映を完了しました</Text>
          {personalizationReasons.slice(0, 3).map((reason) => (
            <Text key={`${reason.source}:${reason.axis ?? reason.label}`} style={styles.personalizationReason}>
              {reason.label}が{reason.direction}
            </Text>
          ))}
        </View>
      ) : null}

      {hasDisplayablePlaceFeedbackSummary(summary) ? <Summary summary={summary!} /> : null}
    </View>
  );
}

function Summary({ summary }: { summary: PlaceFeedbackSummary }) {
  return (
    <View testID="place-feedback-summary" style={styles.summary}>
      <Text style={styles.summaryHeading}>みんなの集計</Text>
      {summary.visitedCount >= 3 ? (
        <Text testID="place-feedback-summary-visited" style={styles.summaryText}>3人以上の来店記録があります</Text>
      ) : null}
      {summary.ratingAverage !== null ? (
        <Text testID="place-feedback-summary-rating" style={styles.summaryText}>
          平均評価 {summary.ratingAverage > 0 ? '+' : ''}{summary.ratingAverage.toFixed(2)}（3件以上）
        </Text>
      ) : null}
      {summary.aspects.map((item) => {
        const valueLabel = placeFeedbackValueLabel(item.aspect, item.aspectValue);
        if (!valueLabel) return null;
        return (
          <Text
            key={`${item.aspect}:${item.aspectValue}`}
            testID={`place-feedback-summary-${item.aspect}`}
            style={styles.summaryText}
          >
            {placeFeedbackAspectLabel(item.aspect)}：{valueLabel}（3件以上）
          </Text>
        );
      })}
    </View>
  );
}

function today(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  headingCopy: { flex: 1, gap: 4 },
  heading: { fontSize: 16, fontWeight: '800', color: colors.text },
  description: { fontSize: 11, lineHeight: 17, color: colors.textSecondary },
  owned: { fontSize: 10, color: colors.info, fontWeight: '700' },
  status: { fontSize: 12, color: colors.textSecondary },
  visitedStatus: { fontSize: 13, color: colors.success, fontWeight: '700' },
  field: { gap: 7 },
  label: { fontSize: 12, color: colors.text, fontWeight: '700' },
  visitRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xs,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 13,
  },
  secondaryButton: {
    minHeight: 40,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    backgroundColor: colors.infoSoft,
    borderWidth: 1,
    borderColor: colors.info,
  },
  secondaryButtonText: { color: colors.info, fontWeight: '700', fontSize: 12 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  choice: {
    minHeight: 36,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceSelected: { borderColor: colors.orange, backgroundColor: colors.activeBg },
  choiceText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  choiceTextSelected: { color: colors.text, fontWeight: '800' },
  currentValue: { color: colors.textTertiary, fontSize: 11 },
  error: { color: colors.danger, fontSize: 12, lineHeight: 17 },
  personalizationPrompt: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.xs,
    backgroundColor: colors.infoSoft,
  },
  personalizationApplied: {
    gap: 4,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: radius.xs,
    backgroundColor: colors.surface,
  },
  personalizationHeading: { color: colors.text, fontSize: 13, fontWeight: '800' },
  personalizationDescription: { color: colors.textSecondary, fontSize: 11, lineHeight: 17 },
  personalizationReason: { color: colors.textSecondary, fontSize: 11, lineHeight: 16 },
  personalizationButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    backgroundColor: colors.info,
  },
  personalizationButtonText: { color: colors.surface, fontWeight: '800', fontSize: 12 },
  saveButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    backgroundColor: colors.orange,
  },
  saveButtonText: { color: colors.surface, fontWeight: '800', fontSize: 13 },
  disabled: { opacity: 0.45 },
  summary: { gap: 5, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderSoft },
  summaryHeading: { color: colors.text, fontSize: 13, fontWeight: '800' },
  summaryText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
});
