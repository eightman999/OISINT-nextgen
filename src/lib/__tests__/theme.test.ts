import { describe, expect, it } from 'vitest';

import {
  colors,
  contrastRatio,
  genreColor,
  rankColors,
  readableTextColor,
  sceneColors,
  tagColors,
} from '@/theme';

describe('theme contrast', () => {
  it('keeps semantic foreground tokens at WCAG AA contrast', () => {
    expect(contrastRatio(colors.orange, colors.surfaceSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.textSecondary, colors.surfaceSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.textTertiary, colors.surfaceSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.warning, colors.warningSoft)).toBeGreaterThanOrEqual(4.5);

    Object.values(tagColors).forEach(({ color, background }) => {
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    });

    Object.values(sceneColors).forEach(({ accent, soft }) => {
      expect(contrastRatio(accent, soft)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('chooses AA text for every genre and rank background', () => {
    const genres = [
      'ラーメン',
      'バーガー',
      '寿司',
      'カフェ',
      'ピザ',
      '居酒屋',
      '焼肉',
      'ファミレス',
      '定食',
      'フレンチ',
      undefined,
    ];
    const backgrounds = [...genres.map((genre) => genreColor(genre)), ...rankColors];

    backgrounds.forEach((background) => {
      expect(contrastRatio(readableTextColor(background), background)).toBeGreaterThanOrEqual(4.5);
    });
  });
});
