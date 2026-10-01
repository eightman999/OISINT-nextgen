import { afterEach, describe, expect, it, vi } from 'vitest';

import { calibratePersona } from '@/lib/personaCalibration';
import { recognizeSearchBehavior } from '@/lib/behaviorRecognition';
import {
  answerPreferenceHearingLocally,
  confirmedPreferenceHintsToQuery,
  createImportedTasteMerge,
  emptyPersonalizationSnapshot,
  getNextPreferenceHearingQuestionLocally,
  loadLocalPersonalization,
  mergeImportedTasteTags,
  previewPreferenceObservationFromSnapshot,
  recordPreferenceObservationLocally,
  restoreStoredPersonalizationLocally,
  saveCalibrationLocally,
  saveLocalPersonalization,
  snapshotFromCalibration,
  tasteProfileForCurrentContext,
} from '@/lib/personalization';
import { loadTasteProfile, saveTasteProfile } from '@/lib/profile';
import type { TasteProfile } from '@/types';

function installLocalStorage() {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
  vi.stubGlobal('window', { localStorage });
  return localStorage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local personalization', () => {
  it('stores aggregates without raw calibration answers', () => {
    const storage = installLocalStorage();
    const result = calibratePersona('eightman-decider', {
      protect: 'discovery',
      trust: 'official',
      atmosphere: 'character',
      tradeoff: 'special',
    });

    saveCalibrationLocally(result);

    const serialized = storage.setItem.mock.calls.map((call) => call[1]).join('\n');
    expect(serialized).not.toContain('protect');
    expect(serialized).not.toContain('tradeoff');
    expect(loadLocalPersonalization()?.scenarioId).toBe('eightman-decider');
  });

  it('merges imported tags while deduplicating values', () => {
    installLocalStorage();
    const merged = mergeImportedTasteTags(['町中華', '町中華', '  カフェ  ']);
    expect(merged.likes).toEqual(['町中華', 'カフェ']);
    expect(merged.sourceKinds).toContain('maps_takeout');
    expect(merged.learningState.tags.map((tag) => tag.label)).toEqual(
      expect.arrayContaining(['町中華', 'カフェ']),
    );
  });

  it('uses the supplied cloud snapshot as the Maps merge base', () => {
    installLocalStorage();
    saveTasteProfile({
      likes: ['端末だけの古い値'],
      avoid: ['端末だけの除外'],
      allergies: '甲殻類',
      healthGoal: 'none',
    });
    const cloudBase = {
      ...emptyPersonalizationSnapshot(),
      likes: ['クラウド正本'],
      avoid: ['クラウド正本の除外'],
    };

    const merged = createImportedTasteMerge(
      ['Takeoutの好み'],
      [],
      [{ label: 'Takeoutの好み', matches: 2, confidence: 0.9 }],
      undefined,
      cloudBase,
    );

    expect(merged.snapshot.likes).toEqual(['クラウド正本', 'Takeoutの好み']);
    expect(merged.snapshot.likes).not.toContain('端末だけの古い値');
    expect(merged.snapshot.avoid).toEqual(['クラウド正本の除外']);
    expect(merged.tasteProfile.allergies).toBe('甲殻類');
  });

  it('uses a Maps context co-occurrence as a question, not an implicit confirmation', () => {
    installLocalStorage();
    const merged = mergeImportedTasteTags(
      ['静かな店', '特別な日'],
      [],
      [
        { label: '静かな店', matches: 2, confidence: 0.91, contexts: ['special'] },
        { label: '特別な日', matches: 2, confidence: 0.91, contexts: ['special'] },
      ],
    );

    expect(merged.learningState.contexts.special?.axes.quiet?.observations).toBe(2);
    expect(merged.learningState.contexts.special?.tags.map((tag) => tag.label)).toEqual(
      expect.arrayContaining(['静かな店', '特別な日']),
    );
    expect(merged.learningState.contexts.special?.confirmedAxes.quiet).toBeUndefined();
    expect(merged.likes).toEqual([]);
    const question = getNextPreferenceHearingQuestionLocally(loadTasteProfile());
    expect(question).toMatchObject({
      kind: 'context_tag',
      context: 'special',
      tagLabel: '静かな店',
    });
    expect(question?.reason).toContain('保存リスト');
  });

  it('stores only recognized aggregates from behavior, never the raw query', () => {
    const storage = installLocalStorage();
    recordPreferenceObservationLocally(
      recognizeSearchBehavior({
        eventKey: 'search:opaque-id',
        query: '秘密の待ち合わせ場所で静かな寿司。個人名は田中。',
      }),
    );

    const serialized = storage.setItem.mock.calls.map((call) => call[1]).join('\n');
    expect(serialized).toContain('寿司');
    expect(serialized).toContain('静かな店');
    expect(serialized).not.toContain('秘密の待ち合わせ場所');
    expect(serialized).not.toContain('田中');
    expect(loadLocalPersonalization()?.sourceKinds).toContain('behavior_signals');
  });

  it('uses a supplied cloud snapshot as the feedback base on a new device', () => {
    installLocalStorage();
    const seededCloud = snapshotFromCalibration(calibratePersona('eightman-decider', {
      protect: 'discovery',
      trust: 'official',
      atmosphere: 'character',
      tradeoff: 'special',
    }));
    const cloudBase = {
      ...seededCloud,
      scores: { ...seededCloud.scores, quiet: 82 },
      learningState: {
        ...seededCloud.learningState,
        axes: {
          ...seededCloud.learningState.axes,
          quiet: { ...seededCloud.learningState.axes.quiet, mean: 82 },
        },
      },
    };
    // localStorageは空でも、remoteのquiet=82をbaseにしてから反映する。
    const next = previewPreferenceObservationFromSnapshot(cloudBase, {
      eventKey: 'feedback-v1-cloud-base',
      sourceKind: 'feedback',
      strength: 1,
      axes: { quiet: 20 },
    });
    expect(next.scores.quiet).toBeGreaterThan(50);
    expect(next.learningState.axes.quiet.mean).toBeGreaterThan(50);
    expect(loadLocalPersonalization()).toBeNull();
  });

  it('does not use another account\'s local snapshot when the cloud profile is empty', () => {
    installLocalStorage();
    const staleLocal = snapshotFromCalibration(calibratePersona('eightman-decider', {
      protect: 'discovery',
      trust: 'official',
      atmosphere: 'character',
      tradeoff: 'special',
    }));
    saveLocalPersonalization({ ...staleLocal, scores: { ...staleLocal.scores, quiet: 94 } });

    const cloudBase = emptyPersonalizationSnapshot();
    const next = previewPreferenceObservationFromSnapshot(cloudBase, {
      eventKey: 'feedback-v1-empty-cloud',
      sourceKind: 'feedback',
      strength: 1,
      axes: { quiet: 20 },
    });

    expect(next.scores.quiet).toBeLessThan(50);
    expect(next.scores.quiet).not.toBe(94);
    expect(loadLocalPersonalization()?.scores.quiet).toBe(94);
  });

  it('upgrades a v1 aggregate snapshot without losing its scores or tags', () => {
    const storage = installLocalStorage();
    storage.setItem('oisint:personalization:v1', JSON.stringify({
      scenarioId: 'legacy',
      scores: {
        evidence: 70,
        health: 50,
        quiet: 80,
        value: 60,
        novelty: 40,
        groupFit: 55,
      },
      likes: ['寿司'],
      avoid: [],
      modelVersion: 'scenario-calibration-v1',
      sourceKinds: ['demo_answers'],
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));

    const loaded = loadLocalPersonalization();
    expect(loaded?.scores.quiet).toBe(80);
    expect(loaded?.likes).toEqual(['寿司']);
    expect(loaded?.learningState.schemaVersion).toBe(4);
    expect(loaded?.learningState.axes.quiet.mean).toBe(80);
    expect(loaded?.learningState.confirmedAxes.quiet).toBe('high');
  });

  it('uses only explicitly confirmed axis beliefs as fixed search hints', () => {
    installLocalStorage();
    const profile: TasteProfile = {
      likes: [],
      avoid: [],
      allergies: '',
      healthGoal: 'none',
    };
    recordPreferenceObservationLocally({
      eventKey: 'quiet:one',
      sourceKind: 'behavior_signals',
      strength: 1,
      axes: { quiet: 86 },
    });
    recordPreferenceObservationLocally({
      eventKey: 'quiet:two',
      sourceKind: 'behavior_signals',
      strength: 1,
      axes: { quiet: 82 },
    });

    expect(confirmedPreferenceHintsToQuery(loadLocalPersonalization())).toBeNull();
    const question = getNextPreferenceHearingQuestionLocally(profile);
    expect(question).toMatchObject({ kind: 'axis', axis: 'quiet' });
    answerPreferenceHearingLocally(question!, 'high', profile);

    expect(confirmedPreferenceHintsToQuery(loadLocalPersonalization())).toContain(
      '静かで会話しやすい店',
    );

    for (let index = 0; index < 8; index += 1) {
      recordPreferenceObservationLocally({
        eventKey: `lively-after-confirmation:${index}`,
        sourceKind: 'behavior_signals',
        strength: 5,
        axes: { quiet: 10 },
      });
    }
    // New behavior creates a new question, but cannot silently reverse the fixed search hint.
    expect(confirmedPreferenceHintsToQuery(loadLocalPersonalization())).toContain(
      '静かで会話しやすい店',
    );
    const revisedQuestion = getNextPreferenceHearingQuestionLocally(profile);
    expect(revisedQuestion).toMatchObject({ kind: 'axis', axis: 'quiet' });
    answerPreferenceHearingLocally(revisedQuestion!, 'low', profile);
    expect(confirmedPreferenceHintsToQuery(loadLocalPersonalization())).toContain(
      '活気のある雰囲気',
    );
  });

  it('uses a confirmed contextual preference only when the current search matches it', () => {
    installLocalStorage();
    const profile: TasteProfile = {
      likes: [],
      avoid: [],
      allergies: '',
      healthGoal: 'none',
    };
    for (const eventKey of ['group-quiet:one', 'group-quiet:two']) {
      recordPreferenceObservationLocally({
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 1,
        axes: { quiet: 86 },
        contexts: ['group'],
      });
    }

    const question = getNextPreferenceHearingQuestionLocally(profile);
    expect(question).toMatchObject({ kind: 'context_axis', context: 'group', axis: 'quiet' });
    answerPreferenceHearingLocally(question!, 'high', profile);

    expect(
      confirmedPreferenceHintsToQuery(
        loadLocalPersonalization(),
        '友人3人で会話しやすい店',
      ),
    ).toContain('複数人で探す時は静かで会話しやすい店');
    expect(
      confirmedPreferenceHintsToQuery(loadLocalPersonalization(), 'ひとりで気軽に食べたい'),
    ).toBeNull();
  });

  it('applies a confirmed contextual cuisine only to matching searches', () => {
    installLocalStorage();
    const profile: TasteProfile = {
      likes: [],
      avoid: ['寿司'],
      allergies: '',
      healthGoal: 'none',
    };
    saveTasteProfile(profile);
    for (const eventKey of ['special-sushi:one', 'special-sushi:two']) {
      recordPreferenceObservationLocally({
        eventKey,
        sourceKind: 'behavior_signals',
        strength: 2,
        tags: [{ label: '寿司', affinity: 0.8 }],
        contexts: ['special'],
        tagsContextOnly: true,
      }, profile);
    }
    const question = getNextPreferenceHearingQuestionLocally(profile);
    expect(question).toMatchObject({
      kind: 'context_tag',
      context: 'special',
      tagLabel: '寿司',
    });
    answerPreferenceHearingLocally(question!, 'prefer', profile);

    const snapshot = loadLocalPersonalization();
    expect(confirmedPreferenceHintsToQuery(snapshot, '記念日の夕食')).toContain(
      '特別な日は「寿司」を優先',
    );
    expect(tasteProfileForCurrentContext(snapshot, profile, '記念日の夕食')).toMatchObject({
      likes: ['寿司'],
      avoid: [],
    });
    expect(tasteProfileForCurrentContext(snapshot, profile, 'ひとりの夕食')).toMatchObject({
      likes: [],
      avoid: ['寿司'],
    });
    // A contextual answer remains separate from the user-editable global profile.
    expect(loadTasteProfile()).toMatchObject({ likes: [], avoid: ['寿司'] });
  });

  it('ignores orphan contextual confirmations from a corrupted snapshot', () => {
    installLocalStorage();
    const profile: TasteProfile = {
      likes: [],
      avoid: [],
      allergies: '',
      healthGoal: 'none',
    };
    recordPreferenceObservationLocally({
      eventKey: 'special-sushi',
      sourceKind: 'behavior_signals',
      strength: 2,
      tags: [{ label: '寿司', affinity: 0.8 }],
      contexts: ['special'],
      tagsContextOnly: true,
    }, profile);
    const snapshot = loadLocalPersonalization()!;
    snapshot.learningState.contexts.special!.confirmedAxes = { quiet: 'high' };
    snapshot.learningState.contexts.special!.confirmedTags = { '個人名メモ': 'prefer' };

    expect(confirmedPreferenceHintsToQuery(snapshot, '記念日')).toBeNull();
    expect(tasteProfileForCurrentContext(snapshot, profile, '記念日').likes).toEqual([]);
  });

  it('restores a cloud aggregate on a new device while preserving private safety fields', () => {
    installLocalStorage();
    const calibration = calibratePersona('local-explorer', {
      protect: 'discovery',
      trust: 'official',
      atmosphere: 'character',
      tradeoff: 'special',
    });
    const cloud = snapshotFromCalibration(calibration);
    saveTasteProfile({
      likes: ['端末だけの一時値'],
      avoid: [],
      allergies: '甲殻類',
      healthGoal: 'high_protein',
    });

    const restored = restoreStoredPersonalizationLocally({
      scenarioId: cloud.scenarioId,
      axisScores: cloud.scores,
      likes: cloud.likes,
      avoid: cloud.avoid,
      modelVersion: cloud.modelVersion,
      sourceKinds: cloud.sourceKinds,
      learningState: cloud.learningState,
      updatedAt: cloud.updatedAt,
    });
    const privateProfile = loadTasteProfile();

    expect(restored.likes).toEqual(cloud.likes);
    expect(loadLocalPersonalization()?.scenarioId).toBe('local-explorer');
    expect(privateProfile.likes).toEqual(cloud.likes);
    expect(privateProfile.allergies).toBe('甲殻類');
    expect(privateProfile.healthGoal).toBe('high_protein');
  });
});
