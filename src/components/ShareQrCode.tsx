import QRCode from 'qrcode';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius } from '@/theme';

// #93 / spec.md §25.4: 調査画面に共有URLの QR コードを表示する。
// qrcode の create() は純 JS でモジュール行列を返すため canvas / Buffer に依存せず、
// web / native を同一コードで描画できる（§36-5: プラットフォームで分岐させない）。
// 描画は行ごとに連続する暗モジュールを 1 本のセグメントへまとめて View 数を抑える。

// QR 規格の静止域（quiet zone）。シンボルの周囲に明モジュール4個分の余白を確保する。
const QUIET_ZONE_MODULES = 4;

export interface QrSegment {
  row: number;
  col: number;
  length: number;
}

export interface QrMatrix {
  moduleCount: number;
  segments: QrSegment[];
}

// 共有URL → QR モジュール行列（行内の連続暗モジュールをセグメント化したもの）。
// 誤り訂正レベルは印刷でなく画面表示のため標準の M で十分。
export function buildQrMatrix(text: string): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const segments: QrSegment[] = [];
  for (let row = 0; row < modules.size; row += 1) {
    let col = 0;
    while (col < modules.size) {
      if (!modules.get(row, col)) {
        col += 1;
        continue;
      }
      let length = 1;
      while (col + length < modules.size && modules.get(row, col + length)) {
        length += 1;
      }
      segments.push({ row, col, length });
      col += length;
    }
  }
  return { moduleCount: modules.size, segments };
}

interface ShareQrCodeProps {
  url: string;
  size?: number;
  testID?: string;
}

export function ShareQrCode({ url, size = 132, testID }: ShareQrCodeProps) {
  const matrix = useMemo(() => {
    try {
      return buildQrMatrix(url);
    } catch {
      // QR 生成失敗（容量超過の長大URL等）でも共有画面全体は壊さない
      return null;
    }
  }, [url]);

  if (!matrix) return null;

  const cell = size / (matrix.moduleCount + QUIET_ZONE_MODULES * 2);
  const offset = cell * QUIET_ZONE_MODULES;

  return (
    <View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel="参加用QRコード。読み取ると共有URLからこの調査へ参加できます"
      style={[styles.container, { width: size, height: size }]}
    >
      {matrix.segments.map((segment) => (
        <View
          key={`${segment.row}-${segment.col}`}
          style={[
            styles.segment,
            {
              top: offset + segment.row * cell,
              left: offset + segment.col * cell,
              width: segment.length * cell,
              height: cell,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // 読み取りコントラスト確保のため QR 本体は純白 / 純黒固定（colors.white / colors.pureBlack）
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  segment: {
    position: 'absolute',
    backgroundColor: colors.pureBlack,
  },
});
