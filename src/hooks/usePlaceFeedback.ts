import { useEffect, useRef, useState } from 'react';

import {
  getOwnPlaceFeedback,
  getPlaceFeedbackSummary,
  savePlaceFeedback,
} from '@/lib/api';
import {
  loadFeedbackLearningBase,
  saveFeedbackLearningProfile,
} from '@/lib/accountRepository';
import {
  buildPlaceFeedbackObservation,
  type FeedbackLearningReason,
} from '@/lib/preferenceLearningFeedback';
import {
  hasProcessedPreferenceObservation,
} from '@/lib/preferenceLearning';
import {
  loadLocalPersonalization,
  markLocalPersonalizationObservation,
  previewPreferenceObservationFromSnapshot,
  previewPreferenceObservationLocally,
  saveLocalPersonalization,
  type PersonalizationSubject,
} from '@/lib/personalization';
import type { PlaceFact, PlaceFeedback, PlaceFeedbackInput, PlaceFeedbackSummary } from '@/types';

export interface PlaceFeedbackState {
  /** 未保存フォームにも使う、本人と店舗の表示単位。 */
  formKey: string;
  feedback?: PlaceFeedback;
  summary?: PlaceFeedbackSummary;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (input: PlaceFeedbackInput) => Promise<void>;
  personalizationApplied: boolean;
  personalizationSaving: boolean;
  personalizationError: string | null;
  personalizationReasons: FeedbackLearningReason[];
  applyFeedbackToPersonalization: () => Promise<void>;
}

/**
 * APIから取得する「本人」フィードバックの所有 subject。
 *
 * placeId だけでは、同じ店舗を表示したまま A→B と切り替わったときに
 * A の feedback/id を B の保存操作へ持ち越してしまう。呼び出し側は
 * AuthProvider の現在値を毎 render 渡し、匿名/サインアウトも別 subject として
 * 扱う。subject を省略するのは既存の未接続テスト/preview用であり、実画面は
 * 必ず明示的に渡す。
 */
export interface PlaceFeedbackSubject {
  userId: string | null;
  isAnonymous?: boolean;
}

interface SubjectIdentity {
  key: string;
  generation: number;
}

interface InFlightOperation {
  key: string;
  generation: number;
  active: boolean;
}

function subjectIdentity(subject: PlaceFeedbackSubject | undefined): string {
  if (subject === undefined) return 'unscoped-preview';
  const userId = subject.userId?.trim();
  if (!userId) return 'signed-out';
  return `${subject.isAnonymous ? 'anonymous' : 'permanent'}:${userId}`;
}

export function usePlaceFeedback(
  placeId: string | undefined,
  placeFacts: readonly PlaceFact[] = [],
  subject?: PlaceFeedbackSubject,
): PlaceFeedbackState {
  const [feedback, setFeedback] = useState<PlaceFeedback | undefined>();
  const [summary, setSummary] = useState<PlaceFeedbackSummary | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personalizationApplied, setPersonalizationApplied] = useState(false);
  const [personalizationSaving, setPersonalizationSaving] = useState(false);
  const [personalizationError, setPersonalizationError] = useState<string | null>(null);
  const [personalizationReasons, setPersonalizationReasons] = useState<FeedbackLearningReason[]>([]);
  const subjectKey = subjectIdentity(subject);
  const hasExplicitSubject = subject !== undefined;
  const subjectUserId = subject?.userId?.trim() ?? '';
  const subjectIsAnonymous = Boolean(subject?.isAnonymous);
  const personalizationSubject: PersonalizationSubject | undefined = subjectUserId
    ? {
        id: subjectUserId,
        kind: subjectIsAnonymous ? 'anonymous' : 'permanent',
      }
    : undefined;
  // subjectだけでなくplaceもtokenに含める。店舗を切り替えた直後に、前店舗の
  // save/read結果が新しい表示へ混入することを防ぐ。
  const viewKey = `${subjectKey}\u0000${placeId ?? ''}`;
  const subjectRunRef = useRef<SubjectIdentity>({ key: viewKey, generation: 0 });
  const saveInFlightRef = useRef<InFlightOperation>({ key: viewKey, generation: 0, active: false });
  const personalizationInFlightRef = useRef<InFlightOperation>({ key: viewKey, generation: 0, active: false });
  const [stateViewKey, setStateViewKey] = useState(viewKey);
  // effectが新しいviewを初期化するまでの1 renderも旧stateを返さない。
  const visibleForSubject = stateViewKey === viewKey;
  const hasReadableSubject = subject === undefined || Boolean(subjectUserId);

  useEffect(() => {
    let mounted = true;
    const previous = subjectRunRef.current;
    const run = previous.key === viewKey
      ? previous
      : { key: viewKey, generation: previous.generation + 1 };
    subjectRunRef.current = run;
    // Aのin-flight完了でB/別店舗のsavingを解除させない。
    saveInFlightRef.current = { key: viewKey, generation: run.generation, active: false };
    personalizationInFlightRef.current = { key: viewKey, generation: run.generation, active: false };
    const generation = run.generation;
    const abortController = new AbortController();
    const isCurrent = () =>
      mounted &&
      !abortController.signal.aborted &&
      subjectRunRef.current.key === viewKey &&
      subjectRunRef.current.generation === generation;

    const load = async () => {
      await Promise.resolve();
      if (!isCurrent()) return;
      // 新viewのsnapshotを隠してから外部読込を開始する。effect本体で同期的に
      // setStateしないため、Reactのset-state-in-effect規則にも適合する。
      setStateViewKey(viewKey);
      setFeedback(undefined);
      setSummary(undefined);
      setLoading(Boolean(placeId));
      setSaving(false);
      setError(null);
      setPersonalizationApplied(false);
      setPersonalizationSaving(false);
      setPersonalizationError(null);
      setPersonalizationReasons([]);
      if (!placeId || !hasReadableSubject) {
        setLoading(false);
        return;
      }

      const loadPersonalizationSubject: PersonalizationSubject | undefined = subjectUserId
        ? { id: subjectUserId, kind: subjectIsAnonymous ? 'anonymous' : 'permanent' }
        : undefined;
      setLoading(true);
      try {
        const [own, summaries] = await Promise.all([
          (!hasExplicitSubject || subjectUserId)
            ? getOwnPlaceFeedback(placeId)
            : Promise.resolve(undefined),
          getPlaceFeedbackSummary([placeId]),
        ]);
        if (!isCurrent()) return;
        setFeedback(own);
        setSummary(summaries.find((item) => item.placeId === placeId));
        if (own) {
          const learning = buildPlaceFeedbackObservation({ feedback: own });
          const local = loadLocalPersonalization(loadPersonalizationSubject);
          setPersonalizationApplied(
            Boolean(local && hasProcessedPreferenceObservation(local.learningState, learning.signalKey)),
          );
        }
      } catch {
        if (isCurrent()) setError('来店記録を読み込めませんでした。時間を置いて再度お試しください。');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
      abortController.abort();
    };
  }, [hasExplicitSubject, hasReadableSubject, placeId, subjectIsAnonymous, subjectKey, subjectUserId, viewKey]);

  const save = async (input: PlaceFeedbackInput) => {
    if (!placeId || saving || !visibleForSubject || !hasReadableSubject) return;
    const currentRun = subjectRunRef.current;
    const generation = currentRun.generation;
    const isCurrent = () =>
      subjectRunRef.current.key === viewKey && subjectRunRef.current.generation === generation;
    const inFlight = saveInFlightRef.current;
    if (inFlight.active && inFlight.key === viewKey && inFlight.generation === generation) return;
    const operation: InFlightOperation = { key: viewKey, generation, active: true };
    saveInFlightRef.current = operation;
    const feedbackId = feedback?.id;
    setSaving(true);
    setError(null);
    try {
      const saved = await savePlaceFeedback(placeId, input, feedbackId);
      const summaries = await getPlaceFeedbackSummary([placeId]);
      if (!isCurrent()) return;
      setFeedback(saved);
      setSummary(summaries.find((item) => item.placeId === placeId));
      // 保存だけでは学習しない。更新後も、本人が改めて明示操作した時だけ反映する。
      setPersonalizationApplied(false);
      setPersonalizationError(null);
      setPersonalizationReasons([]);
    } catch {
      if (isCurrent()) {
        setError('来店記録を保存できませんでした。入力内容と通信状態を確認してください。');
      }
      throw new Error('place feedback save failed');
    } finally {
      if (isCurrent()) setSaving(false);
      if (saveInFlightRef.current === operation) operation.active = false;
    }
  };

  const applyFeedbackToPersonalization = async () => {
    if (!feedback || personalizationSaving || !visibleForSubject || !hasReadableSubject) return;
    const currentRun = subjectRunRef.current;
    const generation = currentRun.generation;
    const isCurrent = () =>
      subjectRunRef.current.key === viewKey && subjectRunRef.current.generation === generation;
    const inFlight = personalizationInFlightRef.current;
    if (inFlight.active && inFlight.key === viewKey && inFlight.generation === generation) return;
    const operation: InFlightOperation = { key: viewKey, generation, active: true };
    personalizationInFlightRef.current = operation;
    const feedbackForSubject = feedback;
    setPersonalizationSaving(true);
    setPersonalizationError(null);
    try {
      const result = buildPlaceFeedbackObservation({ feedback: feedbackForSubject, placeFacts });
      if (!result.observation) {
        setPersonalizationError('評価の向きが分かる記録だけを、安全な項目名で反映できます。');
        return;
      }
      // 永続ユーザーはcloud正本を先に読み、そのsnapshotへだけ観測を適用する。
      // 新端末/localStorage消去時に既存のcloud嗜好をdefaultで上書きしない。
      const base = await loadFeedbackLearningBase();
      const local = base.serverBacked ? null : loadLocalPersonalization(personalizationSubject);
      const snapshot = base.serverBacked
        ? base.snapshot
          ? previewPreferenceObservationFromSnapshot(base.snapshot, result.observation)
          : null
        : previewPreferenceObservationLocally(result.observation, undefined, personalizationSubject) ??
          (local ? previewPreferenceObservationFromSnapshot(local, result.observation) : null);
      if (!snapshot) {
        setPersonalizationError('この端末では好みプロフィールを更新できませんでした。');
        return;
      }
      // The RPC uses a per-user advisory lock plus updated_at CAS. A conflict
      // means another tab committed after `base`; reload the canonical profile,
      // reapply only this feedback observation, and retry instead of sending
      // the stale full snapshot again.
      let nextBase = base.snapshot;
      let nextProfileExists = base.profileExists;
      let nextSnapshot = snapshot;
      let saved: Awaited<ReturnType<typeof saveFeedbackLearningProfile>> | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        saved = await saveFeedbackLearningProfile(nextSnapshot, feedback.id, {
          profileExists: nextProfileExists,
          updatedAt: nextBase?.updatedAt ?? null,
        });
        if (!saved.conflict) break;
        if (!saved.snapshot) throw new Error('feedback learning conflict has no canonical snapshot');
        nextBase = saved.snapshot;
        // A concurrent profile deletion is represented by an empty canonical
        // snapshot and profileExists=false; do not force the next CAS to claim
        // that a row still exists (#515 P2 regression).
        nextProfileExists = saved.profileExists ?? true;
        nextSnapshot = previewPreferenceObservationFromSnapshot(nextBase, result.observation);
      }
      if (!saved || saved.conflict) {
        throw new Error('feedback learning save conflicted repeatedly');
      }
      if (base.serverBacked && !saved.persisted) {
        // cloud正本を読んだ永続ユーザーが保存時に認証を失った場合は、local-onlyへ
      // 暗黙フォールバックしない。失敗時のlocal snapshot/tokenを変更しない。
        throw new Error('permanent feedback learning save did not persist');
      }
      if (!isCurrent()) return;
      const canonical = saved.snapshot ?? snapshot;
      saveLocalPersonalization(
        markLocalPersonalizationObservation(canonical, result.signalKey),
        personalizationSubject,
      );
      setPersonalizationReasons(result.reasons);
      setPersonalizationApplied(true);
    } catch {
      if (isCurrent()) {
        setPersonalizationError('おすすめへの反映を保存できませんでした。時間を置いて再度お試しください。');
      }
    } finally {
      if (isCurrent()) setPersonalizationSaving(false);
      if (personalizationInFlightRef.current === operation) operation.active = false;
    }
  };

  return {
    formKey: viewKey,
    feedback: visibleForSubject ? feedback : undefined,
    summary: visibleForSubject ? summary : undefined,
    loading: visibleForSubject ? loading : true,
    saving: visibleForSubject ? saving : false,
    error: visibleForSubject ? error : null,
    save,
    personalizationApplied: visibleForSubject ? personalizationApplied : false,
    personalizationSaving: visibleForSubject ? personalizationSaving : false,
    personalizationError: visibleForSubject ? personalizationError : null,
    personalizationReasons: visibleForSubject ? personalizationReasons : [],
    applyFeedbackToPersonalization,
  };
}
