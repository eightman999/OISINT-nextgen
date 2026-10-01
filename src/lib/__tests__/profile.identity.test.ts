import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TASTE_PROFILE,
  loadTasteProfile,
  saveTasteProfile,
  tasteProfileToQuery,
} from '@/lib/profile';

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

afterEach(() => vi.unstubAllGlobals());

describe('taste profile subject boundary', () => {
  it('does not expose A profile to B and allows only same-UUID anonymous linking', () => {
    installLocalStorage();
    const anonymousA = { id: 'anon-a', kind: 'anonymous' as const };
    const permanentA = { id: 'anon-a', kind: 'permanent' as const };
    const permanentB = { id: 'user-b', kind: 'permanent' as const };

    saveTasteProfile(
      { likes: ['Aだけ'], avoid: ['A回避'], allergies: 'Aアレルギー', healthGoal: 'diet' },
      anonymousA,
    );
    expect(loadTasteProfile(permanentB)).toEqual(DEFAULT_TASTE_PROFILE);
    expect(tasteProfileToQuery(loadTasteProfile(permanentB))).toBeNull();
    expect(loadTasteProfile(permanentA)).toMatchObject({
      likes: ['Aだけ'],
      avoid: ['A回避'],
      allergies: 'Aアレルギー',
      healthGoal: 'diet',
    });
  });

  it('discards owner-unknown legacy bytes instead of attributing them to a subject', () => {
    const storage = installLocalStorage();
    storage.setItem(
      'oisint:taste-profile:v1',
      JSON.stringify({ likes: ['legacy'], avoid: [], allergies: 'legacy', healthGoal: 'diet' }),
    );

    expect(loadTasteProfile({ id: 'user-b', kind: 'permanent' })).toEqual(DEFAULT_TASTE_PROFILE);
    expect(storage.getItem('oisint:taste-profile:v1')).toBeNull();
  });
});
