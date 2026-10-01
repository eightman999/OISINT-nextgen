import { describe, expect, it } from 'vitest';

import {
  GoogleMapsImportError,
  parseGoogleMapsTakeout,
  selectInferredTasteLabels,
  selectInferredTasteSignals,
} from '@/lib/googleMapsImport';

describe('Google Maps Takeout parser', () => {
  it('extracts only aggregate cuisine signals from Saved CSV', () => {
    const csv = [
      'Title,Note,URL,Tags,Comment',
      '吉祥寺の町中華,"餃子が良い, また行きたい",https://maps.google.com/place/35.0,中華,',
      '静かな喫茶店,落ち着く,https://maps.google.com/place/36.0,カフェ,',
    ].join('\n');

    const result = parseGoogleMapsTakeout(csv, '行きたい店.csv');
    const serialized = JSON.stringify(result);

    expect(result.recordCount).toBe(2);
    expect(result.inferredLikes.map((signal) => signal.label)).toEqual(
      expect.arrayContaining(['町中華・中華', 'カフェ', '静かな店']),
    );
    expect(result.inferredLikes.find((signal) => signal.label === '町中華・中華')).toMatchObject({
      origins: expect.arrayContaining(['explicit_tag', 'text_match']),
      confidence: expect.any(Number),
    });
    expect(result.discardedDetailFields).toBe(2);
    expect(serialized).not.toContain('吉祥寺');
    expect(serialized).not.toContain('maps.google.com');
    expect(serialized).not.toContain('35.0');
  });

  it('accepts saved-place GeoJSON while discarding geometry', () => {
    const geoJson = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { Title: '旅先の寿司', Note: '海鮮' },
          geometry: { type: 'Point', coordinates: [139.7, 35.6] },
        },
      ],
    });

    const result = parseGoogleMapsTakeout(geoJson, 'Saved Places.json');
    expect(result.recordCount).toBe(1);
    expect(result.discardedDetailFields).toBe(1);
    expect(result.inferredLikes.map((signal) => signal.label)).toEqual(
      expect.arrayContaining(['寿司', '海鮮']),
    );
    expect(JSON.stringify(result)).not.toContain('139.7');
  });

  it('rejects timeline and location-history exports', () => {
    const history = JSON.stringify({
      timelineObjects: [{ placeVisit: { location: { latitudeE7: 356000000 } } }],
    });

    expect(() => parseGoogleMapsTakeout(history, 'Semantic Location History.json')).toThrowError(
      expect.objectContaining<Partial<GoogleMapsImportError>>({ code: 'location_history' }),
    );
  });

  it('rejects unrelated CSV files', () => {
    expect(() => parseGoogleMapsTakeout('email,phone\na@example.com,123', 'contacts.csv')).toThrow(
      'Google Takeout',
    );
  });

  it('rejects malformed quoted CSV', () => {
    expect(() => parseGoogleMapsTakeout('Title,URL\n"open,https://example.com', 'Saved.csv')).toThrow(
      '引用符',
    );
  });

  it('keeps only user-selected labels from the aggregate preview', () => {
    const summary = parseGoogleMapsTakeout(
      'Title,Tags,URL\n静かな寿司,寿司,https://maps.example/1\n町中華,中華,https://maps.example/2',
      'Saved.csv',
    );

    expect(selectInferredTasteLabels(summary, ['寿司', 'not-in-preview'])).toEqual(['寿司']);
    expect(selectInferredTasteLabels(summary, [])).toEqual([]);
    expect(selectInferredTasteSignals(summary, ['寿司'])[0]).toMatchObject({
      label: '寿司',
      origins: expect.arrayContaining(['explicit_tag']),
    });
  });

  it('reads explicit Tags and list names as stronger, separate evidence', () => {
    const summary = parseGoogleMapsTakeout(
      [
        'Title,Tags,List Name,URL',
        '店その1,"接待,静か",仕事の会食,https://maps.example/1',
        '店その2,静か,落ち着く店,https://maps.example/2',
      ].join('\n'),
      'Saved.csv',
    );

    const quiet = summary.inferredLikes.find((signal) => signal.label === '静かな店');
    const business = summary.inferredLikes.find((signal) => signal.label === '会食・仕事');
    expect(quiet).toMatchObject({
      matches: 2,
      origins: expect.arrayContaining(['explicit_tag', 'list_name']),
    });
    expect(business?.origins).toEqual(expect.arrayContaining(['explicit_tag', 'list_name']));
    expect(quiet!.confidence).toBeGreaterThan(0.8);
  });

  it('keeps only an allow-listed coarse context that co-occurs with a taste signal', () => {
    const summary = parseGoogleMapsTakeout(
      [
        'Title,Tags,List Name,URL',
        '匿名の保存先A,静か,記念日の候補,https://maps.example/private-a',
        '匿名の保存先B,静か,記念日の候補,https://maps.example/private-b',
      ].join('\n'),
      'Saved.csv',
    );
    const serialized = JSON.stringify(summary);
    const quiet = summary.inferredLikes.find((signal) => signal.label === '静かな店');

    expect(quiet).toMatchObject({ contexts: ['special'], matches: 2 });
    expect(serialized).not.toContain('匿名の保存先A');
    expect(serialized).not.toContain('private-a');
    expect(serialized).not.toContain('記念日の候補');
  });

  it('does not make one contextual record redefine a mostly general taste tag', () => {
    const summary = parseGoogleMapsTakeout(
      [
        'Title,Tags,List Name,URL',
        '匿名の保存先A,カフェ,普段の候補,https://maps.example/a',
        '匿名の保存先B,カフェ,普段の候補,https://maps.example/b',
        '匿名の保存先C,カフェ,記念日の候補,https://maps.example/c',
      ].join('\n'),
      'Saved.csv',
    );

    expect(summary.inferredLikes.find((signal) => signal.label === 'カフェ')).toMatchObject({
      matches: 3,
      contexts: [],
    });
  });

  it('does not mistake a context-like store name or filename for a user situation', () => {
    const summary = parseGoogleMapsTakeout(
      'Title,Tags,URL\n家族ひとり食堂,静か,https://maps.example/private',
      '記念日の寿司.csv',
    );

    expect(summary.inferredLikes.find((signal) => signal.label === '静かな店')?.contexts).toEqual(
      [],
    );
    expect(summary.inferredLikes.find((signal) => signal.label === '寿司')?.contexts).toEqual([]);
  });

  it('does not expose an unrecognized personal tag in the aggregate result', () => {
    const summary = parseGoogleMapsTakeout(
      'Title,Tags,URL\n店その1,田中さん専用の秘密メモ,https://maps.example/1',
      'Saved.csv',
    );

    expect(JSON.stringify(summary)).not.toContain('田中');
    expect(summary.inferredLikes).toEqual([]);
  });

  it('accepts JSON tag arrays without retaining their raw values', () => {
    const summary = parseGoogleMapsTakeout(
      JSON.stringify({
        saved: [
          {
            title: '匿名の保存先',
            tags: ['カフェ', '静か', '個人用コードXYZ'],
            url: 'https://maps.example/secret',
          },
        ],
      }),
      'Saved.json',
    );

    expect(summary.inferredLikes.map((signal) => signal.label)).toEqual(
      expect.arrayContaining(['カフェ', '静かな店']),
    );
    expect(JSON.stringify(summary)).not.toContain('個人用コードXYZ');
    expect(JSON.stringify(summary)).not.toContain('maps.example');
  });

  it('normalizes full-width and half-width tag text before allow-list matching', () => {
    const summary = parseGoogleMapsTakeout(
      'Title,Tags\n匿名の店,"ＣＡＦＥ,ｶﾌｪ"',
      'Saved.csv',
    );

    expect(summary.inferredLikes.map((signal) => signal.label)).toContain('カフェ');
    expect(summary.inferredLikes.find((signal) => signal.label === 'カフェ')?.matches).toBe(1);
  });

  it('rejects a file larger than five UTF-8 megabytes before parsing', () => {
    const oversized = 'a'.repeat(5 * 1024 * 1024 + 1);
    expect(() => parseGoogleMapsTakeout(oversized, 'Saved.csv')).toThrowError(
      expect.objectContaining<Partial<GoogleMapsImportError>>({ code: 'too_large' }),
    );
  });

  it('rejects more than five thousand saved records', () => {
    const csv = ['Title', ...Array.from({ length: 5001 }, (_, index) => `カフェ${index}`)].join('\n');
    expect(() => parseGoogleMapsTakeout(csv, 'Saved.csv')).toThrowError(
      expect.objectContaining<Partial<GoogleMapsImportError>>({ code: 'too_large' }),
    );
  });
});
