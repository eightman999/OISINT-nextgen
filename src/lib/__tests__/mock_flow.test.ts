import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockInvestigation } from '@/data/mock';
import {
  addInvestigationRequirement,
  createInvestigation,
  getInvestigation,
  joinInvestigation,
  rerankInvestigation,
  runInvestigation,
  setVote,
  subscribeInvestigation,
} from '@/lib/api';
import type { Investigation } from '@/types';

const STEP_MS = 800;
const COMPLETE_AFTER_MS = STEP_MS * 5;

// #147-7: モジュールレベルの fixture がプロバイダ操作で変異しないことを
// import 直後のスナップショットと deep-compare して検証する。
const FIXTURE_SNAPSHOT_AT_IMPORT = JSON.stringify(mockInvestigation);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function createCompletedInvestigation(): Promise<string> {
  const { investigationId } = await createInvestigation({
    query: '池袋で3人。肉。',
    displayName: '幹事',
    userId: 'owner-1',
    idempotencyKey: 'mock-flow-key',
    authSubject: 'owner-1',
  });
  await runInvestigation({ investigationId });
  await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
  return investigationId;
}

describe('mock provider full flow (create → run → vote → rerank)', () => {
  it('re-sorts candidates by vote sum on rerank(trigger=vote)', async () => {
    const investigationId = await createCompletedInvestigation();

    // シード votes: c-1 = +2, c-2 = -1, c-3 = +1。
    // c-3 に 2 票追加して合計 +3 とし、c-1 (+2) を上回らせる。
    await setVote(investigationId, 'c-3', 1, 'owner-1');
    await setVote(investigationId, 'c-3', 1, 'guest-1');

    expect(await rerankInvestigation({ investigationId, trigger: 'vote' })).toEqual({
      reranked: true,
    });

    const candidates = getInvestigation(investigationId)?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.id)).toEqual(['c-3', 'c-1', 'c-2']);
    expect(candidates.map((candidate) => candidate.rank)).toEqual([1, 2, 3]);
  });

  it('keeps the current order on rerank(trigger=requirement_added) and only re-assigns ranks', async () => {
    const investigationId = await createCompletedInvestigation();

    // c-2 の票合計を最大 (+2) にしても、requirement_added トリガーでは並び替えない。
    // 現状仕様のピン留め: computeRerankedCandidates は trigger === 'vote' のときだけ
    // 票合計で再ソートし、requirement 系トリガーは rank の振り直しのみ行う（mock.ts:108-130）。
    await setVote(investigationId, 'c-2', 1, 'owner-1');
    await setVote(investigationId, 'c-2', 1, 'guest-1');
    await setVote(investigationId, 'c-2', 1, 'guest-2');

    expect(addInvestigationRequirement(investigationId, '個室', 'owner-1')).toBe(true);
    expect(
      await rerankInvestigation({ investigationId, trigger: 'requirement_added' })
    ).toEqual({ reranked: true });

    const candidates = getInvestigation(investigationId)?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.id)).toEqual(['c-1', 'c-2', 'c-3']);
    expect(candidates.map((candidate) => candidate.rank)).toEqual([1, 2, 3]);
  });

  it('notifies subscribers with the reranked candidate order', async () => {
    const investigationId = await createCompletedInvestigation();
    await setVote(investigationId, 'c-3', 1, 'owner-1');
    await setVote(investigationId, 'c-3', 1, 'guest-1');

    const events: Investigation[] = [];
    const unsubscribe = subscribeInvestigation(investigationId, (next) => {
      events.push(next);
    });
    await rerankInvestigation({ investigationId, trigger: 'vote' });
    unsubscribe();

    // 初期スナップショット + rerank 通知の 2 回。
    expect(events).toHaveLength(2);
    expect(events.at(-1)?.candidates.map((candidate) => candidate.id)).toEqual([
      'c-3',
      'c-1',
      'c-2',
    ]);
  });

  it('overwrites the same user vote instead of duplicating it', async () => {
    const investigationId = await createCompletedInvestigation();

    await setVote(investigationId, 'c-1', 1, 'owner-1');
    await setVote(investigationId, 'c-1', -1, 'owner-1');

    const candidate = getInvestigation(investigationId)?.candidates.find(
      (item) => item.id === 'c-1'
    );
    expect(candidate?.votes['owner-1']).toBe(-1);
    // シードの 3 票 (u-1, u-2, u-3) + owner-1 の 1 エントリのみ。再投票で増えない。
    expect(Object.keys(candidate?.votes ?? {})).toHaveLength(4);
  });

  it('stores, trims, and clears the optional vote comment for the same vote row', async () => {
    const investigationId = await createCompletedInvestigation();

    await setVote(
      investigationId,
      'c-1',
      1,
      'owner-1',
      '  辛い料理が多そう  ',
    );
    expect(
      getInvestigation(investigationId)?.candidates.find(
        (item) => item.id === 'c-1',
      )?.voteComments,
    ).toEqual({ 'owner-1': '辛い料理が多そう' });

    await setVote(investigationId, 'c-1', 0, 'owner-1', '   ');
    const candidate = getInvestigation(investigationId)?.candidates.find(
      (item) => item.id === 'c-1',
    );
    expect(candidate?.votes['owner-1']).toBe(0);
    expect(candidate?.voteComments).toBeUndefined();
  });

  it('returns defensive copies from getInvestigation', async () => {
    const investigationId = await createCompletedInvestigation();

    const first = getInvestigation(investigationId);
    expect(first).toBeDefined();
    first!.title = '書き換え';
    first!.candidates[0].votes['hacker'] = 1;

    const second = getInvestigation(investigationId);
    expect(second?.title).not.toBe('書き換え');
    expect(second?.candidates[0].votes['hacker']).toBeUndefined();
  });

  it('#147-7: does not mutate the imported mockInvestigation fixture across a full flow', async () => {
    const investigationId = await createCompletedInvestigation();

    const { shareToken } = getInvestigation(investigationId) ?? {};
    expect(shareToken).toBeDefined();
    await joinInvestigation({ shareToken: shareToken!, displayName: '参加者', userId: 'guest-1' });
    await setVote(investigationId, 'c-1', -1, 'owner-1');
    expect(addInvestigationRequirement(investigationId, '禁煙', 'owner-1')).toBe(true);
    await rerankInvestigation({ investigationId, trigger: 'vote' });
    await rerankInvestigation({ investigationId, trigger: 'requirement_added' });

    expect(JSON.stringify(mockInvestigation)).toBe(FIXTURE_SNAPSHOT_AT_IMPORT);
  });
});
