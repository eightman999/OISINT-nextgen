import {
  PREFERENCE_LEARNING_MODEL_VERSION,
  type PreferenceObservation,
} from '@/lib/preferenceLearning';
import { TASTE_AXIS_META, type TasteAxis } from '@/lib/personaCalibration';
import type {
  PlaceFact,
  PlaceFeedback,
  PlaceFeedbackAspect,
  PlaceFeedbackRating,
  VoteValue,
} from '@/types';

/**
 * 来店フィードバックから個人プロフィールへ渡す値の上限。
 *
 * 既存 taxonomy の強い肯定値（86）/否定値（20）を aspect 明示の軸目標へ再利用し、
 * rating/vote は既存 behaviorRecognition の強い操作（map 3.8、profile edit 4.5）より
 * 弱い差分に限定する。aspect/rating/voteの強度も同じ順序で固定し、数値を増やす場合は
 * 対応する軸の正典値と「1イベントの最大更新量」テストを同時に更新すること。
 */
export const FEEDBACK_LEARNING_CONFIG = {
  modelVersion: `${PREFERENCE_LEARNING_MODEL_VERSION}-feedback-v1`,
  aspectStrength: 3.2,
  ratingStrength: 1.6,
  voteStrength: 0.8,
  aspectHighTarget: 86,
  aspectLowTarget: 20,
  ratingDelta: 18,
  voteDelta: 12,
  confidenceWithoutFact: {
    aspect: 0.9,
    rating: 0.55,
    vote: 0.4,
  },
  conflictingFactMultiplier: 0.45,
  maxSignalStrength: 3.2,
} as const;

type SignalTier = 'aspect' | 'rating' | 'vote' | 'none';
type Direction = -1 | 1;

interface AspectMapping {
  axis?: Exclude<TasteAxis, 'health'>;
  tag: string;
  positiveValues: readonly string[];
  negativeValues: readonly string[];
}

const ASPECT_MAPPINGS: Record<PlaceFeedbackAspect, AspectMapping> = {
  noise: {
    axis: 'quiet',
    tag: '静かな店',
    positiveValues: ['quiet', 'calm', '静か', '落ち着く', '会話しやすい'],
    negativeValues: ['loud', 'noisy', 'にぎやか', '賑やか', 'うるさい', '騒がしい'],
  },
  space: {
    axis: 'groupFit',
    tag: '席の快適さ',
    positiveValues: ['comfortable', '広い', '快適', '余裕がある', 'ゆったり'],
    negativeValues: ['cramped', '狭い', '窮屈', '落ち着かない'],
  },
  value: {
    axis: 'value',
    tag: 'コスパ重視',
    positiveValues: ['good', 'great', 'お得', '納得', '手頃', '満足'],
    negativeValues: ['bad', 'poor', 'expensive', '高い', '割高', '不満'],
  },
  service: {
    tag: '接客',
    positiveValues: ['good', 'great', '丁寧', '親切', '満足', '良い'],
    negativeValues: ['bad', 'poor', '雑', '冷たい', '不満', '悪い'],
  },
};

const FACT_AXIS_BY_KEY: Partial<Record<string, Exclude<TasteAxis, 'health'>>> = {
  noise_level: 'quiet',
  space_comfort: 'groupFit',
  value_for_money: 'value',
};

export interface FeedbackLearningInput {
  /** Providerから返された本人行だけを受け取る。user_id/place_idは学習結果へ持ち込まない。 */
  feedback: Pick<PlaceFeedback, 'id' | 'rating' | 'aspect' | 'aspectValue'>;
  /** 共有place_factsはキー・確度だけを参照し、値やplace identityは保存しない。 */
  placeFacts?: readonly PlaceFact[];
  /** 既存投票を同じイベントへ束ねる場合だけ指定する。 */
  vote?: VoteValue;
}

export interface FeedbackLearningReason {
  axis?: Exclude<TasteAxis, 'health'>;
  label: string;
  direction: '強まりました' | '弱まりました';
  source: 'aspect' | 'rating' | 'vote';
}

export interface FeedbackLearningResult {
  signalKey: string;
  observation: PreferenceObservation | null;
  tier: SignalTier;
  reasons: FeedbackLearningReason[];
}

/**
 * 来店フィードバックを、既存 adaptive preference service が扱える安全な観測へ変換する純関数。
 * aspect明示 > rating > vote の順で一つのイベントだけを作り、health/制約/free textは除外する。
 */
export function buildPlaceFeedbackObservation(
  input: FeedbackLearningInput,
): FeedbackLearningResult {
  const feedback = input.feedback;
  const mapping = feedback.aspect ? ASPECT_MAPPINGS[feedback.aspect] : undefined;
  const signalKey = feedbackLearningSignalKey(feedback);
  const facts = input.placeFacts ?? [];

  if (mapping) {
    const valueDirection = classifyAspectValue(mapping, feedback.aspectValue);
    // aspectValueは「店の特徴」、rating/voteは「その特徴を好むか」のvalence。
    // 例: loud × dislike は quiet軸を強め、loud × like は quiet軸を弱める。
    const valence = directionForRating(feedback.rating) ?? directionForVote(input.vote);
    if (valueDirection && valence) {
      const direction = (valueDirection * valence) as Direction;
      const confidence = factConfidence(facts, feedback.aspect, 'aspect');
      const axes: Partial<Record<TasteAxis, number>> = mapping.axis
        ? {
            [mapping.axis]: targetForDirection(direction, 'aspect'),
          }
        : {};
      const affinity = direction;
      const tags = [{ label: mapping.tag, affinity }];
      return buildResult({
          signalKey,
          tier: 'aspect',
        axes,
        tags,
        strength: boundedStrength(FEEDBACK_LEARNING_CONFIG.aspectStrength * confidence),
        reasons: mapping.axis
          ? [reasonFor(mapping.axis, direction, 'aspect')]
          : [reasonFor(undefined, direction, 'aspect', mapping.tag)],
      });
    }
  }

  const ratingDirection = directionForRating(feedback.rating);
  if (ratingDirection) {
    const axes = factPreferenceTargets(facts, ratingDirection, 'rating');
    if (Object.keys(axes).length === 0) {
      return { signalKey, observation: null, tier: 'none', reasons: [] };
    }
    const confidence = factConfidence(facts, undefined, 'rating');
    return buildResult({
      signalKey,
      tier: 'rating',
      axes,
      strength: boundedStrength(FEEDBACK_LEARNING_CONFIG.ratingStrength * confidence),
      reasons: Object.keys(axes).map((axis) =>
        reasonFor(
          axis as Exclude<TasteAxis, 'health'>,
          axes[axis as TasteAxis]! >= 50 ? 1 : -1,
          'rating',
        ),
      ),
    });
  }

  const voteDirection = directionForVote(input.vote);
  if (voteDirection) {
    const axes = factPreferenceTargets(facts, voteDirection, 'vote');
    if (Object.keys(axes).length === 0) {
      return { signalKey, observation: null, tier: 'none', reasons: [] };
    }
    const confidence = factConfidence(facts, undefined, 'vote');
    return buildResult({
      signalKey,
      tier: 'vote',
      axes,
      strength: boundedStrength(FEEDBACK_LEARNING_CONFIG.voteStrength * confidence),
      reasons: Object.keys(axes).map((axis) =>
        reasonFor(
          axis as Exclude<TasteAxis, 'health'>,
          axes[axis as TasteAxis]! >= 50 ? 1 : -1,
          'vote',
        ),
      ),
    });
  }

  return { signalKey, observation: null, tier: 'none', reasons: [] };
}

/** 端末内の表示・重複排除だけに使う不透明キー。DB receiptの正本には渡さない。 */
export function feedbackLearningSignalKey(
  feedback: Pick<PlaceFeedback, 'id' | 'rating' | 'aspect' | 'aspectValue'>,
): string {
  const normalized = [
    feedback.id,
    feedback.rating ?? '',
    feedback.aspect ?? '',
    feedback.aspectValue?.normalize('NFKC').trim().slice(0, 120) ?? '',
    FEEDBACK_LEARNING_CONFIG.modelVersion,
  ].join('|');
  return `feedback-v1-${fnv1a(normalized)}`;
}

function buildResult(input: {
  signalKey: string;
  tier: Exclude<SignalTier, 'none'>;
  axes: Partial<Record<TasteAxis, number>>;
  tags?: { label: string; affinity: number }[];
  strength: number;
  reasons: FeedbackLearningReason[];
}): FeedbackLearningResult {
  const observation: PreferenceObservation = {
    eventKey: input.signalKey,
    sourceKind: 'feedback',
    strength: input.strength,
    axes: input.axes,
    tags: input.tags,
  };
  return {
    signalKey: input.signalKey,
    observation,
    tier: input.tier,
    reasons: input.reasons,
  };
}

function reasonFor(
  axis: Exclude<TasteAxis, 'health'> | undefined,
  direction: Direction,
  source: Exclude<SignalTier, 'none'>,
  tag?: string,
): FeedbackLearningReason {
  return {
    axis,
    label: tag ?? (axis ? TASTE_AXIS_META[axis].label : '来店後の記録'),
    direction: direction > 0 ? '強まりました' : '弱まりました',
    source,
  };
}

function classifyAspectValue(mapping: AspectMapping, value: string | undefined): Direction | null {
  if (!value) return null;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
  if (mapping.positiveValues.includes(normalized)) return 1;
  if (mapping.negativeValues.includes(normalized)) return -1;
  return null;
}

function directionForRating(rating: PlaceFeedbackRating | undefined): Direction | null {
  return rating === 1 || rating === -1 ? rating : null;
}

function directionForVote(vote: VoteValue | undefined): Direction | null {
  return vote === 1 || vote === -1 ? vote : null;
}

function targetForDirection(direction: Direction, tier: Exclude<SignalTier, 'none'>): number {
  if (tier === 'aspect') {
    return direction > 0
      ? FEEDBACK_LEARNING_CONFIG.aspectHighTarget
      : FEEDBACK_LEARNING_CONFIG.aspectLowTarget;
  }
  const delta = tier === 'rating'
    ? FEEDBACK_LEARNING_CONFIG.ratingDelta
    : FEEDBACK_LEARNING_CONFIG.voteDelta;
  return 50 + direction * delta;
}

function factPreferenceTargets(
  facts: readonly PlaceFact[],
  valence: Direction,
  tier: Exclude<SignalTier, 'none'>,
): Partial<Record<TasteAxis, number>> {
  const targets = new Map<Exclude<TasteAxis, 'health'>, Direction[]>();
  for (const fact of facts) {
    const axis = FACT_AXIS_BY_KEY[fact.key];
    const featureDirection = factFeatureDirection(fact);
    if (!axis || !featureDirection) continue;
    const directions = targets.get(axis) ?? [];
    directions.push((featureDirection * valence) as Direction);
    targets.set(axis, directions);
  }
  return Object.fromEntries(
    [...targets.entries()].flatMap(([axis, directions]) => {
      const net = directions.reduce((sum, direction) => sum + direction, 0);
      // 同数の反対特徴は、推測で片側へ倒さず unknown として除外する。
      if (net === 0) return [];
      const direction: Direction = net > 0 ? 1 : -1;
      return [[axis, targetForDirection(direction, tier)]];
    }),
  ) as Partial<Record<TasteAxis, number>>;
}

function factFeatureDirection(fact: PlaceFact): Direction | null {
  const raw = fact.value;
  const value = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw
      ? (raw as { value?: unknown }).value
      : undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
  if (fact.key === 'noise_level') {
    if (['quiet', 'calm', '静か', '落ち着く'].includes(normalized)) return 1;
    if (['loud', 'noisy', 'にぎやか', '賑やか', 'うるさい', '騒がしい'].includes(normalized)) return -1;
  }
  if (fact.key === 'space_comfort') {
    if (['comfortable', '広い', '快適', '余裕がある', 'ゆったり'].includes(normalized)) return 1;
    if (['cramped', '狭い', '窮屈', '落ち着かない'].includes(normalized)) return -1;
  }
  if (fact.key === 'value_for_money') {
    if (['good', 'great', 'お得', '納得', '手頃', '満足'].includes(normalized)) return 1;
    if (['bad', 'poor', 'expensive', '高い', '割高', '不満'].includes(normalized)) return -1;
  }
  return null;
}

function factConfidence(
  facts: readonly PlaceFact[],
  aspect: PlaceFeedbackAspect | undefined,
  tier: Exclude<SignalTier, 'none'>,
): number {
  const targetKeys = aspect
    ? [factKeyForAspect(aspect)]
    : Object.keys(FACT_AXIS_BY_KEY);
  const relevant = facts.filter((fact) => targetKeys.includes(fact.key));
  if (relevant.length === 0) return FEEDBACK_LEARNING_CONFIG.confidenceWithoutFact[tier];
  const average = relevant.reduce(
    (sum, fact) => sum + boundedConfidence(fact.confidence),
    0,
  ) / relevant.length;
  const hasConflict = relevant.some((fact) => fact.conflicting);
  return boundedConfidence(
    average * (hasConflict ? FEEDBACK_LEARNING_CONFIG.conflictingFactMultiplier : 1),
  );
}

function factKeyForAspect(aspect: PlaceFeedbackAspect): string {
  return `${aspect === 'noise' ? 'noise_level' : aspect === 'space' ? 'space_comfort' : aspect === 'value' ? 'value_for_money' : 'service_quality'}`;
}

function boundedConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function boundedStrength(value: number): number {
  return Math.min(FEEDBACK_LEARNING_CONFIG.maxSignalStrength, Math.max(0.1, value));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
