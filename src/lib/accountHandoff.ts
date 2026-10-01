import { z } from 'zod';

import { isLiveDataProvider } from '@/lib/api';

// operation_idは復旧トークンではない。匿名JWTにより予約されたDB行を指すだけで、
// これを知っていても現在のGoogle連携済みJWTなしには完了できない。
export const ACCOUNT_HANDOFF_STORAGE_KEY = 'oisint:account-handoff:v1';
const PENDING_OPERATION_MAX_AGE_MS = 15 * 60 * 1000;
let memoryPendingOperation: PendingAccountHandoff | null = null;

const pendingOperationSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  subjectId: z.string().min(1).max(128),
  createdAt: z.number().finite().int().nonnegative(),
}).strict();

const completionSchema = z.object({
  status: z.enum(['completed', 'already_completed']),
}).strict();

export type PendingAccountHandoff = z.infer<typeof pendingOperationSchema>;

function removePendingOperation(): void {
  memoryPendingOperation = null;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ACCOUNT_HANDOFF_STORAGE_KEY);
  } catch {
    // localStorageは補助状態であり、削除不能でも認証状態を変更しない。
  }
}

export function clearPendingAccountHandoff(): void {
  removePendingOperation();
}

export function loadPendingAccountHandoff(now = Date.now()): PendingAccountHandoff | null {
  if (typeof window === 'undefined') {
    if (
      memoryPendingOperation &&
      (memoryPendingOperation.createdAt > now ||
        now - memoryPendingOperation.createdAt > PENDING_OPERATION_MAX_AGE_MS)
    ) {
      memoryPendingOperation = null;
    }
    return memoryPendingOperation;
  }
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ACCOUNT_HANDOFF_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    removePendingOperation();
    return null;
  }
  const parsed = pendingOperationSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.createdAt > now ||
    now - parsed.data.createdAt > PENDING_OPERATION_MAX_AGE_MS
  ) {
    removePendingOperation();
    return null;
  }
  return parsed.data;
}

/**
 * 匿名JWTでサーバーから操作IDを予約し、OAuth redirectをまたぐ端末状態へ保存する。
 * userIdは保存時の照合ヒントにすぎず、Edge/RPCの認証には使わない。
 */
export async function prepareGoogleAccountHandoff(subjectId: string): Promise<boolean> {
  if (!isLiveDataProvider) return false;
  if (typeof subjectId !== 'string' || subjectId.length < 1 || subjectId.length > 128) {
    return false;
  }

  const { supabase } = await import('@/lib/supabase');
  const { data, error } = await supabase.rpc('prepare_account_handoff');
  if (error) throw new Error('account handoff preparation failed');
  const operationId = z.string().uuid().safeParse(Array.isArray(data) ? data[0] : data);
  if (!operationId.success) throw new Error('account handoff preparation returned invalid data');

  const record: PendingAccountHandoff = {
    version: 1,
    operationId: operationId.data,
    subjectId,
    createdAt: Date.now(),
  };
  memoryPendingOperation = record;
  if (typeof window === 'undefined') return true;
  try {
    window.localStorage.setItem(ACCOUNT_HANDOFF_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // OAuthを開始したのに完了監査へ到達できない状態を作らない。
    throw new Error('account handoff state unavailable');
  }
  return true;
}

export type CompleteAccountHandoffResult =
  | { status: 'completed' | 'already_completed' }
  | { status: 'none' };

/** 永続化済み同一subjectのJWTだけで完了Edgeを呼び、成功後にpendingを消す。 */
export async function completePendingAccountHandoff(
  subjectId: string,
): Promise<CompleteAccountHandoffResult> {
  if (!isLiveDataProvider) {
    return { status: 'none' };
  }
  const pending = loadPendingAccountHandoff();
  if (!pending) return { status: 'none' };
  if (pending.subjectId !== subjectId) {
    // 別subjectへ操作IDを持ち越さない。サーバーへは送信しない。
    removePendingOperation();
    return { status: 'none' };
  }

  const { supabase } = await import('@/lib/supabase');
  const { data, error } = await supabase.functions.invoke('complete-account-handoff', {
    body: { operationId: pending.operationId },
  });
  if (error) throw new Error('account handoff completion failed');
  const completion = completionSchema.safeParse(data);
  if (!completion.success) throw new Error('account handoff completion returned invalid data');
  removePendingOperation();
  return completion.data;
}
