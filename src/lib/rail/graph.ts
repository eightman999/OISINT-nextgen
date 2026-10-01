import {
  bboxOfGeometry,
  lineNameKey,
  planarDistanceM,
  pointToSegmentDistanceM,
  representativePoint,
  safeLineAliases,
  safeStationAliases,
  stationNameKey,
} from './normalize';
import type {
  GeoLineString,
  GeoPoint,
  RailDatasetVersion,
  RailLine,
  RailLineAlias,
  RailLineComponent,
  RailLineStation,
  RailStationLink,
  RailStationAlias,
  RailStationGroup,
  RailStationRecord,
} from './types';

export interface RailGraphNode {
  id: string;
  position: GeoPoint;
  degree: number;
}

export interface RailGraphEdge {
  id: string;
  from: string;
  to: string;
  lengthM: number;
  lineId: string;
  componentId: string;
  geometry: GeoLineString;
}

export interface RailGraph {
  nodes: readonly RailGraphNode[];
  edges: readonly RailGraphEdge[];
  components: readonly RailLineComponent[];
  lineStations: readonly RailLineStation[];
  stationLinks: readonly RailStationLink[];
  branchComponents: readonly string[];
  loopComponents: readonly string[];
}

export interface CanonicalRailModel {
  datasetVersion: RailDatasetVersion;
  lines: readonly RailLine[];
  components: readonly RailLineComponent[];
  stationRecords: readonly RailStationRecord[];
  stationGroups: readonly RailStationGroup[];
  stationAliases: readonly RailStationAlias[];
  lineAliases: readonly RailLineAlias[];
  lineStations: readonly RailLineStation[];
  stationLinks: readonly RailStationLink[];
  graph: RailGraph;
}

export interface RailGraphInput {
  datasetVersion: RailDatasetVersion;
  lines: readonly RailLine[];
  stationRecords: readonly RailStationRecord[];
  stationGroups: readonly RailStationGroup[];
  stationAliases?: readonly RailStationAlias[];
  lineAliases?: readonly RailLineAlias[];
  snapThresholdM?: number;
}

type MutableNode = RailGraphNode & { neighbors: Set<string> };
type MutableEdge = RailGraphEdge;
type StationAttachment = {
  lineId: string;
  component: RailLineComponent;
  edge: RailGraphEdge;
  record: RailStationRecord;
  stationGroupId: string;
  distanceM: number;
  position: GeoPoint;
  edgeOffsetM: number;
  nodeDistanceM: number;
};

function nodeKey(point: GeoPoint, precision = 7): string {
  return `${point[0].toFixed(precision)},${point[1].toFixed(precision)}`;
}

function createNode(nodes: Map<string, MutableNode>, point: GeoPoint): MutableNode {
  const id = nodeKey(point);
  const existing = nodes.get(id);
  if (existing) return existing;
  const node: MutableNode = { id, position: point, degree: 0, neighbors: new Set() };
  nodes.set(id, node);
  return node;
}

function addEdge(
  nodes: Map<string, MutableNode>,
  edges: MutableEdge[],
  lineId: string,
  componentId: string,
  geometry: GeoLineString,
  edgeIndex: number,
): void {
  if (geometry.length < 2) return;
  // Node every segment so a closed LineString remains a graph loop instead of
  // collapsing to a self-edge. Input feature order is only geometry traversal;
  // station sequence is assigned later from the graph path.
  for (let index = 1; index < geometry.length; index++) {
    const segment: GeoLineString = [geometry[index - 1], geometry[index]];
    const fromNode = createNode(nodes, segment[0]);
    const toNode = createNode(nodes, segment[1]);
    if (fromNode.id === toNode.id) continue;
    const lengthM = planarDistanceM(segment[0], segment[1]);
    const id = `${componentId}:e${edgeIndex}-${index}`;
    edges.push({ id, from: fromNode.id, to: toNode.id, lengthM, lineId, componentId, geometry: segment });
    fromNode.neighbors.add(toNode.id);
    toNode.neighbors.add(fromNode.id);
    fromNode.degree = fromNode.neighbors.size;
    toNode.degree = toNode.neighbors.size;
  }
}

function connectedComponents(nodes: Map<string, MutableNode>, edges: readonly MutableEdge[]): string[][] {
  const edgeByNode = new Map<string, MutableEdge[]>();
  for (const edge of edges) {
    edgeByNode.set(edge.from, [...(edgeByNode.get(edge.from) ?? []), edge]);
    edgeByNode.set(edge.to, [...(edgeByNode.get(edge.to) ?? []), edge]);
  }
  const seen = new Set<string>();
  const results: string[][] = [];
  for (const start of [...nodes.keys()]) {
    if (seen.has(start)) continue;
    const queue = [start];
    const component: string[] = [];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      component.push(id);
      for (const neighbor of nodes.get(id)?.neighbors ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    results.push(component);
  }
  // component IDs are based on source line and stable graph node identity, not station order.
  return results;
}

function edgeDistanceToStation(
  point: GeoPoint,
  edge: RailGraphEdge,
): { distanceM: number; position: GeoPoint; offsetM: number } {
  let best = { distanceM: Number.POSITIVE_INFINITY, position: edge.geometry[0], offsetM: 0 };
  let offset = 0;
  for (let i = 1; i < edge.geometry.length; i++) {
    const start = edge.geometry[i - 1];
    const end = edge.geometry[i];
    const segment = pointToSegmentDistanceM(point, start, end);
    if (segment.distanceM < best.distanceM) {
      best = { distanceM: segment.distanceM, position: segment.position, offsetM: offset + planarDistanceM(start, end) * segment.fraction };
    }
    offset += planarDistanceM(start, end);
  }
  return best;
}

function stationCompatible(record: RailStationRecord, line: RailLine): boolean {
  const lineMatches = record.lineKey === line.lineKey || lineNameKey(record.lineName) === line.lineKey;
  const operatorMatches = !record.operatorKey || record.operatorKey === line.operatorKey;
  return lineMatches && operatorMatches;
}

function graphPathOrder(
  nodes: Map<string, MutableNode>,
  edges: readonly RailGraphEdge[],
  nodeIds: readonly string[],
): { nodeIds: string[]; edgeIds: string[]; isLoop: boolean; isBranch: boolean } {
  const subset = new Set(nodeIds);
  const edgeByNode = new Map<string, RailGraphEdge[]>();
  for (const edge of edges.filter((item) => subset.has(item.from) && subset.has(item.to))) {
    edgeByNode.set(edge.from, [...(edgeByNode.get(edge.from) ?? []), edge]);
    edgeByNode.set(edge.to, [...(edgeByNode.get(edge.to) ?? []), edge]);
  }
  const degreeValues = [...nodeIds].map((id) => edgeByNode.get(id)?.length ?? 0);
  const isBranch = degreeValues.some((degree) => degree > 2);
  const isLoop = !isBranch && degreeValues.length > 0 && degreeValues.every((degree) => degree === 2);
  const endpoints = nodeIds.filter((id) => (edgeByNode.get(id)?.length ?? 0) === 1);
  const start = (endpoints.length > 0 ? endpoints : [...nodeIds]).slice().sort()[0];
  if (!start) return { nodeIds: [], edgeIds: [], isLoop, isBranch };
  const orderedNodes = [start];
  const orderedEdges: string[] = [];
  const usedEdges = new Set<string>();
  let current = start;
  while (true) {
    const next = (edgeByNode.get(current) ?? [])
      .filter((edge) => !usedEdges.has(edge.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!next) break;
    usedEdges.add(next.id);
    orderedEdges.push(next.id);
    const nextNode = next.from === current ? next.to : next.from;
    orderedNodes.push(nextNode);
    current = nextNode;
    if (isLoop && current === start) break;
    if (orderedNodes.length > nodeIds.length + 1) break;
  }
  return { nodeIds: orderedNodes, edgeIds: orderedEdges, isLoop, isBranch };
}

/** Build graph components and station sequences from compatible line geometry. */
export function buildRailGraph(input: RailGraphInput): RailGraph {
  const snapThresholdM = input.snapThresholdM ?? 120;
  const allNodes = new Map<string, MutableNode>();
  const allEdges: MutableEdge[] = [];
  const components: RailLineComponent[] = [];
  const branchComponents: string[] = [];
  const loopComponents: string[] = [];

  for (const line of input.lines) {
    const sourceGeometry = line.geometry;
    // Every source LineString is inserted as a chain. Shared endpoints are noded;
    // crossing interior vertices should be pre-noded by the ETL parser when present.
    const lineEdges: MutableEdge[] = [];
    sourceGeometry.forEach((geometry, index) => {
      const provisionalComponentId = `${line.id}:source-${index}`;
      addEdge(allNodes, lineEdges, line.id, provisionalComponentId, geometry, index);
    });
    allEdges.push(...lineEdges);
    const sourceNodeIds = [...new Set(lineEdges.flatMap((edge) => [edge.from, edge.to]))];
    for (const nodeIds of connectedComponents(allNodes, lineEdges)) {
      if (!nodeIds.some((id) => sourceNodeIds.includes(id))) continue;
      const componentIndex = components.filter((component) => component.lineId === line.id).length;
      const componentId = `${line.id}:c${componentIndex}`;
      const path = graphPathOrder(allNodes, lineEdges, nodeIds);
      const componentEdges = lineEdges.filter((edge) => nodeIds.includes(edge.from) && nodeIds.includes(edge.to));
      const geometry = componentEdges.map((edge) => edge.geometry);
      const lengthM = componentEdges.reduce((sum, edge) => sum + edge.lengthM, 0);
      const component: RailLineComponent = {
        id: componentId,
        lineId: line.id,
        componentIndex,
        geometry,
        lengthM,
        isLoop: path.isLoop,
        nodeIds: path.nodeIds,
        metadata: { isBranch: path.isBranch },
      };
      components.push(component);
      if (path.isBranch) branchComponents.push(componentId);
      if (path.isLoop) loopComponents.push(componentId);
      // Associate the source edges with the canonical component ID.
      for (const edge of componentEdges) edge.componentId = componentId;
    }
  }

  const attachments: StationAttachment[] = [];
  for (const line of input.lines) {
    const lineComponents = components.filter((component) => component.lineId === line.id);
    const records = input.stationRecords.filter((record) => stationCompatible(record, line));
    for (const record of records) {
      let best: { component: RailLineComponent; edge: RailGraphEdge; distanceM: number; position: GeoPoint; offsetM: number } | null = null;
      for (const component of lineComponents) {
        const componentEdges = allEdges.filter((edge) => edge.componentId === component.id);
        for (const edge of componentEdges) {
          const candidate = edgeDistanceToStation(record.representativePoint, edge);
          if (!best || candidate.distanceM < best.distanceM) best = { component, edge, ...candidate };
        }
      }
      if (!best || best.distanceM > snapThresholdM) continue;
      const nodeDistance = best.component.nodeIds.reduce((nearest, nodeId) => {
        const node = allNodes.get(nodeId);
        return node ? Math.min(nearest, planarDistanceM(record.representativePoint, node.position)) : nearest;
      }, Number.POSITIVE_INFINITY);
      attachments.push({
        lineId: line.id,
        component: best.component,
        edge: best.edge,
        record,
        stationGroupId: input.stationGroups.find((group) => group.recordIds.includes(record.id))?.id ?? record.id,
        distanceM: best.distanceM,
        position: best.position,
        edgeOffsetM: best.offsetM,
        nodeDistanceM: nodeDistance,
      });
    }
  }

  // Convert edge-local offsets into component-path cumulative distances. This is
  // deliberately a graph traversal: no latitude/longitude or source station code
  // ordering is used. Branch components keep pathKey=branch-main and are rejected
  // as a unique corridor by the resolver until a path is explicitly selected.
  const stationEntries: RailLineStation[] = [];
  for (const component of components) {
    const componentEdges = allEdges.filter((edge) => edge.componentId === component.id);
    const path = graphPathOrder(allNodes, componentEdges, component.nodeIds);
    const edgeOrder = path.edgeIds.map((id) => componentEdges.find((edge) => edge.id === id)).filter((edge): edge is RailGraphEdge => Boolean(edge));
    const cumulative = new Map<string, { startM: number; reverse: boolean }>();
    let distance = 0;
    for (let index = 0; index < edgeOrder.length; index++) {
      const edge = edgeOrder[index];
      const from = path.nodeIds[index];
      cumulative.set(edge.id, { startM: distance, reverse: edge.from !== from });
      distance += edge.lengthM;
    }
    const rows = attachments.filter((attachment) => attachment.component.id === component.id).map((attachment) => {
      const edgeInfo = cumulative.get(attachment.edge.id);
      const distanceAlongM = edgeInfo ? edgeInfo.startM + (edgeInfo.reverse ? attachment.edge.lengthM - attachment.edgeOffsetM : attachment.edgeOffsetM) : attachment.edgeOffsetM;
      return { attachment, distanceAlongM };
    }).sort((a, b) => a.distanceAlongM - b.distanceAlongM || a.attachment.record.id.localeCompare(b.attachment.record.id));
    const sequenceByGroup = new Map<string, number>();
    rows.forEach((row) => {
      const sequence = path.isBranch
        ? null
        : (sequenceByGroup.has(row.attachment.stationGroupId)
          ? sequenceByGroup.get(row.attachment.stationGroupId)!
          : sequenceByGroup.size);
      if (sequence !== null) sequenceByGroup.set(row.attachment.stationGroupId, sequence);
      const endpointDistance = path.isLoop || path.isBranch || path.nodeIds.length < 2
        ? Number.POSITIVE_INFINITY
        : Math.min(
          planarDistanceM(row.attachment.record.representativePoint, allNodes.get(path.nodeIds[0])!.position),
          planarDistanceM(row.attachment.record.representativePoint, allNodes.get(path.nodeIds[path.nodeIds.length - 1])!.position),
        );
      stationEntries.push({
        lineId: row.attachment.lineId,
        componentId: component.id,
        stationGroupId: row.attachment.stationGroupId,
        stationRecordId: row.attachment.record.id,
        sequence,
        pathKey: path.isBranch ? 'branch-main' : 'main',
        distanceAlongM: path.isBranch ? null : row.distanceAlongM,
        geometryPosition: row.attachment.position,
        isTerminal: endpointDistance <= snapThresholdM,
        isBranchPoint: path.isBranch,
      });
    });
  }

  const stationLinks: RailStationLink[] = [];
  for (const component of components) {
    const entries = stationEntries.filter((entry) => entry.componentId === component.id);
    const byGroup = new Map<string, RailLineStation>();
    for (const entry of entries) {
      if (!byGroup.has(entry.stationGroupId)) byGroup.set(entry.stationGroupId, entry);
    }
    // The in-memory builder is used by fixtures. A branch's source graph is
    // intentionally not reduced to one walk; production ETL supplies the
    // station-graph links. Simple/loop fixtures still get deterministic links.
    if (component.metadata['isBranch'] === true || byGroup.size < 2) continue;
    const ordered = [...byGroup.values()].sort((a, b) =>
      (a.distanceAlongM ?? Number.POSITIVE_INFINITY) - (b.distanceAlongM ?? Number.POSITIVE_INFINITY) ||
      a.stationGroupId.localeCompare(b.stationGroupId)
    );
    const pairs: [RailLineStation, RailLineStation][] = [];
    for (let index = 1; index < ordered.length; index++) pairs.push([ordered[index - 1], ordered[index]]);
    if (component.isLoop) pairs.push([ordered[ordered.length - 1], ordered[0]]);
    for (const [from, to] of pairs) {
      const distanceM = Math.abs((to.distanceAlongM ?? 0) - (from.distanceAlongM ?? 0));
      const forwardId = `rail-station-link:${component.lineId}:${component.id}:${from.stationGroupId}:${to.stationGroupId}`;
      const reverseId = `rail-station-link:${component.lineId}:${component.id}:${to.stationGroupId}:${from.stationGroupId}`;
      stationLinks.push(
        { id: forwardId, lineId: component.lineId, componentId: component.id, fromStationGroupId: from.stationGroupId, toStationGroupId: to.stationGroupId, fromStationRecordId: from.stationRecordId, toStationRecordId: to.stationRecordId, pathKey: 'station-graph', distanceM, metadata: { fixtureDerived: true } },
        { id: reverseId, lineId: component.lineId, componentId: component.id, fromStationGroupId: to.stationGroupId, toStationGroupId: from.stationGroupId, fromStationRecordId: to.stationRecordId, toStationRecordId: from.stationRecordId, pathKey: 'station-graph', distanceM, metadata: { fixtureDerived: true } },
      );
    }
  }
  const nodes = [...allNodes.values()].map(({ neighbors: _neighbors, ...node }) => node);
  return { nodes, edges: allEdges, components, lineStations: stationEntries, stationLinks, branchComponents, loopComponents };
}

/**
 * Construct canonical IDs and groups from source records. Group codes are used
 * only inside one dataset version and are sanity checked by name/distance.
 */
export function buildCanonicalRailModel(input: {
  datasetVersion: RailDatasetVersion;
  lines: readonly Omit<RailLine, 'componentIds' | 'bbox'>[];
  stationRecords: readonly RailStationRecord[];
  maxGroupDistanceM?: number;
}): Omit<CanonicalRailModel, 'graph' | 'components' | 'lineStations'> & { graph: RailGraph; components: readonly RailLineComponent[]; lineStations: readonly RailLineStation[] } {
  const lines: RailLine[] = input.lines.map((line) => ({
    ...line,
    bbox: bboxOfGeometry(line.geometry),
    componentIds: [],
  }));
  const maxGroupDistanceM = input.maxGroupDistanceM ?? 300;
  const grouped = new Map<string, RailStationRecord[]>();
  for (const record of input.stationRecords) {
    const groupKey = record.sourceGroupCode
      ? `${input.datasetVersion.id}\u0000${record.sourceGroupCode}`
      : `${input.datasetVersion.id}\u0000name\u0000${record.stationNameKey}\u0000${record.operatorKey}\u0000${record.lineKey}`;
    const members = grouped.get(groupKey) ?? [];
    if (members.length > 0) {
      const sameName = members.every((member) => member.stationNameKey === record.stationNameKey);
      const near = members.some((member) => planarDistanceM(member.representativePoint, record.representativePoint) <= maxGroupDistanceM);
      if (!sameName || !near) {
        // Quarantine semantics at this layer: split a contradictory group rather than merging it.
        grouped.set(`${groupKey}\u0000split\u0000${record.id}`, [record]);
        continue;
      }
    }
    members.push(record);
    grouped.set(groupKey, members);
  }
  const stationGroups: RailStationGroup[] = [];
  const stationAliases: RailStationAlias[] = [];
  for (const [key, members] of grouped) {
    const first = members[0];
    const id = `rail-station-group:${key}`;
    const representative = representativePoint(members.map((member) => member.representativePoint));
    const group: RailStationGroup = {
      id,
      datasetVersionId: input.datasetVersion.id,
      sourceGroupCode: first.sourceGroupCode,
      canonicalName: first.stationName,
      nameKey: stationNameKey(first.stationName),
      representativePoint: representative,
      geometry: representative,
      recordIds: members.map((member) => member.id),
      metadata: { sourceRecordCount: members.length },
    };
    stationGroups.push(group);
    stationAliases.push(...safeStationAliases(id, first.stationName, 'mlit_n02'));
  }
  const lineAliases = lines.flatMap((line) => safeLineAliases(line.id, line.lineName, line.operatorName));
  const graph = buildRailGraph({ datasetVersion: input.datasetVersion, lines, stationRecords: input.stationRecords, stationGroups, stationAliases, lineAliases });
  const components = graph.components;
  const lineStations = graph.lineStations.map((entry) => {
    const component = components.find((item) => item.id === entry.componentId);
    if (!component) return entry;
    const ordered = graph.lineStations.filter((item) => item.componentId === entry.componentId && item.pathKey === entry.pathKey).sort((a, b) =>
      (a.distanceAlongM ?? Number.POSITIVE_INFINITY) -
      (b.distanceAlongM ?? Number.POSITIVE_INFINITY)
    );
    return entry.sequence === null
      ? entry
      : {
        ...entry,
        sequence: ordered.findIndex((item) =>
          item.stationGroupId === entry.stationGroupId
        ),
      };
  });
  return { datasetVersion: input.datasetVersion, lines, components, stationRecords: input.stationRecords, stationGroups, stationAliases, lineAliases, lineStations, stationLinks: graph.stationLinks, graph };
}
