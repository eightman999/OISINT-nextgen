import { describe, expect, it } from 'vitest';

import {
  buildCanonicalRailModel,
  createRailResolver,
  anchorsFromLine,
  anchorsFromStationHops,
  anchorsForScope,
  discoverRailPlaces,
  type RailDatasetVersion,
  type RailLine,
  type RailStationRecord,
} from '@/lib/rail';

const dataset: RailDatasetVersion = {
  id: 'N02-2025-fixture',
  provider: 'mlit_n02',
  datasetId: 'N02-2025-fixture',
  datasetYear: 2025,
  dataAsOf: '2025-12-31',
  retrievedAt: '2026-08-19T00:00:00Z',
  sourceUrl: 'https://example.test/N02-2025.zip',
  license: 'CC-BY-4.0',
  contentSha256: 'a'.repeat(64),
  parserVersion: 'test',
  normalizerVersion: 'test',
};

function line(id: string, name: string, operator = 'Fixture鉄道', geometry: readonly (readonly [number, number])[][]): Omit<RailLine, 'componentIds' | 'bbox'> {
  return {
    id,
    datasetVersionId: dataset.id,
    operatorName: operator,
    operatorKey: operator.toLocaleLowerCase('ja-JP'),
    lineName: name,
    lineKey: name.toLocaleLowerCase('ja-JP'),
    railwayType: '1',
    operatorType: '1',
    geometry,
    metadata: {},
  };
}

function station(id: string, code: string, name: string, lineName: string, point: [number, number], groupCode = code, operator = 'Fixture鉄道'): RailStationRecord {
  return {
    id,
    datasetVersionId: dataset.id,
    sourceStationCode: code,
    sourceGroupCode: groupCode,
    stationName: name,
    stationNameKey: name.replace(/駅$/, '').toLocaleLowerCase('ja-JP'),
    operatorName: operator,
    operatorKey: operator.toLocaleLowerCase('ja-JP'),
    lineName,
    lineKey: lineName.toLocaleLowerCase('ja-JP'),
    railwayType: '1',
    operatorType: '1',
    geometry: point,
    representativePoint: point,
    rawProperties: { N02_005: name },
  };
}

function model() {
  const lines = [
    line('simple', 'Fixture線', 'Fixture鉄道', [[[139.70, 35.70], [139.71, 35.70], [139.72, 35.70], [139.73, 35.70]]]),
    line('ring', '環状試験線', 'Fixture鉄道', [[[139.70, 35.71], [139.71, 35.72], [139.72, 35.71], [139.70, 35.71]]]),
    line('branch', '枝線', 'Fixture鉄道', [[[139.80, 35.70], [139.81, 35.70]], [[139.81, 35.70], [139.82, 35.71]], [[139.81, 35.70], [139.82, 35.69]]]),
    line('same-a', '同名線', 'A社', [[[139.60, 35.60], [139.61, 35.60]]]),
    line('same-b', '同名線', 'B社', [[[140.00, 36.00], [140.01, 36.00]]]),
  ];
  const records = [
    station('s1', '1', '池袋', 'Fixture線', [139.7002, 35.70], 'g1'),
    station('s2', '2', '中間', 'Fixture線', [139.715, 35.70], 'g2'),
    station('s3', '3', '所沢', 'Fixture線', [139.725, 35.70], 'g3'),
    station('l1', '4', '環状駅A', '環状試験線', [139.7005, 35.7105], 'g4'),
    station('l2', '5', '環状駅B', '環状試験線', [139.7105, 35.7195], 'g5'),
    station('b1', '6', '枝起点', '枝線', [139.8005, 35.70], 'g6'),
    station('b2', '7', '枝終点', '枝線', [139.8195, 35.71], 'g7'),
    station('a1', '8', '中央', '同名線', [139.605, 35.60], 'g8', 'A社'),
    station('b3', '9', '中央', '同名線', [140.005, 36.00], 'g9', 'B社'),
  ];
  return buildCanonicalRailModel({ datasetVersion: dataset, lines, stationRecords: records, maxGroupDistanceM: 300 });
}

describe('N02 canonical graph and resolver', () => {
  it('simple component sequence is dense and graph-derived', () => {
    const built = model();
    const entries = built.lineStations.filter((entry) => entry.lineId === 'simple').sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
    expect(entries.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.stationGroupId)).toEqual([
      expect.stringContaining('g1'),
      expect.stringContaining('g2'),
      expect.stringContaining('g3'),
    ]);
  });

  it('detects loop and does not silently select one between route', () => {
    const built = model();
    expect(built.graph.loopComponents).toContain('ring:c0');
    const resolver = createRailResolver(built);
    const result = resolver.resolveBetween({ from: '環状駅A', to: '環状駅B', line: '環状試験線' });
    expect(result.status).toBe('ambiguous');
    expect(result.routes.length).toBe(2);
  });

  it('ambiguous same-name line is not guessed', () => {
    const resolver = createRailResolver(model());
    expect(resolver.resolveLine({ line: '同名線' }).status).toBe('ambiguous');
    expect(resolver.resolveLine({ line: '同名線', operator: 'A社' }).status).toBe('resolved');
  });

  it('between and station hops are deterministic', () => {
    const built = model();
    const resolver = createRailResolver(built);
    const between = resolver.resolveBetween({ from: '池袋', to: '所沢', line: 'Fixture線' });
    expect(between.status).toBe('resolved');
    expect(between.routes[0].stations.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    const hops = resolver.resolveStationHops({ origin: '中間', maxStops: 1, line: 'Fixture線' });
    expect(hops.status).toBe('resolved');
    expect(new Set(hops.stations.map((entry) => entry.stationGroupId)).size).toBe(3);
    const lineResult = resolver.resolveLine({ line: 'Fixture線' });
    expect(anchorsFromLine(lineResult, built.stationGroups)).toHaveLength(3);
    expect(anchorsFromStationHops(hops, built.stationGroups)).toHaveLength(3);
  });

  it('any_of and multi_origin preserve every named place without fair-distance guessing', () => {
    const built = model();
    const resolver = createRailResolver(built);
    const alternatives = resolver.resolveAnyOf({ places: ['池袋', '所沢'] });
    expect(alternatives.status).toBe('resolved');
    expect(alternatives.origins?.map((entry) => entry.station?.canonicalName)).toEqual(['池袋', '所沢']);
    const alternativeAnchors = anchorsForScope({ type: 'any_of', places: ['池袋', '所沢'] }, alternatives, built.stationGroups);
    expect(new Set(alternativeAnchors.map((anchor) => anchor.stationGroupId)).size).toBe(2);
    expect(alternativeAnchors.every((anchor) => anchor.sourceScope === 'any_of')).toBe(true);

    const corridor = resolver.resolveBetween({ from: '池袋', to: '所沢', line: 'Fixture線' });
    const corridorAnchors = anchorsForScope({ type: 'corridor', from: '池袋', to: '所沢' }, corridor, built.stationGroups);
    expect(corridorAnchors.every((anchor) => anchor.sourceScope === 'corridor')).toBe(true);

    const origins = resolver.resolveMultiOrigin({ origins: ['池袋', '所沢'] });
    expect(origins.status).toBe('resolved');
    expect(origins.origins?.map((entry) => entry.station?.canonicalName)).toEqual(['池袋', '所沢']);
    const originAnchors = anchorsForScope({ type: 'multi_origin', origins: ['池袋', '所沢'] }, origins, built.stationGroups);
    expect(new Set(originAnchors.map((anchor) => anchor.stationGroupId)).size).toBe(2);
    expect(originAnchors.every((anchor) => anchor.sourceScope === 'multi_origin')).toBe(true);
  });

  it('any_of fails closed when one named place is not in the dataset', () => {
    const resolver = createRailResolver(model());
    const result = resolver.resolveAnyOf({ places: ['池袋', '存在しない駅'] });
    expect(result.status).toBe('not_found');
    expect(result.stations).toHaveLength(0);
  });

  it('branch between is not collapsed into a fabricated sequence', () => {
    const resolver = createRailResolver(model());
    const result = resolver.resolveBetween({ from: '枝起点', to: '枝終点', line: '枝線' });
    expect(result.status).toBe('not_found');
    expect(result.reason).toContain('同一路線上');
  });

  it('multi-anchor discovery dedupes and preserves source station provenance', async () => {
    const built = model();
    const resolver = createRailResolver(built);
    const lineResult = resolver.resolveLine({ line: 'Fixture線' });
    const anchors = anchorsFromLine(lineResult, built.stationGroups);
    const candidates = await discoverRailPlaces(anchors, { search: async (anchor) => [{ provider: 'fixture', providerPlaceId: anchor.stationGroupId === anchors[0].stationGroupId ? 'p1' : 'p1', name: '店', lat: anchor.lat, lng: anchor.lng }] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].discoveryContext).toHaveLength(3);
  });
});
