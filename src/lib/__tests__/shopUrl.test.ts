import { describe, expect, it } from 'vitest';

import { safeShopUrl } from '@/lib/shopUrl';

// 店舗ページ・予約導線 URL の入力検証（§3 P1 / #109）。
// places.metadata.shopUrl は DB 由来の外部入力なので https 以外は fail closed で捨てる。
describe('safeShopUrl', () => {
  it('passes through https URLs unchanged', () => {
    expect(safeShopUrl('https://example.com/shop-a')).toBe('https://example.com/shop-a');
  });

  it('rejects retired HotPepper URLs and non-https schemes', () => {
    expect(safeShopUrl('https://www.hotpepper.jp/strJ000000000/')).toBeNull();
    expect(safeShopUrl('https://foo.hotpepper.jp/strJ000000000/')).toBeNull();
    expect(safeShopUrl('http://example.com/shop-a')).toBeNull();
    expect(safeShopUrl('javascript:alert(1)')).toBeNull();
    expect(safeShopUrl('data:text/html,x')).toBeNull();
  });

  it('rejects empty, undefined, and unparsable values', () => {
    expect(safeShopUrl(undefined)).toBeNull();
    expect(safeShopUrl(null)).toBeNull();
    expect(safeShopUrl('')).toBeNull();
    expect(safeShopUrl('not a url')).toBeNull();
  });
});
