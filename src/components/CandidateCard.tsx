import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  matchStateAccessibilityLabel,
  matchStateColor,
  matchStateSymbol,
  voteSymbol,
} from '@/lib/format';
import {
  colors,
  evidenceColors,
  fonts,
  radius,
  rankColor,
  readableTextColor,
  tagColors,
} from '@/theme';
import type { Candidate, InvestigationMember, Requirement, VoteValue } from '@/types';

import { RestaurantHeroImage, useRestaurantHeroImage } from './RestaurantHeroImage';

interface CandidateCardProps {
  candidate: Candidate;
  members: InvestigationMember[];
  requirements?: Requirement[];
  isSelected?: boolean;
  onPress?: () => void;
  /** 自分の投票を内訳の中で「（自分）」として判別するための現在ユーザーID (#346) */
  currentUserId?: string;
}

interface CardTag {
  label: string;
  color: string;
  background: string;
}

interface CandidateRequirementSummary {
  totalRequirements: number;
  matchedRequirements: number;
  missingMustRequirements: Requirement[];
  unresolvedMustRequirements: Requirement[];
  mismatchedMustRequirements: Requirement[];
}

// design.html: .tag-green / .tag-blue / .tag-orange / .tag-red
const TAG_STYLES = tagColors;

// 投票内訳の行（#346）。design spec §15 の vote-name / vote-count 構造に対応する。
const VOTE_GROUP_DEFS: { value: VoteValue; key: string; label: string }[] = [
  { value: 1, key: 'up', label: '行きたい' },
  { value: 0, key: 'neutral', label: 'どちらでも' },
  { value: -1, key: 'down', label: '行きたくない' },
];

function buildTags(candidate: Candidate): CardTag[] {
  const tags: CardTag[] = [];
  const { place } = candidate;

  const walkMatch = place.access?.match(/徒歩\d+分/);
  if (walkMatch) tags.push({ label: walkMatch[0], ...TAG_STYLES.blue });
  if (place.budget) tags.push({ label: `予算 ${place.budget}`, ...TAG_STYLES.green });
  if (place.card === '可') tags.push({ label: 'カード可', ...TAG_STYLES.orange });
  if (candidate.contradictions.length > 0)
    tags.push({ label: `⚠ 矛盾${candidate.contradictions.length}件`, ...TAG_STYLES.red });

  return tags;
}

function summarizeCandidateRequirements(
  evaluations: Candidate['evaluations'],
  requirements?: Requirement[]
): CandidateRequirementSummary {
  // 重複IDでも従来の find（先頭）と some（いずれか）の意味を両立させる。
  const evaluationsByRequirement = new Map<
    string,
    { firstState: Candidate['evaluations'][number]['state']; hasMismatch: boolean }
  >();
  let matchedRequirements = 0;

  for (const evaluation of evaluations) {
    if (evaluation.state === 'match') matchedRequirements += 1;

    const indexedEvaluation = evaluationsByRequirement.get(evaluation.requirementId);
    if (indexedEvaluation) {
      if (evaluation.state === 'mismatch') indexedEvaluation.hasMismatch = true;
    } else {
      evaluationsByRequirement.set(evaluation.requirementId, {
        firstState: evaluation.state,
        hasMismatch: evaluation.state === 'mismatch',
      });
    }
  }

  const missingMustRequirements: Requirement[] = [];
  const unresolvedMustRequirements: Requirement[] = [];
  const mismatchedMustRequirements: Requirement[] = [];

  for (const requirement of requirements ?? []) {
    if (requirement.priority !== 'must') continue;

    const indexedEvaluation = evaluationsByRequirement.get(requirement.id);
    const firstState = indexedEvaluation?.firstState;

    if (firstState === undefined || firstState === 'mismatch' || firstState === 'unknown') {
      missingMustRequirements.push(requirement);
    }
    if (firstState === undefined || firstState === 'unknown') {
      unresolvedMustRequirements.push(requirement);
    }
    if (indexedEvaluation?.hasMismatch) {
      mismatchedMustRequirements.push(requirement);
    }
  }

  return {
    totalRequirements: requirements?.length ?? evaluations.length,
    matchedRequirements,
    missingMustRequirements,
    unresolvedMustRequirements,
    mismatchedMustRequirements,
  };
}

export function CandidateCard({
  candidate,
  members,
  requirements,
  isSelected,
  onPress,
  currentUserId,
}: CandidateCardProps) {
  const voteEntries = Object.entries(candidate.votes) as [string, VoteValue][];
  // 投票者名の解決。members に居ない投票者は既存の流儀どおり「不明」、
  // 自分の票は「（自分）」を付けて判別できるようにする (#346)。
  const voterName = (userId: string): string => {
    const member = members.find((m) => m.id === userId);
    if (!member) return userId === currentUserId ? '自分' : '不明';
    return userId === currentUserId ? `${member.displayName}（自分）` : member.displayName;
  };
  // 票種別（👍/🤔/👎）の内訳。DB では未投票 = votes に行が無い状態なので、
  // value 0 は明示的な「どちらでも」投票として表示する (#346)。
  const voteDisplay = VOTE_GROUP_DEFS.map((group) => ({
    ...group,
    voters: voteEntries
      .filter(([, value]) => value === group.value)
      .map(([userId]) => voterName(userId)),
  })).filter((group) => group.voters.length > 0);
  // 未投票メンバーの判別（§25.3 合意形成）。votes に行が無いメンバーを列挙する。
  const notVotedNames = members
    .filter((member) => !(member.id in candidate.votes))
    .map((member) =>
      member.id === currentUserId ? `${member.displayName}（自分）` : member.displayName
    );

  const { place } = candidate;
  const tags = buildTags(candidate);
  const hero = useRestaurantHeroImage(place);
  const badgeColor = rankColor(candidate.rank);
  const badgeTextColor = readableTextColor(badgeColor);
  const {
    totalRequirements,
    matchedRequirements,
    missingMustRequirements,
    unresolvedMustRequirements,
    mismatchedMustRequirements,
  } = summarizeCandidateRequirements(candidate.evaluations, requirements);
  // #312: score/rank 自体は §17 のまま維持するが、1位候補に未評価/unknown の
  // must が残る場合は「おすすめ」としての1位強調を行わない。
  const suppressRecommendationEmphasis =
    candidate.rank === 1 && unresolvedMustRequirements.length > 0;

  return (
    <Pressable
      testID={`inv-candidate-${candidate.rank}`}
      accessibilityRole="button"
      accessibilityLabel={`候補${candidate.rank}位 ${place.name}${
        suppressRecommendationEmphasis
          ? '。必須条件に未確認項目があるためおすすめ未確定です'
          : ''
      }。候補の詳細を表示`}
      accessibilityHint="タップすると条件適合度と根拠を確認できます"
      onPress={onPress}
      style={[styles.container, isSelected && styles.selectedContainer]}
    >
      {/* Photo hero (design.html: .restaurant-image-wrap) */}
      <RestaurantHeroImage hero={hero} genre={place.genre}>
        {suppressRecommendationEmphasis ? (
          <View
            testID={`inv-rank-unverified-${candidate.rank}`}
            accessibilityLabel="1位候補ですが、必須条件が未確認のためおすすめ未確定です"
            style={styles.unverifiedRankBadge}
          >
            <Text style={styles.unverifiedRankText}>調査不足</Text>
          </View>
        ) : (
          <View
            testID={`inv-rank-${candidate.rank}`}
            style={[styles.rankBadge, { backgroundColor: badgeColor }]}
          >
            <Text style={[styles.rankText, { color: badgeTextColor }]}>{candidate.rank}</Text>
          </View>
        )}
      </RestaurantHeroImage>

      <View style={styles.body}>
        <Text style={styles.name}>{place.name}</Text>
        {place.address?.trim() ? (
          <Text
            testID={`inv-location-${candidate.rank}`}
            accessibilityLabel={`候補${candidate.rank}位の住所 ${place.address.trim()}`}
            numberOfLines={2}
            style={styles.location}
          >
            ⌖ {place.address.trim()}
          </Text>
        ) : null}
        <Text style={styles.meta}>
          {place.genre}
          {'\n'}
          {place.access}
        </Text>

        <Text
          testID={`inv-fill-${candidate.rank}`}
          accessibilityLabel={`条件 ${matchedRequirements}/${totalRequirements}件が一致`}
          style={styles.fillSummary}
        >
          条件 {matchedRequirements}/{totalRequirements}件が一致
        </Text>

        {suppressRecommendationEmphasis ? (
          <>
            <Text
              testID={`inv-gap-${candidate.rank}`}
              accessibilityRole="alert"
              style={[styles.gapSummary, styles.gapSummaryCritical]}
            >
              未確認の必須条件あり:{' '}
              {unresolvedMustRequirements
                .map((requirement) => requirement.normalizedText)
                .join('、')}
            </Text>
            {mismatchedMustRequirements.length > 0 && (
              <Text
                testID={`inv-mismatch-${candidate.rank}`}
                style={[styles.gapSummary, styles.gapSummaryCritical]}
              >
                不適合の必須条件:{' '}
                {mismatchedMustRequirements
                  .map((requirement) => requirement.normalizedText)
                  .join('、')}
              </Text>
            )}
          </>
        ) : missingMustRequirements.length > 0 ? (
          <Text testID={`inv-gap-${candidate.rank}`} style={styles.gapSummary}>
            要確認: {missingMustRequirements.map((requirement) => requirement.normalizedText).join('、')}
          </Text>
        ) : null}

        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.map((tag) => (
              <View key={tag.label} style={[styles.tag, { backgroundColor: tag.background }]}>
                <Text style={[styles.tagText, { color: tag.color }]}>{tag.label}</Text>
              </View>
            ))}
          </View>
        )}

        {candidate.pros && candidate.pros.length > 0 && (
          <Text style={styles.prosSummary}>
            根拠メモ: {candidate.pros.join('、')}
          </Text>
        )}

        {(place.open || place.close) && (
          <Text style={styles.summary}>
            営業 {place.open ?? '?'}〜{place.close ?? '?'}
          </Text>
        )}

        {candidate.evaluations.length > 0 && (
          <View style={styles.matchList}>
            {candidate.evaluations.map((evaluation, evaluationIndex) => {
              const requirement = requirements?.find((r) => r.id === evaluation.requirementId);
              return (
                <View
                  key={`${evaluation.requirementId}-${evaluationIndex}`}
                  style={styles.matchRow}
                >
                  <Text style={styles.matchLabel} numberOfLines={1}>
                    {requirement?.normalizedText ?? evaluation.requirementId}
                  </Text>
                  <Text
                    accessibilityLabel={matchStateAccessibilityLabel(evaluation.state)}
                    style={[styles.matchSymbol, { color: matchStateColor(evaluation.state) }]}
                  >
                    {matchStateSymbol(evaluation.state)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {place.budget && (
          <View style={styles.price}>
            <Text style={styles.priceText}>予算目安　{place.budget} / 人</Text>
          </View>
        )}

        {(voteDisplay.length > 0 || notVotedNames.length > 0) && (
          <View
            testID={`inv-votes-${candidate.rank}`}
            accessibilityLabel={`候補${candidate.rank}位への投票内訳`}
            style={styles.votes}
          >
            {voteDisplay.map((vote) => (
              <View
                key={vote.key}
                testID={`inv-vote-${vote.key}-${candidate.rank}`}
                accessibilityLabel={`${vote.label}: ${vote.voters.join('、')}`}
                style={styles.voteRow}
              >
                <Text style={styles.voteSymbol}>{voteSymbol(vote.value)}</Text>
                <Text style={styles.voteBadge}>{vote.voters.join('、')}</Text>
                <Text style={styles.voteCount}>{vote.voters.length}票</Text>
              </View>
            ))}
            {notVotedNames.length > 0 && (
              <View
                testID={`inv-vote-none-${candidate.rank}`}
                accessibilityLabel={`未投票: ${notVotedNames.join('、')}`}
                style={styles.voteRow}
              >
                <Text style={styles.voteNoneLabel}>未投票</Text>
                <Text style={styles.voteBadge}>{notVotedNames.join('、')}</Text>
              </View>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  selectedContainer: {
    borderColor: colors.orange,
    borderWidth: 2,
  },

  rankBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 27,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomRightRadius: 8,
    zIndex: 2,
  },
  rankText: {
    fontSize: 13,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  unverifiedRankBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    minHeight: 27,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomRightRadius: 8,
    backgroundColor: colors.warningSoft,
    zIndex: 2,
  },
  unverifiedRankText: {
    color: colors.warning,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  body: {
    padding: 12,
    gap: 8,
  },
  name: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 19,
  },
  location: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  meta: {
    fontSize: 10,
    color: colors.textSecondary,
    lineHeight: 15,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  tag: {
    minHeight: 18,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagText: {
    fontSize: 9,
    fontWeight: '700',
  },
  summary: {
    color: evidenceColors.summary,
    fontSize: 10,
    lineHeight: 15,
  },
  prosSummary: {
    color: evidenceColors.positive,
    fontSize: 10,
    lineHeight: 15,
  },
  fillSummary: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
  },
  gapSummary: {
    color: colors.warning,
    fontSize: 10,
    lineHeight: 15,
  },
  gapSummaryCritical: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.warningSoft,
    fontWeight: '700',
  },
  matchList: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: 8,
    gap: 4,
  },
  matchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  matchLabel: {
    fontSize: 10,
    color: colors.textSecondary,
    flex: 1,
  },
  matchSymbol: {
    fontSize: 12,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  price: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: 8,
  },
  priceText: {
    color: evidenceColors.price,
    fontSize: 10,
  },
  // design spec §15 .vote-item（記号 | 名前 | 票数）を候補カード内の内訳へ流用 (#346)
  votes: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: 8,
    gap: 4,
  },
  voteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  voteSymbol: {
    width: 20,
    fontSize: 11,
    textAlign: 'center',
  },
  voteBadge: {
    flex: 1,
    fontSize: 10,
    color: colors.textSecondary,
  },
  voteCount: {
    fontSize: 10,
    color: colors.textSecondary,
  },
  voteNoneLabel: {
    fontSize: 9,
    color: colors.textTertiary,
    fontWeight: '700',
  },
});
