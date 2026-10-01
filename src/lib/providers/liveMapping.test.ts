import { describe, expect, it } from 'vitest';

import type { Evidence } from '@/types';

import {
  filterProviderLinkedEvidence,
  isPlaceDisplayable,
  mapCandidateRow,
  type CandidateRow,
} from './liveMapping';

const evidence: Evidence[] = [
  {
    id: 'e-1',
    placeId: 'place-1',
    investigationId: 'inv-1',
    scope: 'investigation',
    sourceType: 'official_site',
    sourceUrl: 'https://example.test/shop',
    sourceTitle: '店舗公式',
    excerpt: '17時から23時まで。カード利用可。',
    structuredClaims: [
      { key: 'opening_hours', value: '17:00-23:00', rawText: '17:00-23:00' },
      { key: 'card_accepted', value: true, rawText: 'カード利用可' },
      { key: 'genre', value: ['焼肉'], rawText: '焼肉' },
      { key: 'budget_dinner', value: { min: 3000, max: 5000 }, rawText: '3000〜5000円' },
    ],
    observedAt: '2026-08-15T00:00:00.000Z',
    sourceQuality: 1,
    freshnessScore: 1,
  },
  {
    id: 'e-2',
    placeId: 'place-1',
    investigationId: null,
    scope: 'shared',
    sourceType: 'major_review_platform',
    sourceUrl: 'https://review.example.test/shop',
    sourceTitle: 'レビュー',
    excerpt: '22時閉店。',
    structuredClaims: [
      { key: 'opening_hours', value: '17:00-22:00', rawText: '17:00-22:00' },
    ],
    observedAt: '2026-08-14T00:00:00.000Z',
    sourceQuality: 0.8,
    freshnessScore: 0.9,
  },
];

const row: CandidateRow = {
  id: 'candidate-1',
  investigation_id: 'inv-1',
  place_id: 'place-1',
  score: 0.82,
  rank: 1,
  summary: null,
  pros: ['過去の類似調査で高評価'],
  cons: [
    {
      placeId: 'place-1',
      key: 'opening_hours',
      entries: [
        { evidenceId: 'e-1', value: '17:00-23:00', sourceQuality: 1 },
        { evidenceId: 'e-2', value: '17:00-22:00', sourceQuality: 0.8 },
      ],
    },
  ],
  places: {
    id: 'place-1',
    name: '店A',
    address: '東京都豊島区池袋1-2-3',
    lat: 35.7,
    lng: 139.7,
    metadata: {
      shopUrl: 'https://example.test/shop',
      photoUrl: 'https://example.test/photo.jpg',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    },
    fallback_image_key: 'demo-yakiniku-v1.jpg',
  },
};

describe('LIVE candidate mapping', () => {
  it('keeps backend pros/cons and place metadata for the UI', () => {
    const candidate = mapCandidateRow(
      row,
      evidence,
      [],
      [],
      new Set(['demo-yakiniku-v1.jpg'])
    );

    expect(candidate.pros).toEqual(['過去の類似調査で高評価']);
    expect(candidate.contradictions).toHaveLength(1);
    expect(candidate.contradictions[0]?.key).toBe('opening_hours');
    expect(candidate.contradictions[0]?.entries).toHaveLength(2);
    expect(candidate.place.urls?.pc).toBe('https://example.test/shop');
    expect(candidate.place.photo).toBe('https://example.test/photo.jpg');
    expect(candidate.place.fallbackImageKey).toBe('demo-yakiniku-v1.jpg');
    expect(candidate.place.googlePlaceId).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(candidate.place.lat).toBe(35.7);
    expect(candidate.place.lng).toBe(139.7);
    expect(candidate.place.budget).toBe('3000〜5000円');
    expect(candidate.place.open).toBe('17:00');
    expect(candidate.place.close).toBe('23:00');
    expect(candidate.place.card).toBe('可');
  });

  it('does not invent precise coordinates when a member/public safe row omits them (#151)', () => {
    const safeRow: CandidateRow = {
      ...row,
      places: row.places
        ? { ...row.places, lat: undefined, lng: undefined }
        : null,
    };
    const candidate = mapCandidateRow(safeRow, evidence, [], []);

    expect(candidate.place.lat).toBeUndefined();
    expect(candidate.place.lng).toBeUndefined();
    expect(candidate.place.address).toBe('東京都豊島区池袋1-2-3');
  });

  it('rejects malformed contradiction payloads without breaking the candidate', () => {
    const candidate = mapCandidateRow({ ...row, cons: [{ key: 'unknown', entries: [] }] }, evidence, [], []);
    expect(candidate.contradictions).toEqual([]);
    expect(candidate.place.name).toBe('店A');
  });

  it('ignores inactive and unknown database image keys', () => {
    const inactive = mapCandidateRow(row, evidence, [], [], new Set());
    const unknown = mapCandidateRow(
      {
        ...row,
        places: row.places
          ? { ...row.places, fallback_image_key: 'demo-unknown-v1.jpg' }
          : null,
      },
      evidence,
      [],
      [],
      new Set(['demo-unknown-v1.jpg'])
    );

    expect(inactive.place.fallbackImageKey).toBeUndefined();
    expect(unknown.place.fallbackImageKey).toBeUndefined();
  });

  it('unions the N02 attribution marker only for rail discovery candidates', () => {
    const rail = mapCandidateRow(
      {
        ...row,
        discovery_context: {
          rail: [{ stationGroupId: 'station-1' }],
          attributionPolicies: ['mlit_n02_attribution'],
        },
      },
      [],
      [],
      [],
    );
    const ordinary = mapCandidateRow({ ...row, discovery_context: {} }, [], [], []);

    expect(rail.place.attributionPolicies).toEqual(['mlit_n02_attribution']);
    expect(ordinary.place.attributionPolicies).toEqual([]);
  });

  it('hides a place whose only provider link is expired or explicitly ephemeral', () => {
    const now = new Date('2026-08-24T00:00:00.000Z');
    const stopped = {
      ...row,
      places: row.places
        ? {
            ...row.places,
            place_provider_links: [{
              id: 'legacy-hotpepper-link',
              provider: 'hotpepper',
              storage_policy: 'ephemeral',
              expires_at: now.toISOString(),
              attribution_policy: 'hotpepper_credit_required',
            }],
          }
        : null,
    };
    const expired = {
      ...stopped,
      places: stopped.places
        ? {
            ...stopped.places,
            place_provider_links: [{
              id: 'legacy-hotpepper-link',
              provider: 'hotpepper',
              storage_policy: 'ttl',
              expires_at: '2026-08-23T23:59:59.000Z',
              attribution_policy: 'hotpepper_credit_required',
            }],
          }
        : null,
    };

    expect(isPlaceDisplayable(stopped.places, now)).toBe(false);
    expect(isPlaceDisplayable(expired.places, now)).toBe(false);
  });

  it('keeps a canonical place when another active link remains and filters stopped-link evidence', () => {
    const now = new Date('2026-08-24T00:00:00.000Z');
    const place = row.places
      ? {
          ...row.places,
          place_provider_links: [
            {
              id: 'legacy-hotpepper-link',
              provider: 'hotpepper',
              storage_policy: 'ephemeral',
              expires_at: now.toISOString(),
              attribution_policy: 'hotpepper_credit_required',
            },
            {
              id: 'geoapify-link',
              provider: 'geoapify',
              storage_policy: 'persistent',
              expires_at: null,
              attribution_policy: 'osm_odbl_attribution',
            },
          ],
        }
      : null;
    const legacy = { ...evidence[0], providerLinkId: 'legacy-hotpepper-link' };
    const current = { ...evidence[1], providerLinkId: 'geoapify-link' };

    expect(isPlaceDisplayable(place, now)).toBe(true);
    expect(filterProviderLinkedEvidence(place, [legacy, current], now).map((item) => item.id)).toEqual([
      'e-2',
    ]);
  });
});
