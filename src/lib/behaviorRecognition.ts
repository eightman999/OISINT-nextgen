import type { TasteAxis } from '@/lib/personaCalibration';
import type {
  PreferenceContext,
  PreferenceObservation,
  PreferenceTagObservation,
} from '@/lib/preferenceLearning';
import {
  getCanonicalTasteSignal,
  matchCanonicalTasteSignals,
  mergeAxisTargets,
  type CanonicalTasteSignal,
} from '@/lib/tasteTaxonomy';
import type { Candidate, Requirement, TasteProfile } from '@/types';

export interface SearchBehaviorInput {
  eventKey: string;
  query: string;
  selectedChips?: readonly string[];
}

export type CandidateBehaviorAction =
  | 'candidate_opened'
  | 'vote_up'
  | 'vote_down'
  | 'map_opened'
  | 'decision_copied';

export interface CandidateBehaviorInput {
  eventKey: string;
  action: CandidateBehaviorAction;
  candidate: Candidate;
  requirements?: readonly Requirement[];
}

export function recognizeSearchBehavior(
  input: SearchBehaviorInput,
): PreferenceObservation | null {
  const boundedText = [input.query.slice(0, 2000), ...(input.selectedChips ?? []).slice(0, 20)]
    .join(' ');
  const signals = uniqueSignals(matchCanonicalTasteSignals(boundedText));
  const axes: Partial<Record<TasteAxis, number>> = mergeAxisTargets(signals);

  if (/\d+\s*人|みんな|全員|友人|同僚|家族/.test(boundedText)) {
    axes.groupFit = mergeTarget(axes.groupFit, 74);
  }
  if (/予算|円以内|円くらい|安め|価格/.test(boundedText)) {
    axes.value = mergeTarget(axes.value, 76);
  }
  const contexts = recognizePreferenceContexts(boundedText);

  return observationOrNull({
    eventKey: input.eventKey,
    sourceKind: 'behavior_signals',
    strength: 1,
    axes,
    tags: signals.map((signal) => ({ label: signal.label, affinity: 0.7 })),
    contexts,
    tagsContextOnly: contexts.length > 0,
  });
}

export function recognizeCandidateBehavior(
  input: CandidateBehaviorInput,
): PreferenceObservation | null {
  // Place names, addresses, URLs, and free-text evidence never enter the learning state.
  const signals = uniqueSignals(matchCanonicalTasteSignals(input.candidate.place.genre ?? ''));
  const settings = actionSettings(input.action);
  const axes: Partial<Record<TasteAxis, number>> = {};
  const contexts = recognizePreferenceContexts(
    (input.requirements ?? [])
      .slice(0, 20)
      .map((requirement) => `${requirement.text} ${requirement.normalizedText}`)
      .join(' '),
  );

  if (settings.positive && input.requirements) {
    for (const evaluation of input.candidate.evaluations) {
      if (evaluation.state !== 'match' && evaluation.state !== 'partial') continue;
      const requirement = input.requirements.find(
        (candidate) => candidate.id === evaluation.requirementId,
      );
      if (!requirement) continue;
      if (requirement.kind === 'budget') axes.value = mergeTarget(axes.value, 74);
      if (requirement.kind === 'party_size') axes.groupFit = mergeTarget(axes.groupFit, 78);
      if (requirement.kind === 'atmosphere') {
        const atmosphereSignals = matchCanonicalTasteSignals(
          `${requirement.text} ${requirement.normalizedText}`,
        );
        Object.assign(axes, mergeAxisMaps(axes, mergeAxisTargets(atmosphereSignals)));
      }
    }
  }

  if (settings.positive) {
    Object.assign(axes, mergeAxisMaps(axes, mergeAxisTargets(signals)));
  }
  const tags: PreferenceTagObservation[] = signals.map((signal) => ({
    label: signal.label,
    affinity: settings.affinity,
  }));

  return observationOrNull({
    eventKey: input.eventKey,
    sourceKind: 'behavior_signals',
    strength: settings.strength,
    axes,
    tags,
    contexts,
    tagsContextOnly: contexts.length > 0,
  });
}

export function recognizePreferenceContexts(text: string): PreferenceContext[] {
  const bounded = text.normalize('NFKC').slice(0, 3000);
  const contexts: PreferenceContext[] = [];
  if (/ひとり|一人|1人|おひとり|ソロ/.test(bounded)) contexts.push('solo');
  if (/複数人|みんな|全員|友人|同僚|家族|仲間|[2-9２-９]\s*人/.test(bounded)) {
    contexts.push('group');
  }
  if (/急ぎ|急いで|すぐ決め|短時間|時間がない|サクッと|さっと/.test(bounded)) {
    contexts.push('quick');
  }
  if (/記念日|誕生日|特別な日|お祝い|デート|接待/.test(bounded)) {
    contexts.push('special');
  }
  return [...new Set(contexts)].slice(0, 2);
}

export function recognizeProfileEdit(
  previous: TasteProfile,
  next: TasteProfile,
  eventKey: string,
): PreferenceObservation | null {
  const previousLikes = new Set(previous.likes);
  const previousAvoid = new Set(previous.avoid);
  const nextLikes = new Set(next.likes);
  const nextAvoid = new Set(next.avoid);
  const tags: PreferenceTagObservation[] = [];

  for (const label of nextLikes) {
    if (!previousLikes.has(label)) tags.push({ label, affinity: 1 });
  }
  for (const label of nextAvoid) {
    if (!previousAvoid.has(label)) tags.push({ label, affinity: -1 });
  }
  for (const label of previousLikes) {
    if (!nextLikes.has(label)) tags.push({ label, affinity: 0 });
  }
  for (const label of previousAvoid) {
    if (!nextAvoid.has(label)) tags.push({ label, affinity: 0 });
  }

  const axes: Partial<Record<TasteAxis, number>> = {};
  if (previous.healthGoal !== next.healthGoal) {
    axes.health = next.healthGoal === 'none' ? 50 : 88;
  }

  // Allergies are intentionally excluded: safety constraints are not preference-learning signals.
  return observationOrNull({
    eventKey,
    sourceKind: 'profile_edits',
    strength: 4.5,
    axes,
    tags,
  });
}

export function observationForImportedTasteSignal(input: {
  eventKey: string;
  label: string;
  confidence: number;
  matches: number;
  contexts?: PreferenceContext[];
}): PreferenceObservation {
  const canonical = getCanonicalTasteSignal(input.label);
  const strength = Math.min(
    4.5,
    1.4 + Math.max(0, Math.min(1, input.confidence)) * 2 + Math.log2(input.matches + 1) * 0.35,
  );
  return {
    eventKey: input.eventKey,
    sourceKind: 'maps_takeout',
    strength,
    axes: canonical?.axisTargets,
    tags: [{ label: input.label, affinity: 1 }],
    contexts: input.contexts,
    tagsContextOnly: Boolean(input.contexts?.length),
  };
}

function actionSettings(action: CandidateBehaviorAction): {
  strength: number;
  affinity: number;
  positive: boolean;
} {
  if (action === 'candidate_opened') return { strength: 0.35, affinity: 0.2, positive: true };
  if (action === 'vote_up') return { strength: 2.2, affinity: 0.8, positive: true };
  if (action === 'vote_down') return { strength: 1.25, affinity: -0.5, positive: false };
  if (action === 'map_opened') return { strength: 3.8, affinity: 0.95, positive: true };
  return { strength: 3.6, affinity: 1, positive: true };
}

function observationOrNull(observation: PreferenceObservation): PreferenceObservation | null {
  const hasAxis = Object.keys(observation.axes ?? {}).length > 0;
  const hasTag = (observation.tags ?? []).length > 0;
  return hasAxis || hasTag ? observation : null;
}

function uniqueSignals(signals: CanonicalTasteSignal[]): CanonicalTasteSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    if (seen.has(signal.label)) return false;
    seen.add(signal.label);
    return true;
  });
}

function mergeAxisMaps(
  left: Partial<Record<TasteAxis, number>>,
  right: Partial<Record<TasteAxis, number>>,
): Partial<Record<TasteAxis, number>> {
  const merged = { ...left };
  for (const [axis, target] of Object.entries(right) as [TasteAxis, number][]) {
    merged[axis] = mergeTarget(merged[axis], target);
  }
  return merged;
}

function mergeTarget(current: number | undefined, next: number): number {
  return current == null ? next : (current + next) / 2;
}
