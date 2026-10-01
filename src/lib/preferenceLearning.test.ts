import { describe, expect, it } from 'vitest';

import {
  applyPreferenceObservation,
  answerPreferenceHearingQuestion,
  beliefConfidence,
  createPreferenceLearningState,
  parsePreferenceLearningState,
  preferenceLearningStateForCloud,
  selectPreferenceHearingQuestion,
} from '@/lib/preferenceLearning';
import type { TasteScores } from '@/lib/personaCalibration';
import type { TasteProfile } from '@/types';

const neutralScores: TasteScores = {
  evidence: 50,
  health: 50,
  quiet: 50,
  value: 50,
  novelty: 50,
  groupFit: 50,
};

const emptyProfile: TasteProfile = {
  likes: [],
  avoid: [],
  allergies: '',
  healthGoal: 'none',
};

describe('adaptive preference learning', () => {
  it('migrates a schema-v2 aggregate to schema v4 without inventing contexts', () => {
    const current = createPreferenceLearningState(neutralScores, emptyProfile, 'demo_answers');
    const schemaV2 = {
      ...current,
      schemaVersion: 2,
    } as Record<string, unknown>;
    delete schemaV2.contexts;

    const parsed = parsePreferenceLearningState(
      schemaV2,
      neutralScores,
      emptyProfile,
    );
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.contexts).toEqual({});
    expect(parsed.confirmedAxes).toEqual(current.confirmedAxes);
  });

  it('migrates schema-v3 context axes with empty v4 tag fields', () => {
    const current = createPreferenceLearningState(neutralScores, emptyProfile);
    const schemaV3 = {
      ...current,
      schemaVersion: 3,
      contexts: {
        special: {
          axes: { quiet: { ...current.axes.quiet, mean: 82 } },
          confirmedAxes: { quiet: 'high' },
        },
      },
    };

    const parsed = parsePreferenceLearningState(schemaV3, neutralScores, emptyProfile);
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.contexts.special).toMatchObject({
      tags: [],
      confirmedTags: {},
      confirmedAxes: { quiet: 'high' },
    });
  });

  it('drops confirmed context fields that have no matching learned belief', () => {
    const current = createPreferenceLearningState(neutralScores, emptyProfile);
    const parsed = parsePreferenceLearningState(
      {
        ...current,
        contexts: {
          special: {
            axes: {},
            tags: [
              {
                label: '寿司',
                mean: 0.8,
                weight: 2,
                m2: 0,
                observations: 2,
                sources: ['behavior_signals'],
              },
            ],
            confirmedAxes: { quiet: 'high' },
            confirmedTags: {
              '寿司': 'prefer',
              '個人名メモ': 'prefer',
            },
          },
        },
      },
      neutralScores,
      emptyProfile,
    );

    expect(parsed.contexts.special?.confirmedAxes).toEqual({});
    expect(parsed.contexts.special?.confirmedTags).toEqual({ '寿司': 'prefer' });
  });

  it('deduplicates the same action without increasing confidence twice', () => {
    const initial = createPreferenceLearningState(neutralScores, emptyProfile);
    const observation = {
      eventKey: 'vote:opaque-candidate:1',
      sourceKind: 'behavior_signals' as const,
      strength: 2,
      tags: [{ label: '焼肉', affinity: 0.8 }],
    };

    const once = applyPreferenceObservation(initial, observation);
    const twice = applyPreferenceObservation(once, observation);

    expect(twice).toBe(once);
    expect(once.interactionCount).toBe(1);
    expect(once.tags[0].observations).toBe(1);
  });

  it('does not turn one weak view into a declared preference', () => {
    const initial = createPreferenceLearningState(neutralScores, emptyProfile);
    const learned = applyPreferenceObservation(initial, {
      eventKey: 'open:opaque-candidate',
      sourceKind: 'behavior_signals',
      strength: 0.35,
      tags: [{ label: '焼肉', affinity: 0.2 }],
    });

    expect(selectPreferenceHearingQuestion(learned, emptyProfile)).toBeNull();
    expect(learned.tags[0].mean).toBeCloseTo(0.2);
    expect(beliefConfidence(learned.tags[0], 1)).toBeLessThan(0.2);
  });

  it('asks one confirmation after repeated coherent behavior', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    state = applyPreferenceObservation(state, {
      eventKey: 'search:one',
      sourceKind: 'behavior_signals',
      strength: 1,
      tags: [{ label: '焼肉', affinity: 0.7 }],
    });
    state = applyPreferenceObservation(state, {
      eventKey: 'vote:two',
      sourceKind: 'behavior_signals',
      strength: 2.2,
      tags: [{ label: '焼肉', affinity: 0.8 }],
    });

    const question = selectPreferenceHearingQuestion(state, emptyProfile);
    expect(question).toMatchObject({ kind: 'tag', tagLabel: '焼肉' });
    expect(question?.prompt).toContain('好みとして');
  });

  it('turns conflicting behavior into a trade-off question instead of a conclusion', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    state = applyPreferenceObservation(state, {
      eventKey: 'quiet:one',
      sourceKind: 'behavior_signals',
      strength: 1,
      axes: { quiet: 88 },
    });
    state = applyPreferenceObservation(state, {
      eventKey: 'lively:two',
      sourceKind: 'behavior_signals',
      strength: 1,
      axes: { quiet: 15 },
    });

    expect(selectPreferenceHearingQuestion(state, emptyProfile)).toMatchObject({
      kind: 'axis',
      axis: 'quiet',
    });
  });

  it('separates a contextual preference from the global baseline and asks naturally', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (const eventKey of ['group-quiet:one', 'group-quiet:two']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 1,
        axes: { quiet: 88 },
        contexts: ['group'],
      });
    }

    const question = selectPreferenceHearingQuestion(state, emptyProfile);
    expect(question).toMatchObject({
      kind: 'context_axis',
      context: 'group',
      axis: 'quiet',
    });
    expect(question?.prompt).toContain('複数人で探す時');

    const globalBefore = state.axes.quiet.mean;
    const answer = answerPreferenceHearingQuestion(
      state,
      emptyProfile,
      question!,
      'high',
    );
    expect(answer.learningState.contexts.group?.confirmedAxes.quiet).toBe('high');
    expect(answer.learningState.confirmedAxes.quiet).toBeUndefined();
    expect(answer.learningState.axes.quiet.mean).toBe(globalBefore);
    expect(answer.learningState.answeredQuestionIds[0]).toMatch(
      /^context_axis:group:quiet@o\d+$/,
    );
  });

  it('keeps contextual cuisine evidence out of the global profile until hearing confirms it', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (const eventKey of ['special-sushi:one', 'special-sushi:two']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 2,
        tags: [{ label: '寿司', affinity: 0.8 }],
        contexts: ['special'],
        tagsContextOnly: true,
      });
    }

    expect(state.tags.find((tag) => tag.label === '寿司')).toBeUndefined();
    expect(state.contexts.special?.tags.find((tag) => tag.label === '寿司')).toMatchObject({
      observations: 2,
    });
    const question = selectPreferenceHearingQuestion(state, emptyProfile);
    expect(question).toMatchObject({
      kind: 'context_tag',
      context: 'special',
      tagLabel: '寿司',
    });
    expect(question?.prompt).toContain('特別な日');

    const answer = answerPreferenceHearingQuestion(
      state,
      emptyProfile,
      question!,
      'prefer',
    );
    expect(answer.profile.likes).toEqual([]);
    expect(answer.learningState.tags.find((tag) => tag.label === '寿司')).toBeUndefined();
    expect(answer.learningState.contexts.special?.confirmedTags).toMatchObject({
      '寿司': 'prefer',
    });
    expect(answer.learningState.answeredQuestionIds[0]).toMatch(
      /^context_tag:special:寿司@o\d+$/,
    );
  });

  it('uses an explicit hearing answer to update the editable profile', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    state = applyPreferenceObservation(state, {
      eventKey: 'search:ramen',
      sourceKind: 'behavior_signals',
      strength: 2,
      tags: [{ label: 'ラーメン', affinity: 0.8 }],
    });
    state = applyPreferenceObservation(state, {
      eventKey: 'vote:ramen',
      sourceKind: 'behavior_signals',
      strength: 2,
      tags: [{ label: 'ラーメン', affinity: 0.9 }],
    });
    const question = selectPreferenceHearingQuestion(state, emptyProfile);
    expect(question).not.toBeNull();

    const answer = answerPreferenceHearingQuestion(
      state,
      emptyProfile,
      question!,
      'prefer',
    );
    expect(answer.profile.likes).toContain('ラーメン');
    expect(answer.learningState.answeredQuestionIds).toContain('tag:ラーメン@o3');
    expect(selectPreferenceHearingQuestion(answer.learningState, answer.profile)).toBeNull();
  });

  it('removes local dedupe tokens from the cloud aggregate', () => {
    const state = applyPreferenceObservation(
      createPreferenceLearningState(neutralScores, emptyProfile),
      {
        eventKey: 'candidate:private-opaque-id',
        sourceKind: 'behavior_signals',
        strength: 1,
        tags: [{ label: '寿司', affinity: 0.7 }],
      },
    );
    const cloud = preferenceLearningStateForCloud(state);
    const serialized = JSON.stringify(cloud);

    expect(serialized).not.toContain('processedEventTokens');
    expect(serialized).not.toContain('private-opaque-id');
  });

  it('does not generate an implicit health-preference question', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (const eventKey of ['health:one', 'health:two']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 2,
        axes: { health: 88 },
        tags: [{ label: 'ヘルシー', affinity: 0.9 }],
      });
    }

    expect(selectPreferenceHearingQuestion(state, emptyProfile)).toBeNull();
  });

  it('keeps adapting when recent choices reverse a long-standing preference', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (let index = 0; index < 60; index += 1) {
      state = applyPreferenceObservation(state, {
        eventKey: `long-quiet:${index}`,
        sourceKind: 'behavior_signals',
        strength: 5,
        axes: { quiet: 90 },
      });
    }
    expect(state.axes.quiet.mean).toBeGreaterThan(85);

    for (let index = 0; index < 8; index += 1) {
      state = applyPreferenceObservation(state, {
        eventKey: `recent-lively:${index}`,
        sourceKind: 'behavior_signals',
        strength: 5,
        axes: { quiet: 10 },
      });
    }

    expect(state.axes.quiet.mean).toBeLessThan(50);
    expect(state.axes.quiet.observations).toBe(68);
  });

  it('can revisit a situational answer only after enough new evidence', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (const eventKey of ['ramen:one', 'ramen:two']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 2,
        tags: [{ label: 'ラーメン', affinity: 0.8 }],
      });
    }
    const first = selectPreferenceHearingQuestion(state, emptyProfile);
    expect(first?.id).toBe('tag:ラーメン');
    state = answerPreferenceHearingQuestion(
      state,
      emptyProfile,
      first!,
      'situational',
    ).learningState;
    expect(selectPreferenceHearingQuestion(state, emptyProfile)).toBeNull();

    for (const eventKey of ['ramen:three', 'ramen:four', 'ramen:five']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 2,
        tags: [{ label: 'ラーメン', affinity: 0.8 }],
      });
    }
    expect(selectPreferenceHearingQuestion(state, emptyProfile)).toBeNull();
    state = applyPreferenceObservation(state, {
      eventKey: 'ramen:six',
      sourceKind: 'behavior_signals',
      strength: 2,
      tags: [{ label: 'ラーメン', affinity: 0.8 }],
    });
    expect(selectPreferenceHearingQuestion(state, emptyProfile)?.id).toBe('tag:ラーメン:r2');
  });

  it('keeps the full question id for a maximum-length learned tag', () => {
    const label = '長'.repeat(40);
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (const eventKey of ['long-tag:one', 'long-tag:two']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 2,
        tags: [{ label, affinity: 0.8 }],
      });
    }
    const question = selectPreferenceHearingQuestion(state, emptyProfile);
    expect(question?.id).toBe(`tag:${label}`);
    const answered = answerPreferenceHearingQuestion(
      state,
      emptyProfile,
      question!,
      'situational',
    ).learningState;

    expect(answered.answeredQuestionIds).toContain(`tag:${label}@o3`);
    expect(selectPreferenceHearingQuestion(answered, emptyProfile)).toBeNull();
  });

  it('explains low-support axis questions without claiming conflicting behavior', () => {
    let state = createPreferenceLearningState(neutralScores, emptyProfile);
    for (const eventKey of ['value:one', 'value:two']) {
      state = applyPreferenceObservation(state, {
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 1,
        axes: { value: 80 },
      });
    }

    expect(selectPreferenceHearingQuestion(state, emptyProfile)).toMatchObject({
      kind: 'axis',
      axis: 'value',
      reason: expect.stringContaining('手がかりが少ない'),
    });
  });
});
