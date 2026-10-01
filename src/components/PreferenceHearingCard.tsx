import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  answerPreferenceHearingLocally,
  getNextPreferenceHearingQuestionLocally,
  type PersonalizationSubject,
} from '@/lib/personalization';
import type { PreferenceHearingOption } from '@/lib/preferenceLearning';
import { colors, fonts, radius } from '@/theme';
import type { TasteProfile } from '@/types';

const HEARING_DISMISS_PREFIX = 'oisint:preference-hearing:dismissed:';

interface PreferenceHearingCardProps {
  profile: TasteProfile;
  onProfileChange: (profile: TasteProfile) => void;
  subject?: PersonalizationSubject;
}

export function PreferenceHearingCard({
  profile,
  onProfileChange,
  subject,
}: PreferenceHearingCardProps) {
  const [question] = useState(() => {
    const candidate = getNextPreferenceHearingQuestionLocally(profile, subject);
    return candidate && !wasDismissedThisSession(candidate.id) ? candidate : null;
  });
  const [hidden, setHidden] = useState(false);
  const [answerMessage, setAnswerMessage] = useState('');

  if (!question || hidden) return null;

  const answer = (optionId: PreferenceHearingOption['id']) => {
    const committed = answerPreferenceHearingLocally(question, optionId, profile, subject);
    if (!committed) return;
    onProfileChange(committed.tasteProfile);
    setAnswerMessage('回答を反映しました。次の店探しから使います。');
  };

  return (
    <View testID="preference-hearing" style={styles.container}>
      <View style={styles.topline}>
        <View style={styles.agentBadge}>
          <View style={styles.agentDot} />
          <Text style={styles.agentBadgeText}>OISINTから、1問だけ</Text>
        </View>
        {!answerMessage ? (
          <Pressable
            testID="preference-hearing-dismiss"
            accessibilityRole="button"
            accessibilityLabel="この質問を今回は閉じる"
            onPress={() => {
              dismissForThisSession(question.id);
              setHidden(true);
            }}
            style={styles.dismissButton}
          >
            <Text style={styles.dismissText}>今回は閉じる</Text>
          </Pressable>
        ) : null}
      </View>

      {answerMessage ? (
        <View style={styles.answerState}>
          <Text accessibilityRole="alert" style={styles.answerText}>✓ {answerMessage}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="確認メッセージを閉じる"
            onPress={() => setHidden(true)}
            style={styles.closeButton}
          >
            <Text style={styles.closeButtonText}>閉じる</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.prompt}>{question.prompt}</Text>
          <Text style={styles.reason}>{question.reason}</Text>
          <View style={styles.optionRow}>
            {question.options.map((option) => (
              <Pressable
                key={option.id}
                testID={`preference-hearing-${option.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${option.label}。${option.description}`}
                onPress={() => answer(option.id)}
                style={styles.option}
              >
                <Text style={styles.optionLabel}>{option.label}</Text>
                <Text style={styles.optionDescription}>{option.description}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function wasDismissedThisSession(questionId: string): boolean {
  if (typeof window === 'undefined' || !window.sessionStorage) return false;
  try {
    return window.sessionStorage.getItem(`${HEARING_DISMISS_PREFIX}${questionId}`) === '1';
  } catch {
    return false;
  }
}

function dismissForThisSession(questionId: string): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(`${HEARING_DISMISS_PREFIX}${questionId}`, '1');
  } catch {
    // Session-only dismissal is optional; the learned aggregate remains unchanged.
  }
}

const styles = StyleSheet.create({
  container: {
    marginTop: 14,
    padding: 17,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.md,
    backgroundColor: colors.hearingSoft,
  },
  topline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  agentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  agentDot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.info,
  },
  agentBadgeText: {
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  dismissButton: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  dismissText: {
    color: colors.textTertiary,
    fontSize: 8,
    textDecorationLine: 'underline',
  },
  prompt: {
    maxWidth: 760,
    marginTop: 12,
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 22,
  },
  reason: {
    marginTop: 5,
    color: colors.textSecondary,
    fontSize: 8,
    lineHeight: 15,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 13,
  },
  option: {
    minWidth: 150,
    maxWidth: '100%',
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  optionLabel: {
    color: colors.text,
    fontSize: 9,
    fontWeight: '800',
  },
  optionDescription: {
    marginTop: 3,
    color: colors.textTertiary,
    fontSize: 7,
    lineHeight: 12,
  },
  answerState: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 12,
  },
  answerText: {
    flex: 1,
    color: colors.success,
    fontSize: 9,
    fontWeight: '800',
  },
  closeButton: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 13,
    borderRadius: radius.sm,
    backgroundColor: colors.text,
  },
  closeButtonText: {
    color: colors.surface,
    fontSize: 8,
    fontWeight: '800',
  },
});
