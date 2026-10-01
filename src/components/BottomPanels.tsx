import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  matchStateAccessibilityLabel,
  matchStateColor,
  matchStateSymbol,
} from '@/lib/format';
import { colors, fonts } from '@/theme';
import type { Candidate, Evidence, Requirement, VoteValue } from '@/types';

// design.html: .bottom-grid の3パネル（比較 / みんなの投票 / Evidence）

interface ComparisonPanelProps {
  candidates: Candidate[];
  requirements: Requirement[];
  /** 760px以上では候補を列にした表、それ未満では候補カードを縦積みする。 */
  isWide?: boolean;
}

function voteSummary(candidate: Candidate): string {
  const votes = Object.values(candidate.votes) as VoteValue[];
  const count = (value: VoteValue) => votes.filter((vote) => vote === value).length;
  return `👍 ${count(1)} / 🤔 ${count(0)} / 👎 ${count(-1)}`;
}

function rankingScore(candidate: Candidate): string {
  return Number.isFinite(candidate.score) ? candidate.score.toFixed(2) : '?';
}

function evaluationState(candidate: Candidate, requirementId: string) {
  return candidate.evaluations.find(
    (evaluation) => evaluation.requirementId === requirementId
  )?.state ?? 'unknown';
}

function CandidateComparisonMetrics({ candidate }: { candidate: Candidate }) {
  return (
    <>
      <View style={styles.mobileMetricRow}>
        <Text style={styles.mobileMetricLabel}>順位計算値</Text>
        <Text testID={`comparison-score-${candidate.id}`} style={styles.mobileMetricValue}>
          {rankingScore(candidate)}
        </Text>
      </View>
      <View style={styles.mobileMetricRow}>
        <Text style={styles.mobileMetricLabel}>Evidence</Text>
        <Text testID={`comparison-evidence-${candidate.id}`} style={styles.mobileMetricValue}>
          {candidate.evidence.length}件
        </Text>
      </View>
      <View style={styles.mobileMetricRow}>
        <Text style={styles.mobileMetricLabel}>投票</Text>
        <Text testID={`comparison-votes-${candidate.id}`} style={styles.mobileMetricValue}>
          {voteSummary(candidate)}
        </Text>
      </View>
    </>
  );
}

export function ComparisonPanel({ candidates, requirements, isWide = true }: ComparisonPanelProps) {
  const sortedCandidates = [...candidates].sort((left, right) => left.rank - right.rank);

  return (
    <View testID="candidate-comparison" style={[styles.panel, styles.comparisonPanel]}>
      <Text style={styles.panelTitle}>候補の比較</Text>
      <Text style={styles.comparisonNote}>
        順位計算値は条件適合度の比較用で、成功確率ではありません。
      </Text>
      {isWide ? (
        <View testID="candidate-comparison-wide" style={styles.table}>
          <View style={styles.tableRow}>
            <Text style={[styles.tableHeadCell, styles.tableLabelCell]}>比較項目</Text>
            {sortedCandidates.map((candidate) => (
              <Text key={candidate.id} style={styles.tableHeadCell} numberOfLines={2}>
                {candidate.rank}位 {candidate.place.name}
              </Text>
            ))}
          </View>
          <View style={styles.tableRow}>
            <Text style={[styles.tableCell, styles.tableLabelCell]}>順位計算値</Text>
            {sortedCandidates.map((candidate) => (
              <Text
                key={candidate.id}
                testID={`comparison-score-${candidate.id}`}
                style={styles.tableCell}
              >
                {rankingScore(candidate)}
              </Text>
            ))}
          </View>
          <View style={styles.tableRow}>
            <Text style={[styles.tableCell, styles.tableLabelCell]}>Evidence</Text>
            {sortedCandidates.map((candidate) => (
              <Text
                key={candidate.id}
                testID={`comparison-evidence-${candidate.id}`}
                style={styles.tableCell}
              >
                {candidate.evidence.length}件
              </Text>
            ))}
          </View>
          <View style={styles.tableRow}>
            <Text style={[styles.tableCell, styles.tableLabelCell]}>投票</Text>
            {sortedCandidates.map((candidate) => (
              <Text
                key={candidate.id}
                testID={`comparison-votes-${candidate.id}`}
                style={styles.tableCell}
              >
                {voteSummary(candidate)}
              </Text>
            ))}
          </View>
          {requirements.map((requirement) => (
            <View key={requirement.id} style={styles.tableRow}>
              <Text style={[styles.tableCell, styles.tableLabelCell]} numberOfLines={2}>
                {requirement.normalizedText}
              </Text>
              {sortedCandidates.map((candidate) => {
                const state = evaluationState(candidate, requirement.id);
                return (
                  <Text
                    accessibilityLabel={`${candidate.place.name}: ${matchStateAccessibilityLabel(state)}`}
                    key={candidate.id}
                    testID={`comparison-state-${candidate.id}-${requirement.id}`}
                    style={[styles.tableCell, styles.tableMatch, { color: matchStateColor(state) }]}
                  >
                    {matchStateSymbol(state)}
                  </Text>
                );
              })}
            </View>
          ))}
        </View>
      ) : (
        <View testID="candidate-comparison-stacked" style={styles.mobileComparisonList}>
          {sortedCandidates.map((candidate) => (
            <View key={candidate.id} style={styles.mobileCandidate}>
              <Text style={styles.mobileCandidateTitle}>
                {candidate.rank}位 {candidate.place.name}
              </Text>
              <CandidateComparisonMetrics candidate={candidate} />
              <View style={styles.mobileRequirementList}>
                {requirements.map((requirement) => {
                  const state = evaluationState(candidate, requirement.id);
                  return (
                    <View key={requirement.id} style={styles.mobileMetricRow}>
                      <Text style={styles.mobileRequirementLabel}>
                        {requirement.normalizedText}
                      </Text>
                      <Text
                        accessibilityLabel={`${candidate.place.name}: ${matchStateAccessibilityLabel(state)}`}
                        testID={`comparison-state-${candidate.id}-${requirement.id}`}
                        style={[styles.mobileMatch, { color: matchStateColor(state) }]}
                      >
                        {matchStateSymbol(state)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

interface VotePanelProps {
  candidates: Candidate[];
  onVotePress?: () => void;
}

export function VotePanel({ candidates, onVotePress }: VotePanelProps) {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank);

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>みんなの投票</Text>
      <View style={styles.voteList}>
        {sorted.map((candidate) => {
          const upVotes = (Object.values(candidate.votes) as VoteValue[]).filter(
            (v) => v === 1
          ).length;
          return (
            <View key={candidate.id} style={styles.voteItem}>
              <Text style={styles.voteRank}>{candidate.rank}</Text>
              <Text style={styles.voteName} numberOfLines={1}>
                {candidate.place.name}
              </Text>
              <Text style={styles.voteCount}>{upVotes}票</Text>
            </View>
          );
        })}
      </View>
      {onVotePress && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="候補に投票する"
          style={styles.voteButton}
          onPress={onVotePress}
        >
          <Text style={styles.voteButtonText}>投票する</Text>
        </Pressable>
      )}
    </View>
  );
}

interface EvidencePanelProps {
  evidence: Evidence[];
}

export function EvidencePanel({ evidence }: EvidencePanelProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Evidence</Text>
      {evidence.length === 0 ? (
        <Text testID="inv-evidence-empty" style={styles.empty}>
          Evidenceはまだ収集されていません
        </Text>
      ) : (
        <View style={styles.evidenceList}>
          {evidence.slice(0, 4).map((item) => (
            <View key={item.id} style={styles.evidenceItem}>
              <View style={styles.sourceIcon}>
                <Text style={styles.sourceIconText}>
                  {(item.sourceTitle ?? item.sourceType).charAt(0)}
                </Text>
              </View>
              <View style={styles.evidenceBody}>
                <Text style={styles.sourceName} numberOfLines={1}>
                  {item.sourceTitle ?? item.sourceType}
                </Text>
                <Text style={styles.sourceMeta} numberOfLines={2}>
                  {item.excerpt}
                </Text>
              </View>
              <Text style={styles.evidenceDate}>{item.observedAt.slice(5).replace('-', '/')}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    minWidth: 240,
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    padding: 12,
  },
  panelTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 10,
  },
  comparisonPanel: {
    width: '100%',
  },
  comparisonNote: {
    marginTop: -4,
    marginBottom: 10,
    fontSize: 10,
    lineHeight: 15,
    color: colors.textSecondary,
  },
  table: {
    gap: 0,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    paddingVertical: 6,
    gap: 4,
  },
  tableHeadCell: {
    flex: 1,
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
    textAlign: 'center',
  },
  tableCell: {
    flex: 1,
    fontSize: 10,
    color: colors.text,
    textAlign: 'center',
  },
  tableLabelCell: {
    flex: 1.8,
    textAlign: 'left',
  },
  tableMatch: {
    fontWeight: '800',
    fontSize: 11,
    fontFamily: fonts.brand,
  },
  mobileComparisonList: {
    gap: 10,
  },
  mobileCandidate: {
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 8,
    padding: 10,
    gap: 3,
  },
  mobileCandidateTitle: {
    marginBottom: 5,
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  mobileMetricRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    paddingVertical: 5,
  },
  mobileMetricLabel: {
    flex: 1,
    fontSize: 10,
    color: colors.textSecondary,
  },
  mobileMetricValue: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  mobileRequirementList: {
    marginTop: 4,
  },
  mobileRequirementLabel: {
    flex: 1,
    fontSize: 10,
    color: colors.text,
  },
  mobileMatch: {
    width: 28,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  voteList: {
    gap: 7,
  },
  voteItem: {
    minHeight: 36,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  voteRank: {
    width: 20,
    fontWeight: '800',
    fontSize: 12,
    color: colors.text,
    fontFamily: fonts.brand,
  },
  voteName: {
    flex: 1,
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
  },
  voteCount: {
    fontSize: 10,
    color: colors.textSecondary,
  },
  voteButton: {
    marginTop: 10,
    minHeight: 38,
    borderRadius: 7,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voteButtonText: {
    color: colors.surface,
    fontWeight: '700',
    fontSize: 12,
  },
  evidenceList: {
    gap: 6,
  },
  evidenceItem: {
    minHeight: 38,
    padding: 7,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sourceIcon: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceDisabled,
  },
  sourceIconText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  evidenceBody: {
    flex: 1,
  },
  sourceName: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
  },
  sourceMeta: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 8,
    lineHeight: 11,
  },
  evidenceDate: {
    fontSize: 9,
    color: colors.textTertiary,
    textAlign: 'right',
  },
  empty: {
    fontSize: 11,
    color: colors.textTertiary,
    fontStyle: 'italic',
  },
});
