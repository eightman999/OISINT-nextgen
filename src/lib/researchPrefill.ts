/**
 * 「条件を変えてもう一度調べる」の一時的な引き継ぎ。
 *
 * raw_query は個人入力なので、端末共通の生文字列を sessionStorage に置かず、
 * 作成者 subject と一度だけ使える envelope に束縛する。匿名 UUID から同じ UUID の
 * 恒久アカウントへ identity link した場合だけ、本人の継続として消費を許可する。
 */
export const RESEARCH_AGAIN_PREFILL_KEY = 'oisint:research-again-prefill:v1';

const ENVELOPE_VERSION = 1;
const MAX_RAW_QUERY_LENGTH = 2_000;

export interface ResearchPrefillSubject {
  id: string;
  kind: 'anonymous' | 'permanent';
}

interface StoredResearchPrefill {
  version: 1;
  subjectId: string;
  subjectKind: ResearchPrefillSubject['kind'];
  rawQuery: string;
  oneShot: true;
}

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  return window.sessionStorage;
}

function isSubject(value: unknown): value is ResearchPrefillSubject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ResearchPrefillSubject>;
  return typeof candidate.id === 'string' && candidate.id.length > 0 &&
    (candidate.kind === 'anonymous' || candidate.kind === 'permanent');
}

function belongsToSubject(
  stored: Pick<StoredResearchPrefill, 'subjectId' | 'subjectKind'>,
  subject: ResearchPrefillSubject,
): boolean {
  return stored.subjectId === subject.id &&
    (stored.subjectKind === subject.kind ||
      (stored.subjectKind === 'anonymous' && subject.kind === 'permanent'));
}

/** owner-bound envelope を保存する。subject が無い場合は保存せず、古い値も消す。 */
export function saveResearchAgainPrefill(
  rawQuery: string,
  subject: ResearchPrefillSubject | undefined,
): void {
  const target = storage();
  if (!target) return;
  try {
    if (!isSubject(subject) || rawQuery.length === 0 || rawQuery.length > MAX_RAW_QUERY_LENGTH) {
      target.removeItem(RESEARCH_AGAIN_PREFILL_KEY);
      return;
    }
    const envelope: StoredResearchPrefill = {
      version: ENVELOPE_VERSION,
      subjectId: subject.id,
      subjectKind: subject.kind,
      rawQuery,
      oneShot: true,
    };
    target.setItem(RESEARCH_AGAIN_PREFILL_KEY, JSON.stringify(envelope));
  } catch {
    // sessionStorage は補助機能。保存不能でも遷移自体は継続する。
  }
}

/** 現在 subject にだけ一度限りで返し、成功・失敗を問わず旧 envelope を消費する。 */
export function consumeResearchAgainPrefill(
  subject: ResearchPrefillSubject | undefined,
): string {
  const target = storage();
  if (!target) return '';
  let raw: string | null = null;
  try {
    raw = target.getItem(RESEARCH_AGAIN_PREFILL_KEY);
    // A→B の切替でも古い個人入力を残さない。読み取り後は必ず one-shot 消費する。
    target.removeItem(RESEARCH_AGAIN_PREFILL_KEY);
  } catch {
    return '';
  }
  if (!raw || !isSubject(subject)) return '';

  try {
    const parsed: Partial<StoredResearchPrefill> = JSON.parse(raw);
    if (
      parsed.version !== ENVELOPE_VERSION ||
      parsed.oneShot !== true ||
      typeof parsed.subjectId !== 'string' ||
      (parsed.subjectKind !== 'anonymous' && parsed.subjectKind !== 'permanent') ||
      typeof parsed.rawQuery !== 'string' ||
      parsed.rawQuery.length === 0 ||
      parsed.rawQuery.length > MAX_RAW_QUERY_LENGTH ||
      !belongsToSubject(
        parsed as Pick<StoredResearchPrefill, 'subjectId' | 'subjectKind'>,
        subject,
      )
    ) return '';
    return parsed.rawQuery;
  } catch {
    return '';
  }
}

export function clearResearchAgainPrefill(): void {
  try {
    storage()?.removeItem(RESEARCH_AGAIN_PREFILL_KEY);
  } catch {
    // ストレージ破損・拒否時も画面の個人入力は表示しない。
  }
}
