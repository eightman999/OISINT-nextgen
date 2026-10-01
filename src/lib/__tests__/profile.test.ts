import { describe, expect, it } from 'vitest';

import { locationToQuery, tasteProfileToQuery } from '@/lib/profile';

describe('profile data boundary', () => {
  it('normalizes GPS coordinates before they can enter a raw query', () => {
    expect(
      locationToQuery({
        label: '現在地付近',
        source: 'gps',
        latitude: 35.7295,
        longitude: 139.7109,
      })
    ).toBe('場所: 現在地付近');
  });

  it('does not serialize allergy or health-goal values into the query', () => {
    const query = tasteProfileToQuery({
      likes: ['肉'],
      avoid: ['混雑'],
      allergies: '甲殻類',
      healthGoal: 'high_protein',
    });

    expect(query).toContain('好き: 肉');
    expect(query).toContain('避けたい: 混雑');
    expect(query).not.toContain('甲殻類');
    expect(query).not.toContain('高たんぱく');
  });
});
