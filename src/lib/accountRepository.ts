import {
  emptyPersonalizationSnapshot,
  type LocalPersonalizationSnapshot,
} from '@/lib/personalization';
import {
  validatePersonalAttributeVector,
  type PersonalAttributeKey,
} from '@/lib/attributeVectors';
import {
  isPersonalizationSourceKind,
  parsePreferenceLearningState,
  preferenceLearningStateForCloud,
  type PreferenceLearningState,
} from '@/lib/preferenceLearning';
import {
  PERSONALIZATION_CONSENT_PURPOSE,
  PERSONALIZATION_CONSENT_VERSION,
  type PersonalizationSaveSource,
} from '@/lib/personalizationConsent';
import { clearPersistedAuthSession } from '@/lib/authStorage';
import { normalizeTrustedOrigin } from '@/lib/trustedOrigins';
import { z } from 'zod';

export interface StoredPreferenceProfile {
  scenarioId: string | null;
  axisScores: LocalPersonalizationSnapshot['scores'];
  likes: string[];
  avoid: string[];
  modelVersion: string;
  sourceKinds: LocalPersonalizationSnapshot['sourceKinds'];
  learningState: PreferenceLearningState;
  consentVersion: string;
  consentPurpose: string;
  consentedAt: string;
  updatedAt: string;
}

/**
 * Full-snapshot writes must carry the revision that was used to build the
 * payload.  Re-reading this value inside saveStoredPreferenceProfile would
 * detach the CAS from the payload and permit stale learning to overwrite a
 * newer feedback event.
 */
export interface PreferenceProfileBaseRevision {
  profileExists: boolean;
  updatedAt: string | null;
}

export interface StoredPersonalAttributeVector {
  attributeKey: PersonalAttributeKey;
  embedding: number[];
  modelVersion: string;
  sourceVersion: string;
  consentVersion: string;
  consentPurpose: string;
  createdAt: string;
  updatedAt: string;
}

export async function loadStoredPreferenceProfile(): Promise<StoredPreferenceProfile | null> {
  const { supabase, user } = await getPermanentUser();
  const { data, error } = await supabase
    .from('user_preference_profiles')
    .select(
      'scenario_id, axis_scores, likes, avoid, model_version, source_kinds, learning_state, consent_version, consent_purpose, consented_at, updated_at',
    )
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw new AccountOperationError('保存済みプロフィールを読み込めませんでした。');
  if (!data) return null;

  const axisScores = data.axis_scores as StoredPreferenceProfile['axisScores'];
  const likes = Array.isArray(data.likes) ? data.likes.filter(isString) : [];
  const avoid = Array.isArray(data.avoid) ? data.avoid.filter(isString) : [];
  const sourceKinds = Array.isArray(data.source_kinds)
    ? data.source_kinds.filter(isPersonalizationSourceKind)
    : [];

  return {
    scenarioId: typeof data.scenario_id === 'string' ? data.scenario_id : null,
    axisScores,
    likes,
    avoid,
    modelVersion: typeof data.model_version === 'string' ? data.model_version : 'unknown',
    sourceKinds,
    learningState: parsePreferenceLearningState(
      data.learning_state,
      axisScores,
      { likes, avoid },
      sourceKinds[0],
    ),
    consentVersion:
      typeof data.consent_version === 'string' ? data.consent_version : 'unknown',
    consentPurpose:
      data.consent_purpose === PERSONALIZATION_CONSENT_PURPOSE
        ? PERSONALIZATION_CONSENT_PURPOSE
        : 'unknown',
    consentedAt: typeof data.consented_at === 'string' ? data.consented_at : '',
    updatedAt: typeof data.updated_at === 'string' ? data.updated_at : '',
  };
}

/** #515: feedback適用前に、永続ユーザーのcloud正本をbaseとして取得する。 */
export async function loadFeedbackLearningBase(): Promise<{
  serverBacked: boolean;
  profileExists: boolean;
  snapshot: LocalPersonalizationSnapshot | null;
}> {
  let authenticated: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    authenticated = await getAuthenticatedUser();
  } catch (error) {
    if (error instanceof AccountOperationError && error.message === '認証が必要です。') {
      return { serverBacked: false, profileExists: false, snapshot: null };
    }
    throw error;
  }
  if (authenticated.user.is_anonymous) {
    return { serverBacked: false, profileExists: false, snapshot: null };
  }
  const stored = await loadStoredPreferenceProfile();
  // cloudに行が無い場合も端末localを正本にしない。別アカウントのlocalStorageを
  // 新しい永続ユーザーへ送らないため、空のサーバー基底からopt-inイベントを適用する。
  return {
    serverBacked: true,
    profileExists: stored !== null,
    snapshot: stored
      ? localSnapshotFromStoredPreferenceProfile(stored)
      : emptyPersonalizationSnapshot(),
  };
}

export async function saveStoredPreferenceProfile(
  snapshot: LocalPersonalizationSnapshot,
  baseRevision: PreferenceProfileBaseRevision,
  source: PersonalizationSaveSource = 'account',
): Promise<void> {
  if (baseRevision.profileExists && !baseRevision.updatedAt) {
    throw new AccountOperationError('保存済みプロフィールの基準版を確認できません。再読み込みしてから再度お試しください。');
  }
  const { supabase } = await getPermanentUser();
  const { error } = await supabase.rpc('save_user_preference_profile', {
    p_scenario_id: snapshot.scenarioId,
    p_axis_scores: snapshot.scores,
    p_likes: snapshot.likes,
    p_avoid: snapshot.avoid,
    p_model_version: snapshot.modelVersion,
    p_source_kinds: snapshot.sourceKinds,
    p_learning_state: preferenceLearningStateForCloud(snapshot.learningState),
    p_consent_version: PERSONALIZATION_CONSENT_VERSION,
    p_save_source: source,
    p_expected_updated_at: baseRevision.profileExists ? baseRevision.updatedAt : null,
    p_base_profile_exists: baseRevision.profileExists,
  });
  if (error?.code === '40001') {
    throw new AccountOperationError('保存済みプロフィールが更新されました。再読み込みしてから再度お試しください。');
  }
  if (error) throw new AccountOperationError('好みプロフィールを保存できませんでした。');
}

/**
 * 明示opt-inされた本人の来店フィードバックだけを、重複receipt付きRPCで保存する。
 * 匿名/未接続時は端末内プロフィールのみを正本とし、サーバーへ送らない。
 */
export async function saveFeedbackLearningProfile(
  snapshot: LocalPersonalizationSnapshot,
  feedbackId: string,
  baseRevision: PreferenceProfileBaseRevision,
): Promise<{
  persisted: boolean;
  applied: boolean;
  conflict?: boolean;
  profileExists?: boolean;
  snapshot?: LocalPersonalizationSnapshot;
}> {
  let authenticated: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    authenticated = await getAuthenticatedUser();
  } catch (error) {
    // 匿名利用・mock previewはローカルプロフィールだけで継続できる。認証情報を
    // 収集するためのフォールバックにはせず、未接続時はサーバーRPCを呼ばない。
    if (error instanceof AccountOperationError && error.message === '認証が必要です。') {
      return { persisted: false, applied: true };
    }
    throw error;
  }
  if (authenticated.user.is_anonymous) return { persisted: false, applied: true };
  if (baseRevision.profileExists && !baseRevision.updatedAt) {
    throw new AccountOperationError('保存済みプロフィールの基準版を確認できません。再読み込みしてから再度お試しください。');
  }

  const { data, error } = await authenticated.supabase.rpc('save_place_feedback_learning', {
    p_feedback_id: feedbackId,
    p_scenario_id: snapshot.scenarioId,
    p_axis_scores: snapshot.scores,
    p_likes: snapshot.likes,
    p_avoid: snapshot.avoid,
    p_learning_state: preferenceLearningStateForCloud(snapshot.learningState),
    p_consent_version: PERSONALIZATION_CONSENT_VERSION,
    p_expected_updated_at: baseRevision.profileExists ? baseRevision.updatedAt : null,
    p_base_profile_exists: baseRevision.profileExists,
  });
  if (error?.code === '40001') {
    // Another same-user writer committed after this snapshot was read. Return
    // the canonical row to the caller so it can recompute this feedback
    // observation instead of treating the conflict as an idempotent duplicate.
    const canonical = await loadStoredPreferenceProfile();
    return {
      persisted: true,
      applied: false,
      conflict: true,
      profileExists: canonical !== null,
      snapshot: canonical
        ? localSnapshotFromStoredPreferenceProfile(canonical)
        : emptyPersonalizationSnapshot(),
    };
  }
  if (error) throw new AccountOperationError('来店後の好み反映を保存できませんでした。');
  if (data === false) {
    // receipt競合時は送信側の古いlocal stateを採用せず、DB正本を再取得して同期する。
    const canonical = await loadStoredPreferenceProfile();
    if (!canonical) throw new AccountOperationError('保存済みプロフィールを同期できませんでした。');
    return {
      persisted: true,
      applied: false,
      conflict: false,
      profileExists: true,
      snapshot: localSnapshotFromStoredPreferenceProfile(canonical),
    };
  }
  // 成功時も送信payloadではなく、RPC後に読み取ったDB正本を端末へ同期する。
  const canonical = await loadStoredPreferenceProfile();
  if (!canonical) throw new AccountOperationError('保存済みプロフィールを同期できませんでした。');
  return {
    persisted: true,
    applied: true,
    conflict: false,
    profileExists: true,
    snapshot: localSnapshotFromStoredPreferenceProfile(canonical),
  };
}

export async function deleteStoredPreferenceProfile(): Promise<void> {
  const { supabase } = await getPermanentUser();
  const { error } = await supabase.rpc('delete_user_preference_profile');
  if (error) throw new AccountOperationError('好みプロフィールを削除できませんでした。');
}

export async function loadPersonalAttributeVectors(): Promise<StoredPersonalAttributeVector[]> {
  const { supabase, user } = await getPermanentUser();
  const { data, error } = await supabase
    .from('user_attribute_vectors')
    .select(
      'attribute_key, embedding, model_version, source_version, consent_version, consent_purpose, created_at, updated_at',
    )
    .eq('user_id', user.id);

  if (error) throw new AccountOperationError('個人属性ベクトルを読み込めませんでした。');

  return (data ?? []).flatMap((row) => {
    const checked = validatePersonalAttributeVector(row.attribute_key, parseVector(row.embedding));
    if (!checked) return [];
    return [{
      attributeKey: checked.attributeKey,
      embedding: checked.embedding,
      modelVersion: typeof row.model_version === 'string' ? row.model_version : 'unknown',
      sourceVersion: typeof row.source_version === 'string' ? row.source_version : 'unknown',
      consentVersion: typeof row.consent_version === 'string' ? row.consent_version : 'unknown',
      consentPurpose: typeof row.consent_purpose === 'string' ? row.consent_purpose : 'unknown',
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
    }];
  });
}

export async function savePersonalAttributeVector(input: {
  attributeKey: PersonalAttributeKey;
  embedding: unknown;
  modelVersion: string;
  sourceVersion: string;
}): Promise<void> {
  const checked = validatePersonalAttributeVector(input.attributeKey, input.embedding);
  if (!checked) throw new AccountOperationError('個人属性ベクトルの形式が不正です。');

  const { supabase } = await getPermanentUser();
  const { error } = await supabase.rpc('save_user_attribute_vector', {
    p_attribute_key: checked.attributeKey,
    p_embedding: checked.embedding,
    p_model_version: input.modelVersion,
    p_source_version: input.sourceVersion,
    p_consent_version: PERSONALIZATION_CONSENT_VERSION,
    p_consent_purpose: PERSONALIZATION_CONSENT_PURPOSE,
  });
  if (error) throw new AccountOperationError('個人属性ベクトルを保存できませんでした。');
}

export interface DeleteAccountResult {
  /** サーバー削除後にローカルAuthセッションの破棄まで完了したか。 */
  localSessionCleared: boolean;
}

export async function deleteAccount(): Promise<DeleteAccountResult> {
  // 匿名認証も本人JWTを持つ利用者であり、#167では匿名利用者の自己削除を許可する。
  // 削除対象はEdge側で検証したJWT subjectから決まり、bodyにはuser idを渡さない。
  const { supabase, user } = await getAuthenticatedUser();
  const origin = normalizeTrustedOrigin(
    process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
    'supabase',
  );
  if (!origin) throw new AccountOperationError('アカウント削除の接続先が設定されていません。');
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const session = sessionData.session;
  if (sessionError || !session?.access_token || session.user?.id !== user.id) {
    throw new AccountOperationError('認証セッションを確認できませんでした。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response: Response;
  try {
    response = await fetch(`${origin}/functions/v1/delete-account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: '{}',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new AccountOperationError(
      controller.signal.aborted
        ? 'アカウント削除がタイムアウトしました。'
        : 'アカウントを削除できませんでした。',
    );
  }
  let responseText: string;
  try {
    responseText = await readAccountDeletionResponseText(response, 16 * 1024);
  } catch {
    throw new AccountOperationError(
      controller.signal.aborted
        ? 'アカウント削除がタイムアウトしました。'
        : 'アカウントを削除できませんでした。',
    );
  } finally {
    clearTimeout(timeout);
  }
  const parsedResponse = accountDeletionResponseSchema.safeParse(
    (() => {
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (response.status !== 200 || !parsedResponse.success) {
    throw new AccountOperationError('アカウントを削除できませんでした。');
  }

  // Edge Function の成功がサーバー削除の正本。ローカルsignOutの失敗で
  // 「削除できなかった」と誤表示しない（ブラウザストレージ障害等でも削除は成立している）。
  try {
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError) {
      clearPersistedAuthSession();
      return { localSessionCleared: false };
    }
    return { localSessionCleared: true };
  } catch {
    clearPersistedAuthSession();
    return { localSessionCleared: false };
  }
}

const accountDeletionResponseSchema = z.object({ deleted: z.literal(true) }).strict();

/** JWT付きdelete-account応答をstream上限・fatal UTF-8で読む。 */
export async function readAccountDeletionResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new Error('削除応答のサイズが不正です');
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('削除応答ストリームを利用できません');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('削除応答が大きすぎます');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('削除応答を解釈できません');
  }
}

export async function saveAccountDisplayName(
  displayName: string,
  avatarUrl: string | null,
): Promise<string> {
  const normalized = displayName.trim().slice(0, 60);
  if (!normalized) throw new AccountOperationError('表示名を入力してください。');

  const { supabase, user } = await getPermanentUser();
  const { error: profileError } = await supabase.from('profiles').upsert({
    id: user.id,
    display_name: normalized,
    avatar_url: avatarUrl,
  });
  if (profileError) throw new AccountOperationError('表示名を保存できませんでした。');

  const { error: authError } = await supabase.auth.updateUser({
    data: { display_name: normalized },
  });
  if (authError) throw new AccountOperationError('表示名を認証プロフィールへ反映できませんでした。');

  return normalized;
}

export class AccountOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountOperationError';
  }
}

async function getPermanentUser() {
  const { supabase, user } = await getAuthenticatedUser();
  if (user.is_anonymous) {
    throw new AccountOperationError('Googleログインが必要です。');
  }
  return { supabase, user };
}

async function getAuthenticatedUser() {
  const { supabase } = await import('@/lib/supabase');
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new AccountOperationError('認証が必要です。');
  }
  return { supabase, user: data.user };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseVector(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // pgvector の返却形式がJSON配列でない場合は、無効データとして扱う。
  }
  return null;
}

export function localSnapshotFromStoredPreferenceProfile(
  profile: StoredPreferenceProfile,
): LocalPersonalizationSnapshot {
  return {
    scenarioId: profile.scenarioId,
    scores: profile.axisScores,
    likes: profile.likes,
    avoid: profile.avoid,
    modelVersion: profile.modelVersion,
    sourceKinds: profile.sourceKinds,
    learningState: profile.learningState,
    updatedAt: profile.updatedAt,
  };
}
