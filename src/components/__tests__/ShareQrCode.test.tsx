// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { buildQrMatrix, ShareQrCode } from '@/components/ShareQrCode';

afterEach(cleanup);

const SHARE_URL = 'https://oisint.com/i/0123456789abcdef0123456789abcdef';

describe('buildQrMatrix', () => {
  // #93: 共有URLを純JSのモジュール行列へ変換する（canvas / Buffer 非依存 §36-5）
  it('QR規格の位置検出パターンを持つ正方行列を返す', () => {
    const matrix = buildQrMatrix(SHARE_URL);

    // QR の最小シンボルは version 1 = 21 モジュール
    expect(matrix.moduleCount).toBeGreaterThanOrEqual(21);
    // 先頭行の最初のセグメントは左上ファインダの上辺（幅7の暗モジュール）
    const firstRowSegments = matrix.segments.filter((segment) => segment.row === 0);
    expect(firstRowSegments[0]).toEqual({ row: 0, col: 0, length: 7 });
    // 先頭行の最後のセグメントは右上ファインダの上辺
    expect(firstRowSegments.at(-1)).toEqual({
      row: 0,
      col: matrix.moduleCount - 7,
      length: 7,
    });
    // 全セグメントが行列の範囲内に収まる
    for (const segment of matrix.segments) {
      expect(segment.row).toBeLessThan(matrix.moduleCount);
      expect(segment.col + segment.length).toBeLessThanOrEqual(matrix.moduleCount);
    }
  });

  it('異なるURLからは異なる行列を生成する', () => {
    const a = buildQrMatrix('https://oisint.com/i/aaaa');
    const b = buildQrMatrix('https://oisint.com/i/bbbb');
    expect(a.segments).not.toEqual(b.segments);
  });
});

describe('ShareQrCode', () => {
  it('QRコードをアクセシブルな画像として表示し、全セグメントを描画する', () => {
    const { getByTestId } = render(<ShareQrCode testID="inv-share-qr" url={SHARE_URL} />);

    const qr = getByTestId('inv-share-qr');
    expect(qr.getAttribute('aria-label')).toContain('参加用QRコード');
    // 描画されたセグメント数が行列計算と一致する（描画配線の回帰検知）
    expect(qr.children.length).toBe(buildQrMatrix(SHARE_URL).segments.length);
  });

  it('URLが変わるとQRの内容も変わる', () => {
    const { getByTestId, rerender } = render(
      <ShareQrCode testID="inv-share-qr" url="https://oisint.com/i/aaaa" />
    );
    const before = getByTestId('inv-share-qr').children.length;

    rerender(<ShareQrCode testID="inv-share-qr" url={SHARE_URL} />);
    expect(getByTestId('inv-share-qr').children.length).not.toBe(before);
  });
});
