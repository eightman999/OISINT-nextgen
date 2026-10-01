import { describe, expect, it } from 'vitest';

import {
  recognizeCandidateBehavior,
  recognizePreferenceContexts,
  recognizeProfileEdit,
  recognizeSearchBehavior,
} from '@/lib/behaviorRecognition';
import { mockInvestigation } from '@/data/mock';
import type { TasteProfile } from '@/types';

describe('preference behavior recognition', () => {
  it('keeps only canonical aggregate signals from a raw search', () => {
    const observation = recognizeSearchBehavior({
      eventKey: 'search:1',
      query: '吉祥寺で田中さんと2人、静かな町中華。予算3000円',
      selectedChips: ['カード可'],
    });
    const serialized = JSON.stringify(observation);

    expect(observation?.tags?.map((tag) => tag.label)).toEqual(
      expect.arrayContaining(['町中華・中華', '静かな店']),
    );
    expect(observation?.axes).toMatchObject({ quiet: 86, value: 76, groupFit: 74 });
    expect(observation?.contexts).toEqual(['group']);
    expect(observation?.tagsContextOnly).toBe(true);
    expect(serialized).not.toContain('吉祥寺');
    expect(serialized).not.toContain('田中');
    expect(serialized).not.toContain('3000');
  });

  it('recognizes only coarse allow-listed situations without retaining the sentence', () => {
    const raw = '田中さんと記念日の店を急いで決めたい';
    const contexts = recognizePreferenceContexts(raw);

    expect(contexts).toEqual(['quick', 'special']);
    expect(JSON.stringify(contexts)).not.toContain('田中');
  });

  it('recognizes candidate intent without retaining place identity', () => {
    const candidate = {
      ...mockInvestigation.candidates[0],
      place: {
        ...mockInvestigation.candidates[0].place,
        name: '秘密の店名',
        address: '秘密の住所',
        genre: '焼肉',
      },
    };
    const observation = recognizeCandidateBehavior({
      eventKey: 'vote:opaque:1',
      action: 'vote_up',
      candidate,
      requirements: mockInvestigation.requirements,
    });
    const serialized = JSON.stringify(observation);

    expect(observation?.tags).toContainEqual({ label: '焼肉', affinity: 0.8 });
    expect(serialized).not.toContain('秘密の店名');
    expect(serialized).not.toContain('秘密の住所');
  });

  it('never treats allergy text as a learned preference signal', () => {
    const previous: TasteProfile = {
      likes: [],
      avoid: [],
      allergies: '',
      healthGoal: 'none',
    };
    const next: TasteProfile = {
      ...previous,
      allergies: '甲殻類と個人名を含む安全情報',
    };

    expect(recognizeProfileEdit(previous, next, 'profile:allergy')).toBeNull();
  });

  it('treats a successful map open as a strong aggregate decision without place identity', () => {
    const candidate = {
      ...mockInvestigation.candidates[0],
      place: {
        ...mockInvestigation.candidates[0].place,
        name: '地図だけに渡す秘密の店名',
        address: '地図だけに渡す秘密の住所',
        genre: 'カフェ',
      },
    };
    const observation = recognizeCandidateBehavior({
      eventKey: 'map-open:opaque',
      action: 'map_opened',
      candidate,
      requirements: mockInvestigation.requirements,
    });
    const serialized = JSON.stringify(observation);

    expect(observation?.strength).toBe(3.8);
    expect(observation?.tags).toContainEqual({ label: 'カフェ', affinity: 0.95 });
    expect(serialized).not.toContain('秘密の店名');
    expect(serialized).not.toContain('秘密の住所');
  });
});
