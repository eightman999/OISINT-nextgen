import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocationScope } from "./rail_scope.ts";

export interface RailSearchAnchor {
  stationGroupId: string;
  stationName: string;
  lat: number | null;
  lng: number | null;
  lineId?: string;
  componentId?: string;
  pathKey?: string;
  sequence?: number | null;
  sourceScope:
    | "line"
    | "between"
    | "corridor"
    | "station_hops"
    | "any_of"
    | "multi_origin";
}

export interface RailDatasetMetadata {
  provider: "mlit_n02";
  version: string;
  asOf: string;
}

export type RailResolveResult =
  | {
    status: "resolved";
    anchors: RailSearchAnchor[];
    datasetVersionId: string | null;
    dataset?: RailDatasetMetadata | null;
  }
  | {
    status: "ambiguous" | "not_found" | "unsupported";
    reason: string;
    anchors: [];
    datasetVersionId: string | null;
    dataset?: RailDatasetMetadata | null;
  };

function key(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP").replace(
    /[\s\u3000]+/g,
    " ",
  ).replace(/駅$/, "");
}

type ActiveRailDataset = RailDatasetMetadata & { id: string };

async function activeDataset(
  db: SupabaseClient,
): Promise<ActiveRailDataset | null> {
  const { data, error } = await db.from("rail_dataset_versions").select(
    "id, provider, dataset_id, data_as_of",
  )
    .eq("provider", "mlit_n02").eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    provider: "mlit_n02",
    version: data.dataset_id,
    asOf: data.data_as_of,
  };
}

type StationCandidate = {
  id: string;
  canonical_name: string;
  representative_point: unknown;
};

async function stationCandidatesByName(
  db: SupabaseClient,
  value: string,
  datasetVersionId: string,
): Promise<StationCandidate[]> {
  const nameKey = key(value);
  const direct = await db.from("rail_station_groups").select(
    "id, canonical_name, representative_point",
  ).eq("dataset_version_id", datasetVersionId).eq("name_key", nameKey);
  if (direct.error) throw direct.error;
  if (direct.data?.length) return direct.data;
  const aliases = await db.from("rail_station_aliases").select(
    "station_group_id",
  ).eq("alias_key", nameKey);
  if (aliases.error) throw aliases.error;
  const ids = [
    ...new Set((aliases.data ?? []).map((row) => row.station_group_id)),
  ];
  if (!ids.length) return [];
  // Alias rows do not carry a dataset id. Filter their canonical parent by
  // active version before they enter any station/path combination.
  const activeGroups = await db.from("rail_station_groups").select(
    "id, canonical_name, representative_point",
  ).in("id", ids).eq("dataset_version_id", datasetVersionId);
  if (activeGroups.error) throw activeGroups.error;
  return activeGroups.data ?? [];
}

function pointLat(value: unknown): number | null {
  if (value && typeof value === "object" && "coordinates" in value) {
    const coords = (value as { coordinates?: unknown }).coordinates;
    if (Array.isArray(coords) && typeof coords[1] === "number") {
      return coords[1];
    }
  }
  return null;
}
function pointLng(value: unknown): number | null {
  if (value && typeof value === "object" && "coordinates" in value) {
    const coords = (value as { coordinates?: unknown }).coordinates;
    if (Array.isArray(coords) && typeof coords[0] === "number") {
      return coords[0];
    }
  }
  return null;
}

async function anchorsForLine(
  db: SupabaseClient,
  lineId: string,
  sourceScope: RailSearchAnchor["sourceScope"],
  datasetVersionId: string,
): Promise<RailSearchAnchor[]> {
  const { data: rows, error } = await db.from("rail_line_stations").select(
    "line_id, component_id, station_group_id, station_record_id, path_key, sequence",
  ).eq("line_id", lineId)
    // Sequence is the only semantic order available for a simple component.
    // The remaining orders only resolve equal/null sequences; they must not be
    // used to invent a route through a branch.
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("line_id", { ascending: true })
    .order("component_id", { ascending: true })
    .order("path_key", { ascending: true })
    .order("station_group_id", { ascending: true })
    .order("station_record_id", { ascending: true });
  if (error) throw error;
  return anchorsForRows(db, rows ?? [], sourceScope, datasetVersionId);
}

type RailStationRow = {
  line_id: string;
  component_id: string;
  station_group_id: string;
  station_record_id?: string | null;
  path_key?: string | null;
  sequence: number | null;
};

function compareString(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const a = left ?? "";
  const b = right ?? "";
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNullableSequence(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing && rightMissing) return 0;
  // A null sequence means that no semantic route order exists. Keep it after
  // known sequence values, then use only stable identifiers as a tie-break.
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  return left - right;
}

/** Stable deterministic order for a set of anchors, not a route resolver. */
export function compareRailSearchAnchors(
  left: RailSearchAnchor,
  right: RailSearchAnchor,
): number {
  return compareString(left.lineId, right.lineId) ||
    compareString(left.componentId, right.componentId) ||
    compareString(left.pathKey ?? "main", right.pathKey ?? "main") ||
    compareNullableSequence(left.sequence, right.sequence) ||
    compareString(left.stationGroupId, right.stationGroupId);
}

/** Return a new array; callers that have graph path order must not use this. */
export function sortRailSearchAnchors(
  anchors: RailSearchAnchor[],
): RailSearchAnchor[] {
  return [...anchors].sort(compareRailSearchAnchors);
}

function compareRailStationRows(
  left: RailStationRow,
  right: RailStationRow,
  routeFirst = false,
): number {
  const routeOrder = compareString(left.line_id, right.line_id) ||
    compareString(left.component_id, right.component_id) ||
    compareString(left.path_key ?? "main", right.path_key ?? "main");
  const sequenceOrder = compareNullableSequence(left.sequence, right.sequence);
  const stationOrder =
    compareString(left.station_group_id, right.station_group_id) ||
    compareString(left.station_record_id, right.station_record_id);
  return routeFirst
    ? routeOrder || sequenceOrder || stationOrder
    : sequenceOrder || routeOrder || stationOrder;
}

async function anchorsForRows(
  db: SupabaseClient,
  rows: RailStationRow[],
  sourceScope: RailSearchAnchor["sourceScope"],
  datasetVersionId: string,
): Promise<RailSearchAnchor[]> {
  const stationIds = [...new Set(rows.map((row) => row.station_group_id))];
  if (stationIds.length === 0) return [];
  const stations = await db.from("rail_station_groups").select(
    "id, canonical_name, representative_point",
  ).in("id", stationIds).eq("dataset_version_id", datasetVersionId);
  if (stations.error) throw stations.error;
  const byId = new Map(
    (stations.data ?? []).map((station) => [station.id, station]),
  );
  return rows.flatMap((row) => {
    const station = byId.get(row.station_group_id);
    if (!station) return [];
    return [{
      stationGroupId: row.station_group_id,
      stationName: station.canonical_name,
      lat: pointLat(station.representative_point),
      lng: pointLng(station.representative_point),
      lineId: row.line_id,
      componentId: row.component_id,
      pathKey: row.path_key ?? "main",
      sequence: row.sequence,
      sourceScope,
    }];
  });
}

async function activeLineIds(
  db: SupabaseClient,
  lineIds: string[],
  datasetVersionId: string,
): Promise<Set<string>> {
  if (lineIds.length === 0) return new Set();
  const rows = await db.from("rail_lines").select("id").in("id", lineIds)
    .eq("dataset_version_id", datasetVersionId);
  if (rows.error) throw rows.error;
  return new Set((rows.data ?? []).map((row) => row.id));
}

type RailLinkRow = {
  id: string;
  line_id: string;
  component_id: string;
  from_station_group_id: string;
  to_station_group_id: string;
  path_key: string;
  distance_m: number;
};

/** Enumerate at most two simple graph paths. Two paths are enough to keep a
 * loop/multi-route result ambiguous without allowing candidate explosion. */
function enumerateStationPaths(
  links: RailLinkRow[],
  from: string,
  to: string,
  maxPaths = 2,
): RailLinkRow[][] {
  const outgoing = new Map<string, RailLinkRow[]>();
  for (const link of links) {
    const rows = outgoing.get(link.from_station_group_id) ?? [];
    rows.push(link);
    outgoing.set(link.from_station_group_id, rows);
  }
  for (const rows of outgoing.values()) {
    rows.sort((left, right) =>
      left.to_station_group_id.localeCompare(right.to_station_group_id) ||
      left.id.localeCompare(right.id)
    );
  }
  const paths: RailLinkRow[][] = [];
  const visit = (current: string, seen: Set<string>, path: RailLinkRow[]) => {
    if (paths.length >= maxPaths) return;
    if (current === to) {
      paths.push(path);
      return;
    }
    for (const link of outgoing.get(current) ?? []) {
      if (seen.has(link.to_station_group_id)) continue;
      seen.add(link.to_station_group_id);
      visit(link.to_station_group_id, seen, [...path, link]);
      seen.delete(link.to_station_group_id);
      if (paths.length >= maxPaths) return;
    }
  };
  visit(from, new Set([from]), []);
  return paths;
}

async function stationRowsForMemberships(
  db: SupabaseClient,
  lineId: string,
  componentId: string,
  pathKey: string,
): Promise<RailStationRow[]> {
  const result = await db.from("rail_line_stations").select(
    "line_id, component_id, station_group_id, station_record_id, path_key, sequence",
  ).eq("line_id", lineId).eq("component_id", componentId).eq(
    "path_key",
    pathKey,
  )
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("station_group_id", { ascending: true })
    .order("station_record_id", { ascending: true });
  if (result.error) throw result.error;
  return (result.data ?? []).map((row) => row as RailStationRow).sort(
    (left, right) => compareRailStationRows(left, right),
  );
}

async function resolveLine(
  db: SupabaseClient,
  input: { line: string; operator?: string },
  datasetVersionId: string,
): Promise<RailResolveResult> {
  const query = key(input.line);
  const aliases = await db.from("rail_line_aliases").select("line_id").eq(
    "alias_key",
    query,
  );
  if (aliases.error) throw aliases.error;
  let ids = [...new Set((aliases.data ?? []).map((row) => row.line_id))];
  if (ids.length > 0) {
    const activeIds = await activeLineIds(db, ids, datasetVersionId);
    ids = ids.filter((id) => activeIds.has(id));
  }
  if (ids.length === 0) {
    const lines = await db.from("rail_lines").select("id").eq(
      "dataset_version_id",
      datasetVersionId,
    ).eq("line_key", query);
    if (lines.error) throw lines.error;
    ids = [...new Set((lines.data ?? []).map((row) => row.id))];
  }
  if (input.operator && ids.length > 0) {
    const lines = await db.from("rail_lines").select("id").in("id", ids).eq(
      "operator_key",
      key(input.operator),
    );
    if (lines.error) throw lines.error;
    ids = (lines.data ?? []).map((row) => row.id);
  }
  if (ids.length === 0) {
    return {
      status: "not_found",
      reason: "路線が見つかりません",
      anchors: [],
      datasetVersionId,
    };
  }
  if (ids.length > 1) {
    return {
      status: "ambiguous",
      reason: "路線候補が複数あります",
      anchors: [],
      datasetVersionId,
    };
  }
  return {
    status: "resolved",
    anchors: await anchorsForLine(db, ids[0], "line", datasetVersionId),
    datasetVersionId,
  };
}

async function resolveStationList(
  db: SupabaseClient,
  names: string[],
  sourceScope: "any_of" | "multi_origin",
  datasetVersionId: string,
): Promise<RailResolveResult> {
  // 同じ駅名を複数回問い合わせても結果を増幅しない。順序は入力順を
  // 保持し、resolverの返却順だけを最後に安定ソートする。
  const uniqueNames = [
    ...new Map(names.map((name) => [key(name), name])).values(),
  ];
  const candidates: StationCandidate[] = [];
  for (const name of uniqueNames) {
    const matches = await stationCandidatesByName(db, name, datasetVersionId);
    if (matches.length === 0) {
      return {
        status: "not_found",
        reason: `場所が見つかりません: ${name}`,
        anchors: [],
        datasetVersionId,
      };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        reason: `場所候補が複数あります: ${name}`,
        anchors: [],
        datasetVersionId,
      };
    }
    candidates.push(matches[0]);
  }
  if (candidates.length < 2) {
    return {
      status: "not_found",
      reason: "複数の場所を指定してください",
      anchors: [],
      datasetVersionId,
    };
  }

  const stationIds = candidates.map((candidate) => candidate.id);
  const memberships = await db.from("rail_line_stations").select(
    "line_id, component_id, station_group_id, station_record_id, path_key, sequence",
  ).in("station_group_id", stationIds)
    .order("line_id", { ascending: true })
    .order("component_id", { ascending: true })
    .order("path_key", { ascending: true })
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("station_group_id", { ascending: true })
    .order("station_record_id", { ascending: true });
  if (memberships.error) throw memberships.error;
  const rows = (memberships.data ?? []).map((row) => row as RailStationRow);
  const activeIds = await activeLineIds(
    db,
    [...new Set(rows.map((row) => row.line_id))],
    datasetVersionId,
  );
  const activeRows = rows.filter((row) => activeIds.has(row.line_id));
  const anchors = await anchorsForRows(
    db,
    activeRows,
    sourceScope,
    datasetVersionId,
  );
  if (anchors.length === 0) {
    return {
      status: "not_found",
      reason: "指定された場所の駅anchorが見つかりません",
      anchors: [],
      datasetVersionId,
    };
  }
  return {
    status: "resolved",
    anchors: sortRailSearchAnchors(dedupe(anchors)),
    datasetVersionId,
  };
}

async function resolveRailScopeInternal(
  db: SupabaseClient,
  scope: LocationScope,
  activeDatasetValue?: ActiveRailDataset | null,
): Promise<RailResolveResult> {
  if (scope.type === "current_location") {
    return {
      status: "unsupported",
      reason: "current_location is handled by the existing area resolver",
      anchors: [],
      datasetVersionId: null,
    };
  }
  const active = activeDatasetValue === undefined
    ? await activeDataset(db)
    : activeDatasetValue;
  const datasetVersionId = active?.id ?? null;
  if (!datasetVersionId) {
    return {
      status: "not_found",
      reason: "active N02 dataset is unavailable",
      anchors: [],
      datasetVersionId: null,
    };
  }
  if (scope.type === "travel_time") {
    return {
      status: "unsupported",
      reason: "N02 does not provide travel time",
      anchors: [],
      datasetVersionId,
    };
  }
  if (scope.type === "point") {
    return {
      status: "unsupported",
      reason: "point uses the legacy area resolver",
      anchors: [],
      datasetVersionId,
    };
  }
  if (scope.type === "any_of") {
    return resolveStationList(
      db,
      scope.places,
      "any_of",
      datasetVersionId,
    );
  }
  if (scope.type === "multi_origin") {
    return resolveStationList(
      db,
      scope.origins,
      "multi_origin",
      datasetVersionId,
    );
  }
  if (scope.type === "line") {
    return resolveLine(
      db,
      scope as { line: string; operator?: string },
      datasetVersionId,
    );
  }
  const fromName = scope.type === "station_hops" ? scope.origin : scope.from;
  const fromCandidates = await stationCandidatesByName(
    db,
    fromName,
    datasetVersionId,
  );
  if (fromCandidates.length === 0) {
    return {
      status: "not_found",
      reason: "出発駅が見つかりません",
      anchors: [],
      datasetVersionId,
    };
  }
  if (scope.type === "station_hops") {
    let requestedLineIds: Set<string> | null = null;
    if (scope.line) {
      const lineResult = await resolveLine(
        db,
        { line: scope.line },
        datasetVersionId,
      );
      if (lineResult.status !== "resolved") return lineResult;
      requestedLineIds = new Set(
        lineResult.anchors.map((anchor) => anchor.lineId).filter(
          (id): id is string => Boolean(id),
        ),
      );
    }
    const candidateIds = fromCandidates.map((candidate) => candidate.id);
    const memberships = await db.from("rail_line_stations").select(
      "line_id, component_id, station_group_id, station_record_id, path_key, sequence",
    ).in("station_group_id", candidateIds)
      .order("line_id", { ascending: true })
      .order("component_id", { ascending: true })
      .order("path_key", { ascending: true })
      .order("sequence", { ascending: true, nullsFirst: false })
      .order("station_group_id", { ascending: true })
      .order("station_record_id", { ascending: true });
    if (memberships.error) throw memberships.error;
    let membershipRows = (memberships.data ?? []).map((row) =>
      row as RailStationRow
    )
      .sort((left, right) => compareRailStationRows(left, right, true));
    const activeIds = await activeLineIds(
      db,
      [...new Set(membershipRows.map((row) => row.line_id))],
      datasetVersionId,
    );
    membershipRows = membershipRows.filter((row) =>
      activeIds.has(row.line_id) &&
      (!requestedLineIds || requestedLineIds.has(row.line_id))
    );
    if (!membershipRows.length) {
      return {
        status: "not_found",
        reason: "駅の路線所属が見つかりません",
        anchors: [],
        datasetVersionId,
      };
    }
    const candidateMemberships = uniqueBy(
      membershipRows,
      (row) => row.station_group_id,
    );
    if (candidateMemberships.length !== 1) {
      return {
        status: "ambiguous",
        reason: "出発駅候補が複数あります。路線を指定してください",
        anchors: [],
        datasetVersionId,
      };
    }
    const originId = candidateMemberships[0].station_group_id;
    const all: RailSearchAnchor[] = [];
    for (const membership of membershipRows) {
      const pathKey = membership.path_key ?? "main";
      const rows = await stationRowsForMemberships(
        db,
        membership.line_id,
        membership.component_id,
        pathKey,
      );
      const linksResult = await db.from("rail_station_links").select(
        "id, line_id, component_id, from_station_group_id, to_station_group_id, path_key, distance_m",
      ).eq("line_id", membership.line_id).eq(
        "component_id",
        membership.component_id,
      ).eq("path_key", pathKey)
        .order("from_station_group_id", { ascending: true })
        .order("to_station_group_id", { ascending: true })
        .order("id", { ascending: true });
      if (linksResult.error) throw linksResult.error;
      const links = (linksResult.data ?? []) as RailLinkRow[];
      const reachable = new Set<string>([originId]);
      if (links.length > 0) {
        const outgoing = new Map<string, RailLinkRow[]>();
        for (const link of links) {
          const current = outgoing.get(link.from_station_group_id) ?? [];
          current.push(link);
          outgoing.set(link.from_station_group_id, current);
        }
        const queue: Array<{ id: string; stops: number }> = [{
          id: originId,
          stops: 0,
        }];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.stops >= scope.maxStops) continue;
          for (const link of outgoing.get(current.id) ?? []) {
            if (reachable.has(link.to_station_group_id)) continue;
            reachable.add(link.to_station_group_id);
            queue.push({
              id: link.to_station_group_id,
              stops: current.stops + 1,
            });
          }
        }
      } else if (membership.sequence !== null) {
        for (const row of rows) {
          if (
            row.sequence !== null &&
            Math.abs(row.sequence - membership.sequence) <= scope.maxStops
          ) {
            reachable.add(row.station_group_id);
          }
        }
      }
      all.push(
        ...await anchorsForRows(
          db,
          rows.filter((row) => reachable.has(row.station_group_id)),
          "station_hops",
          datasetVersionId,
        ),
      );
    }
    return {
      status: "resolved",
      // Hops can combine more than one path. This order is only a stable
      // response order; graph traversal remains the source of reachability.
      anchors: sortRailSearchAnchors(dedupe(all)),
      datasetVersionId,
    };
  }
  const toCandidates = await stationCandidatesByName(
    db,
    scope.type === "between" || scope.type === "corridor" ? scope.to : "",
    datasetVersionId,
  );
  if (toCandidates.length === 0) {
    return {
      status: "not_found",
      reason: "到着駅が見つかりません",
      anchors: [],
      datasetVersionId,
    };
  }
  let requestedLineIds: Set<string> | null = null;
  if (scope.line) {
    const lineResult = await resolveLine(
      db,
      { line: scope.line },
      datasetVersionId,
    );
    if (lineResult.status !== "resolved") return lineResult;
    requestedLineIds = new Set(
      lineResult.anchors.map((anchor) => anchor.lineId).filter(
        (id): id is string => Boolean(id),
      ),
    );
  }
  const candidateIds = [
    ...new Set([
      ...fromCandidates.map((candidate) => candidate.id),
      ...toCandidates.map((candidate) => candidate.id),
    ]),
  ];
  const memberships = await db.from("rail_line_stations").select(
    "line_id, component_id, station_group_id, station_record_id, path_key, sequence",
  ).in("station_group_id", candidateIds)
    .order("line_id", { ascending: true })
    .order("component_id", { ascending: true })
    .order("path_key", { ascending: true })
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("station_group_id", { ascending: true })
    .order("station_record_id", { ascending: true });
  if (memberships.error) throw memberships.error;
  const activeIds = await activeLineIds(
    db,
    [...new Set((memberships.data ?? []).map((row) => row.line_id))],
    datasetVersionId,
  );
  const membershipRows = (memberships.data ?? []).map((row) =>
    row as RailStationRow
  )
    .filter((row) =>
      activeIds.has(row.line_id) &&
      (!requestedLineIds || requestedLineIds.has(row.line_id))
    )
    .sort((left, right) => compareRailStationRows(left, right, true));
  const fromIds = new Set(fromCandidates.map((candidate) => candidate.id));
  const toIds = new Set(toCandidates.map((candidate) => candidate.id));
  const fromRows = membershipRows.filter((row) =>
    fromIds.has(row.station_group_id)
  );
  const toRows = membershipRows.filter((row) =>
    toIds.has(row.station_group_id)
  );
  const common = uniqueBy(
    fromRows.flatMap((left) =>
      toRows
        .filter((right) =>
          right.line_id === left.line_id &&
          right.component_id === left.component_id &&
          (right.path_key ?? "main") === (left.path_key ?? "main")
        )
        .map((right) => ({
          line_id: left.line_id,
          component_id: left.component_id,
          path_key: left.path_key ?? "main",
          from_station_group_id: left.station_group_id,
          to_station_group_id: right.station_group_id,
          from_sequence: left.sequence,
          to_sequence: right.sequence,
        }))
    ),
    (row) =>
      `${row.line_id}\u0000${row.component_id}\u0000${row.path_key}\u0000${row.from_station_group_id}\u0000${row.to_station_group_id}`,
  );
  if (common.length === 0) {
    return {
      status: "not_found",
      reason: scope.line
        ? "指定路線上の区間が見つかりません"
        : "共通路線が見つかりません",
      anchors: [],
      datasetVersionId,
    };
  }
  if (common.length > 1) {
    return {
      status: "ambiguous",
      reason: "駅名候補の共通路線経路が複数あります",
      anchors: [],
      datasetVersionId,
    };
  }
  const selected = common[0];
  const component = await db.from("rail_line_components").select(
    "id, is_loop, metadata",
  ).eq("id", selected.component_id).eq("line_id", selected.line_id)
    .maybeSingle();
  if (component.error) throw component.error;
  if (!component.data) {
    return {
      status: "not_found",
      reason: "路線componentが見つかりません",
      anchors: [],
      datasetVersionId,
    };
  }
  const metadata = component.data.metadata as Record<string, unknown> | null;
  // A loop has two valid directions. Keep both directions ambiguous rather
  // than silently selecting a sequence direction.
  if (component.data.is_loop) {
    return {
      status: "ambiguous",
      reason: "環状線は両方向の経路があります",
      anchors: [],
      datasetVersionId,
    };
  }
  const pathKey = selected.path_key;
  const stationRows = await stationRowsForMemberships(
    db,
    selected.line_id,
    selected.component_id,
    pathKey,
  );
  const linksResult = await db.from("rail_station_links").select(
    "id, line_id, component_id, from_station_group_id, to_station_group_id, path_key, distance_m",
  ).eq("line_id", selected.line_id).eq("component_id", selected.component_id)
    .eq("path_key", pathKey)
    .order("from_station_group_id", { ascending: true })
    .order("to_station_group_id", { ascending: true })
    .order("id", { ascending: true });
  if (linksResult.error) throw linksResult.error;
  const links = (linksResult.data ?? []) as RailLinkRow[];
  const paths = enumerateStationPaths(
    links,
    selected.from_station_group_id,
    selected.to_station_group_id,
  );
  if (paths.length > 1 || (metadata?.isBranch === true && links.length === 0)) {
    return {
      status: "ambiguous",
      reason: "枝線の経路を一意に決定できません",
      anchors: [],
      datasetVersionId,
    };
  }
  if (paths.length === 1) {
    const order = new Map<string, number>();
    const pathStationIds = [
      selected.from_station_group_id,
      ...paths[0].map((link) => link.to_station_group_id),
    ];
    pathStationIds.forEach((id, index) => order.set(id, index));
    const pathRows = stationRows
      .filter((row) => order.has(row.station_group_id))
      .sort((left, right) => {
        const pathOrder = (order.get(left.station_group_id) ?? 0) -
          (order.get(right.station_group_id) ?? 0);
        return pathOrder || compareRailStationRows(left, right);
      });
    const anchors = dedupe(
      await anchorsForRows(
        db,
        pathRows,
        scope.type as "between" | "corridor",
        datasetVersionId,
      ),
    );
    if (anchors.length > 0) {
      return { status: "resolved", anchors, datasetVersionId };
    }
  }
  // Legacy/simple rows can still be served by a dense canonical sequence.
  // Branch rows are nullable and never enter this fallback.
  const left = fromRows.find((row) =>
    row.line_id === selected.line_id &&
    row.component_id === selected.component_id &&
    (row.path_key ?? "main") === pathKey &&
    row.station_group_id === selected.from_station_group_id
  );
  const right = toRows.find((row) =>
    row.line_id === selected.line_id &&
    row.component_id === selected.component_id &&
    (row.path_key ?? "main") === pathKey &&
    row.station_group_id === selected.to_station_group_id
  );
  if (
    left?.sequence !== null && left?.sequence !== undefined &&
    right?.sequence !== null && right?.sequence !== undefined
  ) {
    const lower = Math.min(left.sequence, right.sequence);
    const upper = Math.max(left.sequence, right.sequence);
    const interval = stationRows.filter((row) =>
      row.sequence !== null && row.sequence >= lower && row.sequence <= upper
    ).sort((left, right) => compareRailStationRows(left, right));
    const anchors = await anchorsForRows(
      db,
      interval,
      scope.type as "between" | "corridor",
      datasetVersionId,
    );
    if (anchors.length > 0) {
      return { status: "resolved", anchors: dedupe(anchors), datasetVersionId };
    }
  }
  return {
    status: "not_found",
    reason: metadata?.isBranch === true
      ? "枝線の一意な経路が見つかりません"
      : "駅区間のanchorが見つかりません",
    anchors: [],
    datasetVersionId,
  };
}

export async function resolveRailScope(
  db: SupabaseClient,
  scope: LocationScope,
): Promise<RailResolveResult> {
  const active = await activeDataset(db);
  const resolved = await resolveRailScopeInternal(db, scope, active);
  return {
    ...resolved,
    dataset: active
      ? {
        provider: active.provider,
        version: active.version,
        asOf: active.asOf,
      }
      : null,
  };
}

function uniqueBy<T>(items: T[], selector: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = selector(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function dedupe(anchors: RailSearchAnchor[]): RailSearchAnchor[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const id = `${anchor.lineId}:${anchor.componentId}:${
      anchor.pathKey ?? "main"
    }:${anchor.stationGroupId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
