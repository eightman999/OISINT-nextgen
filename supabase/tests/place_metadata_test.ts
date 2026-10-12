import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { canonicalPlaceMetadata } from "../functions/_shared/place_metadata.ts";

Deno.test("canonical metadata excludes distance without mutating discovery metadata", () => {
  for (const distanceM of [123.4, 0, null, undefined]) {
    const metadata = Object.freeze({
      distanceM,
      attribution: "© Overture Maps Foundation",
      license: "CDLA-Permissive-2.0",
      categories: ["restaurant"],
      domain: "lodging",
    });
    const canonical = canonicalPlaceMetadata(metadata);
    assertEquals("distanceM" in canonical, false);
    assertEquals(metadata.distanceM, distanceM);
    assertEquals(canonical, {
      attribution: metadata.attribution,
      license: metadata.license,
      categories: metadata.categories,
      domain: metadata.domain,
    });
    assertNotStrictEquals(canonical, metadata);
  }
});

Deno.test("metadata without distance keeps its contents", () => {
  assertEquals(canonicalPlaceMetadata({}), {});
  assertEquals(canonicalPlaceMetadata({ source: "mock" }), { source: "mock" });
});
