import { mockInvestigation, mockInvestigationEvents } from '@/data/mock';
import { mockPlaceFacts } from '@/data/mockPlaceFacts';
import type {
  CreateInvestigationResponse,
  Investigation,
  InvestigationEvent,
  InvestigationListener,
  InvestigationPreview,
  InvestigationStatus,
  JoinInvestigationResponse,
  PlaceFeedback,
  PlaceFeedbackAspect,
  PlaceFeedbackSummary,
  PublicInvestigation,
  RerankInvestigationResponse,
  RerankTrigger,
  RunInvestigationResponse,
  VoteValue,
} from '@/types';
import {
  LOCATION_ANCHOR_REQUIRED_MESSAGE,
  LOCATION_ANCHOR_REQUIRED_REASON,
} from '@/lib/validation';
import {
  isCanonicalPlaceFeedbackValue,
  normalizePlaceFeedbackInput,
  sanitizePlaceFeedbackSummary,
} from '@/lib/placeFeedback';
import { getOrCreateMockUserId } from '@/lib/mockIdentity';

import type { DataProvider } from './types';

const investigations = new Map<string, Investigation>();
const investigationEvents = new Map<string, InvestigationEvent[]>();
const listeners = new Map<string, Set<InvestigationListener>>();
type StoredPlaceFeedback = PlaceFeedback & { userId: string };
const placeFeedback = new Map<string, StoredPlaceFeedback[]>();
const activeRuns = new Map<string, ReturnType<typeof setInterval>>();
type MockFaultMode = 'create-fail-once' | 'fail-once' | 'zero-candidates';
const faultModes = new Map<string, MockFaultMode>();
const failedOnce = new Set<string>();
let nextFaultModeForTests: MockFaultMode | null = null;
const E2E_FAULT_STORAGE_KEY = 'oisint:e2e-mock-fault:v1';
const mockUserId = getOrCreateMockUserId();

function isCurrentLocationQuery(query: string): boolean {
  return /(?:^|[\s:/、。,.!?！？「」『』()（）])(?:現在地|現在位置|現在地点|今いる場所|いまいる場所|ここ)(?:付近|周辺|近辺|辺り|あたり|近く|そば|エリア)?(?=$|[\s/、。,.!?！？のではにへから])/u.test(
    query.normalize('NFKC')
  );
}

function hasValidSearchAnchor(anchor: unknown): anchor is { lat: number; lng: number } {
  if (!anchor || typeof anchor !== 'object') return false;
  const value = anchor as { lat?: unknown; lng?: unknown };
  return typeof value.lat === 'number' && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && typeof value.lng === 'number' && Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function memberIdentity(request: { displayName: string; userId?: string }): string {
  return request.userId?.trim() || `display-name:${request.displayName.trim()}`;
}

function notify(investigation: Investigation) {
  const subscribed = listeners.get(investigation.id);
  if (!subscribed) return;
  const next = clone(investigation);
  subscribed.forEach((listener) => {
    try {
      listener(next);
    } catch {
      // A listener must not break the provider or the initial subscription.
    }
  });
}

function updateStatus(id: string, status: InvestigationStatus) {
  const investigation = investigations.get(id);
  if (!investigation) return;
  investigation.status = status;
  investigation.updatedAt = new Date().toISOString();
  notify(investigation);
}

// investigation_events 相当のダミーイベント記録（issue #332）。
// 追記は既存の notify（status 更新）と同じタイミングで行い、画面の再取得経路に乗せる。
function appendEvent(
  investigationId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {}
) {
  const events = investigationEvents.get(investigationId) ?? [];
  events.push({
    id: generateUuid(),
    investigationId,
    eventType,
    message,
    metadata,
    createdAt: new Date().toISOString(),
  });
  investigationEvents.set(investigationId, events);
}

// backend run-investigation の step_started message と同文（run-investigation/index.ts:188-194）
const stepMessages: Partial<Record<InvestigationStatus, string>> = {
  recalling: '過去の類似調査を確認しています',
  searching: '候補店を探索しています',
  collecting_evidence: '根拠を収集しています',
  evaluating: '条件を評価しています',
  ranking: 'ランキングを計算しています',
};

function simulateRun(id: string) {
  if (activeRuns.has(id)) return;

  const investigation = investigations.get(id);
  if (!investigation || investigation.status === 'complete') return;
  // DB の investigation_runs.id と同じく、明示的な再実行ごとに非PIIの
  // run keyを発行する。terminal eventのdedupe単位には調査全体でなくこの値を使う。
  const runId = generateUuid();

  const steps: InvestigationStatus[] = [
    'recalling',
    'searching',
    'collecting_evidence',
    'evaluating',
    'ranking',
    'complete',
  ];
  let index = 0;
  appendEvent(id, 'step_started', stepMessages[steps[index]] ?? '', { step: steps[index] });
  appendEvent(id, 'recall_preference', '過去の類似調査で高評価だった店が 1 件あります', {
    places: [{ placeId: 'p-a', name: '店A', avgVote: 1, similarity: 0.61, lastAt: '2026-08-14T10:00:00Z' }],
    kinds: [{ kind: 'quiet', priority: 'must', count: 2 }],
  });
  updateStatus(id, steps[index]);

  const interval = setInterval(() => {
    index += 1;
    if (index >= steps.length) {
      clearInterval(interval);
      activeRuns.delete(id);
      return;
    }

    const current = investigations.get(id);
    if (!current) {
      clearInterval(interval);
      activeRuns.delete(id);
      return;
    }

    const faultMode = faultModes.get(id);
    if (
      faultMode === 'fail-once'
      && !failedOnce.has(id)
      && steps[index] === 'collecting_evidence'
    ) {
      appendEvent(id, 'step_failed', 'ステップ collecting_evidence が失敗しました', {
        step: 'collecting_evidence',
        message: 'Synthetic mock failure (fail-once)',
      });
      current.status = 'failed';
      current.updatedAt = new Date().toISOString();
      failedOnce.add(id);
      clearInterval(interval);
      activeRuns.delete(id);
      notify(current);
      return;
    }

    if (steps[index] === 'complete') {
      current.candidates = faultMode === 'zero-candidates'
        ? []
        : clone(mockInvestigation.candidates).map((candidate, candidateIndex) => ({
            ...candidate,
            investigationId: id,
            rank: candidateIndex + 1,
          }));
      if (faultMode === 'zero-candidates') {
        appendEvent(id, 'no_candidates', '条件を少し緩めてください', { run_id: runId });
        appendEvent(id, 'investigation_failed', '候補が 0 件のため調査を停止しました', {
          step: 'searching',
          code: 'no_candidates',
          run_id: runId,
        });
      } else {
        appendEvent(id, 'search_completed', `候補を ${current.candidates.length} 件見つけました`, {
          count: current.candidates.length,
        });
        appendEvent(id, 'step_started', '調査が完了しました', { step: 'complete', run_id: runId });
      }
      current.status = faultMode === 'zero-candidates' ? 'failed' : 'complete';
      current.updatedAt = new Date().toISOString();
      clearInterval(interval);
      activeRuns.delete(id);
      faultModes.delete(id);
      failedOnce.delete(id);
      notify(current);
      return;
    }

    appendEvent(id, 'step_started', stepMessages[steps[index]] ?? '', { step: steps[index] });
    updateStatus(id, steps[index]);
  }, 800);

  activeRuns.set(id, interval);
}

function computeRerankedCandidates(
  investigation: Investigation,
  trigger: RerankTrigger
): Investigation['candidates'] {
  const candidates = clone(investigation.candidates);
  if (trigger === 'vote') {
    candidates.sort((left, right) => {
      const leftScore = (Object.values(left.votes) as number[]).reduce(
        (sum, value) => sum + value,
        0
      );
      const rightScore = (Object.values(right.votes) as number[]).reduce(
        (sum, value) => sum + value,
        0
      );
      return rightScore - leftScore;
    });
  }
  candidates.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  return candidates;
}

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

const seed = clone({
  ...mockInvestigation,
  shareToken: '0123456789abcdef0123456789abcdef',
});
investigations.set(seed.id, seed);
investigationEvents.set(seed.id, clone(mockInvestigationEvents));

export const mockProvider: DataProvider = {
  async createInvestigation(request): Promise<CreateInvestigationResponse> {
    const investigationId = generateUuid();
    const faultMode = consumeFaultMode();
    if (faultMode === 'create-fail-once') {
      throw new Error('Synthetic mock create failure');
    }
    if (faultMode) faultModes.set(investigationId, faultMode);
    const shareToken = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
    const now = new Date().toISOString();
    const investigation: Investigation = {
      id: investigationId,
      title: request.query.slice(0, 30) || '新しい調査',
      status: 'recalling',
      rawQuery: request.query,
      requirements: clone(mockInvestigation.requirements),
      candidates: [],
      members: [
        {
          id: memberIdentity(request),
          displayName: request.displayName,
          isOnline: true,
          role: 'owner',
        },
      ],
      shareToken,
      createdAt: now,
      updatedAt: now,
    };
    investigations.set(investigationId, investigation);
    // backend create-investigation の parse_completed 相当（create-investigation/index.ts:152）
    appendEvent(investigationId, 'parse_completed', '条件を整理しました', {
      requirementCount: investigation.requirements.length,
      ...(isCurrentLocationQuery(request.query)
        ? { locationScope: { type: 'current_location' } }
        : {}),
    });
    notify(investigation);
    return { investigationId, shareToken };
  },

  async runInvestigation(request): Promise<RunInvestigationResponse> {
    const investigation = investigations.get(request.investigationId);
    if (!investigation) throw new Error('調査が見つかりません');

    // 明示的な再実行でテスト用 fault を再注入できるようにする。初回作成時に
    // 既に fault が紐付いている場合は、同じrunの途中で上書きしない。
    if (!faultModes.has(request.investigationId)) {
      const retryFault = consumeFaultMode();
      if (retryFault && retryFault !== 'create-fail-once') {
        faultModes.set(request.investigationId, retryFault);
      }
    }

    const existingEvents = investigationEvents.get(request.investigationId) ?? [];
    const currentLocationRequested = existingEvents
      .some((event) => event.eventType === 'parse_completed' &&
        (event.metadata?.locationScope as { type?: unknown } | undefined)?.type === 'current_location');
    if (currentLocationRequested && !hasValidSearchAnchor(request.searchAnchor)) {
      updateStatus(request.investigationId, 'draft');
      if (!existingEvents.some((event) => event.eventType === LOCATION_ANCHOR_REQUIRED_REASON)) {
        appendEvent(
          request.investigationId,
          LOCATION_ANCHOR_REQUIRED_REASON,
          LOCATION_ANCHOR_REQUIRED_MESSAGE,
          { reason: LOCATION_ANCHOR_REQUIRED_REASON },
        );
      }
      return {
        status: 'draft',
        reason: LOCATION_ANCHOR_REQUIRED_REASON,
        message: LOCATION_ANCHOR_REQUIRED_MESSAGE,
      };
    }
    simulateRun(request.investigationId);
    return { status: investigation.status };
  },

  async rerankInvestigation(request): Promise<RerankInvestigationResponse> {
    const investigation = investigations.get(request.investigationId);
    if (!investigation) throw new Error('調査が見つかりません');
    if (investigation.status !== 'complete') return { reranked: false };
    investigation.candidates = computeRerankedCandidates(investigation, request.trigger);
    investigation.updatedAt = new Date().toISOString();
    notify(investigation);
    return { reranked: true };
  },

  async joinInvestigation(request): Promise<JoinInvestigationResponse> {
    const investigation = Array.from(investigations.values()).find(
      (candidate) => candidate.shareToken === request.shareToken
    );
    if (!investigation) throw new Error('調査が見つかりません');

    const memberId = memberIdentity(request);
    if (!investigation.members.some((member) => member.id === memberId)) {
      if (investigation.members.length >= 20) throw new Error('参加人数の上限に達しています');
      investigation.members.push({
        id: memberId,
        displayName: request.displayName,
        isOnline: true,
        // live join RPCはeditorを付与する。mockでも同じ権限契約を返す。
        role: 'editor',
      });
      investigation.updatedAt = new Date().toISOString();
      notify(investigation);
    }

    return { investigationId: investigation.id, title: investigation.title };
  },

  async getInvestigation(id): Promise<Investigation | undefined> {
    return getInvestigationSync(id);
  },

  async getInvestigationPreviewByShareToken(
    shareToken: string
  ): Promise<InvestigationPreview | undefined> {
    // live の get_investigation_preview RPC と同じ最小粒度（§33 / issue #335）。
    // candidates / requirements / votes / メンバー個人情報は返さない。
    const investigation = Array.from(investigations.values()).find(
      (candidate) => candidate.shareToken === shareToken
    );
    if (!investigation) return undefined;
    return {
      title: investigation.title,
      status: investigation.status,
      memberCount: investigation.members.length,
    };
  },

  async getInvestigationEvents(investigationId): Promise<InvestigationEvent[]> {
    // live と同じ契約: created_at 昇順の防御的コピーを返す
    return clone(investigationEvents.get(investigationId) ?? []);
  },

  subscribeInvestigation(investigationId, listener): () => void {
    if (!listeners.has(investigationId)) listeners.set(investigationId, new Set());
    listeners.get(investigationId)!.add(listener);
    const investigation = getInvestigationSync(investigationId);
    if (investigation) {
      try {
        listener(investigation);
      } catch {
        // Keep subscription creation successful when a screen listener throws.
      }
    }
    return () => listeners.get(investigationId)?.delete(listener);
  },

  async getPlaceFacts(placeId) {
    // ダミーデータ（src/data/mockPlaceFacts.ts）。未知の place は空配列＝Evidence 表示へフォールバック
    return clone(mockPlaceFacts[placeId] ?? []);
  },

  async getOwnPlaceFeedback(placeId): Promise<PlaceFeedback | undefined> {
    const rows = placeFeedback.get(placeId) ?? [];
    const own = rows
      .filter((row) => row.userId === mockUserId)
      .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))[0];
    if (!own) return undefined;
    const { userId: _userId, ...safe } = clone(own);
    return safe;
  },

  async getPlaceFeedbackSummary(placeIds): Promise<PlaceFeedbackSummary[]> {
    return placeIds.flatMap((placeId) => {
      const rows = placeFeedback.get(placeId) ?? [];
      const visitedCount = new Set(rows.filter((row) => row.visitedAt).map((row) => row.userId)).size;
      const ratings = rows.filter((row) => row.rating !== undefined);
      const aspectCounts = new Map<string, number>();
      rows.forEach((row) => {
        if (row.aspect && row.aspectValue && isCanonicalPlaceFeedbackValue(row.aspect, row.aspectValue)) {
          const key = `${row.aspect}\u0000${row.aspectValue}`;
          aspectCounts.set(key, (aspectCounts.get(key) ?? 0) + 1);
        }
      });
      const aspects = [...aspectCounts.entries()].map(([key, count]) => {
        const [aspect, aspectValue] = key.split('\u0000');
        return { aspect: aspect as PlaceFeedbackAspect, aspectValue, count };
      });
      return [sanitizePlaceFeedbackSummary({
        placeId,
        visitedCount,
        ratingCount: ratings.length,
        ratingAverage: ratings.length
          ? ratings.reduce((sum, row) => sum + (row.rating ?? 0), 0) / ratings.length
          : null,
        aspects,
      })];
    });
  },

  async submitPlaceFeedback(placeId, input): Promise<PlaceFeedback> {
    const normalized = normalizePlaceFeedbackInput(input);
    const now = new Date().toISOString();
    const saved: StoredPlaceFeedback = {
      id: generateUuid(),
      placeId,
      userId: mockUserId,
      createdAt: now,
      ...normalized,
    };
    placeFeedback.set(placeId, [...(placeFeedback.get(placeId) ?? []), saved]);
    const { userId: _userId, ...safe } = clone(saved);
    return safe;
  },

  async updatePlaceFeedback(placeId, feedbackId, input): Promise<PlaceFeedback> {
    const normalized = normalizePlaceFeedbackInput(input);
    const rows = placeFeedback.get(placeId) ?? [];
    const index = rows.findIndex((row) => row.id === feedbackId && row.userId === mockUserId);
    if (index >= 0) {
      const updated = { ...rows[index], ...normalized };
      const nextRows = [...rows];
      nextRows[index] = updated;
      placeFeedback.set(placeId, nextRows);
      const { userId: _userId, ...safe } = clone(updated);
      return safe;
    }
    throw new Error('来店記録が見つかりません');
  },

  async getPublicInvestigation(id): Promise<PublicInvestigation | undefined> {
    // live の get_public_investigation RPC 相当（issue #115 / §33）。
    // visibility='public' でなければ undefined。requirements 文面・votes・members は返さない。
    const investigation = investigations.get(id);
    if (!investigation || investigation.visibility !== 'public') return undefined;
    return {
      id: investigation.id,
      title: investigation.title,
      status: investigation.status,
      createdAt: investigation.createdAt,
      candidates: clone(
        investigation.candidates
          .map((candidate) => ({
            id: candidate.id,
            place: candidate.place,
            score: candidate.score,
            rank: candidate.rank,
            evaluations: candidate.evaluations.map((evaluation, index) => ({
              index: index + 1,
              state: evaluation.state,
              explanation: evaluation.explanation,
            })),
            evidence: candidate.evidence,
            contradictions: candidate.contradictions,
            pros: candidate.pros,
          }))
          .sort((a, b) => a.rank - b.rank)
      ),
    };
  },

  async setInvestigationVisibility(investigationId, visibility) {
    // owner のみ（live は RPC set_investigation_visibility が同じ判定）
    const investigation = investigations.get(investigationId);
    const member = investigation?.members.find((candidate) => candidate.id === mockUserId);
    if (!investigation || member?.role !== 'owner') {
      throw new Error('公開設定を変更する権限がありません');
    }
    investigation.visibility = visibility;
    investigation.updatedAt = new Date().toISOString();
    notify(investigation);
    return visibility;
  },

  async setVote(investigationId, candidateId, value, comment): Promise<void> {
    setVoteForUser(
      investigationId,
      candidateId,
      mockUserId,
      value,
      comment,
    );
  },

  async addRequirement(investigationId, text): Promise<void> {
    if (!addRequirementForUser(investigationId, text, mockUserId)) {
      throw new Error('条件を追加する権限がありません');
    }
  },

  async removeRequirement(investigationId, requirementId): Promise<void> {
    if (!removeRequirementForUser(investigationId, requirementId, mockUserId)) {
      throw new Error('条件を削除する権限がありません');
    }
  },

  async rotateShareToken(investigationId): Promise<string> {
    const newToken = rotateShareTokenForUser(investigationId, mockUserId);
    if (!newToken) {
      throw new Error('共有リンクを再発行する権限がありません');
    }
    return newToken;
  },

  async getUserId(): Promise<string> {
    return mockUserId;
  },
};

export function setNextMockFaultForTests(mode: MockFaultMode | null): void {
  nextFaultModeForTests = mode;
}

function consumeFaultMode(): MockFaultMode | null {
  if (nextFaultModeForTests) {
    const mode = nextFaultModeForTests;
    nextFaultModeForTests = null;
    return mode;
  }

  try {
    if (typeof window === 'undefined') return null;
    const mode = window.sessionStorage.getItem(E2E_FAULT_STORAGE_KEY);
    window.sessionStorage.removeItem(E2E_FAULT_STORAGE_KEY);
    return mode === 'create-fail-once' || mode === 'fail-once' || mode === 'zero-candidates'
      ? mode
      : null;
  } catch {
    return null;
  }
}

// Provider entrypoint alias. The Metro/Vitest resolver selects this module only for mock builds.
export const provider = mockProvider;
export const isLiveDataProvider = false;

export function getInvestigationSync(id: string): Investigation | undefined {
  const investigation = investigations.get(id);
  return investigation ? clone(investigation) : undefined;
}

export function getInvestigationByShareTokenSync(shareToken: string): Investigation | undefined {
  const investigation = Array.from(investigations.values()).find(
    (candidate) => candidate.shareToken === shareToken
  );
  return investigation ? clone(investigation) : undefined;
}

export function setVoteForUser(
  investigationId: string,
  candidateId: string,
  userId: string,
  value: VoteValue,
  comment?: string,
): boolean {
  const investigation = investigations.get(investigationId);
  const candidate = investigation?.candidates.find((item) => item.id === candidateId);
  if (!investigation || !candidate) return false;
  candidate.votes[userId] = value;
  const normalizedComment = comment?.trim() ?? '';
  if (normalizedComment) {
    candidate.voteComments = {
      ...(candidate.voteComments ?? {}),
      [userId]: normalizedComment,
    };
  } else if (candidate.voteComments?.[userId] !== undefined) {
    const nextComments = { ...candidate.voteComments };
    delete nextComments[userId];
    candidate.voteComments = Object.keys(nextComments).length > 0
      ? nextComments
      : undefined;
  }
  investigation.updatedAt = new Date().toISOString();
  notify(investigation);
  return true;
}

export function addRequirementForUser(
  investigationId: string,
  text: string,
  userId: string
): boolean {
  const investigation = investigations.get(investigationId);
  if (!investigation) return false;
  const member = investigation.members.find((candidate) => candidate.id === userId);
  if (member?.role !== 'owner' && member?.role !== 'editor') return false;
  investigation.requirements.push({
    id: `req-${generateUuid()}`,
    text,
    normalizedText: text,
    kind: 'other',
    priority: 'should',
    weight: 0.5,
  });
  investigation.updatedAt = new Date().toISOString();
  notify(investigation);
  return true;
}

// share_token の owner 再発行（issue #177）。owner 以外は null（旧 token のまま）。
// 参加済み members には触れない。成功時は新 token を返し、購読リスナーへ通知する。
export function rotateShareTokenForUser(
  investigationId: string,
  userId: string
): string | null {
  const investigation = investigations.get(investigationId);
  if (!investigation) return null;
  const member = investigation.members.find((candidate) => candidate.id === userId);
  if (member?.role !== 'owner') return null;

  const newToken = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  investigation.shareToken = newToken;
  investigation.updatedAt = new Date().toISOString();
  notify(investigation);
  return newToken;
}

export function removeRequirementForUser(
  investigationId: string,
  requirementId: string,
  userId: string
): boolean {
  const investigation = investigations.get(investigationId);
  if (!investigation) return false;
  const member = investigation.members.find((candidate) => candidate.id === userId);
  if (member?.role !== 'owner' && member?.role !== 'editor') return false;
  const requirementIndex = investigation.requirements.findIndex(
    (requirement) => requirement.id === requirementId
  );
  if (requirementIndex < 0) return false;

  investigation.requirements.splice(requirementIndex, 1);
  investigation.candidates.forEach((candidate) => {
    candidate.evaluations = candidate.evaluations.filter(
      (evaluation) => evaluation.requirementId !== requirementId
    );
  });
  investigation.updatedAt = new Date().toISOString();
  notify(investigation);
  return true;
}
