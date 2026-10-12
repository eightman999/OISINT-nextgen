// Offline boundary regression: no dependency installation, server startup,
// provider credentials, network calls, or real database access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
const investigation = source("supabase/functions/run-investigation/index.ts");
const refresh = source("supabase/functions/place-refresh-worker/index.ts");
const overture = source("supabase/functions/_shared/providers/overture.ts");
const metadata = source("supabase/functions/_shared/place_metadata.ts");

// The functions under test are taken from the production files, not copies.
// Restrict extraction to top-level function declarations; fail if refactored.
function extract(text, name) {
  const match = text.match(new RegExp(
    `^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, "m",
  ));
  assert.ok(match, `missing production function: ${name}`);
  return stripTypeScriptTypes(match[0].replace(/^export /, ""));
}

for (const text of [investigation, refresh]) {
  assert.match(text, /import \{ canonicalPlaceMetadata \} from "\.\.\/_shared\/place_metadata\.ts";/);
}

const providerMeta = {
  storagePolicy: "persistent",
  attributionPolicy: "overture_cdla_attribution",
  ttlHours: null,
};
const functions = runInNewContext([
  extract(metadata, "canonicalPlaceMetadata"),
  extract(overture, "toResult"),
  extract(investigation, "preRankKey"),
  extract(investigation, "toPreRankCandidate"),
  extract(investigation, "upsertPlaceFromResult"),
  extract(investigation, "upsertProviderLink"),
  extract(refresh, "upsertPlace"),
  "({ canonicalPlaceMetadata, toResult, toPreRankCandidate, upsertPlaceFromResult, upsertPlace })",
].join("\n"), {
  // Domain lookup is an explicit dependency stub; this test checks that the
  // existing recognized-domain override reaches the actual write payload.
  getDomainProfile: (value) => value === "lodging" ? { id: value } : null,
  getProviders: () => ({ place: { meta: providerMeta } }),
  throwIfDatabaseError: (error) => { if (error) throw new Error(error.message); },
});

const plain = (value) => JSON.parse(JSON.stringify(value));
function recordingDb() {
  const writes = [];
  return {
    writes,
    from(table) {
      const chain = {
        upsert(payload, options) {
          writes.push({ table, operation: "upsert", payload: plain(payload), options });
          return chain;
        },
        update(payload) {
          writes.push({ table, operation: "update", payload: plain(payload) });
          return chain;
        },
        eq() { return chain; },
        select() { return chain; },
        single: async () => ({ data: table === "places"
          ? { id: "synthetic-place", embedding: null } : { id: "synthetic-link" }, error: null }),
        maybeSingle: async () => ({ data: { id: "synthetic-place" }, error: null }),
      };
      return chain;
    },
  };
}

let cases = 0;
for (const distance of [123.4, 0, null]) {
  const result = functions.toResult({
    provider_place_id: "synthetic-overture",
    name: "Synthetic restaurant",
    address: "Synthetic address",
    lat: 0,
    lng: 0,
    website: "https://example.test/shop",
    category: "restaurant",
    region_id: "synthetic-region",
    release: "synthetic-release",
    distance_m: distance,
    promoted_at: "2026-01-01T00:00:00Z",
  }, "2026-01-02T00:00:00Z");
  for (const domain of [undefined, "lodging", "unknown"]) {
    const input = { ...result, domain, metadata: Object.freeze({ ...result.metadata }) };
    const before = plain(input);
    const db = recordingDb();
    const written = await functions.upsertPlaceFromResult(db, input);
    assert.equal(written.linkId, "synthetic-link");
    const place = db.writes.find((write) => write.table === "places").payload;
    assert.equal("distanceM" in place.metadata, false);
    const expected = plain(result.metadata);
    delete expected.distanceM;
    if (domain === "lodging") expected.domain = domain;
    assert.deepEqual(place.metadata, expected);
    assert.equal(place.refreshed_at, result.fetchedAt);
    const link = db.writes.find((write) => write.table === "place_provider_links").payload;
    assert.equal(link.attribution_policy, providerMeta.attributionPolicy);
    assert.equal(link.storage_policy, providerMeta.storagePolicy);
    assert.equal(link.source_url, result.url);
    assert.equal(functions.toPreRankCandidate(input).distanceM, distance);
    assert.deepEqual(plain(input), before);
    cases++;
  }
  const db = recordingDb();
  const input = { ...result, metadata: Object.freeze({ ...result.metadata, domain: "lodging" }) };
  const before = plain(input);
  await functions.upsertPlace(db, {
    placeId: "synthetic-place", provider: "overture", providerPlaceId: result.providerPlaceId,
  }, input, result.fetchedAt);
  const expected = plain(input.metadata);
  delete expected.distanceM;
  assert.deepEqual(db.writes[0].payload.metadata, expected);
  assert.deepEqual(plain(input), before);
  assert.equal(functions.toPreRankCandidate(input).distanceM, distance);
  cases++;
}
for (const input of [{}, { source: "mock", categories: ["restaurant"] }]) {
  assert.deepEqual(plain(functions.canonicalPlaceMetadata(input)), input);
  assert.notEqual(functions.canonicalPlaceMetadata(input), input);
  cases++;
}
console.log(`PASS: ${cases} offline metadata cases (${fileURLToPath(root)})`);
