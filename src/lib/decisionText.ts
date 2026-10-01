import type {
  Candidate,
  Evidence,
  Investigation,
  MatchState,
  Requirement,
} from '@/types';

export interface DecisionTextOptions {
  /** The event date/time is not part of the persisted Investigation model. */
  dateTime?: string;
  /** Place has no phone field in the current model, so callers may provide it here. */
  phoneNumber?: string;
  /** Place has no map URL field in the current model, so callers may provide it here. */
  mapUrl?: string;
  /** Optional caller-supplied reason when the current evidence is insufficient. */
  reason?: string;
  /** Optional caller-supplied reasons for the detailed version. */
  reasons?: readonly string[];
  /** Optional explicit questions; otherwise they are derived from unknown requirements. */
  phoneQuestions?: readonly string[];
  /** Falls back to the existing Place URL when omitted. */
  verificationUrl?: string;
}
export interface DecisionTextResult {
  short: string;
  detailed: string;
}

const UNKNOWN = '不明';
const UNKNOWN_SOURCE = '出典不明';
const MAX_REJECTED_CANDIDATES = 2;
const MAX_PHONE_QUESTIONS = 3;

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function valueOrUnknown(value: string | undefined | null): string {
  return nonEmpty(value) ?? UNKNOWN;
}

function httpUrlOrUndefined(value: string | undefined | null): string | undefined {
  const candidate = nonEmpty(value);
  if (!candidate) return undefined;

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function sourceDomain(sourceUrl: string | undefined): string {
  const url = httpUrlOrUndefined(sourceUrl);
  if (!url) return UNKNOWN_SOURCE;

  try {
    return new URL(url).hostname.replace(/^www\./i, '') || UNKNOWN_SOURCE;
  } catch {
    return UNKNOWN_SOURCE;
  }
}

function evidenceForEvaluation(candidate: Candidate, evidenceIds: readonly string[]): Evidence | undefined {
  return evidenceIds
    .map((id) => candidate.evidence.find((evidence) => evidence.id === id))
    .find((evidence): evidence is Evidence => Boolean(evidence));
}

function evaluationReason(candidate: Candidate, states: readonly MatchState[]): string | undefined {
  const evaluation = candidate.evaluations.find(
    (entry) => states.includes(entry.state) && nonEmpty(entry.explanation),
  );
  if (!evaluation) return undefined;

  const explanation = nonEmpty(evaluation.explanation);
  if (!explanation) return undefined;

  const evidence = evidenceForEvaluation(candidate, evaluation.evidenceIds);
  return `${explanation}（${sourceDomain(evidence?.sourceUrl)}）`;
}

function evidenceBackedReasons(candidate: Candidate): string[] {
  return candidate.evaluations.flatMap((evaluation) => {
    if (!['match', 'partial'].includes(evaluation.state)) return [];

    const explanation = nonEmpty(evaluation.explanation);
    const evidence = evidenceForEvaluation(candidate, evaluation.evidenceIds);
    if (!explanation || !evidence) return [];

    return [`${explanation}（${sourceDomain(evidence.sourceUrl)}）`];
  });
}

function reasonLines(candidate: Candidate, options: DecisionTextOptions): string[] {
  const suppliedReasons = (options.reasons ?? [])
    .map((reason) => nonEmpty(reason))
    .filter((reason): reason is string => Boolean(reason))
    .map((reason) => `${reason}（${UNKNOWN_SOURCE}）`);
  const generatedReasons = evidenceBackedReasons(candidate);
  const oneLineReason = nonEmpty(options.reason);
  const reasons = suppliedReasons.length > 0
    ? suppliedReasons
    : oneLineReason
      ? [`${oneLineReason}（${UNKNOWN_SOURCE}）`]
      : generatedReasons;

  const safeReasons = reasons.length > 0
    ? reasons
    : [`根拠を確認できる情報は${UNKNOWN}（${UNKNOWN_SOURCE}）`];

  return Array.from({ length: 3 }, (_, index) => safeReasons[index] ?? `追加の選定理由は${UNKNOWN}（${UNKNOWN_SOURCE}）`);
}

function unknownRequirements(investigation: Investigation, candidate: Candidate): Requirement[] {
  const evaluationsByRequirement = new Map(
    candidate.evaluations.map((evaluation) => [evaluation.requirementId, evaluation]),
  );

  return investigation.requirements.filter((requirement) => {
    const evaluation = evaluationsByRequirement.get(requirement.id);
    return !evaluation || evaluation.state === 'unknown';
  });
}

function phoneQuestions(
  unknowns: readonly Requirement[],
  options: DecisionTextOptions,
): string[] {
  const suppliedQuestions = (options.phoneQuestions ?? [])
    .map((question) => nonEmpty(question))
    .filter((question): question is string => Boolean(question))
    .slice(0, MAX_PHONE_QUESTIONS);
  if (suppliedQuestions.length > 0) return suppliedQuestions;

  return unknowns
    .map((requirement) => nonEmpty(requirement.text))
    .filter((text): text is string => Boolean(text))
    .map((text) => `「${text}」について確認する`)
    .slice(0, MAX_PHONE_QUESTIONS);
}

function rejectedReason(candidate: Candidate): string {
  const reason = evaluationReason(candidate, ['mismatch', 'partial', 'unknown']);
  return reason ? `判定理由: ${reason}` : `判定理由は${UNKNOWN}（${UNKNOWN_SOURCE}）`;
}

/**
 * Generates paste-ready decision text without changing Investigation or Candidate.
 * Selection is intentionally represented only by the Candidate argument.
 */
export function generateDecisionText(
  investigation: Investigation,
  selectedCandidate: Candidate,
  options: DecisionTextOptions = {},
): DecisionTextResult {
  const address = valueOrUnknown(selectedCandidate.place.address);
  const dateTime = valueOrUnknown(options.dateTime);
  const phoneNumber = valueOrUnknown(options.phoneNumber);
  const mapUrl = httpUrlOrUndefined(options.mapUrl) ?? UNKNOWN;
  const verificationUrl =
    httpUrlOrUndefined(options.verificationUrl) ??
    httpUrlOrUndefined(selectedCandidate.place.urls?.pc) ??
    UNKNOWN;
  const reasons = reasonLines(selectedCandidate, options);
  const shortReason = `選んだ理由: ${reasons[0]}`;
  const unknowns = unknownRequirements(investigation, selectedCandidate);
  const questions = phoneQuestions(unknowns, options);
  const rejected = investigation.candidates
    .filter((candidate) => candidate.id !== selectedCandidate.id)
    .sort((left, right) => left.rank - right.rank)
    .slice(0, MAX_REJECTED_CANDIDATES);

  const short = [
    `店名: ${valueOrUnknown(selectedCandidate.place.name)}`,
    `日時・住所: ${dateTime} / ${address}`,
    `地図リンク: ${mapUrl}`,
    shortReason,
    `電話番号: ${phoneNumber}`,
  ].join('\n');

  const rejectedLines = rejected.length > 0
    ? rejected.map((candidate) => `・${valueOrUnknown(candidate.place.name)}: ${rejectedReason(candidate)}`)
    : [`・比較対象: ${UNKNOWN}（比較対象なし）`];
  const questionLines = questions.length > 0
    ? questions.map((question) => `・${question}`)
    : [`・${UNKNOWN}な条件はありません`];

  const detailed = [
    `店名: ${valueOrUnknown(selectedCandidate.place.name)}`,
    `日時・住所: ${dateTime} / ${address}`,
    `地図リンク: ${mapUrl}`,
    `選んだ理由: ${reasons[0]}`,
    `選んだ理由: ${reasons[1]}`,
    `選んだ理由: ${reasons[2]}`,
    `落とした2件の理由:`,
    ...rejectedLines,
    `残る不明: ${unknowns.length}件`,
    `店に電話で聞くこと:`,
    ...questionLines,
    `電話番号: ${phoneNumber}`,
    `検証用URL: ${verificationUrl}`,
  ].join('\n');

  return { short, detailed };
}
