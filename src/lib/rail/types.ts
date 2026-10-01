/**
 * N02 canonical model and LocationScope contract.
 *
 * The source record is deliberately kept separate from the logical station
 * group: N02 may contain one feature per operator/line while users expect a
 * transfer station to resolve as one search anchor.
 */

export type GeoPoint = readonly [number, number];
export type GeoLineString = readonly GeoPoint[];
export type GeoMultiLineString = readonly GeoLineString[];

export interface RailDatasetVersion {
  id: string;
  provider: 'mlit_n02';
  datasetId: string;
  datasetYear: number;
  dataAsOf: string;
  retrievedAt: string;
  sourceUrl: string;
  license: 'CC-BY-4.0';
  contentSha256: string;
  parserVersion: string;
  normalizerVersion: string;
}

export interface RailLine {
  id: string;
  datasetVersionId: string;
  operatorName: string;
  operatorKey: string;
  lineName: string;
  lineKey: string;
  railwayType: string | null;
  operatorType: string | null;
  geometry: GeoMultiLineString;
  bbox: readonly [number, number, number, number] | null;
  componentIds: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
}

export interface RailLineComponent {
  id: string;
  lineId: string;
  componentIndex: number;
  geometry: GeoMultiLineString;
  lengthM: number;
  isLoop: boolean;
  nodeIds: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
}

export interface RailStationRecord {
  id: string;
  datasetVersionId: string;
  sourceStationCode: string;
  sourceGroupCode: string | null;
  stationName: string;
  stationNameKey: string;
  operatorName: string;
  operatorKey: string;
  lineName: string;
  lineKey: string;
  railwayType: string | null;
  operatorType: string | null;
  geometry: GeoMultiLineString | GeoPoint;
  representativePoint: GeoPoint;
  rawProperties: Readonly<Record<string, unknown>>;
}

export interface RailStationGroup {
  id: string;
  datasetVersionId: string;
  sourceGroupCode: string | null;
  canonicalName: string;
  nameKey: string;
  representativePoint: GeoPoint;
  geometry: GeoMultiLineString | GeoPoint;
  recordIds: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
}

export interface RailStationAlias {
  stationGroupId: string;
  alias: string;
  aliasKey: string;
  aliasType: 'canonical' | 'suffix_variant' | 'spacing_variant' | 'source';
  source: string;
}

export interface RailLineAlias {
  lineId: string;
  alias: string;
  aliasKey: string;
  aliasType: 'canonical' | 'spacing_variant' | 'source' | 'curated';
}

export interface RailLineStation {
  lineId: string;
  componentId: string;
  stationGroupId: string;
  stationRecordId: string;
  sequence: number | null;
  /** A path key identifies an explicit station graph/path. */
  pathKey: string;
  distanceAlongM: number | null;
  geometryPosition: GeoPoint;
  isTerminal: boolean;
  isBranchPoint: boolean;
}

export interface RailStationLink {
  id: string;
  lineId: string;
  componentId: string;
  fromStationGroupId: string;
  toStationGroupId: string;
  fromStationRecordId: string;
  toStationRecordId: string;
  pathKey: string;
  distanceM: number;
  metadata: Readonly<Record<string, unknown>>;
}

export type LocationScope =
  | { type: 'point'; place: string }
  | { type: 'any_of'; places: string[] }
  | { type: 'multi_origin'; origins: string[] }
  | { type: 'line'; line: string; operator?: string }
  | { type: 'between'; from: string; to: string; line?: string }
  | { type: 'corridor'; from: string; to: string; line?: string }
  | { type: 'station_hops'; origin: string; maxStops: number; line?: string }
  | { type: 'travel_time'; origin: string; maxMinutes: number };

export type ResolveStatus =
  | 'resolved'
  | 'ambiguous'
  | 'not_found'
  | 'unsupported'
  | 'stale_warning';

export interface ResolvedLine {
  status: ResolveStatus;
  input: string;
  line?: RailLine;
  candidates?: readonly RailLine[];
  datasetVersion?: RailDatasetVersion;
  stations?: readonly RailLineStation[];
  reason?: string;
}

export interface ResolvedStation {
  status: ResolveStatus;
  input: string;
  station?: RailStationGroup;
  candidates?: readonly RailStationGroup[];
  datasetVersion?: RailDatasetVersion;
  reason?: string;
}

export interface CorridorRoute {
  line: RailLine;
  component: RailLineComponent;
  stations: readonly RailLineStation[];
  direction: 'forward' | 'reverse' | 'loop_a' | 'loop_b';
  distanceM: number;
}

export interface ResolvedCorridor {
  status: ResolveStatus;
  from: ResolvedStation;
  to: ResolvedStation;
  routes: readonly CorridorRoute[];
  datasetVersion?: RailDatasetVersion;
  reason?: string;
}

export interface ResolvedStationSet {
  status: ResolveStatus;
  origin: ResolvedStation;
  /** any_of / multi_origin preserve every independently resolved origin. */
  origins?: readonly ResolvedStation[];
  stations: readonly RailLineStation[];
  lines: readonly RailLine[];
  datasetVersion?: RailDatasetVersion;
  reason?: string;
}

export interface SearchAnchor {
  stationGroupId: string;
  stationName: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  sourceScope: LocationScope['type'];
  lineId?: string;
  componentId?: string;
  sequence?: number | null;
  pathKey?: string;
}

export interface PlaceSearchCandidate {
  provider: string;
  providerPlaceId: string;
  name: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RailCandidateProvenance {
  type: 'rail_line' | 'rail_corridor' | 'rail_station_hops' | 'rail_any_of' | 'rail_multi_origin';
  lineId?: string;
  componentId?: string;
  stationGroupId: string;
  stationName: string;
  distanceM?: number;
  sequence?: number | null;
  pathKey?: string;
}

export interface RailPlaceCandidate extends PlaceSearchCandidate {
  discoveryContext: RailCandidateProvenance[];
}
