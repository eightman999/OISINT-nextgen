import { isLiveDataProvider } from '@/lib/api';

export const TERMS_CONSENT_VERSION = 'terms-v1';

const TERMS_CONSENT_STORAGE_KEY = 'oisint:terms-consent:v1';

export const TERMS_CONSENT_LABEL =
  '利用規約とプライバシーポリシーに同意します。';

export const TERMS_CONSENT_SUMMARY =
  '検索・調査のため、入力した調査文の一部は外部の検索サービスやAIサービスへ送信されます。調査結果は公開情報をもとにした補助情報で、AIが生成した説明には誤りが含まれる場合があります。本サービスは18歳以上を対象とします。';

// server/client時計の小さなずれだけを許容し、遠い未来の同意日時を拒否する。
const CONSENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

let pendingSignInConsent: { acceptedAt: string; expiresAt: number; claimed: boolean } | null = null;

export interface LocalTermsConsent {
  version: string;
  acceptedAt: string;
  /** 新規記録は現在のAuth subjectへ束縛する。旧形式はundefinedのまま読む。 */
  subjectId?: string;
  subjectKind?: 'anonymous' | 'permanent';
}

export interface TermsConsentSubject {
  id: string;
  kind: 'anonymous' | 'permanent';
}

export interface AccountTermsConsent {
  termsVersion: string;
  termsAcceptedAt: string;
}

export type TermsConsentRecordResult =
  | {
      ok: true;
      scope: 'account' | 'local';
      acceptedAt: string;
      subjectId?: string;
      subjectKind?: 'anonymous' | 'permanent';
    }
  | {
      ok: false;
      reason: 'server-unavailable';
      message: string;
    };

export type TermsConsentActionResult =
  | { status: 'ready' }
  | { status: 'needs-consent' }
  | { status: 'error'; message: string };

function readLocalRecord(): LocalTermsConsent | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(TERMS_CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { version?: unknown }).version !== 'string'
    ) {
      return null;
    }

    const acceptedAt = (parsed as { acceptedAt?: unknown }).acceptedAt;
    return {
      version: (parsed as { version: string }).version,
      // 旧記録はversionだけでも読み取る。次のserver/local書き込みで日時を付与する。
      acceptedAt: typeof acceptedAt === 'string' ? acceptedAt : '',
      ...readSubjectFields(parsed),
    };
  } catch {
    return null;
  }
}

/** この端末に保存された規約同意（旧version-only形式も読み取り可能）。 */
export function loadLocalTermsConsent(): LocalTermsConsent | null {
  return readLocalRecord();
}

/** この端末で現在の版数の規約同意が記録済みか。 */
export function isTermsConsentRecordedLocally(subject?: TermsConsentSubject | null): boolean {
  const local = readLocalRecord();
  if (local?.version !== TERMS_CONSENT_VERSION) return false;
  if (!isValidConsentTimestamp(local.acceptedAt)) return false;
  if (subject === undefined || subject === null) return true;
  return localConsentBelongsToSubject(local, subject);
}

/** 同意モーダル直後のsign-inだけに使う短命handoff。別端末/別subjectへ保存しない。 */
export function markPendingSignInConsent(acceptedAt: string): void {
  if (!isValidConsentTimestamp(acceptedAt)) return;
  pendingSignInConsent = {
    acceptedAt,
    expiresAt: Date.now() + 5 * 60 * 1000,
    claimed: false,
  };
}

/** 同意日時付きで端末記録を書き込む（匿名・未接続ではこの記録が正本）。 */
export function markTermsConsentRecordedLocally(
  acceptedAt = new Date().toISOString(),
  subject?: TermsConsentSubject,
): void {
  if (typeof window === 'undefined') return;

  try {
    // 不正・空・異常な未来日時を現在時刻へ置換すると、serverの同意証明を
    // client時刻で捏造するため、書き込み自体を行わない。
    if (!isValidConsentTimestamp(acceptedAt)) return;
    const record: LocalTermsConsent = {
      version: TERMS_CONSENT_VERSION,
      acceptedAt,
    };
    if (subject?.id && (subject.kind === 'anonymous' || subject.kind === 'permanent')) {
      record.subjectId = subject.id;
      record.subjectKind = subject.kind;
    }
    window.localStorage.setItem(TERMS_CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Local storage is optional. The modal may re-appear on the next visit.
  }
}

/**
 * 永続アカウントの同意をserver正本へ記録する。
 * 匿名・mockはアカウント行を持たないため、明示同意後の端末記録だけで進める。
 * 永続ユーザーではRPC成功後にだけ呼び出し側がlocal記録とpending actionを進める。
 */
export async function recordTermsConsentForAccount(): Promise<TermsConsentRecordResult> {
  if (!isLiveDataProvider) {
    return {
      ok: true,
      scope: 'local',
      acceptedAt: new Date().toISOString(),
    };
  }

  try {
    const { supabase } = await import('@/lib/supabase');
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    if (!userData.user) {
      return {
        ok: true,
        scope: 'local',
        acceptedAt: new Date().toISOString(),
      };
    }
    if (userData.user.is_anonymous) {
      return {
        ok: true,
        scope: 'local',
        acceptedAt: new Date().toISOString(),
        subjectId: userData.user.id,
        subjectKind: 'anonymous',
      };
    }

    const { data, error } = await supabase.rpc('record_terms_consent', {
      p_terms_version: TERMS_CONSENT_VERSION,
    });
    if (error) throw error;

    let acceptedAt = typeof data === 'string' && isValidConsentTimestamp(data) ? data : '';
    if (!acceptedAt) {
      const profileAcceptedAt =
        (await loadAccountTermsConsentFromClient(supabase, userData.user.id))?.termsAcceptedAt ?? '';
      acceptedAt = isValidConsentTimestamp(profileAcceptedAt) ? profileAcceptedAt : '';
    }
    if (!acceptedAt) throw new Error('server returned an invalid terms consent timestamp');
    return {
      ok: true,
      scope: 'account',
      acceptedAt,
      subjectId: userData.user.id,
      subjectKind: 'permanent',
    };
  } catch {
    return {
      ok: false,
      reason: 'server-unavailable',
      message: '利用規約への同意をサーバーへ記録できないため、先へ進めません。通信状態を確認して再度お試しください。',
    };
  }
}

/**
 * 永続ユーザーが実行可能な操作を始める前の同意確認。
 * localStorageだけを信用せず、serverにある同版記録を先に確認する。
 */
export async function ensureTermsConsentForAction(): Promise<TermsConsentActionResult> {
  const local = readLocalRecord();
  if (!isLiveDataProvider) {
    return local?.version === TERMS_CONSENT_VERSION && isValidConsentTimestamp(local.acceptedAt)
      ? { status: 'ready' }
      : { status: 'needs-consent' };
  }

  try {
    const { supabase } = await import('@/lib/supabase');
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const user = userData.user;
    if (!user || user.is_anonymous) {
      const localUsable = !user
        ? local?.version === TERMS_CONSENT_VERSION && isValidConsentTimestamp(local.acceptedAt)
        : local?.version === TERMS_CONSENT_VERSION &&
          isValidConsentTimestamp(local.acceptedAt) &&
          localConsentBelongsToSubject(local, {
            id: user.id,
            kind: 'anonymous',
          });
      return localUsable
        ? { status: 'ready' }
        : { status: 'needs-consent' };
    }

    const server = await loadAccountTermsConsentFromClient(supabase, user.id);
    if (server?.termsVersion === TERMS_CONSENT_VERSION) {
      if (!isValidConsentTimestamp(server.termsAcceptedAt)) {
        return {
          status: 'error',
          message: 'サーバーの利用規約同意日時が不正なため、先へ進めません。再度明示的に同意してください。',
        };
      }
      markTermsConsentRecordedLocally(server.termsAcceptedAt, {
        id: user.id,
        kind: 'permanent',
      });
      return { status: 'ready' };
    }

    // 同一UUIDの匿名→恒久linkだけを移行対象にする。別account、subjectなしの
    // legacy record、version-only recordは本人同意の証明にならないためmodalへ戻す。
    if (
      local?.version === TERMS_CONSENT_VERSION &&
      isValidConsentTimestamp(local.acceptedAt) &&
      localConsentBelongsToSubject(local, { id: user.id, kind: 'permanent' })
    ) {
      const recorded = await recordTermsConsentForAccount();
      if (recorded.ok) {
        markTermsConsentRecordedLocally(recorded.acceptedAt, {
          id: user.id,
          kind: 'permanent',
        });
        return { status: 'ready' };
      }
      return { status: 'error', message: recorded.message };
    }

    return { status: 'needs-consent' };
  } catch {
    return {
      status: 'error',
      message: '利用規約の同意状態を確認できないため、先へ進めません。通信状態を確認して再度お試しください。',
    };
  }
}

/** 匿名利用中の同意を、後から永続アカウントへ明示的に同期する。 */
export async function syncLocalTermsConsentForAccount(): Promise<void> {
  if (!isLiveDataProvider) return;

  const { supabase } = await import('@/lib/supabase');
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user || userData.user.is_anonymous) return;

  const server = await loadAccountTermsConsentFromClient(supabase, userData.user.id);
  if (server?.termsVersion === TERMS_CONSENT_VERSION) {
    if (!isValidConsentTimestamp(server.termsAcceptedAt)) {
      throw new Error('server returned an invalid terms consent timestamp');
    }
    markTermsConsentRecordedLocally(server.termsAcceptedAt, {
      id: userData.user.id,
      kind: 'permanent',
    });
    return;
  }

  const local = readLocalRecord();
  if (
    local?.version !== TERMS_CONSENT_VERSION ||
    !isValidConsentTimestamp(local.acceptedAt) ||
    !localConsentBelongsToSubject(local, {
      id: userData.user.id,
      kind: 'permanent',
    })
  ) {
    const pending = pendingSignInConsent;
    if (
      pending &&
      !pending.claimed &&
      pending.expiresAt >= Date.now() &&
      isValidConsentTimestamp(pending.acceptedAt)
    ) {
      pending.claimed = true;
      try {
        const recorded = await recordTermsConsentForAccount();
        if (!recorded.ok) throw new Error(recorded.message);
        markTermsConsentRecordedLocally(recorded.acceptedAt, {
          id: userData.user.id,
          kind: 'permanent',
        });
        pendingSignInConsent = null;
        return;
      } catch (error) {
        pending.claimed = false;
        throw error;
      }
    }
    return;
  }
  const recorded = await recordTermsConsentForAccount();
  if (!recorded.ok) throw new Error(recorded.message);
  markTermsConsentRecordedLocally(recorded.acceptedAt, {
    id: userData.user.id,
    kind: 'permanent',
  });
}

/** 認証ユーザーの同意を読む。通信障害は既存呼び出しとの互換のためnullで返す。 */
export async function loadAccountTermsConsent(): Promise<AccountTermsConsent | null> {
  if (!isLiveDataProvider) return null;

  try {
    const { supabase } = await import('@/lib/supabase');
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user || userData.user.is_anonymous) return null;
    return await loadAccountTermsConsentFromClient(supabase, userData.user.id);
  } catch {
    return null;
  }
}

type SupabaseClientLike = Awaited<typeof import('@/lib/supabase')>['supabase'];

async function loadAccountTermsConsentFromClient(
  supabase: SupabaseClientLike,
  userId?: string,
): Promise<AccountTermsConsent | null> {
  let query = supabase
    .from('profiles')
    .select('terms_version, terms_accepted_at');
  if (userId) query = query.eq('id', userId);
  const { data: profile, error: profileError } = await query.maybeSingle();
  if (profileError) throw profileError;
  if (!profile || typeof profile.terms_version !== 'string') return null;
  return {
    termsVersion: profile.terms_version,
    termsAcceptedAt: typeof profile.terms_accepted_at === 'string' ? profile.terms_accepted_at : '',
  };
}

function isValidConsentTimestamp(value: string): boolean {
  if (!value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    parsed > 0 &&
    parsed <= Date.now() + CONSENT_CLOCK_SKEW_MS;
}

function readSubjectFields(parsed: object): Pick<LocalTermsConsent, 'subjectId' | 'subjectKind'> {
  const subjectId = (parsed as { subjectId?: unknown }).subjectId;
  const subjectKind = (parsed as { subjectKind?: unknown }).subjectKind;
  if (
    typeof subjectId !== 'string' ||
    !subjectId.trim() ||
    (subjectKind !== 'anonymous' && subjectKind !== 'permanent')
  ) {
    return {};
  }
  return { subjectId: subjectId.trim(), subjectKind };
}

function localConsentBelongsToSubject(
  local: LocalTermsConsent | null,
  subject: TermsConsentSubject,
): boolean {
  if (!local?.subjectId || !local.subjectKind || local.subjectId !== subject.id) return false;
  // 匿名で明示同意した端末記録は、同じUUIDが恒久化された場合だけ引き継げる。
  return local.subjectKind === subject.kind ||
    (local.subjectKind === 'anonymous' && subject.kind === 'permanent');
}
