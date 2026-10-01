import {
  observationForImportedTasteSignal,
  recognizePreferenceContexts,
} from '@/lib/behaviorRecognition';
import {
  PREFERENCE_CONTEXT_LABELS,
  PREFERENCE_LEARNING_MODEL_VERSION,
  applyPreferenceObservation,
  answerPreferenceHearingQuestion,
  createPreferenceLearningState,
  isPersonalizationSourceKind,
  markPreferenceObservationProcessed,
  parsePreferenceLearningState,
  scoresFromLearningState,
  selectPreferenceHearingQuestion,
  type PersonalizationSourceKind,
  type PreferenceContext,
  type PreferenceHearingOption,
  type PreferenceHearingQuestion,
  type PreferenceLearningState,
  type PreferenceObservation,
} from '@/lib/preferenceLearning';
import {
  PERSONA_MODEL_VERSION,
  TASTE_AXIS_IDS,
  type PersonaCalibrationResult,
  type TasteAxis,
  type TasteScores,
} from '@/lib/personaCalibration';
import { clearTasteProfile, loadTasteProfile, saveTasteProfile } from '@/lib/profile';
import type { TasteProfile } from '@/types';

const PERSONALIZATION_STORAGE_KEY = 'oisint:personalization:v1';
const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 40;

const CONFIRMED_AXIS_HINTS: Partial<
  Record<Exclude<TasteAxis, 'health'>, { high: string; low?: string }>
> = {
  evidence: { high: '公式情報と根拠を優先' },
  quiet: { high: '静かで会話しやすい店', low: '活気のある雰囲気' },
  value: { high: '価格の納得感を重視', low: '価格より店の魅力を優先' },
  novelty: { high: '新しい個人店も候補に残す', low: '定番で安心できる店を優先' },
  groupFit: { high: '全員が納得しやすい店を優先' },
};

export interface LocalPersonalizationSnapshot {
  scenarioId: string | null;
  scores: TasteScores;
  likes: string[];
  avoid: string[];
  modelVersion: string;
  sourceKinds: PersonalizationSourceKind[];
  learningState: PreferenceLearningState;
  updatedAt: string;
  /** 端末内プロフィールの所有Auth subject。旧記録は未設定のまま隔離する。 */
  subjectId?: string;
  subjectKind?: 'anonymous' | 'permanent';
}

export interface PersonalizationSubject {
  id: string;
  kind: 'anonymous' | 'permanent';
}

export interface ImportedTasteSignalInput {
  label: string;
  matches: number;
  confidence: number;
  contexts?: PreferenceContext[];
}

export interface ImportedTasteMerge {
  snapshot: LocalPersonalizationSnapshot;
  tasteProfile: TasteProfile;
}

export interface PreferenceHearingCommit {
  snapshot: LocalPersonalizationSnapshot;
  tasteProfile: TasteProfile;
}

export interface StoredPersonalizationForDevice {
  scenarioId: string | null;
  axisScores: TasteScores;
  likes: string[];
  avoid: string[];
  modelVersion: string;
  sourceKinds: PersonalizationSourceKind[];
  learningState: PreferenceLearningState;
  updatedAt: string;
}

export function snapshotFromCalibration(
  result: PersonaCalibrationResult,
): LocalPersonalizationSnapshot {
  const updatedAt = new Date().toISOString();
  const likes = sanitizeTags(result.profile.likes);
  const avoid = sanitizeTags(result.profile.avoid);
  return {
    scenarioId: result.persona.id,
    scores: { ...result.scores },
    likes,
    avoid,
    modelVersion: result.modelVersion,
    sourceKinds: ['demo_answers'],
    learningState: createPreferenceLearningState(
      result.scores,
      { likes, avoid },
      'demo_answers',
      updatedAt,
    ),
    updatedAt,
  };
}

/**
 * 永続ユーザーにcloudプロフィールがまだ無い場合の安全な基底。
 * 認証ユーザーのlocalStorageは別アカウント由来の可能性があるため、cloud保存前の
 * 正本として流用しない。匿名/local-onlyの初期化は previewPreferenceObservationLocally
 * が従来どおり端末プロフィールを使う。
 */
export function emptyPersonalizationSnapshot(): LocalPersonalizationSnapshot {
  const scores = emptyScores();
  const updatedAt = new Date().toISOString();
  return {
    scenarioId: null,
    scores,
    likes: [],
    avoid: [],
    modelVersion: PREFERENCE_LEARNING_MODEL_VERSION,
    sourceKinds: [],
    learningState: createPreferenceLearningState(scores, { likes: [], avoid: [] }, undefined, updatedAt),
    updatedAt,
  };
}

export function saveCalibrationLocally(
  result: PersonaCalibrationResult,
  subject?: PersonalizationSubject,
): void {
  saveTasteProfile(result.profile, subject);
  saveLocalPersonalization(snapshotFromCalibration(result), subject);
}

export function loadLocalPersonalization(
  subject?: PersonalizationSubject,
): LocalPersonalizationSnapshot | null {
  if (typeof window === 'undefined') return null;

  // 本番のsubject省略読取は、端末共通の旧global記録を別人へ帰属させるため禁止する。
  // owner不明の個人化データは復元せず、残存キーも消して次回漏えいを防ぐ。
  if (!subject && !allowUnscopedLocalStorage()) {
    try {
      window.localStorage.removeItem(PERSONALIZATION_STORAGE_KEY);
    } catch {
      // localStorage は任意機能。読み取りを空へ倒すことが主目的。
    }
    return null;
  }

  try {
    const raw = window.localStorage.getItem(PERSONALIZATION_STORAGE_KEY);
    if (!raw) return null;
    const snapshot = parseSnapshot(JSON.parse(raw));
    if (!snapshot) return null;
    if (subject === undefined) return snapshot;
    return localPersonalizationBelongsToSubject(snapshot, subject) ? snapshot : null;
  } catch {
    return null;
  }
}

export function saveLocalPersonalization(
  snapshot: LocalPersonalizationSnapshot,
  subject?: PersonalizationSubject,
): void {
  if (typeof window === 'undefined') return;
  if (!subject && !allowUnscopedLocalStorage()) return;

  const safe = parseSnapshot({
    ...snapshot,
    ...(subject ? { subjectId: subject.id, subjectKind: subject.kind } : {}),
  });
  if (!safe) return;

  try {
    window.localStorage.setItem(PERSONALIZATION_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // Local storage is optional. The in-memory result remains usable.
  }
}

export function restoreStoredPersonalizationLocally(
  stored: StoredPersonalizationForDevice,
  subject?: PersonalizationSubject,
): LocalPersonalizationSnapshot {
  const snapshot = parseSnapshot({
    scenarioId: stored.scenarioId,
    scores: stored.axisScores,
    likes: stored.likes,
    avoid: stored.avoid,
    modelVersion: stored.modelVersion,
    sourceKinds: stored.sourceKinds,
    learningState: stored.learningState,
    updatedAt: stored.updatedAt,
  });
  if (!snapshot) throw new Error('保存済みプロフィールの形式を確認できませんでした。');

  // Allergies and health goals intentionally never come from cloud storage. Preserve the
  // device-private values while restoring only the portable aggregate profile.
  const privateProfile = loadTasteProfile(subject);
  saveTasteProfile({
    ...privateProfile,
    likes: snapshot.likes,
    avoid: snapshot.avoid,
  }, subject);
  saveLocalPersonalization(snapshot, subject);
  return snapshot;
}

export function confirmedPreferenceHintsToQuery(
  snapshot: LocalPersonalizationSnapshot | null,
  currentQuery = '',
  selectedChips: readonly string[] = [],
): string | null {
  if (!snapshot) return null;

  const activeContexts = recognizePreferenceContexts(
    [currentQuery.slice(0, 2000), ...selectedChips.slice(0, 20)].join(' '),
  );
  const contextualAxes = new Set<Exclude<TasteAxis, 'health'>>();
  const contextualTagHints = activeContexts.flatMap((context) => {
    const contextState = snapshot.learningState.contexts[context];
    if (!contextState) return [];

    return Object.entries(contextState.confirmedTags)
      .map(([label, choice]) => {
        if (choice === 'situational') return null;
        const belief = contextState.tags.find((tag) => tag.label === label);
        if (!belief) return null;
        return {
          text: `${PREFERENCE_CONTEXT_LABELS[context]}は「${label}」を${
            choice === 'prefer' ? '優先' : '避ける'
          }`,
          distance: Math.abs(belief.mean) * 50,
          contextual: true as const,
        };
      })
      .filter(
        (hint): hint is { text: string; distance: number; contextual: true } => Boolean(hint),
      );
  });
  const contextualHints = activeContexts.flatMap((context) => {
    const contextState = snapshot.learningState.contexts[context];
    if (!contextState) return [];
    return TASTE_AXIS_IDS
      .filter((axis): axis is Exclude<TasteAxis, 'health'> => axis !== 'health')
      .map((axis) => {
        const copy = CONFIRMED_AXIS_HINTS[axis];
        const choice = contextState.confirmedAxes[axis];
        const belief = contextState.axes[axis];
        if (!belief) return null;
        const text = confirmedChoiceText(copy, choice);
        if (!text) return null;
        contextualAxes.add(axis);
        return {
          text: `${PREFERENCE_CONTEXT_LABELS[context]}は${text}`,
          distance: Math.abs(belief.mean - 50),
          contextual: true,
        };
      })
      .filter(
        (hint): hint is { text: string; distance: number; contextual: true } => Boolean(hint),
      );
  });

  const globalHints = TASTE_AXIS_IDS
    .filter((axis): axis is Exclude<TasteAxis, 'health'> => axis !== 'health')
    .filter((axis) => !contextualAxes.has(axis))
    .map((axis) => {
      const copy = CONFIRMED_AXIS_HINTS[axis];
      const choice = snapshot.learningState.confirmedAxes[axis];
      const text = confirmedChoiceText(copy, choice);
      return text
        ? { text, distance: Math.abs(snapshot.scores[axis] - 50), contextual: false as const }
        : null;
    })
    .filter(
      (hint): hint is { text: string; distance: number; contextual: false } => Boolean(hint),
    );

  const hints = [...contextualTagHints, ...contextualHints, ...globalHints]
    .sort(
      (left, right) =>
        Number(right.contextual) - Number(left.contextual) || right.distance - left.distance,
    )
    .slice(0, 3)
    .map((hint) => hint.text);

  return hints.length > 0 ? `確認済みの好み: ${hints.join('、')}` : null;
}

export function tasteProfileForCurrentContext(
  snapshot: LocalPersonalizationSnapshot | null,
  profile: TasteProfile,
  currentQuery = '',
  selectedChips: readonly string[] = [],
): TasteProfile {
  const likes = new Set(sanitizeTags(profile.likes));
  const avoid = new Set(sanitizeTags(profile.avoid));
  if (!snapshot) return { ...profile, likes: [...likes], avoid: [...avoid] };

  const activeContexts = recognizePreferenceContexts(
    [currentQuery.slice(0, 2000), ...selectedChips.slice(0, 20)].join(' '),
  );
  const choicesByLabel = new Map<string, Set<'prefer' | 'avoid'>>();
  for (const context of activeContexts) {
    const contextState = snapshot.learningState.contexts[context];
    if (!contextState) continue;
    const learnedLabels = new Set(contextState.tags.map((tag) => tag.label));
    const confirmedTags = contextState.confirmedTags;
    for (const [rawLabel, choice] of Object.entries(confirmedTags)) {
      if (choice === 'situational') continue;
      const label = sanitizeTags([rawLabel])[0];
      if (!label || !learnedLabels.has(label)) continue;
      const choices = choicesByLabel.get(label) ?? new Set<'prefer' | 'avoid'>();
      choices.add(choice);
      choicesByLabel.set(label, choices);
    }
  }

  for (const [label, choices] of choicesByLabel) {
    // When two simultaneously active contexts disagree, preserve the editable global profile
    // until the user provides a more specific constraint instead of choosing an arbitrary winner.
    if (choices.size !== 1) continue;
    if (choices.has('prefer')) {
      avoid.delete(label);
      likes.add(label);
    } else {
      likes.delete(label);
      avoid.add(label);
    }
  }

  return {
    ...profile,
    likes: sanitizeTags([...likes]),
    avoid: sanitizeTags([...avoid]),
  };
}

function confirmedChoiceText(
  copy: { high: string; low?: string } | undefined,
  choice: 'high' | 'low' | 'situational' | undefined,
): string | null {
  if (!copy || !choice || choice === 'situational') return null;
  if (choice === 'high') return copy.high;
  return copy.low ?? null;
}

export function clearLocalPersonalization(subject?: PersonalizationSubject): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PERSONALIZATION_STORAGE_KEY);
  } catch {
    // The caller can still clear the server-side copy independently.
  }
  clearTasteProfile(subject);
}

export function recordPreferenceObservationLocally(
  observation: PreferenceObservation | null,
  profileOverride?: TasteProfile,
  subject?: PersonalizationSubject,
): LocalPersonalizationSnapshot | null {
  const next = previewPreferenceObservationLocally(observation, profileOverride, subject);
  if (!next) return null;
  if (!observation) return next;
  const existing = loadLocalPersonalization(subject);
  if (existing?.learningState === next.learningState) return existing;
  if (profileOverride) saveTasteProfile(profileOverride, subject);
  saveLocalPersonalization(next, subject);
  return next;
}

/** side effectを起こさず、明示opt-inのサーバー先行保存に使う次状態を作る。 */
export function previewPreferenceObservationLocally(
  observation: PreferenceObservation | null,
  profileOverride?: TasteProfile,
  subject?: PersonalizationSubject,
): LocalPersonalizationSnapshot | null {
  if (!observation) return loadLocalPersonalization(subject);
  const existing = loadLocalPersonalization(subject);
  const tasteProfile = profileOverride ?? loadTasteProfile(subject);
  const base = existing ?? {
    scenarioId: null,
    scores: emptyScores(),
    likes: sanitizeTags(tasteProfile.likes),
    avoid: sanitizeTags(tasteProfile.avoid),
    modelVersion: PREFERENCE_LEARNING_MODEL_VERSION,
    sourceKinds: [],
    learningState: createPreferenceLearningState(emptyScores(), tasteProfile),
    updatedAt: new Date().toISOString(),
  } satisfies LocalPersonalizationSnapshot;
  return previewPreferenceObservationFromSnapshot(base, observation, tasteProfile);
}

/** 指定したprofile正本へだけ観測を適用する純粋な変換。新端末のcloud同期でlocalを優先しない。 */
export function previewPreferenceObservationFromSnapshot(
  base: LocalPersonalizationSnapshot,
  observation: PreferenceObservation,
  profileOverride?: Pick<TasteProfile, 'likes' | 'avoid'>,
): LocalPersonalizationSnapshot {
  const nextLearningState = applyPreferenceObservation(base.learningState, observation);
  if (nextLearningState === base.learningState) return base;
  const likes = profileOverride?.likes ?? base.likes;
  const avoid = profileOverride?.avoid ?? base.avoid;
  return {
    ...base,
    scores: scoresFromLearningState(nextLearningState),
    likes: sanitizeTags(likes),
    avoid: sanitizeTags(avoid),
    modelVersion: PREFERENCE_LEARNING_MODEL_VERSION,
    sourceKinds: uniqueSourceKinds([...base.sourceKinds, observation.sourceKind]),
    learningState: nextLearningState,
    updatedAt: nextLearningState.updatedAt,
  };
}

/** サーバー正本を取得した後、ローカル重複排除だけを付与する。 */
export function markLocalPersonalizationObservation(
  snapshot: LocalPersonalizationSnapshot,
  eventKey: string,
): LocalPersonalizationSnapshot {
  const learningState = markPreferenceObservationProcessed(snapshot.learningState, eventKey);
  return learningState === snapshot.learningState
    ? snapshot
    : { ...snapshot, learningState, updatedAt: learningState.updatedAt };
}

/** 旧unscoped記録を別subjectへ自動帰属させず、同一UUIDの匿名→恒久linkだけ許可する。 */
export function localPersonalizationBelongsToSubject(
  snapshot: LocalPersonalizationSnapshot | null,
  subject: PersonalizationSubject,
): boolean {
  if (!snapshot?.subjectId || !snapshot.subjectKind || snapshot.subjectId !== subject.id) return false;
  return snapshot.subjectKind === subject.kind ||
    (snapshot.subjectKind === 'anonymous' && subject.kind === 'permanent');
}

function allowUnscopedLocalStorage(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.EXPO_PUBLIC_DATA_PROVIDER_MODE === 'mock';
}

export function getNextPreferenceHearingQuestionLocally(
  profile: Pick<TasteProfile, 'likes' | 'avoid'> = loadTasteProfile(),
  subject?: PersonalizationSubject,
): PreferenceHearingQuestion | null {
  const snapshot = loadLocalPersonalization(subject);
  return snapshot
    ? selectPreferenceHearingQuestion(snapshot.learningState, profile)
    : null;
}

export function answerPreferenceHearingLocally(
  question: PreferenceHearingQuestion,
  optionId: PreferenceHearingOption['id'],
  profile: TasteProfile = loadTasteProfile(),
  subject?: PersonalizationSubject,
): PreferenceHearingCommit | null {
  const existing = loadLocalPersonalization(subject);
  if (!existing) return null;

  const answer = answerPreferenceHearingQuestion(
    existing.learningState,
    profile,
    question,
    optionId,
  );
  const snapshot: LocalPersonalizationSnapshot = {
    ...existing,
    scores: scoresFromLearningState(answer.learningState),
    likes: sanitizeTags(answer.profile.likes),
    avoid: sanitizeTags(answer.profile.avoid),
    modelVersion: PREFERENCE_LEARNING_MODEL_VERSION,
    sourceKinds: uniqueSourceKinds([...existing.sourceKinds, 'hearing_answers']),
    learningState: answer.learningState,
    updatedAt: answer.learningState.updatedAt,
  };
  saveTasteProfile(answer.profile, subject);
  saveLocalPersonalization(snapshot, subject);
  return { snapshot, tasteProfile: answer.profile };
}

export function mergeImportedTasteTags(
  likes: string[],
  avoid: string[] = [],
  inferredSignals?: ImportedTasteSignalInput[],
  subject?: PersonalizationSubject,
): LocalPersonalizationSnapshot {
  const merge = createImportedTasteMerge(likes, avoid, inferredSignals, subject);
  commitImportedTasteMerge(merge, subject);
  return merge.snapshot;
}

export function createImportedTasteMerge(
  likes: string[],
  avoid: string[] = [],
  inferredSignals: ImportedTasteSignalInput[] = likes.map((label) => ({
    label,
    matches: 1,
    confidence: 0.75,
  })),
  subject?: PersonalizationSubject,
  baseSnapshot?: LocalPersonalizationSnapshot,
): ImportedTasteMerge {
  // Authenticated imports must be computed from the cloud row that supplied
  // the CAS revision.  Only the private allergy/health fields remain local;
  // aggregate likes/avoid and learning state come from the explicit base.
  const existing = baseSnapshot ?? loadLocalPersonalization(subject);
  const localTasteProfile = loadTasteProfile(subject);
  const tasteProfile = baseSnapshot
    ? { ...localTasteProfile, likes: baseSnapshot.likes, avoid: baseSnapshot.avoid }
    : localTasteProfile;
  const contextualOnlyLabels = new Set(
    likes.filter((label) => {
      const evidence = inferredSignals.filter((signal) => signal.label === label);
      return evidence.length > 0 && evidence.every((signal) => (signal.contexts?.length ?? 0) > 0);
    }),
  );
  const mergedProfile: TasteProfile = {
    ...tasteProfile,
    // A tag seen only in a named situation remains contextual until the user confirms it.
    // This prevents an anniversary list from silently becoming a preference for every search.
    likes: sanitizeTags([
      ...tasteProfile.likes,
      ...likes.filter((label) => !contextualOnlyLabels.has(label)),
    ]),
    avoid: sanitizeTags([...tasteProfile.avoid, ...avoid]),
  };
  const updatedAt = new Date().toISOString();
  let learningState = existing?.learningState ?? createPreferenceLearningState(
    existing?.scores ?? emptyScores(),
    tasteProfile,
    existing?.sourceKinds[0],
    updatedAt,
  );

  inferredSignals.slice(0, MAX_TAGS).forEach((signal, index) => {
    learningState = applyPreferenceObservation(
      learningState,
      observationForImportedTasteSignal({
        eventKey: `maps-import:${updatedAt}:${index}:${signal.label}`,
        label: signal.label,
        matches: signal.matches,
        confidence: signal.confidence,
        contexts: signal.contexts,
      }),
    );
  });
  avoid.slice(0, MAX_TAGS).forEach((label, index) => {
    learningState = applyPreferenceObservation(learningState, {
      eventKey: `maps-import-avoid:${updatedAt}:${index}:${label}`,
      sourceKind: 'maps_takeout',
      strength: 3,
      tags: [{ label, affinity: -1 }],
    });
  });

  const next: LocalPersonalizationSnapshot = {
    scenarioId: existing?.scenarioId ?? null,
    scores: scoresFromLearningState(learningState),
    likes: mergedProfile.likes,
    avoid: mergedProfile.avoid,
    modelVersion: PREFERENCE_LEARNING_MODEL_VERSION,
    sourceKinds: uniqueSourceKinds([...(existing?.sourceKinds ?? []), 'maps_takeout']),
    learningState,
    updatedAt: learningState.updatedAt,
  };
  return { snapshot: next, tasteProfile: mergedProfile };
}

export function commitImportedTasteMerge(
  merge: ImportedTasteMerge,
  subject?: PersonalizationSubject,
): void {
  saveTasteProfile(merge.tasteProfile, subject);
  saveLocalPersonalization(merge.snapshot, subject);
}

function parseSnapshot(value: unknown): LocalPersonalizationSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LocalPersonalizationSnapshot>;
  const scores = parseScores(candidate.scores);
  if (!scores) return null;

  const likes = sanitizeTags(candidate.likes);
  const avoid = sanitizeTags(candidate.avoid);
  const sourceKinds = uniqueSourceKinds(candidate.sourceKinds);
  const fallbackSource = sourceKinds[0];
  const learningState = parsePreferenceLearningState(
    candidate.learningState,
    scores,
    { likes, avoid },
    fallbackSource,
  );
  const updatedAt =
    typeof candidate.updatedAt === 'string' && !Number.isNaN(Date.parse(candidate.updatedAt))
      ? candidate.updatedAt
      : learningState.updatedAt;

  return {
    scenarioId:
      typeof candidate.scenarioId === 'string' && candidate.scenarioId.length <= 64
        ? candidate.scenarioId
        : null,
    scores,
    likes,
    avoid,
    modelVersion:
      typeof candidate.modelVersion === 'string' && candidate.modelVersion.length <= 80
        ? candidate.modelVersion
        : PERSONA_MODEL_VERSION,
    sourceKinds,
    learningState,
    updatedAt,
    subjectId: typeof candidate.subjectId === 'string' && candidate.subjectId.trim()
      ? candidate.subjectId.trim()
      : undefined,
    subjectKind:
      candidate.subjectKind === 'anonymous' || candidate.subjectKind === 'permanent'
        ? candidate.subjectKind
        : undefined,
  };
}

function parseScores(value: unknown): TasteScores | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Record<(typeof TASTE_AXIS_IDS)[number], unknown>>;
  const scores = {} as TasteScores;
  for (const axis of TASTE_AXIS_IDS) {
    const score = candidate[axis];
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    scores[axis] = Math.round(Math.min(100, Math.max(0, score)));
  }
  return scores;
}

function emptyScores(): TasteScores {
  return Object.fromEntries(TASTE_AXIS_IDS.map((axis) => [axis, 50])) as TasteScores;
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, MAX_TAG_LENGTH))
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAGS);
}

function uniqueSourceKinds(value: unknown): PersonalizationSourceKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPersonalizationSourceKind))];
}
