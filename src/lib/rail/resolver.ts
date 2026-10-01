import { lineNameKey, operatorKey, stationNameKey } from './normalize';
import type {
  LocationScope,
  RailDatasetVersion,
  RailLine,
  RailLineAlias,
  RailLineComponent,
  RailLineStation,
  RailStationLink,
  RailStationAlias,
  RailStationGroup,
  ResolvedCorridor,
  ResolvedLine,
  ResolvedStation,
  ResolvedStationSet,
  CorridorRoute,
} from './types';
import type { RailGraph } from './graph';

export interface RailResolverData {
  datasetVersion: RailDatasetVersion;
  lines: readonly RailLine[];
  components: readonly RailLineComponent[];
  stationGroups: readonly RailStationGroup[];
  stationAliases: readonly RailStationAlias[];
  lineAliases: readonly RailLineAlias[];
  lineStations: readonly RailLineStation[];
  stationLinks?: readonly RailStationLink[];
  graph?: RailGraph;
}

export interface LineInput {
  line: string;
  operator?: string;
}

export interface StationInput {
  station: string;
  line?: string;
  operator?: string;
}

export interface BetweenInput {
  from: string;
  to: string;
  line?: string;
}

export interface StationHopInput {
  origin: string;
  maxStops: number;
  line?: string;
}

export interface AnyOfInput {
  places: readonly string[];
}

export interface MultiOriginInput {
  origins: readonly string[];
}

export interface RailLocationResolver {
  resolveLine(input: LineInput): ResolvedLine;
  resolveStation(input: StationInput): ResolvedStation;
  resolveBetween(input: BetweenInput): ResolvedCorridor;
  resolveStationHops(input: StationHopInput): ResolvedStationSet;
  resolveAnyOf(input: AnyOfInput): ResolvedStationSet;
  resolveMultiOrigin(input: MultiOriginInput): ResolvedStationSet;
  resolveScope(scope: LocationScope): ResolvedLine | ResolvedCorridor | ResolvedStationSet | { status: 'unsupported'; reason: string };
}

function resultVersion(data: RailResolverData): RailDatasetVersion {
  return data.datasetVersion;
}

function lineMatches(line: RailLine, raw: string, operator?: string, aliases: readonly RailLineAlias[] = []): boolean {
  const query = lineNameKey(raw);
  const operatorQuery = operator ? operatorKey(operator) : null;
  const aliasHit = aliases.some((alias) => alias.lineId === line.id && alias.aliasKey === query);
  const nameHit = line.lineKey === query || lineNameKey(line.lineName) === query;
  const opHit = !operatorQuery || line.operatorKey === operatorQuery;
  return opHit && (nameHit || aliasHit);
}

function stationMatches(group: RailStationGroup, raw: string, aliases: readonly RailStationAlias[]): boolean {
  const query = stationNameKey(raw);
  return group.nameKey === query || aliases.some((alias) => alias.stationGroupId === group.id && alias.aliasKey === query);
}

function lineStationsFor(data: RailResolverData, lineId: string, componentId?: string): RailLineStation[] {
  return data.lineStations
    .filter((entry) => entry.lineId === lineId && (!componentId || entry.componentId === componentId))
    .slice()
    .sort((a, b) => (a.sequence ?? Number.POSITIVE_INFINITY) - (b.sequence ?? Number.POSITIVE_INFINITY) || a.stationGroupId.localeCompare(b.stationGroupId));
}

function lineForId(data: RailResolverData, lineId: string): RailLine | undefined {
  return data.lines.find((line) => line.id === lineId);
}

function stationMemberships(data: RailResolverData, stationId: string, lineId?: string): RailLineStation[] {
  return data.lineStations.filter((entry) => entry.stationGroupId === stationId && (!lineId || entry.lineId === lineId));
}

function stationLinksFor(data: RailResolverData, lineId: string, componentId: string): RailStationLink[] {
  return (data.stationLinks ?? []).filter((link) => link.lineId === lineId && link.componentId === componentId);
}

function enumerateStationPaths(
  links: readonly RailStationLink[],
  from: string,
  to: string,
  maxPaths = 2,
): RailStationLink[][] {
  const outgoing = new Map<string, RailStationLink[]>();
  for (const link of links) outgoing.set(link.fromStationGroupId, [...(outgoing.get(link.fromStationGroupId) ?? []), link]);
  for (const current of outgoing.values()) current.sort((a, b) => a.toStationGroupId.localeCompare(b.toStationGroupId) || a.id.localeCompare(b.id));
  const paths: RailStationLink[][] = [];
  const visit = (current: string, groups: Set<string>, path: RailStationLink[]) => {
    if (paths.length >= maxPaths) return;
    if (current === to) {
      paths.push(path);
      return;
    }
    for (const link of outgoing.get(current) ?? []) {
      if (groups.has(link.toStationGroupId)) continue;
      groups.add(link.toStationGroupId);
      visit(link.toStationGroupId, groups, [...path, link]);
      groups.delete(link.toStationGroupId);
    }
  };
  visit(from, new Set([from]), []);
  return paths;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export class InMemoryRailLocationResolver implements RailLocationResolver {
  constructor(private readonly data: RailResolverData) {}

  resolveLine(input: LineInput): ResolvedLine {
    const candidates = this.data.lines.filter((line) => lineMatches(line, input.line, input.operator, this.data.lineAliases));
    if (candidates.length === 0) {
      return { status: 'not_found', input: input.line, datasetVersion: resultVersion(this.data), reason: '路線が見つかりません' };
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', input: input.line, candidates, datasetVersion: resultVersion(this.data), reason: '路線候補が複数あります。事業者または路線を指定してください' };
    }
    const line = candidates[0];
    return { status: 'resolved', input: input.line, line, stations: lineStationsFor(this.data, line.id), datasetVersion: resultVersion(this.data) };
  }

  resolveStation(input: StationInput): ResolvedStation {
    const query = stationNameKey(input.station);
    let candidates = this.data.stationGroups.filter((station) => stationMatches(station, query, this.data.stationAliases));
    if (input.line || input.operator) {
      const lines = this.data.lines.filter((line) => {
        const operatorMatch = !input.operator || line.operatorKey === operatorKey(input.operator);
        return operatorMatch && (!input.line || lineMatches(line, input.line, input.operator, this.data.lineAliases));
      });
      const lineIds = new Set(lines.map((line) => line.id));
      candidates = candidates.filter((station) => stationMemberships(this.data, station.id).some((entry) => lineIds.has(entry.lineId)));
    }
    if (candidates.length === 0) return { status: 'not_found', input: input.station, datasetVersion: resultVersion(this.data), reason: '駅が見つかりません' };
    if (candidates.length > 1) return { status: 'ambiguous', input: input.station, candidates, datasetVersion: resultVersion(this.data), reason: '駅候補が複数あります' };
    return { status: 'resolved', input: input.station, station: candidates[0], datasetVersion: resultVersion(this.data) };
  }

  resolveBetween(input: BetweenInput): ResolvedCorridor {
    const fromCandidates = this.data.stationGroups.filter((station) => stationMatches(station, input.from, this.data.stationAliases));
    const toCandidates = this.data.stationGroups.filter((station) => stationMatches(station, input.to, this.data.stationAliases));
    const from = fromCandidates.length === 1
      ? { status: 'resolved' as const, input: input.from, station: fromCandidates[0], datasetVersion: resultVersion(this.data) }
      : { status: fromCandidates.length > 1 ? 'ambiguous' as const : 'not_found' as const, input: input.from, candidates: fromCandidates, datasetVersion: resultVersion(this.data), reason: fromCandidates.length > 1 ? '出発駅候補が複数あります' : '出発駅が見つかりません' };
    const to = toCandidates.length === 1
      ? { status: 'resolved' as const, input: input.to, station: toCandidates[0], datasetVersion: resultVersion(this.data) }
      : { status: toCandidates.length > 1 ? 'ambiguous' as const : 'not_found' as const, input: input.to, candidates: toCandidates, datasetVersion: resultVersion(this.data), reason: toCandidates.length > 1 ? '到着駅候補が複数あります' : '到着駅が見つかりません' };
    const lineIds = input.line
      ? new Set(this.data.lines.filter((line) => lineMatches(line, input.line!, undefined, this.data.lineAliases)).map((line) => line.id))
      : null;
    const fromIds = new Set(fromCandidates.filter((station) => !lineIds || stationMemberships(this.data, station.id).some((entry) => lineIds.has(entry.lineId))).map((station) => station.id));
    const toIds = new Set(toCandidates.filter((station) => !lineIds || stationMemberships(this.data, station.id).some((entry) => lineIds.has(entry.lineId))).map((station) => station.id));
    const pairs = fromCandidates.flatMap((fromStation) =>
      toCandidates.filter((toStation) => fromIds.has(fromStation.id) && toIds.has(toStation.id)).flatMap((toStation) => {
        const fromEntries = stationMemberships(this.data, fromStation.id);
        const toEntries = stationMemberships(this.data, toStation.id);
        return fromEntries.filter((left) =>
          (!lineIds || lineIds.has(left.lineId)) &&
          toEntries.some((right) => right.lineId === left.lineId && right.componentId === left.componentId && right.pathKey === left.pathKey)
        ).map((left) => ({
          fromStation,
          toStation,
          fromEntry: left,
          toEntry: toEntries.find((right) => right.lineId === left.lineId && right.componentId === left.componentId && right.pathKey === left.pathKey)!,
        }));
      })
    );
    const common = uniqueBy(pairs, (pair) => `${pair.fromStation.id}\u0000${pair.toStation.id}\u0000${pair.fromEntry.lineId}\u0000${pair.fromEntry.componentId}\u0000${pair.fromEntry.pathKey}`);
    const routes: CorridorRoute[] = [];
    for (const pair of common) {
      const line = lineForId(this.data, pair.fromEntry.lineId);
      const component = this.data.components.find((item) => item.id === pair.fromEntry.componentId);
      if (!line || !component) continue;
      const graphLinks = stationLinksFor(this.data, line.id, component.id);
      if (graphLinks.length > 0) {
        const paths = enumerateStationPaths(graphLinks, pair.fromStation.id, pair.toStation.id);
        const byGroup = new Map<string, RailLineStation>();
        for (const entry of lineStationsFor(this.data, line.id, component.id)) {
          if (!byGroup.has(entry.stationGroupId)) byGroup.set(entry.stationGroupId, entry);
        }
        for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
          const path = paths[pathIndex];
          const stations = [pair.fromStation.id, ...path.map((link) => link.toStationGroupId)]
            .map((groupId) => byGroup.get(groupId))
            .filter((entry): entry is RailLineStation => Boolean(entry));
          routes.push({
            line,
            component,
            stations,
            direction: component.isLoop ? (pathIndex === 0 ? 'loop_a' : 'loop_b') : 'forward',
            distanceM: path.reduce((sum, link) => sum + link.distanceM, 0),
          });
        }
        continue;
      }
      if (component.metadata['isBranch'] === true) {
        // A component with degree > 2 has no single semantic sequence. Do not
        // pick the first branch; callers must provide a path-aware contract.
        continue;
      }
      const entries = lineStationsFor(this.data, line.id, component.id);
      const fromIndex = entries.findIndex((entry) => entry.stationGroupId === pair.fromStation.id);
      const toIndex = entries.findIndex((entry) => entry.stationGroupId === pair.toStation.id);
      if (fromIndex < 0 || toIndex < 0) continue;
      const forward = entries.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1);
      const direction: CorridorRoute['direction'] = fromIndex <= toIndex ? 'forward' : 'reverse';
      if (pair.fromEntry.distanceAlongM === null || pair.toEntry.distanceAlongM === null) continue;
      const distanceM = Math.abs(pair.fromEntry.distanceAlongM - pair.toEntry.distanceAlongM);
      routes.push({ line, component, stations: direction === 'forward' ? forward : forward.slice().reverse(), direction, distanceM });
      if (component.isLoop && fromIndex !== toIndex) {
        const reverseStations = entries.slice(toIndex).concat(entries.slice(0, fromIndex + 1));
        const total = component.lengthM;
        routes.push({ line, component, stations: reverseStations, direction: 'loop_b', distanceM: Math.max(0, total - distanceM) });
      }
    }
    const deduped = uniqueBy(routes, (route) => `${route.line.id}\u0000${route.component.id}\u0000${route.direction}\u0000${route.stations.map((s) => s.stationGroupId).join(',')}`);
    if (deduped.length === 0) return { status: 'not_found', from, to, routes: [], datasetVersion: resultVersion(this.data), reason: '同一路線上の区間が見つかりません' };
    const status = deduped.length === 1 ? 'resolved' : 'ambiguous';
    return { status, from, to, routes: deduped, datasetVersion: resultVersion(this.data), reason: status === 'ambiguous' ? '複数の鉄道路線経路があります' : undefined };
  }

  resolveStationHops(input: StationHopInput): ResolvedStationSet {
    if (!Number.isInteger(input.maxStops) || input.maxStops < 0 || input.maxStops > 100) {
      return { status: 'unsupported', origin: { status: 'not_found', input: input.origin, datasetVersion: resultVersion(this.data) }, stations: [], lines: [], datasetVersion: resultVersion(this.data), reason: 'maxStops は0〜100の整数で指定してください' };
    }
    const origin = this.resolveStation({ station: input.origin, line: input.line });
    if (origin.status !== 'resolved') return { status: origin.status, origin, stations: [], lines: [], datasetVersion: resultVersion(this.data), reason: origin.reason };
    const requestedLines = input.line
      ? this.data.lines.filter((line) => lineMatches(line, input.line!, undefined, this.data.lineAliases))
      : this.data.lines;
    const requestedLineIds = new Set(requestedLines.map((line) => line.id));
    const memberships = stationMemberships(this.data, origin.station!.id).filter((entry) => requestedLineIds.has(entry.lineId));
    const selected = new Map<string, RailLineStation>();
    const lines = new Map<string, RailLine>();
    for (const membership of memberships) {
      const line = lineForId(this.data, membership.lineId);
      if (!line) continue;
      lines.set(line.id, line);
      const links = stationLinksFor(this.data, membership.lineId, membership.componentId);
      if (links.length > 0) {
        const adjacency = new Map<string, RailStationLink[]>();
        for (const link of links) adjacency.set(link.fromStationGroupId, [...(adjacency.get(link.fromStationGroupId) ?? []), link]);
        const distances = new Map<string, number>([[origin.station!.id, 0]]);
        const queue: string[] = [origin.station!.id];
        while (queue.length > 0) {
          const current = queue.shift()!;
          const stops = distances.get(current)!;
          if (stops >= input.maxStops) continue;
          for (const link of adjacency.get(current) ?? []) {
            if (distances.has(link.toStationGroupId)) continue;
            distances.set(link.toStationGroupId, stops + 1);
            queue.push(link.toStationGroupId);
          }
        }
        for (const entry of lineStationsFor(this.data, membership.lineId, membership.componentId)) {
          if (distances.has(entry.stationGroupId)) selected.set(`${entry.lineId}\u0000${entry.componentId}\u0000${entry.pathKey}\u0000${entry.stationGroupId}`, entry);
        }
      } else if (membership.sequence !== null) {
        for (const entry of lineStationsFor(this.data, membership.lineId, membership.componentId)) {
          if (entry.sequence !== null && Math.abs(entry.sequence - membership.sequence) <= input.maxStops) selected.set(`${entry.lineId}\u0000${entry.componentId}\u0000${entry.pathKey}\u0000${entry.stationGroupId}`, entry);
        }
      }
    }
    return { status: 'resolved', origin, stations: [...selected.values()].sort((a, b) => a.lineId.localeCompare(b.lineId) || (a.sequence ?? Number.POSITIVE_INFINITY) - (b.sequence ?? Number.POSITIVE_INFINITY)), lines: [...lines.values()], datasetVersion: resultVersion(this.data) };
  }

  private resolveStationList(values: readonly string[]): ResolvedStationSet {
    const names = [...new Map(values.map((value) => [stationNameKey(value), value])).values()];
    const resolved = names.map((station) => this.resolveStation({ station }));
    const first = resolved[0] ?? {
      status: 'not_found' as const,
      input: '',
      candidates: [],
      datasetVersion: resultVersion(this.data),
      reason: '場所が指定されていません',
    };
    const failed = resolved.find((result) => result.status !== 'resolved');
    if (failed) {
      return {
        status: failed.status,
        origin: first,
        origins: resolved,
        stations: [],
        lines: [],
        datasetVersion: resultVersion(this.data),
        reason: failed.reason,
      };
    }
    if (resolved.length < 2) {
      return {
        status: 'not_found',
        origin: first,
        origins: resolved,
        stations: [],
        lines: [],
        datasetVersion: resultVersion(this.data),
        reason: '複数の場所を指定してください',
      };
    }
    const groups = resolved.flatMap((result) => result.station ? [result.station] : []);
    const entries = uniqueBy(
      groups.flatMap((group) => stationMemberships(this.data, group.id)),
      (entry) => `${entry.lineId}\u0000${entry.componentId}\u0000${entry.pathKey}\u0000${entry.stationGroupId}\u0000${entry.stationRecordId}`,
    ).sort((left, right) =>
      left.lineId.localeCompare(right.lineId) ||
      left.componentId.localeCompare(right.componentId) ||
      left.pathKey.localeCompare(right.pathKey) ||
      (left.sequence ?? Number.POSITIVE_INFINITY) - (right.sequence ?? Number.POSITIVE_INFINITY) ||
      left.stationGroupId.localeCompare(right.stationGroupId) ||
      left.stationRecordId.localeCompare(right.stationRecordId)
    );
    if (entries.length === 0) {
      return {
        status: 'not_found',
        origin: first,
        origins: resolved,
        stations: [],
        lines: [],
        datasetVersion: resultVersion(this.data),
        reason: '指定された場所の駅所属が見つかりません',
      };
    }
    const lines = uniqueBy(
      entries.flatMap((entry) => {
        const line = lineForId(this.data, entry.lineId);
        return line ? [line] : [];
      }),
      (line) => line.id,
    );
    return {
      status: 'resolved',
      origin: first,
      origins: resolved,
      stations: entries,
      lines,
      datasetVersion: resultVersion(this.data),
    };
  }

  resolveAnyOf(input: AnyOfInput): ResolvedStationSet {
    return this.resolveStationList(input.places);
  }

  resolveMultiOrigin(input: MultiOriginInput): ResolvedStationSet {
    return this.resolveStationList(input.origins);
  }

  resolveScope(scope: LocationScope) {
    if (scope.type === 'any_of') return this.resolveAnyOf({ places: scope.places });
    if (scope.type === 'multi_origin') return this.resolveMultiOrigin({ origins: scope.origins });
    if (scope.type === 'line') return this.resolveLine({ line: scope.line, operator: scope.operator });
    if (scope.type === 'between' || scope.type === 'corridor') return this.resolveBetween({ from: scope.from, to: scope.to, line: scope.line });
    if (scope.type === 'station_hops') return this.resolveStationHops({ origin: scope.origin, maxStops: scope.maxStops, line: scope.line });
    if (scope.type === 'travel_time') return { status: 'unsupported' as const, reason: 'N02は所要時間を提供しないため、travel_timeは未対応です' };
    return { status: 'unsupported' as const, reason: 'point scopeは既存area経路で解決します' };
  }
}

export function createRailResolver(data: RailResolverData): RailLocationResolver {
  return new InMemoryRailLocationResolver(data);
}
