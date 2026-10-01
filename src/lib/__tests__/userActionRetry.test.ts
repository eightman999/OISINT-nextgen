import { describe, expect, it } from 'vitest';

import { retryAfterAmbiguousMutation } from '@/lib/userActionRetry';

describe('応答を失った条件変更の再試行方針', () => {
  it('条件追加は同じ書込を再送せずsnapshot更新へ収束する', () => {
    expect(retryAfterAmbiguousMutation('add-requirement')).toBe('refresh');
  });

  it('条件削除も同じ書込を再送せずsnapshot更新へ収束する', () => {
    expect(retryAfterAmbiguousMutation('remove-requirement')).toBe('refresh');
  });
});
