import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockInvestigation } from '@/data/mock';
import {
  addInvestigationRequirement,
  createInvestigation,
  getInvestigation,
  getInvestigationEvents,
  getInvestigationPreviewByShareToken,
  getOwnPlaceFeedback,
  getPlaceFeedbackSummary,
  joinInvestigation,
  removeRequirement,
  rerankInvestigation,
  runInvestigation,
  savePlaceFeedback,
  subscribeInvestigation,
} from '@/lib/api';
import { setNextMockFaultForTests } from '@/lib/providers/mock';
import type { Investigation } from '@/types';

const STEP_MS = 800;
const COMPLETE_AFTER_MS = STEP_MS * 5;
const TEST_IDEMPOTENCY_KEY = 'test-idempotency-key';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('mock investigation flow', () => {
  it('does not mutate the imported seed when assigning the mock share token', () => {
    expect(mockInvestigation.shareToken).toBe('share-token-mock-001');
    expect(getInvestigation('inv-001')?.shareToken).toBe(
      '0123456789abcdef0123456789abcdef'
    );
  });

  it('emits one complete snapshot with all candidates already present', async () => {
    const { investigationId } = await createInvestigation({
      query: '池袋で3人。肉。',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });
    const events: Investigation[] = [];
    const unsubscribe = subscribeInvestigation(investigationId, (next) => {
      events.push(next);
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    unsubscribe();

    const completeEvents = events.filter((event) => event.status === 'complete');
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].candidates).toHaveLength(3);
  });

  it('ignores a second run while the first mock run is active', async () => {
    const { investigationId } = await createInvestigation({
      query: '新宿で2人',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });
    const events: Investigation[] = [];
    const unsubscribe = subscribeInvestigation(investigationId, (next) => {
      events.push(next);
    });

    await runInvestigation({ investigationId });
    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    unsubscribe();

    expect(events.filter((event) => event.status === 'complete')).toHaveLength(1);
  });

  it('fails once without candidates and completes after an explicit retry', async () => {
    setNextMockFaultForTests('fail-once');
    const { investigationId } = await createInvestigation({
      query: '池袋で一時障害から復旧する調査',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(getInvestigation(investigationId)).toMatchObject({
      status: 'failed',
      candidates: [],
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    expect(getInvestigation(investigationId)).toMatchObject({
      status: 'complete',
    });
    expect(getInvestigation(investigationId)?.candidates).toHaveLength(3);
  });

  it('fails creation once and allows the same request to succeed on retry', async () => {
    const request = {
      query: '作成失敗から再試行する調査',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    };
    setNextMockFaultForTests('create-fail-once');

    await expect(createInvestigation(request)).rejects.toThrow('Synthetic mock create failure');
    await expect(createInvestigation(request)).resolves.toMatchObject({
      investigationId: expect.any(String),
      shareToken: expect.any(String),
    });
  });

  it('returns a nonterminal status at run acceptance before the mock pipeline completes', async () => {
    const { investigationId } = await createInvestigation({
      query: '受付と実行を分離する調査',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    const response = await runInvestigation({ investigationId });
    expect(response.status).toBe('recalling');
    expect(getInvestigation(investigationId)?.status).toBe('recalling');

    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    expect(getInvestigation(investigationId)?.status).toBe('complete');
  });

  it('terminates a deterministic zero-candidate result as failed', async () => {
    setNextMockFaultForTests('zero-candidates');
    const { investigationId } = await createInvestigation({
      query: '候補が見つからない条件',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    expect(getInvestigation(investigationId)).toMatchObject({
      status: 'failed',
      candidates: [],
    });
    const eventsBeforeRetry = await getInvestigationEvents(investigationId);
    expect(eventsBeforeRetry.filter((event) => event.eventType === 'no_candidates')).toHaveLength(1);
    expect(eventsBeforeRetry.filter((event) => event.eventType === 'investigation_failed')).toHaveLength(1);
    await expect(runInvestigation({ investigationId })).resolves.toMatchObject({ status: 'recalling' });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    const eventsAfterRetry = await getInvestigationEvents(investigationId);
    expect(eventsAfterRetry.filter((event) => event.eventType === 'no_candidates')).toHaveLength(1);
    expect(eventsAfterRetry.filter((event) => event.eventType === 'investigation_failed')).toHaveLength(1);
    expect(getInvestigation(investigationId)).toMatchObject({
      status: 'complete',
      candidates: expect.any(Array),
    });
    expect(getInvestigation(investigationId)?.candidates).toHaveLength(3);
  });

  it('keeps run-scoped terminal event keys distinct across explicit zero-candidate retries', async () => {
    setNextMockFaultForTests('zero-candidates');
    const { investigationId } = await createInvestigation({
      query: '候補0件のrun単位イベント検証',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    setNextMockFaultForTests('zero-candidates');
    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);

    const events = await getInvestigationEvents(investigationId);
    const noCandidateRunIds = events
      .filter((event) => event.eventType === 'no_candidates')
      .map((event) => event.metadata?.['run_id']);
    expect(noCandidateRunIds).toHaveLength(2);
    expect(new Set(noCandidateRunIds).size).toBe(2);
    expect(noCandidateRunIds.every((runId) => typeof runId === 'string')).toBe(true);
  });

  it('current_location without GPS anchor stops with a dedicated draft reason', async () => {
    const { investigationId } = await createInvestigation({
      query: '現在地付近で寿司',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await expect(runInvestigation({ investigationId })).resolves.toEqual({
      status: 'draft',
      reason: 'location_anchor_required',
      message: '現在地を検索に使用できませんでした。駅名・地名を入力してください。',
    });
    await expect(runInvestigation({ investigationId })).resolves.toMatchObject({
      status: 'draft',
      reason: 'location_anchor_required',
    });

    expect(getInvestigation(investigationId)).toMatchObject({
      status: 'draft',
      candidates: [],
    });
    const events = await getInvestigationEvents(investigationId);
    expect(events.filter((event) => event.eventType === 'location_anchor_required')).toHaveLength(1);
    expect(events.some((event) => event.eventType === 'no_candidates')).toBe(false);
    expect(events.some((event) => event.eventType === 'step_failed')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('35.7295');
    expect(JSON.stringify(events)).not.toContain('139.7109');
  });

  it('current_location with a valid GPS anchor keeps the mock run path', async () => {
    const { investigationId } = await createInvestigation({
      query: '現在地付近で焼肉',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await expect(runInvestigation({
      investigationId,
      searchAnchor: { lat: 35.7295, lng: 139.7109 },
    })).resolves.toMatchObject({ status: 'recalling' });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);

    expect(getInvestigation(investigationId)?.status).toBe('complete');
    const events = await getInvestigationEvents(investigationId);
    expect(events.some((event) => event.eventType === 'location_anchor_required')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('35.7295');
    expect(JSON.stringify(events)).not.toContain('139.7109');
  });
});

describe('mock investigation events (#332)', () => {
  it('records parse_completed and the step_started chain across a full run', async () => {
    const { investigationId } = await createInvestigation({
      query: '池袋で3人。肉。',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    expect((await getInvestigationEvents(investigationId)).map((e) => e.eventType)).toEqual([
      'parse_completed',
    ]);

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);

    const events = await getInvestigationEvents(investigationId);
    // created_at 昇順（記録順）。step は backend run-investigation と同じ並び。
    // recalling 直後に recall_preference（issue #105 / #111）が追記される。
    expect(
      events.map((e) => (e.metadata?.['step'] as string | undefined) ?? e.eventType)
    ).toEqual([
      'parse_completed',
      'recalling',
      'recall_preference',
      'searching',
      'collecting_evidence',
      'evaluating',
      'ranking',
      'search_completed',
      'complete',
    ]);
    expect(events.at(-1)?.message).toBe('調査が完了しました');
    expect(events.find((e) => e.eventType === 'search_completed')?.message).toBe(
      '候補を 3 件見つけました'
    );
  });

  it('records step_failed with a user-readable reason in metadata.message on fail-once', async () => {
    setNextMockFaultForTests('fail-once');
    const { investigationId } = await createInvestigation({
      query: '一時障害の調査ログ',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);

    const failure = (await getInvestigationEvents(investigationId)).find(
      (e) => e.eventType === 'step_failed'
    );
    expect(failure?.message).toBe('ステップ collecting_evidence が失敗しました');
    expect(failure?.metadata?.['message']).toBe('Synthetic mock failure (fail-once)');
  });

  it('records no_candidates when a run terminates with zero candidates', async () => {
    setNextMockFaultForTests('zero-candidates');
    const { investigationId } = await createInvestigation({
      query: '候補が見つからない調査ログ',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);

    const events = await getInvestigationEvents(investigationId);
    expect(
      events.some(
        (e) => e.eventType === 'no_candidates' && e.message === '条件を少し緩めてください'
      )
    ).toBe(true);
    expect(events.some((e) => e.eventType === 'search_completed')).toBe(false);
  });

  it('keeps a separate no_candidates event for an explicit retry that also finds zero candidates', async () => {
    setNextMockFaultForTests('zero-candidates');
    const { investigationId } = await createInvestigation({
      query: '候補0件を再試行する調査ログ',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);
    setNextMockFaultForTests('zero-candidates');
    await expect(runInvestigation({ investigationId })).resolves.toMatchObject({ status: 'recalling' });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);

    const events = await getInvestigationEvents(investigationId);
    expect(events.filter((event) => event.eventType === 'no_candidates')).toHaveLength(2);
    expect(events.filter((event) => event.eventType === 'investigation_failed')).toHaveLength(2);
    expect(getInvestigation(investigationId)).toMatchObject({ status: 'failed', candidates: [] });
  });

  it('serves seeded events for inv-001 as defensive copies', async () => {
    const first = await getInvestigationEvents('inv-001');
    expect(first.length).toBeGreaterThan(0);
    expect(first[0].eventType).toBe('parse_completed');

    first[0].eventType = '書き換え';
    const second = await getInvestigationEvents('inv-001');
    expect(second[0].eventType).toBe('parse_completed');
  });
});

describe('mock collaboration', () => {
  it('notifies subscribers when a participant joins', async () => {
    const { investigationId, shareToken } = await createInvestigation({
      query: '池袋で3人',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });
    const events: Investigation[] = [];
    const unsubscribe = subscribeInvestigation(investigationId, (next) => {
      events.push(next);
    });

    await joinInvestigation({ shareToken, displayName: '参加者' });
    unsubscribe();

    expect(events).toHaveLength(2);
    expect(events.at(-1)?.members.map((member) => member.displayName)).toEqual([
      '幹事',
      '参加者',
    ]);
  });

  it('is idempotent for the same identity and permits distinct explicit identities', async () => {
    const { investigationId, shareToken } = await createInvestigation({
      query: '池袋で3人',
      displayName: '同名',
      userId: 'owner-1',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'owner-1',
    });

    await joinInvestigation({ shareToken, displayName: '同名', userId: 'guest-1' });
    await joinInvestigation({ shareToken, displayName: '同名', userId: 'guest-1' });
    await joinInvestigation({ shareToken, displayName: '同名', userId: 'guest-2' });

    expect(getInvestigation(investigationId)?.members).toHaveLength(3);
  });

  it('does not throw when the initial snapshot listener throws', async () => {
    const { investigationId } = await createInvestigation({
      query: '池袋で3人',
      displayName: '幹事',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'test-auth-subject',
    });

    expect(() =>
      subscribeInvestigation(investigationId, () => {
        throw new Error('listener error');
      })
    ).not.toThrow();
  });

  it('creates unique requirement ids even when the clock does not advance', async () => {
    const { investigationId } = await createInvestigation({
      query: '池袋で3人',
      displayName: '幹事',
      userId: 'owner-1',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'owner-1',
    });

    const now = vi.spyOn(Date, 'now').mockReturnValue(123);
    expect(addInvestigationRequirement(investigationId, '個室', 'owner-1')).toBe(true);
    expect(addInvestigationRequirement(investigationId, '禁煙', 'owner-1')).toBe(true);
    now.mockRestore();

    const requirements = getInvestigation(investigationId)?.requirements ?? [];
    const added = requirements.slice(-2);
    expect(added[0].id).not.toBe(added[1].id);
  });

  it('allows only editors to remove a requirement and drops its candidate evaluations', async () => {
    const { investigationId } = await createInvestigation({
      query: '池袋で3人',
      displayName: '幹事',
      userId: 'owner-1',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'owner-1',
    });
    await runInvestigation({ investigationId });
    await vi.advanceTimersByTimeAsync(COMPLETE_AFTER_MS);

    await expect(
      removeRequirement(investigationId, 'r-1', 'guest-1')
    ).rejects.toThrow('条件を削除する権限がありません');
    expect(getInvestigation(investigationId)?.requirements.some(({ id }) => id === 'r-1')).toBe(
      true
    );

    await removeRequirement(investigationId, 'r-1', 'owner-1');
    const investigation = getInvestigation(investigationId);
    expect(investigation?.requirements.some(({ id }) => id === 'r-1')).toBe(false);
    expect(
      investigation?.candidates.every((candidate) =>
        candidate.evaluations.every(({ requirementId }) => requirementId !== 'r-1')
      )
    ).toBe(true);
  });

  it('assigns the same owner/editor roles as live and validates a non-complete rerank response', async () => {
    const { investigationId, shareToken } = await createInvestigation({
      query: '池袋で3人',
      displayName: '幹事',
      userId: 'owner-1',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'owner-1',
    });

    await joinInvestigation({ shareToken, displayName: '参加者', userId: 'guest-1' });
    const members = getInvestigation(investigationId)?.members ?? [];
    expect(members.map((member) => member.role)).toEqual(['owner', 'editor']);
    expect(addInvestigationRequirement(investigationId, '編集者限定', 'guest-1')).toBe(true);
    expect(await rerankInvestigation({ investigationId, trigger: 'vote' })).toEqual({
      reranked: false,
    });
  });
});

describe('share preview (issue #335 / spec.md §33)', () => {
  it('returns only the minimal safe fields for the seeded share token', async () => {
    const preview = await getInvestigationPreviewByShareToken(
      '0123456789abcdef0123456789abcdef'
    );

    expect(preview).toEqual({
      title: '8/23 池袋 夜飯',
      status: 'complete',
      memberCount: 3,
    });
    // 粒度契約: candidates / requirements / rawQuery / shareToken / members を含まない
    expect(Object.keys(preview ?? {}).sort()).toEqual(['memberCount', 'status', 'title']);
  });

  it('returns undefined for an unknown share token without error details', async () => {
    await expect(
      getInvestigationPreviewByShareToken('ffffffffffffffffffffffffffffffff')
    ).resolves.toBeUndefined();
  });

  it('reflects joins in memberCount only, not member identities', async () => {
    const { shareToken } = await createInvestigation({
      query: '池袋で3人',
      displayName: '幹事',
      userId: 'owner-1',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      authSubject: 'owner-1',
    });

    await joinInvestigation({ shareToken, displayName: '参加者', userId: 'guest-1' });
    const preview = await getInvestigationPreviewByShareToken(shareToken);
    expect(preview?.memberCount).toBe(2);
    expect(JSON.stringify(preview)).not.toContain('参加者');
  });
});

describe('place feedback facade (#110)', () => {
  it('saves and reads only the current mock user row, while hiding sub-threshold summaries', async () => {
    const saved = await savePlaceFeedback('feedback-place-110', {
      visitedAt: '2026-08-24',
      rating: 1,
      aspect: 'noise',
      aspectValue: 'quiet',
    });

    expect(saved).toMatchObject({
      placeId: 'feedback-place-110',
      visitedAt: '2026-08-24',
      rating: 1,
      aspect: 'noise',
      aspectValue: 'quiet',
    });
    expect(saved).not.toHaveProperty('userId');
    await expect(getOwnPlaceFeedback('feedback-place-110')).resolves.toMatchObject({
      id: saved.id,
      placeId: 'feedback-place-110',
    });

    await expect(getPlaceFeedbackSummary(['feedback-place-110'])).resolves.toEqual([{
      placeId: 'feedback-place-110',
      visitedCount: 0,
      ratingCount: 0,
      ratingAverage: null,
      aspects: [],
    }]);
  });

  it('updates the existing own row instead of creating a second UI-visible row', async () => {
    const first = await savePlaceFeedback('feedback-place-110-edit', {
      visitedAt: '2026-08-23',
      rating: -1,
    });
    const second = await savePlaceFeedback(
      'feedback-place-110-edit',
      { visitedAt: '2026-08-24', rating: 0 },
      first.id,
    );

    expect(second.id).toBe(first.id);
    await expect(getOwnPlaceFeedback('feedback-place-110-edit')).resolves.toMatchObject({
      id: first.id,
      visitedAt: '2026-08-24',
      rating: 0,
    });
  });
});
