import { describe, expect, it } from 'vitest';

import {
  buildPlaceFeedbackObservation,
  FEEDBACK_LEARNING_CONFIG,
  feedbackLearningSignalKey,
} from '@/lib/preferenceLearningFeedback';
import type { PlaceFact } from '@/types';

function fact(overrides: Partial<PlaceFact> = {}): PlaceFact {
  return {
    placeId: 'private-place-id-must-not-leak',
    key: 'noise_level',
    value: { value: 'quiet', count: 5 },
    confidence: 0.9,
    evidenceCount: 3,
    conflicting: false,
    lastVerifiedAt: '2026-08-24T00:00:00Z',
    ...overrides,
  };
}

describe('preferenceLearningFeedback (#515)', () => {
  it('aspect明示を最優先し、特徴×valenceでquiet/loudの因果方向を反映する', () => {
    const result = buildPlaceFeedbackObservation({
      feedback: {
        id: 'feedback-1',
        rating: 1,
        aspect: 'noise',
        aspectValue: 'quiet',
      },
      placeFacts: [fact()],
    });

    expect(result.tier).toBe('aspect');
    expect(result.observation).toMatchObject({
      sourceKind: 'feedback',
      axes: { quiet: 86 },
      tags: [{ label: '静かな店', affinity: 1 }],
    });
    expect(result.observation?.axes).not.toHaveProperty('health');
    expect(JSON.stringify(result)).not.toContain('private-place-id-must-not-leak');
    expect(result.reasons[0]).toMatchObject({ label: '落ち着いて過ごしたい', source: 'aspect' });
  });

  it.each([
    ['quiet', 1, 86],
    ['quiet', -1, 20],
    ['loud', 1, 20],
    ['loud', -1, 86],
  ] as const)('noise=%s × rating=%s は quiet=%s になる', (aspectValue, rating, target) => {
    const result = buildPlaceFeedbackObservation({
      feedback: {
        id: `feedback-noise-${aspectValue}-${rating}`,
        rating,
        aspect: 'noise',
        aspectValue,
      },
    });

    expect(result.tier).toBe('aspect');
    expect(result.observation?.axes).toEqual({ quiet: target });
  });

  it.each([
    ['good', 1, 86],
    ['good', -1, 20],
    ['bad', 1, 20],
    ['bad', -1, 86],
  ] as const)('value=%s × rating=%s は value=%s になる', (aspectValue, rating, target) => {
    const result = buildPlaceFeedbackObservation({
      feedback: { id: `feedback-value-${aspectValue}-${rating}`, rating, aspect: 'value', aspectValue },
    });
    expect(result.observation?.axes).toEqual({ value: target });
  });

  it('spaceの快適/窮屈もgroupFitへvalenceを反転して反映する', () => {
    expect(buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-space-good', rating: 1, aspect: 'space', aspectValue: 'comfortable' },
    }).observation?.axes).toEqual({ groupFit: 86 });
    expect(buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-space-bad', rating: -1, aspect: 'space', aspectValue: 'cramped' },
    }).observation?.axes).toEqual({ groupFit: 86 });
  });

  it('serviceの固定tagもrating/voteのvalenceなしには更新しない', () => {
    expect(buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-service-no-valence', aspect: 'service', aspectValue: 'good' },
    }).observation).toBeNull();
    expect(buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-service-like', rating: 1, aspect: 'service', aspectValue: 'good' },
    }).observation?.tags).toEqual([{ label: '接客', affinity: 1 }]);
  });

  it('aspectValueが自由記述で不明、valenceだけでは学習しない', () => {
    const result = buildPlaceFeedbackObservation({
      feedback: {
        id: 'feedback-2',
        rating: -1,
        aspect: 'value',
        aspectValue: 'この文章はプロフィールへ保存してはいけない',
      },
    });

    expect(result.tier).toBe('none');
    expect(result.observation).toBeNull();
    expect(JSON.stringify(result)).not.toContain('この文章はプロフィールへ保存してはいけない');
  });

  it('rating-onlyはstructured factの軸だけへ弱く反映し、矛盾で強度を下げる', () => {
    const clear = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-3', rating: 1 },
      placeFacts: [fact()],
    });
    const conflicting = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-4', rating: 1 },
      placeFacts: [fact({ conflicting: true })],
    });

    expect(clear.tier).toBe('rating');
    expect(clear.observation?.axes).toEqual({ quiet: 68 });
    expect(conflicting.observation!.strength).toBeLessThan(clear.observation!.strength);
    expect(conflicting.observation!.strength).toBeGreaterThanOrEqual(0.1);
    expect(conflicting.observation?.axes).not.toHaveProperty('health');
  });

  it('rating/vote-onlyでstructured featureが無い場合は全軸を捏造しない', () => {
    expect(buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-no-fact', rating: 1 },
    }).observation).toBeNull();
    expect(buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-no-fact-vote' },
      vote: 1,
    }).observation).toBeNull();
  });

  it('反対のstructured factが同数ならunknownへ倒し、片側を捏造しない', () => {
    const result = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-conflict', rating: 1 },
      placeFacts: [fact(), fact({ value: { value: 'loud' }, conflicting: true })],
    });
    expect(result.observation).toBeNull();
  });

  it('vote-onlyはratingより弱く、同一feedbackのsignal keyは決定的', () => {
    const input = { id: 'feedback-5', aspect: undefined, rating: undefined } as const;
    const result = buildPlaceFeedbackObservation({ feedback: input, vote: 1, placeFacts: [fact()] });

    expect(result.tier).toBe('vote');
    expect(result.observation!.strength).toBeLessThan(FEEDBACK_LEARNING_CONFIG.ratingStrength);
    expect(result.observation!.strength).toBeLessThanOrEqual(FEEDBACK_LEARNING_CONFIG.maxSignalStrength);
    expect(feedbackLearningSignalKey(input)).toBe(feedbackLearningSignalKey(input));
  });

  it('強度はaspect明示 > rating > voteの順で既存behaviorの強操作を超えない', () => {
    const aspect = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-strength-aspect', rating: 1, aspect: 'noise', aspectValue: 'quiet' },
    });
    const rating = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-strength-rating', rating: 1 },
      placeFacts: [fact()],
    });
    const vote = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-strength-vote' },
      vote: 1,
      placeFacts: [fact()],
    });

    expect(aspect.observation!.strength).toBeGreaterThan(rating.observation!.strength);
    expect(rating.observation!.strength).toBeGreaterThan(vote.observation!.strength);
    expect(aspect.observation!.strength).toBeLessThan(3.8);
  });

  it('中立記録だけではプロフィールを更新しない', () => {
    const result = buildPlaceFeedbackObservation({
      feedback: { id: 'feedback-6', rating: 0 },
    });
    expect(result.tier).toBe('none');
    expect(result.observation).toBeNull();
  });
});
