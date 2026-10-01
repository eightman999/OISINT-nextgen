import { planarDistanceM } from './normalize';
import type {
  LocationScope,
  RailCandidateProvenance,
  RailLineStation,
  RailPlaceCandidate,
  PlaceSearchCandidate,
  ResolvedCorridor,
  ResolvedLine,
  ResolvedStationSet,
  SearchAnchor,
  RailStationGroup,
} from './types';

export interface StationAnchorSource {
  stationGroup: RailStationGroup;
  lineStation?: RailLineStation;
}

export function anchorsFromLine(
  result: ResolvedLine,
  groups: readonly RailStationGroup[],
  radiusMeters = 800,
): SearchAnchor[] {
  if (result.status !== 'resolved' || !result.line || !result.stations) return [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  return result.stations.flatMap((entry) => {
    const group = byId.get(entry.stationGroupId);
    if (!group) return [];
    return [{ stationGroupId: group.id, stationName: group.canonicalName, lat: group.representativePoint[1], lng: group.representativePoint[0], radiusMeters, sourceScope: 'line' as const, lineId: entry.lineId, componentId: entry.componentId, sequence: entry.sequence }];
  });
}

export function anchorsFromCorridor(
  result: ResolvedCorridor,
  groups: readonly RailStationGroup[],
  radiusMeters = 800,
  sourceScope: 'between' | 'corridor' = 'between',
): SearchAnchor[] {
  if (result.status !== 'resolved') return [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  return result.routes.flatMap((route) => route.stations.flatMap((entry) => {
    const group = byId.get(entry.stationGroupId);
    if (!group) return [];
    return [{ stationGroupId: group.id, stationName: group.canonicalName, lat: group.representativePoint[1], lng: group.representativePoint[0], radiusMeters, sourceScope, lineId: entry.lineId, componentId: entry.componentId, sequence: entry.sequence }];
  }));
}

export function anchorsFromStationHops(
  result: ResolvedStationSet,
  groups: readonly RailStationGroup[],
  radiusMeters = 800,
  sourceScope: 'station_hops' | 'any_of' | 'multi_origin' = 'station_hops',
): SearchAnchor[] {
  if (result.status !== 'resolved') return [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  return result.stations.flatMap((entry) => {
    const group = byId.get(entry.stationGroupId);
    if (!group) return [];
    return [{ stationGroupId: group.id, stationName: group.canonicalName, lat: group.representativePoint[1], lng: group.representativePoint[0], radiusMeters, sourceScope, lineId: entry.lineId, componentId: entry.componentId, sequence: entry.sequence }];
  });
}

export function dedupeAnchors(anchors: readonly SearchAnchor[]): SearchAnchor[] {
  const byKey = new Map<string, SearchAnchor>();
  for (const anchor of anchors) {
    const key = `${anchor.stationGroupId}\u0000${anchor.lineId ?? ''}\u0000${anchor.componentId ?? ''}\u0000${anchor.pathKey ?? ''}`;
    const existing = byKey.get(key);
    if (!existing || anchor.radiusMeters > existing.radiusMeters) byKey.set(key, anchor);
  }
  return [...byKey.values()].sort((a, b) => a.stationGroupId.localeCompare(b.stationGroupId) || (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function anchorsForScope(
  scope: LocationScope,
  resolved: ResolvedLine | ResolvedCorridor | ResolvedStationSet,
  groups: readonly RailStationGroup[],
  radiusMeters = 800,
): SearchAnchor[] {
  if (scope.type === 'line') return dedupeAnchors(anchorsFromLine(resolved as ResolvedLine, groups, radiusMeters));
  if (scope.type === 'between' || scope.type === 'corridor') return dedupeAnchors(anchorsFromCorridor(resolved as ResolvedCorridor, groups, radiusMeters, scope.type));
  if (scope.type === 'station_hops') return dedupeAnchors(anchorsFromStationHops(resolved as ResolvedStationSet, groups, radiusMeters));
  if (scope.type === 'any_of' || scope.type === 'multi_origin') return dedupeAnchors(anchorsFromStationHops(resolved as ResolvedStationSet, groups, radiusMeters, scope.type));
  return [];
}

export interface RailPlaceSearch {
  search(anchor: SearchAnchor): Promise<readonly PlaceSearchCandidate[]>;
}

/** Query every anchor, then dedupe while preserving all station provenance. */
export async function discoverRailPlaces(
  anchors: readonly SearchAnchor[],
  searcher: RailPlaceSearch,
): Promise<RailPlaceCandidate[]> {
  const merged = new Map<string, RailPlaceCandidate>();
  for (const anchor of anchors) {
    const candidates = await searcher.search(anchor);
    for (const candidate of candidates) {
      const key = `${candidate.provider}\u0000${candidate.providerPlaceId}`;
      const provenance: RailCandidateProvenance = {
        type: anchor.sourceScope === 'between' || anchor.sourceScope === 'corridor'
          ? 'rail_corridor'
          : anchor.sourceScope === 'station_hops'
          ? 'rail_station_hops'
          : anchor.sourceScope === 'any_of'
          ? 'rail_any_of'
          : anchor.sourceScope === 'multi_origin'
          ? 'rail_multi_origin'
          : 'rail_line',
        lineId: anchor.lineId,
        componentId: anchor.componentId,
        stationGroupId: anchor.stationGroupId,
        stationName: anchor.stationName,
        distanceM: typeof candidate.lat === 'number' && typeof candidate.lng === 'number' ? planarDistanceM([candidate.lng, candidate.lat], [anchor.lng, anchor.lat]) : undefined,
        sequence: anchor.sequence,
        pathKey: anchor.pathKey,
      };
      const existing = merged.get(key);
      if (!existing) merged.set(key, { ...candidate, discoveryContext: [provenance] });
      else if (!existing.discoveryContext.some((entry) => entry.stationGroupId === provenance.stationGroupId && entry.lineId === provenance.lineId && entry.componentId === provenance.componentId && entry.pathKey === provenance.pathKey)) existing.discoveryContext.push(provenance);
    }
  }
  return [...merged.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}
