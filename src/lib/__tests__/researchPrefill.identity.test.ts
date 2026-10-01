import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeResearchAgainPrefill,
  RESEARCH_AGAIN_PREFILL_KEY,
  saveResearchAgainPrefill,
} from '@/lib/researchPrefill';

function installSessionStorage() {
  const values = new Map<string, string>();
  const sessionStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
  vi.stubGlobal('window', { sessionStorage });
  return sessionStorage;
}

afterEach(() => vi.unstubAllGlobals());

describe('research-again prefill subject boundary', () => {
  it('is one-shot and cannot be consumed by another subject', () => {
    const storage = installSessionStorage();
    saveResearchAgainPrefill('Aの個人入力', { id: 'user-a', kind: 'permanent' });

    expect(consumeResearchAgainPrefill({ id: 'user-b', kind: 'permanent' })).toBe('');
    expect(storage.getItem(RESEARCH_AGAIN_PREFILL_KEY)).toBeNull();
    expect(consumeResearchAgainPrefill({ id: 'user-a', kind: 'permanent' })).toBe('');
  });

  it('allows only the same UUID anonymous-to-permanent identity link', () => {
    installSessionStorage();
    saveResearchAgainPrefill('同じ本人の再調査', { id: 'anon-a', kind: 'anonymous' });

    expect(consumeResearchAgainPrefill({ id: 'anon-a', kind: 'permanent' })).toBe('同じ本人の再調査');
  });

  it('rejects malformed, unowned, and oversized envelopes', () => {
    const storage = installSessionStorage();
    storage.setItem(
      RESEARCH_AGAIN_PREFILL_KEY,
      JSON.stringify({ version: 1, subjectId: 'user-a', subjectKind: 'permanent', rawQuery: 'x', oneShot: false }),
    );
    expect(consumeResearchAgainPrefill({ id: 'user-a', kind: 'permanent' })).toBe('');
    storage.setItem(
      RESEARCH_AGAIN_PREFILL_KEY,
      JSON.stringify({ version: 1, subjectId: 'user-a', subjectKind: 'permanent', rawQuery: 'x'.repeat(2001), oneShot: true }),
    );
    expect(consumeResearchAgainPrefill({ id: 'user-a', kind: 'permanent' })).toBe('');
  });
});
