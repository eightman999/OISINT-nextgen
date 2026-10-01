import type { LocationSelection, TasteHealthGoal, TasteProfile } from '@/types';

const TASTE_PROFILE_STORAGE_KEY = 'oisint:taste-profile:v1';
const TASTE_PROFILE_SUBJECT_KEY_PREFIX = `${TASTE_PROFILE_STORAGE_KEY}:subject:`;

export interface TasteProfileSubject {
  id: string;
  kind: 'anonymous' | 'permanent';
}

interface StoredTasteProfileEnvelope {
  version: 2;
  subjectId: string;
  subjectKind: TasteProfileSubject['kind'];
  profile: TasteProfile;
}

export const DEFAULT_TASTE_PROFILE: TasteProfile = {
  likes: [],
  avoid: [],
  allergies: '',
  healthGoal: 'none',
};

/**
 * 端末内の個人プロフィールはAuth subject単位で保存する。
 * 永続subjectは、同じUUIDの匿名subjectからのidentity linkだけを引き継ぐ。
 * subjectなしの旧APIはテスト/mock互換だけで許容し、本番設定では非永続の空profileへ
 * 倒す。認証subjectを渡した読み込みが旧global値を採用することはない。
 */
export function loadTasteProfile(subject?: TasteProfileSubject): TasteProfile {
  if (typeof window === 'undefined') return DEFAULT_TASTE_PROFILE;

  try {
    if (!subject) return allowUnscopedLocalStorage() ? readLegacyProfile() : cloneDefaultProfile();

    quarantineLegacyProfile();
    const direct = readSubjectProfile(subject);
    if (direct) return direct;

    // 匿名→恒久の同一UUID linkだけは本人境界を証明できるため許可する。
    if (subject.kind === 'permanent') {
      const linked = readSubjectProfile({ id: subject.id, kind: 'anonymous' });
      if (linked) {
        writeSubjectProfile(subject, linked);
        return linked;
      }
    }
    return cloneDefaultProfile();
  } catch {
    return cloneDefaultProfile();
  }
}

export function saveTasteProfile(profile: TasteProfile, subject?: TasteProfileSubject): void {
  if (typeof window === 'undefined') return;

  try {
    const safe = normalizeProfile(profile);
    if (subject) {
      writeSubjectProfile(subject, safe);
      return;
    }
    if (!allowUnscopedLocalStorage()) return;
    window.localStorage.setItem(TASTE_PROFILE_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // Local storage is an enhancement; the current session still works without it.
  }
}

export function clearTasteProfile(subject?: TasteProfileSubject): void {
  if (typeof window === 'undefined') return;

  try {
    if (!subject) {
      window.localStorage.removeItem(TASTE_PROFILE_STORAGE_KEY);
      return;
    }
    window.localStorage.removeItem(subjectStorageKey(subject));
    // Only the same UUID anonymous predecessor can be linked to a permanent user.
    if (subject.kind === 'permanent') {
      window.localStorage.removeItem(subjectStorageKey({ id: subject.id, kind: 'anonymous' }));
    }
  } catch {
    // Clearing local preferences is best-effort when storage is unavailable.
  }
}

export function tasteProfileToQuery(profile: TasteProfile): string | null {
  // アレルギーと健康目的は raw_query / 共有調査へ渡さない。
  // private な検索条件の受け渡し経路が整備されるまでは、この端末の補助情報として保持する。
  const parts: string[] = [];
  if (profile.likes.length > 0) parts.push(`好き: ${profile.likes.join('、')}`);
  if (profile.avoid.length > 0) parts.push(`避けたい: ${profile.avoid.join('、')}`);

  return parts.length > 0 ? parts.join(' / ') : null;
}

export function locationToQuery(location: LocationSelection | null): string | null {
  if (!location) return null;

  if (
    location.source === 'gps' &&
    typeof location.latitude === 'number' &&
    typeof location.longitude === 'number'
  ) {
    // 座標は raw_query、共有URL、決定文へ到達させない。
    return '場所: 現在地付近';
  }

  return `場所: ${location.label}`;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function cloneDefaultProfile(): TasteProfile {
  return { ...DEFAULT_TASTE_PROFILE, likes: [], avoid: [] };
}

function allowUnscopedLocalStorage(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.EXPO_PUBLIC_DATA_PROVIDER_MODE === 'mock';
}

function normalizeProfile(value: unknown): TasteProfile {
  const parsed = value && typeof value === 'object' ? value as Partial<TasteProfile> : {};
  return {
    likes: Array.isArray(parsed.likes) ? parsed.likes.filter(isString) : [],
    avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter(isString) : [],
    allergies: typeof parsed.allergies === 'string' ? parsed.allergies : '',
    healthGoal: isHealthGoal(parsed.healthGoal) ? parsed.healthGoal : 'none',
  };
}

function subjectStorageKey(subject: TasteProfileSubject): string {
  // UUIDs are validated by AuthProvider/Supabase; encode anyway so a malformed
  // local fixture cannot create a path-like storage key.
  return `${TASTE_PROFILE_SUBJECT_KEY_PREFIX}${subject.kind}:${encodeURIComponent(subject.id)}`;
}

function readLegacyProfile(): TasteProfile {
  const stored = window.localStorage.getItem(TASTE_PROFILE_STORAGE_KEY);
  if (!stored) return cloneDefaultProfile();
  try {
    return normalizeProfile(JSON.parse(stored) as unknown);
  } catch {
    return cloneDefaultProfile();
  }
}

function readSubjectProfile(subject: TasteProfileSubject): TasteProfile | null {
  const raw = window.localStorage.getItem(subjectStorageKey(subject));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTasteProfileEnvelope>;
    if (
      parsed.version !== 2 ||
      parsed.subjectId !== subject.id ||
      parsed.subjectKind !== subject.kind ||
      !parsed.profile
    ) return null;
    return normalizeProfile(parsed.profile);
  } catch {
    return null;
  }
}

function writeSubjectProfile(subject: TasteProfileSubject, profile: TasteProfile): void {
  const envelope: StoredTasteProfileEnvelope = {
    version: 2,
    subjectId: subject.id,
    subjectKind: subject.kind,
    profile,
  };
  window.localStorage.setItem(subjectStorageKey(subject), JSON.stringify(envelope));
}

function quarantineLegacyProfile(): void {
  const legacy = window.localStorage.getItem(TASTE_PROFILE_STORAGE_KEY);
  if (!legacy) return;
  // Owner不明の旧global値は、別subjectへ帰属させず破棄する。アレルギー等の
  // private値を後から誰かのアカウントへ結び付ける根拠がないためである。
  window.localStorage.removeItem(TASTE_PROFILE_STORAGE_KEY);
}

function isHealthGoal(value: unknown): value is TasteHealthGoal {
  return value === 'none' || value === 'diet' || value === 'high_protein';
}
