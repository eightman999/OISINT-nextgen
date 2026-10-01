/// <reference types="node" />

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  deterministicRestaurantImageKey,
  isRestaurantImageKey,
  RESTAURANT_IMAGE_KEYS,
  resolveRestaurantImage,
  restaurantImageKeyForGenre,
} from './restaurantImages';

interface RestaurantImageCatalog {
  schemaVersion: number;
  assetFormat: {
    mimeType: string;
    width: number;
    height: number;
  };
  items: {
    key: string;
    active: boolean;
  }[];
}

const ASSET_DIRECTORY = fileURLToPath(
  new URL('../../assets/demo/restaurants/', import.meta.url)
);

describe('restaurantImages', () => {
  it('defines the complete, unique set of generated restaurant image keys', () => {
    expect(RESTAURANT_IMAGE_KEYS).toEqual([
      'demo-yakiniku-v1.jpg',
      'demo-izakaya-v1.jpg',
      'demo-steak-v1.jpg',
      'demo-sushi-v1.jpg',
      'demo-cafe-v1.jpg',
      'demo-ramen-v1.jpg',
      'demo-italian-v1.jpg',
      'demo-washoku-v1.jpg',
      'demo-chinese-v1.jpg',
      'demo-bistro-v1.jpg',
      'demo-yakitori-v1.jpg',
      'demo-tempura-v1.jpg',
      'demo-soba-v1.jpg',
      'demo-udon-v1.jpg',
      'demo-curry-v1.jpg',
      'demo-korean-v1.jpg',
      'demo-spanish-v1.jpg',
      'demo-seafood-v1.jpg',
      'demo-vegan-v1.jpg',
      'demo-bakery-v1.jpg',
    ]);
    expect(new Set(RESTAURANT_IMAGE_KEYS).size).toBe(20);
  });

  it('keeps the on-disk JPEG asset manifest in sync with the catalog', () => {
    const actualKeys = readdirSync(ASSET_DIRECTORY)
      .filter((name) => /^demo-.+-v1\.jpg$/.test(name))
      .sort();
    const expectedKeys = [...RESTAURANT_IMAGE_KEYS].sort();

    expect(actualKeys).toEqual(expectedKeys);
    for (const key of actualKeys) {
      const path = `${ASSET_DIRECTORY}/${key}`;
      expect(statSync(path).size).toBeGreaterThan(0);
      expect([...readFileSync(path).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  });

  it('keeps catalog.json active items and format aligned with the runtime keys', () => {
    const catalog = JSON.parse(
      readFileSync(`${ASSET_DIRECTORY}/catalog.json`, 'utf8')
    ) as RestaurantImageCatalog;

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.assetFormat).toEqual({
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
    });
    expect(catalog.items).toHaveLength(20);
    expect(catalog.items.every((item) => item.active === true)).toBe(true);
    expect(catalog.items.map((item) => item.key).sort()).toEqual(
      [...RESTAURANT_IMAGE_KEYS].sort()
    );
  });

  it('rejects the retired provider photo without a generated fallback', () => {
    expect(
      resolveRestaurantImage({
        photo: '  https://imgfp.hotp.jp/restaurant.jpg?size=large  ',
        genre: '焼肉',
      })
    ).toEqual({ kind: 'none' });
  });

  it('fails closed for the retired provider image host', () => {
    expect(
      resolveRestaurantImage({
        photo: '  https://IMGFP.HOTP.JP:443/restaurant.jpg?size=large  ',
        genre: '焼肉',
      })
    ).toEqual({ kind: 'none' });
  });

  it('does not display a legacy generated photo key', () => {
    expect(
      resolveRestaurantImage({ photo: 'demo-cafe-v1.jpg', genre: '焼肉' })
    ).toEqual({ kind: 'none' });
  });

  it('does not display generated database overrides', () => {
    expect(
      resolveRestaurantImage({
        photo: 'demo-cafe-v1.jpg',
        fallbackImageKey: 'demo-sushi-v1.jpg',
        genre: '焼肉',
      })
    ).toEqual({ kind: 'none' });
    expect(
      resolveRestaurantImage({
        photo: 'https://imgfp.hotp.jp/provider.jpg',
        fallbackImageKey: 'demo-sushi-v1.jpg',
      })
    ).toEqual({ kind: 'none' });
  });

  it('ignores unknown database image keys', () => {
    expect(
      resolveRestaurantImage({
        fallbackImageKey: 'demo-unknown-v1.jpg',
        genre: '韓国料理',
      })
    ).toEqual({ kind: 'none' });
  });

  it.each([
    'https://images.example.test/restaurant.jpg',
    'https://imgfp.hotp.jp.evil.example/restaurant.jpg',
    'https://127.0.0.1/restaurant.jpg',
    'https://localhost/restaurant.jpg',
    'https://user:secret@imgfp.hotp.jp/restaurant.jpg',
    'https://imgfp.hotp.jp:8443/restaurant.jpg',
    'https://imgfp.hotp.jp\\@evil.com/restaurant.jpg',
    'https://imgfp.hotp.jp\n@evil.com/restaurant.jpg',
  ])('does not request an untrusted remote image URL: %s', (photo) => {
    expect(resolveRestaurantImage({ photo, genre: '寿司' })).toEqual({ kind: 'none' });
  });

  it.each([
    ['焼き肉・ホルモン', 'demo-yakiniku-v1.jpg'],
    ['大衆酒場', 'demo-izakaya-v1.jpg'],
    ['鉄板焼き', 'demo-steak-v1.jpg'],
    ['江戸前鮨', 'demo-sushi-v1.jpg'],
    ['喫茶店・スイーツ', 'demo-cafe-v1.jpg'],
    ['中華そば', 'demo-ramen-v1.jpg'],
    ['台湾まぜそば', 'demo-ramen-v1.jpg'],
    ['油そば', 'demo-ramen-v1.jpg'],
    ['イタリアンバル', 'demo-italian-v1.jpg'],
    ['日本料理・懐石', 'demo-washoku-v1.jpg'],
    ['四川料理', 'demo-chinese-v1.jpg'],
    ['フレンチビストロ', 'demo-bistro-v1.jpg'],
    ['焼き鳥・串焼き', 'demo-yakitori-v1.jpg'],
    ['天麩羅専門店', 'demo-tempura-v1.jpg'],
    ['手打ち蕎麦', 'demo-soba-v1.jpg'],
    ['讃岐うどん', 'demo-udon-v1.jpg'],
    ['スープカレー', 'demo-curry-v1.jpg'],
    ['韓国家庭料理', 'demo-korean-v1.jpg'],
    ['スペインバル', 'demo-spanish-v1.jpg'],
    ['魚介・シーフード', 'demo-seafood-v1.jpg'],
    ['ヴィーガン・野菜料理', 'demo-vegan-v1.jpg'],
    ['街のパン屋', 'demo-bakery-v1.jpg'],
    ['ヴィーガンカフェ', 'demo-vegan-v1.jpg'],
    ['パンケーキ', 'demo-cafe-v1.jpg'],
    ['フレンチトースト', 'demo-cafe-v1.jpg'],
    ['カレーパン専門店', 'demo-bakery-v1.jpg'],
    ['パン', 'demo-bakery-v1.jpg'],
    ['カレーうどん', 'demo-udon-v1.jpg'],
    ['天ぷらそば', 'demo-soba-v1.jpg'],
  ] as const)('maps genre alias %s to %s', (genre, expectedKey) => {
    expect(restaurantImageKeyForGenre(genre)).toBe(expectedKey);
  });

  it('does not treat the パン substring in シャンパン as a bakery alias', () => {
    expect(restaurantImageKeyForGenre('シャンパンバー')).toBeUndefined();
  });

  it('does not display genre images for missing or invalid photos', () => {
    expect(resolveRestaurantImage({ genre: 'ラーメン' })).toEqual({ kind: 'none' });
    expect(resolveRestaurantImage({ photo: 'not-a-known-key', genre: '中華料理' })).toEqual({ kind: 'none' });
    expect(resolveRestaurantImage({ photo: 'http://example.test/photo.jpg', genre: '和食' })).toEqual({ kind: 'none' });
  });

  it('displays no image for unknown or missing genres', () => {
    const unknownGenre = resolveRestaurantImage({ genre: '創作料理' });
    const repeatedGenre = resolveRestaurantImage({ genre: '創作料理' });
    const missingGenre = resolveRestaurantImage({ fallbackSeed: 'place-123' });

    expect(unknownGenre).toEqual(repeatedGenre);
    expect(unknownGenre).toEqual({ kind: 'none' });
    expect(missingGenre).toEqual({ kind: 'none' });
  });

  it('normalizes fallback seeds deterministically', () => {
    expect(deterministicRestaurantImageKey(' ＣＡＦＥ－ＢＡＲ ')).toBe(
      deterministicRestaurantImageKey('cafe bar')
    );
    expect(deterministicRestaurantImageKey('place-123')).toBe('demo-washoku-v1.jpg');
  });

  it('rejects legacy, unknown, and malformed keys', () => {
    expect(isRestaurantImageKey('demo-yakiniku-v1.jpg')).toBe(true);
    expect(isRestaurantImageKey(' demo-yakiniku-v1.jpg ')).toBe(false);
    expect(isRestaurantImageKey('demo-yakiniku-v1')).toBe(false);
    expect(isRestaurantImageKey('demo-unknown-v1.jpg')).toBe(false);
  });
});
