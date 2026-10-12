import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source equivalence only: no SQL parser, database, RLS or runtime acceptance.
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const migration = read('supabase/migrations/202610120002_recall_null_limit.sql');
const functionPattern = /create or replace function public\.\w+\([\s\S]*?\$\$;/g;
const definitions = migration.match(functionPattern) ?? [];
const cases = [
  ['0005_rpc.sql', 'match_investigations', 5],
  ['0008_p1_recall.sql', 'match_investigation_places', 5],
  ['0008_p1_recall.sql', 'match_requirement_kinds', 8],
];
assert.equal(definitions.length, cases.length);
// Reject additional SQL, including ownership, ACL, historical edits or DDL.
assert.equal(migration.replace(functionPattern, '').replace(/--[^\n]*/g, '').trim(), '');
for (const [index, [source, name, fallback]] of cases.entries()) {
  const original = read(`supabase/migrations/${source}`).match(
    new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`),
  )?.[0];
  assert.ok(original, `${name}: original definition exists`);
  assert.equal(original.match(/limit match_count;/g)?.length, 1);
  assert.equal(definitions[index], original.replace('limit match_count;', `limit coalesce(match_count, ${fallback});`),
    `${name}: only the terminal LIMIT may change`);
  assert.match(definitions[index], new RegExp(`match_count int default ${fallback}\\b`));
  assert.match(definitions[index], /language sql\nstable\nsecurity definer\nset search_path = public/);
  console.log(`${name}: exact definition equality except NULL fallback ${fallback}`);
}
console.log('PASS: exactly three terminal LIMIT substitutions; declarations, filters, projections, ordering, internal limits and attributes preserved in source.');
console.log('SQL regression fixture NOT EXECUTED by this check. No runtime or catalog/ACL verification is claimed.');
