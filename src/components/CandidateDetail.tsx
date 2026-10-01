import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { generateDecisionText } from '@/lib/decisionText';
import { googleMapsDirectionsUrlForPlace, googleMapsUrlForPlace } from '@/lib/googleMapsUrl';
import {
  matchStateAccessibilityLabel,
  matchStateColor,
  matchStateSymbol,
} from '@/lib/format';
import { safeShopUrl } from '@/lib/shopUrl';
import { safePublicEvidenceUrl } from '@/lib/evidenceSafety';
import { colors, evidenceColors, radius } from '@/theme';
import type { Candidate, Evidence, Investigation, PlaceFact, Requirement, VoteValue } from '@/types';

import { CandidateLocationCard } from './CandidateLocationCard';
import { PlaceFactsBadge } from './PlaceFactsBadge';
import { PlaceFeedbackPanel, type PlaceFeedbackPanelProps } from './PlaceFeedbackPanel';
import { RestaurantHeroImage, useRestaurantHeroImage } from './RestaurantHeroImage';
import { VoteButtons } from './VoteButtons';

interface CandidateDetailProps {
  candidate: Candidate;
  investigation?: Investigation;
  requirements: Requirement[];
  /** 対象 place の place_facts（§44.5）。未指定/空なら既存の Evidence 表示のみ（フォールバック） */
  placeFacts?: PlaceFact[];
  /** 本人の来店記録と、3件以上に丸めた公開集計（#110）。 */
  placeFeedback?: PlaceFeedbackPanelProps;
  userVote?: VoteValue;
  userVoteComment?: string;
  onVoteChange?: (value: VoteValue, comment?: string) => void;
  onMapOpened?: () => void;
  onDecisionCopied?: () => void;
}

export function CandidateDetail({
  candidate,
  investigation,
  requirements,
  placeFacts,
  placeFeedback,
  userVote,
  userVoteComment,
  onVoteChange,
  onMapOpened,
  onDecisionCopied,
}: CandidateDetailProps) {
  const [mapStatus, setMapStatus] = useState<'idle' | 'unavailable'>('idle');
  const [shopStatus, setShopStatus] = useState<'idle' | 'unavailable'>('idle');
  const mapUrl = googleMapsUrlForPlace(candidate.place);
  const directionsUrl = googleMapsDirectionsUrlForPlace(candidate.place);
  // 店舗写真（§3 P1 / #109）。photoUrl が無い・読み込めない場合は候補カードと同じプレースホルダへ。
  const hero = useRestaurantHeroImage(candidate.place);
  // 店舗ページ・予約導線（§3 P1 / #109）。metadata.shopUrl 由来。https 以外は表示しない。
  const shopUrl = safeShopUrl(candidate.place.urls?.pc);
  const decisionText = investigation
    ? generateDecisionText(investigation, candidate, {
        mapUrl,
      })
    : null;
  const voteComments = Object.entries(candidate.voteComments ?? {})
    .sort(([leftMemberId], [rightMemberId]) => leftMemberId.localeCompare(rightMemberId))
    .map(([memberId, comment]) => ({
      memberId,
      displayName:
        investigation?.members.find((member) => member.id === memberId)?.displayName ?? '不明',
      comment,
    }));

  const handleOpenMap = async () => {
    setMapStatus('idle');
    try {
      await Linking.openURL(mapUrl);
      onMapOpened?.();
    } catch {
      setMapStatus('unavailable');
    }
  };

  const handleOpenDirections = async () => {
    setMapStatus('idle');
    try {
      await Linking.openURL(directionsUrl);
      onMapOpened?.();
    } catch {
      setMapStatus('unavailable');
    }
  };

  const handleOpenShopPage = async () => {
    if (!shopUrl) return;
    setShopStatus('idle');
    try {
      await Linking.openURL(shopUrl);
    } catch {
      setShopStatus('unavailable');
    }
  };

  return (
    <View style={styles.container}>
      {/* 店舗写真ヒーロー（§3 P1 / #109）。写真がない場合は生成画像を使わずジャンルを表示する */}
      <RestaurantHeroImage hero={hero} genre={candidate.place.genre} style={styles.heroWrap} />
      <View style={styles.header}>
        <Text style={styles.name}>{candidate.place.name}</Text>
        <View style={styles.mapButtonRow}>
          <Pressable
            testID="candidate-map-open"
            accessibilityRole="link"
            accessibilityLabel={`${candidate.place.name}をGoogle Mapsで確認`}
            onPress={() => void handleOpenMap()}
            style={styles.mapButton}
          >
            <Text style={styles.mapButtonText}>Google Mapsで確認 ↗</Text>
          </Pressable>
          <Pressable
            testID="candidate-directions-open"
            accessibilityRole="link"
            accessibilityLabel={`${candidate.place.name}への道順を地図で見る`}
            onPress={() => void handleOpenDirections()}
            style={styles.mapButton}
          >
            <Text style={styles.mapButtonText}>道順を見る ↗</Text>
          </Pressable>
          {shopUrl ? (
            <Pressable
              testID="candidate-shop-open"
              accessibilityRole="link"
              accessibilityLabel={`${candidate.place.name}の店舗ページを開く。予約もこちらから`}
              onPress={() => void handleOpenShopPage()}
              style={styles.mapButton}
            >
              <Text style={styles.mapButtonText}>店舗ページ・予約 ↗</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {mapStatus === 'unavailable' ? (
        <Text accessibilityRole="alert" style={styles.mapError}>
          地図を開けませんでした。店名をコピーして検索してください。
        </Text>
      ) : null}
      {shopStatus === 'unavailable' ? (
        <Text accessibilityRole="alert" style={styles.mapError}>
          店舗ページを開けませんでした。店名で検索してください。
        </Text>
      ) : null}

      <CandidateLocationCard place={candidate.place} />

      <View style={styles.section}>
        <Text style={styles.heading}>条件</Text>
        {candidate.evaluations.map((evaluation) => {
          const requirement = requirements.find((r) => r.id === evaluation.requirementId);
          const evidence = evaluation.evidenceIds
            .map((evidenceId) => candidate.evidence.find((item) => item.id === evidenceId))
            .find((item): item is Evidence => Boolean(item));
          const kind = requirement?.kind ?? 'other';
          return (
            <View testID={`inv-claim-${kind}`} key={evaluation.requirementId} style={styles.evaluationRow}>
              <Text
                accessibilityLabel={matchStateAccessibilityLabel(evaluation.state)}
                style={[
                  styles.symbol,
                  { color: matchStateColor(evaluation.state) },
                ]}
              >
                {matchStateSymbol(evaluation.state)}
              </Text>
              <View style={styles.evaluationInfo}>
                <Text style={styles.requirementText}>
                  {requirement?.normalizedText ?? evaluation.requirementId}
                </Text>
                <Text style={styles.explanation}>{evaluation.explanation}</Text>
                <Text testID={`inv-claim-source-${kind}`} style={styles.sourceLabel}>
                  {sourceLabel(evidence)}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.section}>
        <Text style={styles.heading}>Evidence</Text>
        <PlaceFactsBadge facts={placeFacts ?? []} />
        {candidate.evidence.length > 0 ? (
          candidate.evidence.map((evidence) => (
            <EvidenceItem key={evidence.id} evidence={evidence} />
          ))
        ) : (
          <Text testID="candidate-evidence-empty" style={styles.empty}>
            Evidenceはまだ収集されていません
          </Text>
        )}
        <Text testID="inv-evidence-footnote" style={styles.evidenceFootnote}>
          引用は原文照合していません。重要な条件は出典を開いて店舗へ直接確認してください。
        </Text>
      </View>

      {candidate.contradictions.length > 0 && (
        <View testID="inv-contradiction" style={styles.section}>
          <Text style={styles.heading}>⚠ 矛盾</Text>
          {candidate.contradictions.map((contradiction, index) => (
            <View key={index} style={styles.contradiction}>
              <Text style={styles.contradictionTitle}>
                {contradiction.key}
              </Text>
              {contradiction.entries.map((entry) => (
                <Text key={entry.evidenceId} style={styles.contradictionEntry}>
                  {entry.evidenceId}: {String(entry.value)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}

      {candidate.pros && candidate.pros.length > 0 && (
        <View testID="inv-pros" style={styles.section}>
          <Text style={styles.heading}>選定理由の補足</Text>
          {candidate.pros.map((pro) => (
            <Text key={pro} style={styles.proText}>・{pro}</Text>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.heading}>投票</Text>
        {/* userVote undefined = 未投票。0 を既定にすると「どちらでも」へ投票済みに
            見えてしまい、自分の投票が反映されたか判別できない（#346） */}
        <VoteCommentEditor
          key={`${candidate.id}:${userVoteComment ?? ''}`}
          userVote={userVote}
          initialComment={userVoteComment}
          onVoteChange={onVoteChange}
        />
        {voteComments.length > 0 ? (
          <View testID="vote-comments" style={styles.voteComments}>
            {voteComments.map((entry) => (
              <Text
                key={entry.memberId}
                testID={`vote-comment-${entry.memberId}`}
                style={styles.voteCommentText}
              >
                {entry.displayName}: {entry.comment}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {placeFeedback ? <PlaceFeedbackPanel key={candidate.place.id} {...placeFeedback} /> : null}

      <DecisionTextPanel decisionText={decisionText} onDecisionCopied={onDecisionCopied} />
    </View>
  );
}

interface DecisionTextPanelProps {
  decisionText: ReturnType<typeof generateDecisionText> | null;
  onDecisionCopied?: () => void;
}

function DecisionTextPanel({ decisionText, onDecisionCopied }: DecisionTextPanelProps) {
  const [decisionFormat, setDecisionFormat] = useState<'short' | 'detailed' | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'unavailable'>('idle');

  const handleCopyDecision = async () => {
    if (!decisionText || !decisionFormat) return;

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setCopyStatus('unavailable');
      return;
    }

    try {
      await navigator.clipboard.writeText(decisionText[decisionFormat]);
      setCopyStatus('copied');
      onDecisionCopied?.();
    } catch {
      setCopyStatus('unavailable');
    }
  };

  if (!decisionText) return null;

  return (
    <View testID="decision-text" style={styles.decisionSection}>
      <Text style={styles.heading}>この店に決めた</Text>
      <Pressable
        testID="decision-button"
        accessibilityRole="button"
        accessibilityLabel="この店に決めた。決定テキストの形式を選ぶ"
        onPress={() => {
          setDecisionFormat((current) => current ?? 'short');
          setCopyStatus('idle');
        }}
        style={styles.decisionButton}
      >
        <Text style={styles.decisionButtonText}>貼り付け用テキストを作る</Text>
      </Pressable>

      {decisionFormat && (
        <View style={styles.decisionBody}>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="決定テキストの形式"
            style={styles.decisionFormatRow}
          >
            <Pressable
              testID="decision-short"
              accessibilityRole="radio"
              accessibilityLabel="短い版を選ぶ"
              accessibilityState={{ checked: decisionFormat === 'short' }}
              aria-checked={decisionFormat === 'short'}
              onPress={() => {
                setDecisionFormat('short');
                setCopyStatus('idle');
              }}
              style={[styles.formatButton, decisionFormat === 'short' && styles.formatButtonActive]}
            >
              <Text style={styles.formatButtonText}>短い版</Text>
            </Pressable>
            <Pressable
              testID="decision-detailed"
              accessibilityRole="radio"
              accessibilityLabel="詳しい版を選ぶ"
              accessibilityState={{ checked: decisionFormat === 'detailed' }}
              aria-checked={decisionFormat === 'detailed'}
              onPress={() => {
                setDecisionFormat('detailed');
                setCopyStatus('idle');
              }}
              style={[styles.formatButton, decisionFormat === 'detailed' && styles.formatButtonActive]}
            >
              <Text style={styles.formatButtonText}>詳しい版</Text>
            </Pressable>
          </View>
          <Text selectable style={styles.decisionPreview}>
            {decisionText[decisionFormat]}
          </Text>
          <Pressable
            testID="decision-copy"
            accessibilityRole="button"
            accessibilityLabel={`${decisionFormat === 'short' ? '短い版' : '詳しい版'}をコピー`}
            onPress={() => void handleCopyDecision()}
            style={styles.copyButton}
          >
            <Text style={styles.copyButtonText}>コピー</Text>
          </Pressable>
          {copyStatus === 'copied' && <Text style={styles.copyStatus}>コピーしました</Text>}
          {copyStatus === 'unavailable' && (
            <Text style={styles.copyStatus}>
              この環境ではコピーできません。テキストを長押しして選択してください。
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function VoteCommentEditor({
  userVote,
  initialComment,
  onVoteChange,
}: {
  userVote?: VoteValue;
  initialComment?: string;
  onVoteChange?: (value: VoteValue, comment?: string) => void;
}) {
  const [commentDraft, setCommentDraft] = useState(initialComment ?? '');
  const submitVote = (value: VoteValue) => {
    const comment = commentDraft.trim();
    if (comment) onVoteChange?.(value, comment);
    else onVoteChange?.(value);
  };
  const disabled = userVote === undefined || !onVoteChange;

  return (
    <>
      <VoteButtons value={userVote} onChange={submitVote} />
      <TextInput
        testID="vote-comment-input"
        accessibilityLabel="投票の任意コメント"
        accessibilityHint="同じ調査のメンバーに表示されます"
        value={commentDraft}
        onChangeText={setCommentDraft}
        placeholder="任意コメント（例: 辛い料理が多そう）"
        multiline
        style={styles.voteCommentInput}
      />
      <Pressable
        testID="vote-comment-save"
        accessibilityRole="button"
        accessibilityLabel="投票コメントを保存"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          if (userVote !== undefined) submitVote(userVote);
        }}
        style={[
          styles.voteCommentButton,
          disabled && styles.voteCommentButtonDisabled,
        ]}
      >
        <Text style={styles.voteCommentButtonText}>コメントを保存</Text>
      </Pressable>
      {userVote === undefined ? (
        <Text style={styles.voteCommentHint}>先に票を選ぶとコメントも保存できます。</Text>
      ) : null}
    </>
  );
}

function sourceLabel(evidence: Evidence | undefined): string {
  if (!evidence) return '出典不明';

  try {
    const domain = new URL(evidence.sourceUrl).hostname.replace(/^www\./i, '');
    return `${evidence.sourceTitle ?? evidence.sourceType} · ${domain}`;
  } catch {
    return evidence.sourceTitle ?? evidence.sourceType;
  }
}

function EvidenceItem({ evidence }: { evidence: Evidence }) {
  const safeUrl = safePublicEvidenceUrl(evidence.sourceUrl);
  const handlePress = () => {
    if (safeUrl) Linking.openURL(safeUrl).catch(() => {});
  };

  const content = (
    <>
      <Text style={styles.evidenceSource}>{evidence.sourceTitle ?? evidence.sourceType}</Text>
      <Text style={styles.evidenceExcerpt}>{evidence.excerpt}</Text>
      {safeUrl && (
        <Text testID="evidence-source-url" style={styles.evidenceUrl}>
          {safeUrl}
        </Text>
      )}
    </>
  );
  return safeUrl ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${evidence.sourceTitle ?? evidence.sourceType}。Evidenceを開く`}
      onPress={handlePress}
      style={styles.evidenceItem}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.evidenceItem}>{content}</View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 20,
    paddingTop: 8,
  },
  // 詳細パネルは幅が広いので、ヒーローの高さを抑えて角丸をパネルに合わせる
  heroWrap: {
    borderRadius: radius.sm,
    maxHeight: 280,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  name: {
    fontSize: 22,
    fontWeight: 'bold',
    color: colors.text,
  },
  mapButtonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    // RNのflexShrink既定は0のため、リンクが3つに増えた際（#109/#484）に
    // 狭幅で親を突き抜ける。縮小と折り返しを許可する（#220）。
    flexShrink: 1,
    maxWidth: '100%',
  },
  mapButton: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.sm,
    backgroundColor: colors.infoSoft,
  },
  mapButtonText: {
    color: colors.info,
    fontSize: 9,
    fontWeight: '800',
  },
  mapError: {
    color: colors.danger,
    fontSize: 9,
  },
  section: {
    gap: 8,
  },
  heading: {
    fontSize: 15,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 4,
  },
  evaluationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  symbol: {
    fontSize: 18,
    fontWeight: '800',
    width: 24,
    textAlign: 'center',
  },
  evaluationInfo: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
  },
  requirementText: {
    fontSize: 14,
    color: colors.textSecondary,
    flex: 1,
  },
  explanation: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  sourceLabel: {
    color: colors.info,
    fontSize: 11,
    lineHeight: 16,
  },
  evidenceItem: {
    backgroundColor: colors.surface,
    borderRadius: radius.xs,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  evidenceSource: {
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.text,
  },
  evidenceExcerpt: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  evidenceUrl: {
    fontSize: 11,
    color: colors.info,
    marginTop: 2,
  },
  evidenceFootnote: {
    color: colors.textTertiary,
    fontSize: 10,
    lineHeight: 15,
  },
  empty: {
    fontSize: 13,
    color: colors.textTertiary,
    fontStyle: 'italic',
  },
  contradiction: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.xs,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  contradictionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.warning,
  },
  contradictionEntry: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  proText: {
    color: evidenceColors.positive,
    lineHeight: 20,
  },
  voteCommentInput: {
    minHeight: 72,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xs,
    color: colors.text,
    backgroundColor: colors.surface,
    textAlignVertical: 'top',
  },
  voteCommentButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    backgroundColor: colors.info,
  },
  voteCommentButtonDisabled: {
    opacity: 0.45,
  },
  voteCommentButtonText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '700',
  },
  voteCommentHint: {
    color: colors.textTertiary,
    fontSize: 11,
  },
  voteComments: {
    gap: 4,
    paddingTop: 4,
  },
  voteCommentText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  decisionSection: {
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  decisionButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  decisionButtonText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '700',
  },
  decisionBody: {
    gap: 8,
  },
  decisionFormatRow: {
    flexDirection: 'row',
    gap: 8,
  },
  formatButton: {
    flex: 1,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  formatButtonActive: {
    borderColor: colors.orange,
    backgroundColor: colors.activeBg,
  },
  formatButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  decisionPreview: {
    minHeight: 100,
    padding: 10,
    borderRadius: radius.xs,
    backgroundColor: colors.surfaceSoft,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 19,
  },
  copyButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  copyButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
  copyStatus: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
});
