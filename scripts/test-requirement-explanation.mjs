// Offline regression: Node.js 22.13+ with --experimental-vm-modules.
// Runs production matching/facts modules and extracted pipeline functions.
// No providers, database, network, credentials, or dependency installation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
const root = process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url));
const shared = path.join(root, "supabase/functions/_shared");
const baseline = process.argv.includes("--baseline");
const source = (name) => fs.readFileSync(path.join(shared, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const context = vm.createContext({ URL });
const cache = new Map();
const forbidden = () => { throw new Error("Out-of-scope dependency invoked"); };
// These dependencies are linked but not called by the fact/matching cases.
const unused = {
  "evidence_content.ts": ["filterReusableSafeSharedEvidence", "isReusableSafeSharedEvidence"],
  "provider_ttl.ts": ["isEvidenceWithinTtl"],
  "validation.ts": ["filterValidClaims"],
};
function moduleFor(name) {
  if (cache.has(name)) return cache.get(name);
  const m = unused[name]
    ? new vm.SyntheticModule(unused[name], function () {
      for (const key of unused[name]) this.setExport(key, forbidden);
    }, { context })
    : new vm.SourceTextModule(stripTypeScriptTypes(source(name)), { context, identifier: name });
  cache.set(name, m);
  return m;
}
const matching = moduleFor("requirement_matching.ts");
await matching.link((specifier) => {
  assert.ok(specifier.startsWith("./"), "unexpected external dependency");
  return moduleFor(specifier.slice(2));
});
await matching.evaluate();
const facts = cache.get("facts.ts").namespace;
function extract(text, name) {
  const match = text.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing production function: ${name}`);
  return stripTypeScriptTypes(match[0].replace(/^export /, ""));
}
const pipeline = source("pipeline.ts");
const functions = ["applyClaimMatchingOverrides", "persistCandidateEvaluations", "insertUnknownEvaluations", "guardEvaluation", "usesDeterministicSharedClaims", "isClaimRelevantToRequirement"];
const guardContext = {
  deterministicEvaluations: matching.namespace.deterministicEvaluations,
  structuredFilterClaimKeyForRequirement: facts.structuredFilterClaimKeyForRequirement,
  DETERMINISTIC_SHARED_KINDS: new Set(["payment", "budget", "reservation", "party_size", "time"]),
  // Guard tests exercise semantic and empty-claim paths, not schema validation.
  mergeEvidenceClaims: (groups) => { assert.equal(groups.flat().length, 0); return []; },
  evidenceClaimSignature: forbidden,
  evidenceContainsAllClaims: forbidden,
  evaluateFromEvidence: forbidden,
  throwIfDatabaseError: (error) => { if (error) throw new Error(error.message); },
};
const api = vm.runInNewContext(functions.map((name) => extract(pipeline, name)).join("\n") + `\n({ ${functions.join(",")} })`, guardContext);
const results = [];
function record(name, row, privateFragments, expectedState, publicFact) {
  assert.equal(row.state, expectedState, name);
  const exposed = privateFragments.some((text) => row.explanation.includes(text));
  if (!baseline) assert.equal(exposed, false, `${name}: private condition in explanation`);
  if (publicFact) assert.ok(row.explanation.includes(publicFact), `${name}: public fact lost`);
  results.push({ name, exposed, row: plain(row) });
}
async function persist(row) {
  let captured;
  await api.persistCandidateEvaluations({ from(table) {
    assert.equal(table, "requirement_evaluations");
    return { upsert: async (rows) => { captured = plain(rows); return { error: null }; } };
  } }, [row]);
  assert.deepEqual(captured[0], plain(row));
  return captured[0];
}
const rowFor = (req) => ({ investigation_id: "synthetic-investigation", candidate_id: "synthetic-candidate", requirement_id: req.id, state: "unknown", confidence: 0, explanation: "", evidence_ids: [] });
const cases = [
  ["time match", "time", "18:17〜20:43", ["17:00-23:00"], "match", "17:00〜23:00"],
  ["time partial", "time", "18:17〜20:43", ["20:00-23:00"], "partial", "20:00〜23:00"],
  ["time mismatch", "time", "18:17〜20:43", ["21:00-23:00"], "mismatch", "21:00〜23:00"],
  ["time conflict", "time", "18:17〜20:43", ["17:00-23:00", "21:00-23:30"], "partial"],
  ["time multiple same", "time", "18:17〜20:43", ["17:00-23:00", "17:00-23:00"], "match", "17:00〜23:00"],
  ["budget match", "budget", "4317円以下", [{ min: 2000, max: 3000 }], "match", "2000〜3000円"],
  ["budget partial", "budget", "4317円以下", [{ min: 4000, max: 5000 }], "partial", "4000〜5000円"],
  ["budget mismatch", "budget", "4317円以下", [{ min: 6000, max: 7000 }], "mismatch", "6000〜7000円"],
  ["budget conflict", "budget", "4317円以下", [{ min: 2000, max: 3000 }, { min: 6000, max: 7000 }], "partial"],
  ["budget overlapping states", "budget", "4317円以下", [{ min: 2000, max: 4200 }, { min: 4100, max: 5000 }], "partial"],
  ["budget vague", "budget", "安い", [{ min: 1000, max: 2000 }], "match", "1000〜2000円"],
];
for (const [name, kind, text, values, expected, venueFact] of cases) {
  const req = { id: "synthetic-requirement", kind, originalText: text, normalizedText: text, sourceAttested: true };
  const claims = values.map((value, i) => ({ key: kind === "time" ? "opening_hours" : "budget_dinner", value, rawText: "PRIVATE_RAW_SENTINEL", evidenceIds: [`synthetic-evidence-${i}`] }));
  const row = rowFor(req);
  api.applyClaimMatchingOverrides([row], [req], claims);
  assert.equal(row.evidence_ids.length, values.length, name);
  record(name, await persist(row), ["18:17", "20:43", "4317", "目安上限3000", "PRIVATE_RAW_SENTINEL"], expected, venueFact);
}
// Known-fact writer: requirements never appear in fact-derived explanations.
for (const [kind, text, key, value, expected, fact, hidden] of [
  ["budget", "4317円以下", "budget_dinner", { min: 2000, max: 3000 }, "match", "2000〜3000円", "4317"],
  ["party_size", "17人", "capacity", 30, "partial", "30席", "17人"],
  ["party_size", "17人", "capacity", 10, "mismatch", "10席", "17人"],
  ["access", "駅から徒歩17分以内", "nearest_station_walk_minutes", 8, "match", "徒歩8分", "17分"],
]) {
  const req = { id: "synthetic-requirement", kind, originalText: text, normalizedText: text, priority: "must" };
  const result = facts.evaluateFromFacts([req], [{ key, value, confidence: 0.8 }], [{ id: "synthetic-evidence", structuredClaims: [{ key, value }] }])[0];
  const row = { ...rowFor(req), state: result.state, confidence: result.confidence, explanation: result.explanation, evidence_ids: result.evidenceIds };
  record(`facts ${kind} ${expected}`, await persist(row), [hidden], expected, fact);
}
// AI can echo a request, normalize it, or paraphrase it. Do not substring-redact.
for (const state of ["match", "partial", "mismatch", "unknown"]) {
  for (const variant of ["echo PRIVATE_AI_SENTINEL 18:17 4317円", "normalized PRIVATE_AI_SENTINEL", "paraphrase PRIVATE_AI_SENTINEL"]) {
    const url = "https://example.test/venue";
    const req = { id: "synthetic-requirement", kind: "other", originalText: "PRIVATE_AI_SENTINEL", normalizedText: "PRIVATE_AI_SENTINEL", sourceAttested: true };
    const guarded = api.guardEvaluation({ requirementId: req.id, state, confidence: 0.7, explanation: variant, sourceUrls: [url], claims: [] }, req, new Set([url]), { placeId: "synthetic-place", sharedByUrl: new Map(), neutralCitationByRequirement: new Map([[req.id, new Map([[url, { id: "synthetic-evidence", scope: "shared", investigationId: null, placeId: "synthetic-place", sourceUrl: url, excerpt: "Public citation" }]])]]) });
    assert.equal(guarded.confidence, 0.7);
    assert.deepEqual(plain(guarded.evidenceIds), ["synthetic-evidence"]);
    record(`AI ${state} ${variant.split(" ")[0]}`, await persist({ ...rowFor(req), state: guarded.state, confidence: guarded.confidence, explanation: guarded.explanation, evidence_ids: guarded.evidenceIds }), ["PRIVATE_AI_SENTINEL", "18:17", "4317"], state);
  }
}
for (const [kind, attested] of [["time", true], ["budget", true], ["other", false]]) {
  const req = { id: "synthetic-requirement", kind, originalText: "PRIVATE_UNKNOWN_SENTINEL", normalizedText: "PRIVATE_UNKNOWN_SENTINEL", sourceAttested: attested };
  const guarded = api.guardEvaluation({ requirementId: req.id, state: "unknown", confidence: 0, explanation: "PRIVATE_UNKNOWN_SENTINEL", sourceUrls: [], claims: [] }, req, new Set(), { placeId: "synthetic-place", sharedByUrl: new Map(), neutralCitationByRequirement: new Map() });
  record(`AI unknown ${kind}/${attested}`, await persist({ ...rowFor(req), state: guarded.state, confidence: guarded.confidence, explanation: guarded.explanation, evidence_ids: guarded.evidenceIds }), ["PRIVATE_UNKNOWN_SENTINEL"], "unknown");
}
if (baseline) assert.ok(results.some((result) => result.exposed), "baseline must reproduce disclosure");
console.log(JSON.stringify({ baseline, cases: results.length, exposed: results.filter((r) => r.exposed).length, results }, null, 2));
