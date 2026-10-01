import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type RailSearchAnchor,
  sortRailSearchAnchors,
} from "../functions/_shared/rail_resolver.ts";

function anchor(
  stationGroupId: string,
  overrides: Partial<RailSearchAnchor> = {},
): RailSearchAnchor {
  return {
    stationGroupId,
    stationName: stationGroupId,
    lat: null,
    lng: null,
    lineId: "line-a",
    componentId: "component-a",
    pathKey: "main",
    sequence: null,
    sourceScope: "station_hops",
    ...overrides,
  };
}

Deno.test("rail resolver sorts nullable sequence ties without inventing sequence", () => {
  const input = [
    anchor("group-z", { sequence: null }),
    anchor("group-2", { sequence: 2 }),
    anchor("group-a", { sequence: null }),
    anchor("group-1", { sequence: 1 }),
  ];
  const sorted = sortRailSearchAnchors(input);

  assertEquals(sorted.map((item) => item.stationGroupId), [
    "group-1",
    "group-2",
    "group-a",
    "group-z",
  ]);
  assertEquals(sorted.map((item) => item.sequence), [1, 2, null, null]);
  assertEquals(input.map((item) => item.stationGroupId), [
    "group-z",
    "group-2",
    "group-a",
    "group-1",
  ]);
});

Deno.test("rail resolver tie-break groups paths before station id", () => {
  const input = [
    anchor("group-z", {
      lineId: "line-b",
      componentId: "component-z",
      pathKey: "branch",
    }),
    anchor("group-z", {
      lineId: "line-a",
      componentId: "component-z",
      pathKey: "branch",
    }),
    anchor("group-z", {
      lineId: "line-a",
      componentId: "component-a",
      pathKey: "main",
    }),
    anchor("group-a", {
      lineId: "line-a",
      componentId: "component-a",
      pathKey: "main",
    }),
  ];
  const sorted = sortRailSearchAnchors(input);

  assertEquals(
    sorted.map((
      item,
    ) => [item.lineId, item.componentId, item.pathKey, item.stationGroupId]),
    [
      ["line-a", "component-a", "main", "group-a"],
      ["line-a", "component-a", "main", "group-z"],
      ["line-a", "component-z", "branch", "group-z"],
      ["line-b", "component-z", "branch", "group-z"],
    ],
  );
  // Sorting is intentionally non-mutating so graph-path callers can retain
  // their own order and only station_hops uses this stable response order.
  assertNotEquals(sorted, input);
});
