import { describe, expect, it } from 'vitest';

import { buildShareUrl } from '@/lib/shareUrl';

describe('buildShareUrl', () => {
  it('URL パラメータの shareToken を優先して参加URLを作る', () => {
    expect(
      buildShareUrl({
        paramToken: 'a'.repeat(32),
        investigationShareToken: 'b'.repeat(32),
        investigationId: 'inv-1',
      })
    ).toBe(`https://oisint.com/i/${'a'.repeat(32)}`);
  });

  it('パラメータが無くても調査本体の share_token で参加URLを作る', () => {
    // 共有URL以外の経路（作成直後の遷移・再読み込み）では shareToken パラメータが無い。
    // ここで id 形式へ落ちると、共有された相手は RLS で何も見られない（§25.4）。
    expect(
      buildShareUrl({
        investigationShareToken: 'b'.repeat(32),
        investigationId: 'inv-1',
      })
    ).toBe(`https://oisint.com/i/${'b'.repeat(32)}`);
  });

  it('token がどちらも無い場合だけ id 形式へ退避する', () => {
    expect(buildShareUrl({ investigationId: 'inv-1' })).toBe(
      'https://oisint.com/investigations/inv-1'
    );
  });

  it('空文字の token は未指定として扱う', () => {
    expect(
      buildShareUrl({
        paramToken: '',
        investigationShareToken: 'b'.repeat(32),
        investigationId: 'inv-1',
      })
    ).toBe(`https://oisint.com/i/${'b'.repeat(32)}`);
  });
});
