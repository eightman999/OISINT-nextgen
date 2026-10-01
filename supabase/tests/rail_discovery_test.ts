import { assertEquals } from "@std/assert";
import {
  configuredPositiveInt,
  preRankRailCandidates,
} from "../functions/_shared/rail_discovery.ts";
import type { PlaceSearchResult } from "../functions/_shared/providers/types.ts";

function result(id: string, lat: number): PlaceSearchResult {
  return {
    provider: "fixture",
    providerPlaceId: id,
    name: id,
    address: "",
    lat,
    lng: 139,
    url: "https://example.test/" + id,
    structuredClaims: [],
    metadata: {},
  };
}

Deno.test("rail discovery budget rejects absent/non-positive values", () => {
  assertEquals(configuredPositiveInt(undefined), null);
  assertEquals(configuredPositiveInt("0"), null);
  assertEquals(configuredPositiveInt("-1"), null);
  assertEquals(configuredPositiveInt("12"), 12);
});

Deno.test("rail discovery pre-rank happens after merged candidates", () => {
  const first = result("first", 35);
  const second = result("second", 35);
  const third = result("third", 35);
  const output = preRankRailCandidates([
    { result: third, distanceM: 30 },
    { result: second, distanceM: 10 },
    { result: first, distanceM: 20 },
  ], 2);
  assertEquals(output.map((item) => item.providerPlaceId), ["second", "first"]);
});
