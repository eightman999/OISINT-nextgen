import { describe, expect, it } from 'vitest';

import { classifyJoinError, joinErrorMessage } from '@/lib/userFacingErrors';

describe('参加エラーの安全な分類', () => {
  it('無効・期限切れ・上限・通信障害を区別する', () => {
    expect(classifyJoinError(new Error('調査が見つかりません'))).toBe('invalid');
    expect(classifyJoinError(new Error('共有リンクの有効期限が切れています'))).toBe('expired');
    expect(classifyJoinError(new Error('参加人数の上限に達しています'))).toBe('capacity');
    expect(classifyJoinError(new Error('fetch failed'))).toBe('network');
  });

  it('内部エラーを表示文へ含めない', () => {
    const message = joinErrorMessage('network');
    expect(message).toContain('通信状態');
    expect(message).not.toMatch(/fetch|stack|token|supabase/i);
  });
});
