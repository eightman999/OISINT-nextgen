import type {
  GeoPoint,
  RailLineAlias,
  RailStationAlias,
} from './types';

/** Normalize only safe orthographic differences; do not invent aliases. */
export function normalizeRailText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s\u3000]+/g, ' ');
}

export function stationNameKey(value: string): string {
  return normalizeRailText(value).replace(/駅$/, '');
}

export function lineNameKey(value: string): string {
  return normalizeRailText(value);
}

export function operatorKey(value: string): string {
  return normalizeRailText(value);
}

export function railIdentityKey(operator: string, line: string): string {
  return `${operatorKey(operator)}\u0000${lineNameKey(line)}`;
}

export function safeStationAliases(
  stationGroupId: string,
  name: string,
  source: string,
): RailStationAlias[] {
  const values = new Map<string, RailStationAlias>();
  const add = (alias: string, aliasType: RailStationAlias['aliasType']) => {
    const aliasKey = stationNameKey(alias);
    if (!aliasKey || values.has(aliasKey)) return;
    values.set(aliasKey, { stationGroupId, alias, aliasKey, aliasType, source });
  };
  add(name, 'canonical');
  add(name.endsWith('駅') ? name.slice(0, -1) : `${name}駅`, 'suffix_variant');
  const compact = name.replace(/[\s\u3000]+/g, '');
  if (compact !== name) add(compact, 'spacing_variant');
  return [...values.values()];
}

export function safeLineAliases(
  lineId: string,
  name: string,
  operator: string,
): RailLineAlias[] {
  const values = new Map<string, RailLineAlias>();
  const add = (alias: string, aliasType: RailLineAlias['aliasType']) => {
    const aliasKey = lineNameKey(alias);
    if (!aliasKey || values.has(aliasKey)) return;
    values.set(aliasKey, { lineId, alias, aliasKey, aliasType });
  };
  add(name, 'canonical');
  const compact = name.replace(/[\s\u3000]+/g, '');
  if (compact !== name) add(compact, 'spacing_variant');
  if (operator && !normalizeRailText(name).startsWith(normalizeRailText(operator))) {
    add(`${operator}${name}`, 'source');
  }
  return [...values.values()];
}

export function representativePoint(
  geometry: readonly GeoPoint[] | readonly (readonly GeoPoint[])[],
): GeoPoint {
  const points: GeoPoint[] = Array.isArray(geometry[0]) && Array.isArray((geometry as any)[0]?.[0])
    ? (geometry as readonly (readonly GeoPoint[])[]).flatMap((line) => [...line])
    : [...(geometry as readonly GeoPoint[])];
  if (points.length === 0) throw new Error('geometry has no coordinates');
  // Stable midpoint by input geometry order, not a geographic sort.
  return points[Math.floor((points.length - 1) / 2)];
}

export function bboxOfGeometry(
  geometry: readonly (readonly GeoPoint[])[],
): readonly [number, number, number, number] | null {
  const points = geometry.flatMap((line) => [...line]);
  if (points.length === 0) return null;
  let minX = points[0][0];
  let maxX = points[0][0];
  let minY = points[0][1];
  let maxY = points[0][1];
  for (const [x, y] of points.slice(1)) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export function planarDistanceM(a: GeoPoint, b: GeoPoint): number {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const x = (b[0] - a[0]) * 111_320 * Math.cos(lat);
  const y = (b[1] - a[1]) * 110_540;
  return Math.hypot(x, y);
}

export function pointToSegmentDistanceM(
  point: GeoPoint,
  start: GeoPoint,
  end: GeoPoint,
): { distanceM: number; position: GeoPoint; fraction: number } {
  const lat = point[1] * Math.PI / 180;
  const cosLat = Math.cos(lat);
  const sx = start[0] * 111_320 * cosLat;
  const sy = start[1] * 110_540;
  const ex = end[0] * 111_320 * cosLat;
  const ey = end[1] * 110_540;
  const px = point[0] * 111_320 * cosLat;
  const py = point[1] * 110_540;
  const dx = ex - sx;
  const dy = ey - sy;
  const len2 = dx * dx + dy * dy;
  const fraction = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / len2));
  const position: GeoPoint = [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
  return { distanceM: Math.hypot(px - (sx + dx * fraction), py - (sy + dy * fraction)), position, fraction };
}
