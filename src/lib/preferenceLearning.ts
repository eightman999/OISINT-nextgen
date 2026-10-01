import {
  TASTE_AXIS_IDS,
  TASTE_AXIS_META,
  type TasteAxis,
  type TasteScores,
} from '@/lib/personaCalibration';
import { getCanonicalTasteSignal } from '@/lib/tasteTaxonomy';
import type { TasteProfile } from '@/types';

export const PREFERENCE_LEARNING_MODEL_VERSION = 'adaptive-preference-v4';
export const PREFERENCE_LEARNING_SCHEMA_VERSION = 4;

const MAX_LEARNED_TAGS = 24;
const MAX_CONTEXT_TAGS = 12;
const MAX_EVENT_TOKENS = 160;
const MAX_ANSWERED_QUESTIONS = 40;
const MAX_TAG_LENGTH = 40;
const MAX_EFFECTIVE_BELIEF_WEIGHT = 24;
const QUESTION_REASK_OBSERVATION_INTERVAL = 4;
const QUESTION_ANSWER_OBSERVATION_MARKER = '@o';

export const PERSONALIZATION_SOURCE_KINDS = [
  'demo_answers',
  'maps_takeout',
  'behavior_signals',
  'hearing_answers',
  'profile_edits',
  // 来店後フィードバック。本人の明示操作があったイベントだけを追加する。
  'feedback',
] as const;

export type PersonalizationSourceKind = (typeof PERSONALIZATION_SOURCE_KINDS)[number];
export type ConfirmableTasteAxis = Exclude<TasteAxis, 'health'>;
export type ConfirmedAxisChoice = 'high' | 'low' | 'situational';
export type ConfirmedTagChoice = 'prefer' | 'avoid' | 'situational';

export const PREFERENCE_CONTEXTS = ['solo', 'group', 'quick', 'special'] as const;
export type PreferenceContext = (typeof PREFERENCE_CONTEXTS)[number];

export const PREFERENCE_CONTEXT_LABELS: Record<PreferenceContext, string> = {
  solo: 'ひとりで探す時',
  group: '複数人で探す時',
  quick: '急いで決める時',
  special: '特別な日',
};

export interface AxisBelief {
  mean: number;
  weight: number;
  m2: number;
  observations: number;
  sources: PersonalizationSourceKind[];
}

export interface TagBelief extends AxisBelief {
  label: string;
}

export interface ContextPreferenceState {
  axes: Partial<Record<ConfirmableTasteAxis, AxisBelief>>;
  tags: TagBelief[];
  confirmedAxes: Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>>;
  confirmedTags: Record<string, ConfirmedTagChoice>;
}

export interface PreferenceLearningState {
  schemaVersion: 4;
  axes: Record<TasteAxis, AxisBelief>;
  tags: TagBelief[];
  interactionCount: number;
  processedEventTokens: string[];
  answeredQuestionIds: string[];
  confirmedAxes: Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>>;
  contexts: Partial<Record<PreferenceContext, ContextPreferenceState>>;
  updatedAt: string;
}

export interface PreferenceTagObservation {
  label: string;
  /** -1 = avoid, 0 = situational/unknown, 1 = prefer. */
  affinity: number;
}

export interface PreferenceObservation {
  eventKey: string;
  sourceKind: PersonalizationSourceKind;
  strength: number;
  axes?: Partial<Record<TasteAxis, number>>;
  tags?: PreferenceTagObservation[];
  contexts?: PreferenceContext[];
  /** Contextual confirmations update only the selected context, not the global baseline. */
  contextOnly?: boolean;
  /** Contextual behavior can keep cuisine/tag evidence out of the global tag baseline. */
  tagsContextOnly?: boolean;
  occurredAt?: string;
}

export interface PreferenceHearingOption {
  id: 'prefer' | 'situational' | 'avoid' | 'high' | 'low';
  label: string;
  description: string;
}

export interface PreferenceHearingQuestion {
  id: string;
  kind: 'tag' | 'axis' | 'context_tag' | 'context_axis';
  prompt: string;
  reason: string;
  options: PreferenceHearingOption[];
  tagLabel?: string;
  axis?: TasteAxis;
  context?: PreferenceContext;
}

export interface PreferenceHearingAnswer {
  learningState: PreferenceLearningState;
  profile: TasteProfile;
}

export function createPreferenceLearningState(
  scores: TasteScores,
  profile: Pick<TasteProfile, 'likes' | 'avoid'>,
  sourceKind?: PersonalizationSourceKind,
  updatedAt = new Date().toISOString(),
): PreferenceLearningState {
  const initialWeight = sourceKind ? (sourceKind === 'demo_answers' ? 1.5 : 1) : 0;
  const initialSources = sourceKind ? [sourceKind] : [];
  const axes = Object.fromEntries(
    TASTE_AXIS_IDS.map((axis) => [
      axis,
      {
        mean: clamp(scores[axis], 0, 100),
        weight: initialWeight,
        m2: 0,
        observations: sourceKind ? 1 : 0,
        sources: initialSources,
      },
    ]),
  ) as Record<TasteAxis, AxisBelief>;

  const tags = [
    ...profile.likes.map((label) => initialTagBelief(label, 1, sourceKind)),
    ...profile.avoid.map((label) => initialTagBelief(label, -1, sourceKind)),
  ].filter((belief): belief is TagBelief => Boolean(belief));

  return {
    schemaVersion: PREFERENCE_LEARNING_SCHEMA_VERSION,
    axes,
    tags: uniqueTagBeliefs(tags).slice(0, MAX_LEARNED_TAGS),
    interactionCount: 0,
    processedEventTokens: [],
    answeredQuestionIds: [],
    confirmedAxes: sourceKind === 'demo_answers' ? inferConfirmedAxesFromScores(scores) : {},
    contexts: {},
    updatedAt: validDate(updatedAt) ?? new Date().toISOString(),
  };
}

export function parsePreferenceLearningState(
  value: unknown,
  fallbackScores: TasteScores,
  fallbackProfile: Pick<TasteProfile, 'likes' | 'avoid'>,
  fallbackSource?: PersonalizationSourceKind,
): PreferenceLearningState {
  const fallback = createPreferenceLearningState(
    fallbackScores,
    fallbackProfile,
    fallbackSource,
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;

  const candidate = value as Partial<
    Omit<PreferenceLearningState, 'schemaVersion' | 'confirmedAxes' | 'contexts'>
  > & {
    schemaVersion?: unknown;
    confirmedAxes?: unknown;
    contexts?: unknown;
  };
  if (
    candidate.schemaVersion !== 1 &&
    candidate.schemaVersion !== 2 &&
    candidate.schemaVersion !== 3 &&
    candidate.schemaVersion !== 4
  ) return fallback;
  if (!candidate.axes || typeof candidate.axes !== 'object') return fallback;

  const axes = {} as Record<TasteAxis, AxisBelief>;
  for (const axis of TASTE_AXIS_IDS) {
    const parsed = parseBelief((candidate.axes as Partial<Record<TasteAxis, unknown>>)[axis], 0, 100);
    if (!parsed) return fallback;
    axes[axis] = parsed;
  }

  const tags = Array.isArray(candidate.tags)
    ? candidate.tags
        .map((tag) => parseTagBelief(tag))
        .filter((tag): tag is TagBelief => Boolean(tag))
        .slice(0, MAX_LEARNED_TAGS)
    : [];
  const confirmedAxes = candidate.schemaVersion >= 2
    ? parseConfirmedAxes(candidate.confirmedAxes)
    : inferConfirmedAxesFromBeliefs(axes);
  const contexts = candidate.schemaVersion >= 3
    ? parseContextPreferenceStates(candidate.contexts)
    : {};

  return {
    schemaVersion: PREFERENCE_LEARNING_SCHEMA_VERSION,
    axes,
    tags: uniqueTagBeliefs(tags),
    interactionCount: safeInteger(candidate.interactionCount, 0, 100_000),
    processedEventTokens: safeStrings(candidate.processedEventTokens, MAX_EVENT_TOKENS, 24),
    answeredQuestionIds: safeStrings(
      candidate.answeredQuestionIds,
      MAX_ANSWERED_QUESTIONS,
      100,
    ),
    confirmedAxes,
    contexts,
    updatedAt: validDate(candidate.updatedAt) ?? fallback.updatedAt,
  };
}

export function applyPreferenceObservation(
  state: PreferenceLearningState,
  observation: PreferenceObservation,
): PreferenceLearningState {
  const token = eventToken(observation.eventKey);
  if (!token || state.processedEventTokens.includes(token)) return state;

  const strength = clamp(observation.strength, 0.1, 5);
  const observationContexts = uniqueContexts(observation.contexts);
  const axisEntries = Object.entries(observation.axes ?? {}).filter(
    (entry): entry is [TasteAxis, number] =>
      TASTE_AXIS_IDS.includes(entry[0] as TasteAxis) && Number.isFinite(entry[1]),
  );
  const tagEntries = (observation.tags ?? [])
    .map((tag) => ({
      label: sanitizeTag(tag.label),
      affinity: clamp(tag.affinity, -1, 1),
    }))
    .filter((tag) => Boolean(tag.label));

  const contextualAxisEntries = axisEntries.filter(
    (entry): entry is [ConfirmableTasteAxis, number] => entry[0] !== 'health',
  );
  const hasGlobalAxes = !observation.contextOnly && axisEntries.length > 0;
  const hasContextAxes = observationContexts.length > 0 && contextualAxisEntries.length > 0;
  const hasGlobalTags =
    !observation.contextOnly && !observation.tagsContextOnly && tagEntries.length > 0;
  const hasContextTags = observationContexts.length > 0 && tagEntries.length > 0;
  if (!hasGlobalAxes && !hasContextAxes && !hasGlobalTags && !hasContextTags) return state;

  const axes = Object.fromEntries(
    TASTE_AXIS_IDS.map((axis) => [axis, cloneBelief(state.axes[axis])]),
  ) as Record<TasteAxis, AxisBelief>;
  if (!observation.contextOnly) {
    for (const [axis, target] of axisEntries) {
      axes[axis] = updateBelief(
        axes[axis],
        clamp(target, 0, 100),
        strength,
        observation.sourceKind,
      );
    }
  }

  const contexts = cloneContextPreferenceStates(state.contexts);
  for (const context of observationContexts) {
    const current = contexts[context] ?? {
      axes: {},
      tags: [],
      confirmedAxes: {},
      confirmedTags: {},
    };
    const contextAxes = { ...current.axes };
    for (const [axis, target] of contextualAxisEntries) {
      contextAxes[axis] = updateBelief(
        contextAxes[axis] ?? emptyBelief(50),
        clamp(target, 0, 100),
        strength,
        observation.sourceKind,
      );
    }
    contexts[context] = {
      axes: contextAxes,
      tags: updateTagBeliefs(
        current.tags,
        tagEntries,
        strength,
        observation.sourceKind,
        MAX_CONTEXT_TAGS,
      ),
      confirmedAxes: { ...current.confirmedAxes },
      confirmedTags: { ...current.confirmedTags },
    };
  }

  const tags = hasGlobalTags
    ? updateTagBeliefs(
        state.tags,
        tagEntries,
        strength,
        observation.sourceKind,
        MAX_LEARNED_TAGS,
      )
    : state.tags.map((tag) => ({ ...cloneBelief(tag), label: tag.label }));

  return {
    ...state,
    axes,
    contexts,
    tags,
    interactionCount:
      state.interactionCount + (observation.sourceKind === 'behavior_signals' ? 1 : 0),
    processedEventTokens: [...state.processedEventTokens, token].slice(-MAX_EVENT_TOKENS),
    updatedAt: validDate(observation.occurredAt) ?? new Date().toISOString(),
  };
}

export function scoresFromLearningState(state: PreferenceLearningState): TasteScores {
  return Object.fromEntries(
    TASTE_AXIS_IDS.map((axis) => [axis, Math.round(clamp(state.axes[axis].mean, 0, 100))]),
  ) as TasteScores;
}

export function beliefConfidence(belief: AxisBelief, range: number): number {
  if (belief.weight <= 0) return 0;
  const support = 1 - Math.exp(-belief.weight / 3.5);
  const disagreement = beliefDisagreement(belief, range);
  return round(clamp(support * (1 - disagreement * 0.72), 0, 1));
}

export function beliefDisagreement(belief: AxisBelief, range: number): number {
  if (belief.weight <= 0 || belief.m2 <= 0) return 0;
  const deviation = Math.sqrt(Math.max(0, belief.m2 / belief.weight));
  return round(clamp(deviation / Math.max(range, 0.001), 0, 1));
}

export function selectPreferenceHearingQuestion(
  state: PreferenceLearningState,
  profile: Pick<TasteProfile, 'likes' | 'avoid'>,
): PreferenceHearingQuestion | null {
  const explicitTags = new Set([...profile.likes, ...profile.avoid]);
  const contextualTagCandidate = PREFERENCE_CONTEXTS
    .flatMap((context) => {
      const contextState = state.contexts[context];
      if (!contextState) return [];
      return contextState.tags.map((tag) => ({
        context,
        tag,
      }));
    })
    .filter(({ context, tag }) => !isContextMarkerTag(context, tag.label))
    .filter(({ tag }) =>
      tag.sources.some(
        (source) => source === 'behavior_signals' || source === 'maps_takeout',
      ),
    )
    .filter(({ tag }) => getCanonicalTasteSignal(tag.label)?.axisTargets.health == null)
    .filter(({ tag }) => Math.abs(tag.mean) >= 0.32)
    .filter(({ tag }) => tag.observations >= 2 || tag.weight >= 3.5)
    .filter(({ tag }) => beliefConfidence(tag, 1) >= 0.24)
    .map(({ context, tag }) => ({
      context,
      tag,
      questionId: nextHearingQuestionId(
        'context_tag',
        `${context}:${tag.label}`,
        tag,
        state.answeredQuestionIds,
      ),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { questionId: string } =>
        Boolean(candidate.questionId),
    )
    .sort((left, right) => tagPriority(right.tag) - tagPriority(left.tag))[0];

  if (contextualTagCandidate) {
    return tagQuestion(
      contextualTagCandidate.tag,
      contextualTagCandidate.questionId,
      contextualTagCandidate.context,
    );
  }

  const tagCandidate = state.tags
    .filter((tag) => tag.sources.includes('behavior_signals'))
    .filter((tag) => getCanonicalTasteSignal(tag.label)?.axisTargets.health == null)
    .filter((tag) => !explicitTags.has(tag.label))
    .filter((tag) => Math.abs(tag.mean) >= 0.32)
    .filter((tag) => tag.observations >= 2 || tag.weight >= 3.5)
    .filter((tag) => beliefConfidence(tag, 1) >= 0.24)
    .map((tag) => ({
      tag,
      questionId: nextHearingQuestionId(
        'tag',
        tag.label,
        tag,
        state.answeredQuestionIds,
      ),
    }))
    .filter(
      (candidate): candidate is { tag: TagBelief; questionId: string } =>
        Boolean(candidate.questionId),
    )
    .sort((left, right) => tagPriority(right.tag) - tagPriority(left.tag))[0];

  if (tagCandidate) return tagQuestion(tagCandidate.tag, tagCandidate.questionId);

  const contextualAxisCandidate = PREFERENCE_CONTEXTS
    .flatMap((context) => {
      const contextState = state.contexts[context];
      if (!contextState) return [];
      return Object.entries(contextState.axes).map(([axis, belief]) => ({
        context,
        axis: axis as ConfirmableTasteAxis,
        belief,
        confirmed: contextState.confirmedAxes[axis as ConfirmableTasteAxis],
      }));
    })
    .filter(
      (candidate): candidate is {
        context: PreferenceContext;
        axis: ConfirmableTasteAxis;
        belief: AxisBelief;
        confirmed: ConfirmedAxisChoice | undefined;
      } => Boolean(candidate.belief),
    )
    .filter(({ belief }) =>
      belief.sources.some(
        (source) => source === 'behavior_signals' || source === 'maps_takeout',
      ),
    )
    .filter(({ belief }) => belief.observations >= 2)
    .map(({ context, axis, belief, confirmed }) => ({
      context,
      axis,
      belief,
      confirmed,
      questionId: nextHearingQuestionId(
        'context_axis',
        `${context}:${axis}`,
        belief,
        state.answeredQuestionIds,
      ),
      confidence: beliefConfidence(belief, 50),
      disagreement: beliefDisagreement(belief, 50),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { questionId: string } =>
        Boolean(candidate.questionId),
    )
    .filter(
      ({ confidence, disagreement, belief, confirmed }) =>
        (!confirmed && belief.sources.includes('maps_takeout')) ||
        confidence < 0.66 ||
        disagreement >= 0.25,
    )
    .sort(
      (left, right) =>
        right.disagreement - left.disagreement || left.confidence - right.confidence,
    )[0];

  if (contextualAxisCandidate) {
    return axisQuestion(
      contextualAxisCandidate.axis,
      contextualAxisCandidate.belief,
      contextualAxisCandidate.questionId,
      contextualAxisCandidate.context,
    );
  }

  const axisCandidate = TASTE_AXIS_IDS
    .filter((axis) => axis !== 'health')
    .map((axis) => ({ axis, belief: state.axes[axis] }))
    .filter(({ belief }) => belief.sources.includes('behavior_signals'))
    .filter(({ belief }) => belief.observations >= 2)
    .map(({ axis, belief }) => ({
      axis,
      belief,
      questionId: nextHearingQuestionId(
        'axis',
        axis,
        belief,
        state.answeredQuestionIds,
      ),
      confidence: beliefConfidence(belief, 50),
      disagreement: beliefDisagreement(belief, 50),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { questionId: string } =>
        Boolean(candidate.questionId),
    )
    .filter(({ confidence, disagreement }) => confidence < 0.66 || disagreement >= 0.25)
    .sort(
      (left, right) =>
        right.disagreement - left.disagreement || left.confidence - right.confidence,
    )[0];

  return axisCandidate
    ? axisQuestion(axisCandidate.axis, axisCandidate.belief, axisCandidate.questionId)
    : null;
}

export function answerPreferenceHearingQuestion(
  state: PreferenceLearningState,
  profile: TasteProfile,
  question: PreferenceHearingQuestion,
  optionId: PreferenceHearingOption['id'],
): PreferenceHearingAnswer {
  if (!question.options.some((option) => option.id === optionId)) {
    throw new Error('選択された回答が質問に含まれていません');
  }

  let nextProfile: TasteProfile = {
    ...profile,
    likes: [...profile.likes],
    avoid: [...profile.avoid],
  };
  let confirmedAxes = { ...state.confirmedAxes };
  let observation: PreferenceObservation;

  if (question.kind === 'context_tag' && question.tagLabel && question.context) {
    if (optionId !== 'prefer' && optionId !== 'avoid' && optionId !== 'situational') {
      throw new Error('文脈タグ質問の回答形式が正しくありません');
    }
    const label = sanitizeTag(question.tagLabel);
    if (!label) throw new Error('質問の学習対象が見つかりません');
    const currentContext = state.contexts[question.context] ?? {
      axes: {},
      tags: [],
      confirmedAxes: {},
      confirmedTags: {},
    };
    const contexts = cloneContextPreferenceStates(state.contexts);
    contexts[question.context] = {
      axes: { ...currentContext.axes },
      tags: currentContext.tags.map((tag) => ({ ...cloneBelief(tag), label: tag.label })),
      confirmedAxes: { ...currentContext.confirmedAxes },
      confirmedTags: {
        ...currentContext.confirmedTags,
        [label]: optionId,
      },
    };
    observation = {
      eventKey: `hearing:${question.id}:${optionId}`,
      sourceKind: 'hearing_answers',
      strength: optionId === 'situational' ? 2.5 : 4.5,
      tags: [{
        label,
        affinity: optionId === 'prefer' ? 1 : optionId === 'avoid' ? -1 : 0,
      }],
      contexts: [question.context],
      contextOnly: true,
    };
    state = { ...state, contexts };
  } else if (question.kind === 'tag' && question.tagLabel) {
    if (optionId !== 'prefer' && optionId !== 'avoid' && optionId !== 'situational') {
      throw new Error('タグ質問の回答形式が正しくありません');
    }
    const label = sanitizeTag(question.tagLabel);
    if (!label) throw new Error('質問の学習対象が見つかりません');
    const affinity = optionId === 'prefer' ? 1 : optionId === 'avoid' ? -1 : 0;
    if (optionId === 'prefer') {
      nextProfile = {
        ...nextProfile,
        likes: uniqueStrings([...nextProfile.likes, label]),
        avoid: nextProfile.avoid.filter((tag) => tag !== label),
      };
    } else if (optionId === 'avoid') {
      nextProfile = {
        ...nextProfile,
        likes: nextProfile.likes.filter((tag) => tag !== label),
        avoid: uniqueStrings([...nextProfile.avoid, label]),
      };
    }
    observation = {
      eventKey: `hearing:${question.id}:${optionId}`,
      sourceKind: 'hearing_answers',
      strength: optionId === 'situational' ? 2.5 : 4.5,
      tags: [{ label, affinity }],
    };
  } else if (
    question.kind === 'context_axis' &&
    question.axis &&
    question.axis !== 'health' &&
    question.context
  ) {
    if (optionId !== 'high' && optionId !== 'low' && optionId !== 'situational') {
      throw new Error('文脈質問の回答形式が正しくありません');
    }
    const currentContext = state.contexts[question.context] ?? {
      axes: {},
      tags: [],
      confirmedAxes: {},
      confirmedTags: {},
    };
    const contexts = cloneContextPreferenceStates(state.contexts);
    contexts[question.context] = {
      axes: { ...currentContext.axes },
      tags: currentContext.tags.map((tag) => ({ ...cloneBelief(tag), label: tag.label })),
      confirmedAxes: {
        ...currentContext.confirmedAxes,
        [question.axis]: optionId,
      },
      confirmedTags: { ...currentContext.confirmedTags },
    };
    observation = {
      eventKey: `hearing:${question.id}:${optionId}`,
      sourceKind: 'hearing_answers',
      strength: optionId === 'situational' ? 2.5 : 4.5,
      axes: {
        [question.axis]: optionId === 'high' ? 85 : optionId === 'low' ? 15 : 50,
      },
      contexts: [question.context],
      contextOnly: true,
    };
    state = { ...state, contexts };
  } else if (question.kind === 'axis' && question.axis && question.axis !== 'health') {
    if (optionId !== 'high' && optionId !== 'low' && optionId !== 'situational') {
      throw new Error('軸質問の回答形式が正しくありません');
    }
    confirmedAxes = {
      ...confirmedAxes,
      [question.axis]: optionId,
    };
    observation = {
      eventKey: `hearing:${question.id}:${optionId}`,
      sourceKind: 'hearing_answers',
      strength: optionId === 'situational' ? 2.5 : 4.5,
      axes: {
        [question.axis]: optionId === 'high' ? 85 : optionId === 'low' ? 15 : 50,
      },
    };
  } else {
    throw new Error('質問の学習対象が見つかりません');
  }

  const observedState = applyPreferenceObservation(
    { ...state, confirmedAxes },
    observation,
  );
  let answeredAt: number | undefined;
  if (question.kind === 'tag') {
    answeredAt = observedState.tags.find(
      (tag) => tag.label === sanitizeTag(question.tagLabel),
    )?.observations;
  } else if (question.kind === 'context_tag' && question.context) {
    answeredAt = observedState.contexts[question.context]?.tags.find(
      (tag) => tag.label === sanitizeTag(question.tagLabel),
    )?.observations;
  } else if (
    question.kind === 'context_axis' &&
    question.context &&
    question.axis &&
    question.axis !== 'health'
  ) {
    answeredAt = observedState.contexts[question.context]?.axes[question.axis]?.observations;
  } else if (question.axis) {
    answeredAt = observedState.axes[question.axis].observations;
  }
  if (answeredAt == null) throw new Error('質問の学習対象が見つかりません');
  const answeredQuestionIds = safeStrings(
    [
      ...state.answeredQuestionIds,
      `${question.id}${QUESTION_ANSWER_OBSERVATION_MARKER}${answeredAt}`,
    ],
    MAX_ANSWERED_QUESTIONS,
    100,
  );
  const learningState = { ...observedState, answeredQuestionIds };
  return { learningState, profile: nextProfile };
}

export function preferenceLearningStateForCloud(
  state: PreferenceLearningState,
): Omit<PreferenceLearningState, 'processedEventTokens'> {
  const { processedEventTokens: _localDedupeTokens, ...aggregate } = state;
  return aggregate;
}

export function isPersonalizationSourceKind(value: unknown): value is PersonalizationSourceKind {
  return PERSONALIZATION_SOURCE_KINDS.includes(value as PersonalizationSourceKind);
}

/**
 * ローカルの重複排除状態だけを検査する。引数はイベント識別子からハッシュ化されるため、
 * 呼び出し側が raw query / place identity を状態へ保存することはない。
 */
export function hasProcessedPreferenceObservation(
  state: PreferenceLearningState,
  eventKey: string,
): boolean {
  const token = eventToken(eventKey);
  return Boolean(token && state.processedEventTokens.includes(token));
}

/** サーバー正本を端末へ同期した後に、ローカル重複排除だけを付与する。 */
export function markPreferenceObservationProcessed(
  state: PreferenceLearningState,
  eventKey: string,
): PreferenceLearningState {
  const token = eventToken(eventKey);
  if (!token || state.processedEventTokens.includes(token)) return state;
  return {
    ...state,
    processedEventTokens: [...state.processedEventTokens, token].slice(-MAX_EVENT_TOKENS),
  };
}

function tagQuestion(
  tag: TagBelief,
  questionId: string,
  context?: PreferenceContext,
): PreferenceHearingQuestion {
  const leansPositive = tag.mean >= 0;
  const contextLabel = context ? PREFERENCE_CONTEXT_LABELS[context] : null;
  return {
    id: questionId,
    kind: context ? 'context_tag' : 'tag',
    tagLabel: tag.label,
    context,
    prompt: contextLabel
      ? leansPositive
        ? `${contextLabel}に「${tag.label}」を選ぶ傾向があります。この場面の好みとして考えてよいですか？`
        : `${contextLabel}に「${tag.label}」を外す傾向があります。この場面では避けたいですか？`
      : leansPositive
        ? `「${tag.label}」を選ぶ場面が続きました。次から好みとして考えてよいですか？`
        : `「${tag.label}」を外す選択がありました。普段も避けたいですか？`,
    reason: contextLabel
      ? tag.sources.includes('maps_takeout')
        ? `保存リスト内の「${contextLabel}」だけを、普段の好みと混ぜずに確認しています。`
        : `${contextLabel}の選択だけを、普段の好みと混ぜずに確認しています。`
      : '一度の操作では決めつけず、複数の選択をまとめて確認しています。',
    options: leansPositive
      ? [
          {
            id: 'prefer',
            label: contextLabel ? 'この場面では好み' : '好みとして覚える',
            description: contextLabel ? 'この場面の店探しだけで使う' : '次の店探しでも候補条件に使う',
          },
          { id: 'situational', label: 'その時だけ', description: '場面によって変わるので固定しない' },
          { id: 'avoid', label: 'むしろ避けたい', description: '推測を反対方向へ直す' },
        ]
      : [
          {
            id: 'avoid',
            label: contextLabel ? 'この場面では避けたい' : '普段も避けたい',
            description: contextLabel ? 'この場面の店探しだけで外す' : '次の店探しでも外す条件に使う',
          },
          { id: 'situational', label: 'その時だけ', description: '場面によって変わるので固定しない' },
          { id: 'prefer', label: '本当は好き', description: '推測を反対方向へ直す' },
        ],
  };
}

function isContextMarkerTag(context: PreferenceContext, label: string): boolean {
  // This label describes why a list/search is contextual; asking whether "special occasions"
  // are preferred on special occasions would be tautological rather than useful hearing.
  return context === 'special' && label === '特別な日';
}

function axisQuestion(
  axis: Exclude<TasteAxis, 'health'>,
  belief: AxisBelief,
  questionId: string,
  context?: PreferenceContext,
): PreferenceHearingQuestion {
  const copy: Record<Exclude<TasteAxis, 'health'>, { prompt: string; high: string; low: string }> = {
    evidence: {
      prompt: '店を決めるとき、情報を確かめる手間と直感のどちらを優先しますか？',
      high: '根拠を確かめたい',
      low: '直感で試したい',
    },
    quiet: {
      prompt: '静かな店を選ぶ日と、活気のある店を選ぶ日がありました。普段はどちらを先にしますか？',
      high: '静かさを優先',
      low: '活気を優先',
    },
    value: {
      prompt: '店選びでは、価格の納得感をどのくらい優先しますか？',
      high: '価格をよく見る',
      low: '魅力を優先する',
    },
    novelty: {
      prompt: 'いつもの安心できる店と、初めての一軒なら普段はどちらに寄りますか？',
      high: '新しい一軒',
      low: 'いつもの安心',
    },
    groupFit: {
      prompt: '複数人の店選びでは、自分の一番と全員の納得のどちらを先にしますか？',
      high: '全員の納得',
      low: '自分の一番',
    },
  };
  const selected = copy[axis as Exclude<TasteAxis, 'health'>];
  const contextLabel = context ? PREFERENCE_CONTEXT_LABELS[context] : null;
  return {
    id: questionId,
    kind: context ? 'context_axis' : 'axis',
    axis,
    context,
    prompt: contextLabel
      ? `${contextLabel}は「${selected.high}」と「${selected.low}」のどちらに寄せますか？`
      : selected.prompt,
    reason: contextLabel
      ? belief.sources.includes('maps_takeout')
        ? `保存リストで「${contextLabel}」と「${TASTE_AXIS_META[axis].label}」が重なった傾向を、ほかの場面と混ぜずに確認しています。`
        : `${contextLabel}の選択だけを、ほかの場面と混ぜずに確認しています。`
      : beliefDisagreement(belief, 50) >= 0.25
        ? `${TASTE_AXIS_META[axis].label}について、行動だけでは判断が割れています。`
        : `${TASTE_AXIS_META[axis].label}について、まだ手がかりが少ないため確認しています。`,
    options: [
      {
        id: 'high',
        label: selected.high,
        description: contextLabel ? 'この場面の候補で優先する' : '普段の候補でも優先する',
      },
      {
        id: 'situational',
        label: contextLabel ? 'この場面でも変わる' : '場面による',
        description: '固定せず、次の変化を見てたずねる',
      },
      {
        id: 'low',
        label: selected.low,
        description: contextLabel ? 'この場面では反対側を優先する' : '反対側を普段の基準にする',
      },
    ],
  };
}

function updateBelief(
  belief: AxisBelief,
  target: number,
  addedWeight: number,
  sourceKind: PersonalizationSourceKind,
): AxisBelief {
  const currentWeight = Math.max(0, belief.weight);
  // Keep lifetime observation counts, but bound the effective memory so a long history cannot
  // make a genuinely changed preference impossible to learn. Scale m2 with the retained weight.
  const retainedWeight = Math.min(currentWeight, MAX_EFFECTIVE_BELIEF_WEIGHT);
  const retainedM2 = currentWeight > 0
    ? belief.m2 * (retainedWeight / currentWeight)
    : 0;
  const nextWeight = retainedWeight + addedWeight;
  const delta = target - belief.mean;
  const mean = retainedWeight === 0
    ? target
    : belief.mean + (addedWeight / nextWeight) * delta;
  const m2 = retainedWeight === 0
    ? 0
    : Math.max(0, retainedM2 + addedWeight * delta * (target - mean));
  return {
    mean: round(mean),
    weight: round(nextWeight),
    m2: round(m2),
    observations: Math.min(100_000, belief.observations + 1),
    sources: uniqueSources([...belief.sources, sourceKind]),
  };
}

function updateTagBeliefs(
  currentTags: readonly TagBelief[],
  entries: readonly { label: string; affinity: number }[],
  strength: number,
  sourceKind: PersonalizationSourceKind,
  limit: number,
): TagBelief[] {
  const tags = currentTags.map((tag) => ({ ...cloneBelief(tag), label: tag.label }));
  for (const entry of entries) {
    const index = tags.findIndex((tag) => tag.label === entry.label);
    const current = index >= 0
      ? tags[index]
      : ({
          label: entry.label,
          mean: 0,
          weight: 0,
          m2: 0,
          observations: 0,
          sources: [],
        } satisfies TagBelief);
    const next = {
      ...updateBelief(current, entry.affinity, strength, sourceKind),
      label: entry.label,
    };
    if (index >= 0) tags[index] = next;
    else tags.push(next);
  }
  return tags
    .sort((left, right) => tagPriority(right) - tagPriority(left))
    .slice(0, limit);
}

function legacyHearingQuestionId(
  kind: PreferenceHearingQuestion['kind'],
  key: string,
  belief: AxisBelief,
): string {
  const base = `${kind}:${key}`;
  const revision = Math.max(
    1,
    Math.floor(
      Math.max(0, belief.observations - 2) / QUESTION_REASK_OBSERVATION_INTERVAL,
    ) + 1,
  );
  return revision === 1 ? base : `${base}:r${revision}`;
}

function nextHearingQuestionId(
  kind: PreferenceHearingQuestion['kind'],
  key: string,
  belief: AxisBelief,
  answeredQuestionIds: readonly string[],
): string | null {
  const base = `${kind}:${key}`;
  const markedAnswers = answeredQuestionIds
    .map(parseAnsweredQuestionMarker)
    .filter((answer): answer is AnsweredQuestionMarker => {
      return answer !== null && questionRevision(base, answer.questionId) != null;
    })
    .sort((left, right) => {
      return (
        questionRevision(base, right.questionId)! - questionRevision(base, left.questionId)! ||
        right.observations - left.observations
      );
    });
  const latest = markedAnswers[0];
  if (latest) {
    if (
      belief.observations - latest.observations <
      QUESTION_REASK_OBSERVATION_INTERVAL
    ) return null;
    const nextRevision = questionRevision(base, latest.questionId)! + 1;
    return `${base}:r${nextRevision}`;
  }

  const legacyAnswers = new Set(answeredQuestionIds);
  const hasLegacyAnswer = [...legacyAnswers].some(
    (questionId) => questionRevision(base, questionId) != null,
  );
  if (!hasLegacyAnswer) return base;

  // Schema-v1 and early schema-v2 snapshots did not record the answer-time count.
  // Preserve their four-observation bucket behavior until the next answered revision.
  const legacyQuestionId = legacyHearingQuestionId(kind, key, belief);
  return legacyAnswers.has(legacyQuestionId) ? null : legacyQuestionId;
}

interface AnsweredQuestionMarker {
  questionId: string;
  observations: number;
}

function parseAnsweredQuestionMarker(value: string): AnsweredQuestionMarker | null {
  const markerIndex = value.lastIndexOf(QUESTION_ANSWER_OBSERVATION_MARKER);
  if (markerIndex <= 0) return null;
  const observations = Number(value.slice(markerIndex + QUESTION_ANSWER_OBSERVATION_MARKER.length));
  if (!Number.isSafeInteger(observations) || observations < 0) return null;
  return { questionId: value.slice(0, markerIndex), observations };
}

function questionRevision(base: string, questionId: string): number | null {
  if (questionId === base) return 1;
  if (!questionId.startsWith(`${base}:r`)) return null;
  const revision = Number(questionId.slice(base.length + 2));
  return Number.isSafeInteger(revision) && revision >= 2 ? revision : null;
}

function parseConfirmedAxes(
  value: unknown,
): Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  const confirmed: Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>> = {};
  for (const axis of TASTE_AXIS_IDS) {
    if (axis === 'health') continue;
    const choice = candidate[axis];
    if (choice === 'high' || choice === 'low' || choice === 'situational') {
      confirmed[axis] = choice;
    }
  }
  return confirmed;
}

function parseConfirmedTags(value: unknown): Record<string, ConfirmedTagChoice> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const confirmed: Record<string, ConfirmedTagChoice> = {};
  for (const [rawLabel, choice] of Object.entries(value).slice(0, MAX_CONTEXT_TAGS * 2)) {
    const label = sanitizeTag(rawLabel);
    if (
      label &&
      (choice === 'prefer' || choice === 'avoid' || choice === 'situational')
    ) {
      confirmed[label] = choice;
    }
    if (Object.keys(confirmed).length >= MAX_CONTEXT_TAGS) break;
  }
  return confirmed;
}

function parseContextPreferenceStates(
  value: unknown,
): Partial<Record<PreferenceContext, ContextPreferenceState>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  const contexts: Partial<Record<PreferenceContext, ContextPreferenceState>> = {};
  for (const context of PREFERENCE_CONTEXTS) {
    const rawContext = candidate[context];
    if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) continue;
    const raw = rawContext as Record<string, unknown>;
    const rawAxes = raw.axes && typeof raw.axes === 'object' && !Array.isArray(raw.axes)
      ? raw.axes as Record<string, unknown>
      : {};
    const axes: Partial<Record<ConfirmableTasteAxis, AxisBelief>> = {};
    for (const axis of TASTE_AXIS_IDS) {
      if (axis === 'health') continue;
      const belief = parseBelief(rawAxes[axis], 0, 100);
      if (belief) axes[axis] = belief;
    }
    const confirmedAxes = Object.fromEntries(
      Object.entries(parseConfirmedAxes(raw.confirmedAxes)).filter(([axis]) =>
        Boolean(axes[axis as ConfirmableTasteAxis]),
      ),
    ) as ContextPreferenceState['confirmedAxes'];
    const tags = Array.isArray(raw.tags)
      ? uniqueTagBeliefs(
          raw.tags
            .map((tag) => parseTagBelief(tag))
            .filter((tag): tag is TagBelief => Boolean(tag)),
        ).slice(0, MAX_CONTEXT_TAGS)
      : [];
    const learnedLabels = new Set(tags.map((tag) => tag.label));
    const confirmedTags = Object.fromEntries(
      Object.entries(parseConfirmedTags(raw.confirmedTags)).filter(([label]) =>
        learnedLabels.has(label),
      ),
    );
    if (
      Object.keys(axes).length > 0 ||
      tags.length > 0 ||
      Object.keys(confirmedAxes).length > 0 ||
      Object.keys(confirmedTags).length > 0
    ) {
      contexts[context] = { axes, tags, confirmedAxes, confirmedTags };
    }
  }
  return contexts;
}

function inferConfirmedAxesFromScores(
  scores: TasteScores,
): Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>> {
  const confirmed: Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>> = {};
  for (const axis of TASTE_AXIS_IDS) {
    if (axis === 'health') continue;
    if (scores[axis] >= 68) confirmed[axis] = 'high';
    else if (scores[axis] <= 32) confirmed[axis] = 'low';
  }
  return confirmed;
}

function inferConfirmedAxesFromBeliefs(
  axes: Record<TasteAxis, AxisBelief>,
): Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>> {
  const confirmed: Partial<Record<ConfirmableTasteAxis, ConfirmedAxisChoice>> = {};
  for (const axis of TASTE_AXIS_IDS) {
    if (axis === 'health') continue;
    const belief = axes[axis];
    if (
      !belief.sources.includes('hearing_answers') &&
      !belief.sources.includes('demo_answers')
    ) continue;
    if (belief.mean >= 68) confirmed[axis] = 'high';
    else if (belief.mean <= 32) confirmed[axis] = 'low';
    else if (belief.sources.includes('hearing_answers')) confirmed[axis] = 'situational';
  }
  return confirmed;
}

function parseBelief(value: unknown, min: number, max: number): AxisBelief | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AxisBelief>;
  if (
    !finiteInRange(candidate.mean, min, max) ||
    !finiteInRange(candidate.weight, 0, 1000) ||
    !finiteInRange(candidate.m2, 0, 10_000_000)
  ) return null;
  return {
    mean: candidate.mean,
    weight: candidate.weight,
    m2: candidate.m2,
    observations: safeInteger(candidate.observations, 0, 100_000),
    sources: uniqueSources(candidate.sources),
  };
}

function parseTagBelief(value: unknown): TagBelief | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<TagBelief>;
  const label = sanitizeTag(candidate.label);
  const belief = parseBelief(candidate, -1, 1);
  return label && belief ? { ...belief, label } : null;
}

function initialTagBelief(
  rawLabel: string,
  affinity: -1 | 1,
  sourceKind?: PersonalizationSourceKind,
): TagBelief | null {
  const label = sanitizeTag(rawLabel);
  if (!label) return null;
  return {
    label,
    mean: affinity,
    weight: sourceKind ? 3 : 1.5,
    m2: 0,
    observations: 1,
    sources: sourceKind ? [sourceKind] : [],
  };
}

function cloneBelief(belief: AxisBelief): AxisBelief {
  return { ...belief, sources: [...belief.sources] };
}

function emptyBelief(mean: number): AxisBelief {
  return {
    mean,
    weight: 0,
    m2: 0,
    observations: 0,
    sources: [],
  };
}

function cloneContextPreferenceStates(
  value: PreferenceLearningState['contexts'],
): PreferenceLearningState['contexts'] {
  const contexts: PreferenceLearningState['contexts'] = {};
  for (const context of PREFERENCE_CONTEXTS) {
    const state = value[context];
    if (!state) continue;
    const axes: ContextPreferenceState['axes'] = {};
    for (const axis of TASTE_AXIS_IDS) {
      if (axis === 'health') continue;
      const belief = state.axes[axis];
      if (belief) axes[axis] = cloneBelief(belief);
    }
    contexts[context] = {
      axes,
      tags: state.tags.map((tag) => ({ ...cloneBelief(tag), label: tag.label })),
      confirmedAxes: { ...state.confirmedAxes },
      confirmedTags: { ...state.confirmedTags },
    };
  }
  return contexts;
}

function uniqueTagBeliefs(tags: TagBelief[]): TagBelief[] {
  const byLabel = new Map<string, TagBelief>();
  for (const tag of tags) {
    if (!byLabel.has(tag.label)) byLabel.set(tag.label, tag);
  }
  return [...byLabel.values()];
}

function tagPriority(tag: TagBelief): number {
  return beliefConfidence(tag, 1) * Math.abs(tag.mean) * Math.log2(tag.observations + 1);
}

function uniqueSources(value: unknown): PersonalizationSourceKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPersonalizationSourceKind))];
}

function uniqueContexts(value: unknown): PreferenceContext[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (context): context is PreferenceContext =>
      PREFERENCE_CONTEXTS.includes(context as PreferenceContext),
  ))].slice(0, 2);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(sanitizeTag).filter(Boolean))].slice(0, MAX_LEARNED_TAGS);
}

function safeStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(-limit);
}

function eventToken(value: string): string {
  const normalized = value.trim().slice(0, 300);
  if (!normalized) return '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ev-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sanitizeTag(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TAG_LENGTH) : '';
}

function safeInteger(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(clamp(value, min, max))
    : min;
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validDate(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
