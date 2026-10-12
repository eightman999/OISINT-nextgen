// Dependency-free source-contract checks only: this does not execute/parse SQL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/202610120001_revenuecat_transfer_uuid_normalization.sql');
const base = read('supabase/migrations/202608240002_revenuecat_entitlements.sql');
const names = ['revoke_revenuecat_transfer', 'apply_revenuecat_transfer'];
const functionBody = (source, name) => {
  const start = source.indexOf(`create or replace function public.${name}(`);
  assert(start >= 0, `${name} exists`);
  const end = source.indexOf('\n$$;', start);
  assert(end > start, `${name} body ends`);
  return source.slice(start, end + 4);
};
let checks = 0;
const check = (ok, label) => { assert(ok, label); checks++; };
check((sql.match(/create or replace function /g) ?? []).length === 2, 'only two RPCs replaced');
for (const name of names) {
  const body = functionBody(sql, name);
  const previous = functionBody(base, name);
  check(body.includes('security definer\nset search_path = public'), `${name}: fixed search path`);
  check((body.match(/lower\(raw_id\)/g) ?? []).length === 2, `${name}: both identity lists normalize`);
  check(!/(?<!lower\()raw_id [<=>]|p_transferred_to\[i\] <>/.test(body), `${name}: no raw equality remains`);
  for (const array of ['p_transferred_from', 'p_transferred_to', ...(name.startsWith('apply') ? ['p_product_ids', 'p_expiration_at_ms', 'p_grace_period_expiration_at_ms', 'p_will_renew'] : [])]) {
    check(body.includes(`array_ndims(${array}) is distinct from 1`), `${name}: ${array} dimensions`);
    check(body.includes(`array_lower(${array}, 1) is distinct from 1`), `${name}: ${array} lower bound`);
  }
  check((body.match(/coalesce\(u.is_anonymous, false\) = false/g) ?? []).length === (previous.match(/coalesce\(u.is_anonymous, false\) = false/g) ?? []).length, `${name}: permanent-user guards retained`);
  for (const side of ['from', 'to']) {
    check(body.includes(`if subject = any(${side}_ids) then\n      ${name.startsWith('apply') ? '  ' : ''}return 'ignored_invalid_transfer';`), `${name}: duplicate ${side} rejected`);
  }
  check(body.includes("if from_ids && to_ids then\n    return 'ignored_invalid_transfer';"), `${name}: intersections rejected`);
  for (const marker of [
    'for subject in select unnest(from_ids || to_ids) order by 1 loop',
    'perform pg_advisory_xact_lock(hashtextextended(subject::text, 0));',
    'on conflict (event_id) do nothing;',
    "return 'ignored_duplicate';",
    'p_event_timestamp_ms > existing.last_event_timestamp_ms',
  ]) check(body.includes(marker) && previous.includes(marker), `${name}: retained ${marker}`);
  check(body.slice(0, body.indexOf('pg_advisory_xact_lock')).includes('ignored_invalid_transfer'), `${name}: validation before locks`);
}
const apply = functionBody(sql, 'apply_revenuecat_transfer');
check((apply.match(/lower\(p_transferred_to\[i\]\)/g) ?? []).length === 2, 'same normalization for validation and writes');
check(apply.includes("if p_product_ids[i] is null\n       or p_product_ids[i] not in"), 'null product fails closed');
check(apply.includes('p_event_timestamp_ms <= existing.last_event_timestamp_ms'), 'destination stale guard retained');
check((apply.match(/for i in 1\.\.coalesce\(array_length\(p_transferred_to, 1\), 0\) loop/g) ?? []).length === 2, 'original aligned indexes used twice');
check((sql.match(/from public;/g) ?? []).length === 2 && (sql.match(/to service_role;/g) ?? []).length === 2, 'service-only grants retained');
const fixture = read('supabase/tests/rls/111_revenuecat_transfer_uuid.sql');
check(fixture.includes('if ok is distinct from true'), 'SQL assertion treats NULL as failure');
check(fixture.trimEnd().endsWith('rollback;'), 'synthetic fixture rolls back');
console.log(`${checks} static source-contract checks passed. SQL fixtures NOT executed.`);
