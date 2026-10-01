import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import { setInvestigationVisibility } from '@/lib/api';
import { colors, radius } from '@/theme';
import type { PublicInvestigation } from '@/types';

interface VisibilityToggleProps {
  investigationId: string;
  visibility: 'private' | 'public';
  /** owner のみ切り替え UI を表示（#115）。PATCH は owner 以外 403 */
  canToggle: boolean;
  onVisibilityChange?: (next: 'private' | 'public') => void;
}

// 公開/非公開切り替え（issue #115 / §3 P1, §33）。既定 private。
// owner 以外には表示しない（canToggle=false）。
export function VisibilityToggle({
  investigationId,
  visibility,
  canToggle,
  onVisibilityChange,
}: VisibilityToggleProps) {
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [lastVisibility, setLastVisibility] = useState(visibility);

  // visibility の変更（購読の snapshot 更新）を監視してエラー表示を消す。
  // effect 内で同期 setState しないため、描画中に前回値と比較してリセットする。
  if (lastVisibility !== visibility) {
    setLastVisibility(visibility);
    if (errorMessage) setErrorMessage('');
  }

  if (!canToggle) return null;

  const handleToggle = async () => {
    const next = visibility === 'public' ? 'private' : 'public';
    setBusy(true);
    setErrorMessage('');
    try {
      await setInvestigationVisibility(investigationId, next);
      onVisibilityChange?.(next);
    } catch {
      setErrorMessage('公開設定を変更できませんでした。権限と通信状態を確認してください。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="inv-visibility" style={styles.container}>
      <Text style={styles.title}>公開設定</Text>
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.state}>
            {visibility === 'public' ? '公開中' : '非公開'}
          </Text>
          <Text style={styles.description}>
            {visibility === 'public'
              ? '公開ページでは候補と根拠のみを表示します。検索文・条件の文面・投票は表示されません。'
              : 'あなたと共有リンクを受け取った参加者だけが閲覧できます。'}
          </Text>
        </View>
        <Pressable
          testID="inv-visibility-toggle"
          accessibilityRole="switch"
          accessibilityLabel={visibility === 'public' ? '非公開に切り替える' : '公開に切り替える'}
          accessibilityState={{ checked: visibility === 'public', disabled: busy }}
          aria-checked={visibility === 'public'}
          disabled={busy}
          onPress={() => void handleToggle()}
          style={[styles.button, busy && styles.disabled]}
        >
          <Text style={styles.buttonText}>
            {busy ? '変更中…' : visibility === 'public' ? '非公開にする' : '公開する'}
          </Text>
        </Pressable>
      </View>
      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

// 公開ページの候補表示。公開データには requirement 文面・votes が無い（§33）ため、
// 判定の連番・状態・説明と Evidence だけを出す。
export function PublicCandidateCard({ candidate }: { candidate: PublicInvestigation['candidates'][number] }) {
  return (
    <View testID={`pub-candidate-${candidate.rank}`} style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.rankBadge}>
          <Text style={styles.rankText}>{candidate.rank}</Text>
        </View>
        <View style={styles.cardHeaderCopy}>
          <Text style={styles.cardName}>{candidate.place.name}</Text>
          <Text style={styles.cardMeta}>
            {candidate.place.genre}
            {candidate.place.access ? ` / ${candidate.place.access}` : ''}
          </Text>
        </View>
      </View>

      {candidate.evaluations.length > 0 && (
        <View style={styles.evaluationList}>
          {candidate.evaluations.map((evaluation) => (
            <View key={evaluation.index} style={styles.evaluationRow}>
              <Text style={[styles.stateSymbol, { color: matchStateColor(evaluation.state) }]}>
                {matchStateSymbol(evaluation.state)}
              </Text>
              <View style={styles.evaluationCopy}>
                <Text style={styles.conditionLabel}>条件 {evaluation.index}</Text>
                <Text style={styles.explanation}>{evaluation.explanation}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {candidate.pros && candidate.pros.length > 0 && (
        <View style={styles.pros}>
          {candidate.pros.map((pro) => (
            <Text key={pro} style={styles.proText}>・{pro}</Text>
          ))}
        </View>
      )}

      {candidate.evidence.length > 0 && (
        <View style={styles.evidenceList}>
          {candidate.evidence.map((evidence) => (
            <View key={evidence.id} style={styles.evidenceItem}>
              <Text style={styles.evidenceSource}>
                {evidence.sourceTitle ?? evidence.sourceType}
              </Text>
              <Text style={styles.evidenceExcerpt}>{evidence.excerpt}</Text>
            </View>
          ))}
        </View>
      )}

      {candidate.contradictions.length > 0 && (
        <Text style={styles.contradictionNote}>
          ⚠ 情報源によって食い違う情報が {candidate.contradictions.length} 件あります
        </Text>
      )}

      {candidate.place.budget ? (
        <Text style={styles.budget}>予算目安　{candidate.place.budget} / 人</Text>
      ) : null}
    </View>
  );
}

function matchStateSymbol(state: string): string {
  switch (state) {
    case 'match':
      return '✓';
    case 'partial':
      return '△';
    case 'mismatch':
      return '✗';
    default:
      return '？';
  }
}

function matchStateColor(state: string): string {
  switch (state) {
    case 'match':
      return colors.success;
    case 'partial':
      return colors.warning;
    case 'mismatch':
      return colors.danger;
    default:
      return colors.textTertiary;
  }
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  },
  copy: {
    flex: 1,
    minWidth: 200,
    gap: 3,
  },
  state: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text,
  },
  description: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  button: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.sm,
    backgroundColor: colors.infoSoft,
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.info,
  },
  disabled: {
    opacity: 0.5,
  },
  error: {
    fontSize: 11,
    color: colors.danger,
  },
  card: {
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rankBadge: {
    width: 27,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.orange,
  },
  rankText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.surface,
  },
  cardHeaderCopy: {
    flex: 1,
    gap: 2,
  },
  cardName: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  cardMeta: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  evaluationList: {
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: 8,
  },
  evaluationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  stateSymbol: {
    width: 18,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 18,
  },
  evaluationCopy: {
    flex: 1,
    gap: 2,
  },
  conditionLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  explanation: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  pros: {
    gap: 3,
  },
  proText: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.success,
  },
  evidenceList: {
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: 8,
  },
  evidenceItem: {
    gap: 2,
    padding: 10,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.canvas,
  },
  evidenceSource: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  evidenceExcerpt: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  contradictionNote: {
    fontSize: 11,
    color: colors.warning,
  },
  budget: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  loadingWrap: {
    alignItems: 'center',
    paddingVertical: 30,
  },
});

export function LoadingIndicator() {
  return (
    <View style={styles.loadingWrap}>
      <Text>読み込んでいます…</Text>
    </View>
  );
}
