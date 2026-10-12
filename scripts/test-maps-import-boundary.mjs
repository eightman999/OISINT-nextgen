// Offline regression harness: production TSX + repository source, synthetic dependencies.
// Requires the project's React/React DOM/jsdom and a TSX transformer (rolldown).
// Run: node --experimental-vm-modules scripts/test-maps-import-boundary.mjs
// MAPS_TEST_DEPENDENCIES may point to an existing trusted node_modules directory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.env.MAPS_TEST_SOURCE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.MAPS_TEST_DEPENDENCIES
  ? path.join(process.env.MAPS_TEST_DEPENDENCIES, '../fixture.cjs') : import.meta.url);
const React = require('react');
const { JSDOM } = require('jsdom');
const { transform } = require('rolldown/experimental');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { createRoot } = require('react-dom/client');
const { act } = React;
const cases = [];
async function test(name, fn) {
  await fn();
  cases.push(name);
  console.log(`PASS ${name}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const A = { id: 'synthetic-subject-a', kind: 'permanent' };
const B = { id: 'synthetic-subject-b', kind: 'permanent' };
const signalFor = (label) => ({ label, matches: 2, confidence: 0.8, contexts: [], origins: ['explicit_tag'] });
const snapshot = { scenarioId: null, scores: {}, likes: ['synthetic-A'], avoid: [], modelVersion: 'fixture', sourceKinds: ['maps_takeout'], learningState: {}, updatedAt: '2026-01-01T00:00:00Z' };
const fixture = { saves: [], commits: [], applied: [], save: async () => {}, parsed: [] };
const native = (tag) => function Native({ children, testID, onPress, accessibilityState, accessibilityLabel, accessibilityRole, style, numberOfLines, ...rest }) {
  return React.createElement(tag, {
    ...rest, 'data-testid': testID, onClick: onPress,
    'aria-label': accessibilityLabel, role: accessibilityRole,
    'aria-checked': accessibilityState?.checked,
  }, children);
};
const modules = {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { View: native('div'), Text: native('span'), Pressable: native('button'), Platform: { OS: 'web' }, Linking: { openURL() {} }, StyleSheet: { create: x => x } },
  '@/lib/accountRepository': {
    localSnapshotFromStoredPreferenceProfile: x => x,
    saveStoredPreferenceProfile: async (...args) => { fixture.saves.push(args); return fixture.save(...args); },
  },
  '@/lib/googleMapsImport': {
    GoogleMapsImportError: class extends Error {},
    parseGoogleMapsTakeout: (text) => { fixture.parsed.push(text); return { recordCount: 1, discardedDetailFields: 2, inferredLikes: [signalFor(text)] }; },
    selectInferredTasteSignals: (summary, labels) => summary.inferredLikes.filter(s => labels.includes(s.label)),
    selectInferredTasteLabels: (summary, labels) => summary.inferredLikes.filter(s => labels.includes(s.label)).map(s => s.label),
  },
  '@/lib/personalization': {
    emptyPersonalizationSnapshot: () => snapshot,
    createImportedTasteMerge: (likes, avoid, signals, subject) => ({ snapshot: { ...snapshot, likes, subjectId: subject?.id } }),
    commitImportedTasteMerge: (...args) => fixture.commits.push(args),
  },
  '@/lib/preferenceLearning': { PREFERENCE_CONTEXT_LABELS: {}, preferenceLearningStateForCloud: x => x },
  '@/lib/personalizationConsent': { PERSONALIZATION_CONSENT_LABEL: 'synthetic consent', PERSONALIZATION_CONSENT_VERSION: 'test-v1' },
  '@/theme': { colors: {}, fonts: {}, radius: {} },
};
async function moduleFrom(code, dependencies) {
  const context = vm.createContext({ console, AbortController, Error, Promise, setTimeout, clearTimeout, process: { env: {} } });
  const cache = new Map();
  const dependency = async (name) => {
    if (!cache.has(name)) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      const exports = dependencies[name];
      const mod = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
      cache.set(name, mod);
      await mod.link(() => {}); await mod.evaluate();
    }
    return cache.get(name);
  };
  const mod = new vm.SourceTextModule(code, { context, importModuleDynamically: dependency });
  await mod.link(dependency); await mod.evaluate();
  return mod.namespace;
}
const panelSource = await readFile(path.join(root, 'src/components/GoogleMapsImportPanel.tsx'), 'utf8');
const compiled = await transform('GoogleMapsImportPanel.tsx', panelSource, { jsx: { runtime: 'automatic' } });
assert.equal(compiled.errors.length, 0);
const { GoogleMapsImportPanel } = await moduleFrom(compiled.code, modules);
async function mount(subject = A, extra = {}) {
  fixture.saves = []; fixture.commits = []; fixture.applied = []; fixture.parsed = []; fixture.save = async () => {};
  const container = document.createElement('div'); document.body.append(container);
  const tree = createRoot(container);
  const props = subject => ({ subject, isAuthenticated: !!subject, baseProfile: null, baseProfileLoaded: true, onApplied: x => fixture.applied.push(x), ...extra });
  const render = async subject => act(async () => tree.render(React.createElement(GoogleMapsImportPanel, props(subject))));
  await render(subject);
  const get = id => container.querySelector(`[data-testid="${id}"]`);
  const click = async id => act(async () => get(id).click());
  const file = async (text, name = 'synthetic.csv') => act(async () => {
    const input = get('maps-import-file');
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name, size: 10, text: () => typeof text === 'string' ? Promise.resolve(text) : text }] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  const close = async () => { await act(async () => tree.unmount()); container.remove(); };
  return { container, get, click, file, render, close };
}
if (process.env.MAPS_TEST_BASELINE === '1') {
  await test('baseline reproduces retained A preview and consent under B', async () => {
    const v = await mount(); await v.file('synthetic-A'); await v.click('maps-import-consent'); await v.render(B);
    assert.ok(v.container.textContent.includes('synthetic-A'));
    assert.equal(v.get('maps-import-consent').getAttribute('aria-checked'), 'true');
    await v.click('maps-import-apply');
    assert.equal(fixture.saves[0][0].likes[0], 'synthetic-A');
    assert.equal(fixture.saves[0][0].subjectId, B.id); await v.close();
  });
  await test('baseline reproduces delayed A file visible under B', async () => {
    const d = deferred(); const v = await mount(); await v.file(d.promise); await v.render(B);
    await act(async () => d.resolve('synthetic-delayed-A'));
    assert.ok(v.container.textContent.includes('synthetic-delayed-A')); await v.close();
  });
  await test('baseline reproduces stale A save committing after A -> B -> A', async () => {
    const v = await mount(); const d = deferred(); fixture.save = () => d.promise;
    await v.file('synthetic-A'); await v.click('maps-import-consent'); await v.click('maps-import-apply');
    await v.render(B); await v.render(A); await act(async () => d.resolve());
    assert.equal(fixture.commits.length, 1); assert.equal(fixture.applied.length, 1); await v.close();
  });
  console.log(JSON.stringify({ baselineReproductions: cases }, null, 2));
  dom.window.close();
  process.exit(0);
}
await test('A -> B clears preview, selection and consent; A -> B -> A does not revive them', async () => {
  const v = await mount(); await v.file('synthetic-A'); await v.click('maps-import-consent');
  assert.equal(v.get('maps-import-consent').getAttribute('aria-checked'), 'true');
  await v.render(B); assert.equal(v.get('maps-import-preview'), null);
  await v.render(A); assert.equal(v.get('maps-import-preview'), null);
  await v.file('synthetic-new-A'); assert.equal(v.get('maps-import-consent').getAttribute('aria-checked'), 'false');
  assert.equal(fixture.saves.length, 0); await v.close();
});
for (const returnToA of [false, true]) await test(`delayed file read discarded after ${returnToA ? 'A -> B -> A' : 'A -> B'}`, async () => {
  const d = deferred(); const v = await mount(); await v.file(d.promise); await v.render(B);
  if (returnToA) await v.render(A);
  await act(async () => d.resolve('synthetic-old-A'));
  assert.equal(v.get('maps-import-preview'), null); assert.equal(fixture.parsed.length, 0); await v.close();
});
await test('old failed file read does not replace new subject error/busy state', async () => {
  const d = deferred(); const newer = deferred(); const v = await mount(); await v.file(d.promise); await v.render(B); await v.file(newer.promise);
  await act(async () => d.reject(new Error('synthetic old failure')));
  assert.equal(v.get('maps-import-error'), null); assert.equal(v.get('maps-import-file').disabled, true);
  await act(async () => newer.resolve('synthetic-B')); assert.ok(v.container.textContent.includes('synthetic-B')); await v.close();
});
for (const reject of [false, true]) await test(`save ${reject ? 'failure' : 'success'} after A -> B -> A cannot commit locally or report`, async () => {
  const v = await mount(); const d = deferred(); fixture.save = () => d.promise;
  await v.file('synthetic-A'); await v.click('maps-import-consent'); await v.click('maps-import-apply');
  assert.equal(fixture.saves.length, 1); const boundary = fixture.saves[0][3]; assert.equal(boundary.expectedSubjectId, A.id);
  await v.render(B); await v.render(A); assert.equal(boundary.signal.aborted, true);
  await act(async () => reject ? d.reject(new Error('synthetic stale failure')) : d.resolve());
  assert.equal(fixture.commits.length, 0); assert.equal(fixture.applied.length, 0); assert.equal(v.get('maps-import-error'), null);
  assert.equal(v.get('maps-import-success'), null); await v.close();
});
await test('unmount invalidates in-flight save and prevents local commit', async () => {
  const v = await mount(); const d = deferred(); fixture.save = () => d.promise;
  await v.file('synthetic-A'); await v.click('maps-import-consent'); await v.click('maps-import-apply'); await v.close();
  assert.equal(fixture.saves[0][3].signal.aborted, true); await act(async () => d.resolve()); assert.equal(fixture.commits.length, 0);
});
await test('same-subject success preserves CAS payload and requires renewed consent after selection changes', async () => {
  const v = await mount(A, { baseProfile: { updatedAt: 'synthetic-revision' } });
  await v.file('synthetic-A'); await v.click('maps-import-consent'); await v.click('maps-import-signal-0');
  assert.equal(v.get('maps-import-consent').getAttribute('aria-checked'), 'false');
  await v.click('maps-import-signal-0'); await v.click('maps-import-consent'); await v.click('maps-import-apply');
  assert.equal(fixture.saves.length, 1); assert.equal(fixture.saves[0][1].updatedAt, 'synthetic-revision');
  assert.equal(fixture.saves[0][1].profileExists, true); assert.equal(fixture.commits.length, 1); assert.equal(fixture.applied.length, 1); await v.close();
});
await test('guest local-only import still works; moving to account clears guest consent', async () => {
  const v = await mount(null); await v.file('synthetic-guest'); await v.click('maps-import-consent'); await v.click('maps-import-apply');
  assert.equal(fixture.saves.length, 0); assert.equal(fixture.commits.length, 1);
  await v.render(B); assert.equal(v.get('maps-import-preview'), null); await v.close();
});
await test('authenticated import without permanent subject fails before save or commit', async () => {
  const v = await mount({ id: 'synthetic-anonymous', kind: 'anonymous' }); await v.file('synthetic-invalid'); await v.click('maps-import-consent'); await v.click('maps-import-apply');
  assert.equal(fixture.saves.length, 0); assert.equal(fixture.commits.length, 0); assert.ok(v.get('maps-import-error')); await v.close();
});
// Extract only complete production declarations; dependency behavior is recorded,
// not a reimplementation of the save function. No network/database is contacted.
const repository = await readFile(path.join(root, 'src/lib/accountRepository.ts'), 'utf8');
const saveStart = repository.indexOf('export async function saveStoredPreferenceProfile(');
const saveEnd = repository.indexOf('\n}\n', saveStart) + 2;
const authStart = repository.indexOf('async function getPermanentUser(');
const authEnd = repository.indexOf('\nfunction isString', authStart);
const repoCode = stripTypeScriptTypes(`class AccountOperationError extends Error {}\n${repository.slice(saveStart, saveEnd)}\n${repository.slice(authStart, authEnd)}`);
const auth = { globalListeners: new Set(), user: A, session: A, listeners: new Set(), calls: [], headers: {}, signal: null, beforeUser: async () => {}, beforeSession: async () => {}, rpcWait: async () => ({ error: null }), beforeDispatch: async () => {}, unsubscribed: 0 };
const sessionFor = subject => subject && ({ user: { id: subject.id, is_anonymous: subject.kind === 'anonymous' }, access_token: `synthetic-token-for-${subject.id}` });
const supabase = {
  auth: {
    getUser: async () => { await auth.beforeUser(); return { data: { user: auth.user && { id: auth.user.id, is_anonymous: auth.user.kind === 'anonymous' } }, error: null }; },
    getSession: async () => { await auth.beforeSession(); return { data: { session: sessionFor(auth.session) }, error: null }; },
    onAuthStateChange: listener => { auth.listeners.add(listener); return { data: { subscription: { unsubscribe: () => { auth.listeners.delete(listener); auth.unsubscribed++; } } } }; },
  },
  rpc: (name, payload) => {
    const headers = {}; let signal;
    return {
      setHeader(key, value) { headers[key] = value; return this; },
      abortSignal(value) { signal = value; return this; },
      async then(resolve, reject) {
        try {
          await auth.beforeDispatch();
          auth.calls.push({ name, payload, headers, signal, currentSubject: auth.session?.id });
          auth.headers = headers; auth.signal = signal;
          resolve(await auth.rpcWait());
        } catch (error) { reject(error); }
      },
    };
  },
};
const identity = await moduleFrom(stripTypeScriptTypes(await readFile(path.join(root, 'src/lib/authSubjectGeneration.ts'), 'utf8')), {});
// Evaluate the production singleton's observer registration, with createClient
// returning only this synthetic client. No SDK initialization or HTTP occurs.
let registeringSingleton = true;
const addListener = supabase.auth.onAuthStateChange;
supabase.auth.onAuthStateChange = listener => {
  if (!registeringSingleton) return addListener(listener);
  auth.globalListeners.add(listener);
  return { data: { subscription: { unsubscribe: () => auth.globalListeners.delete(listener) } } };
};
await moduleFrom(stripTypeScriptTypes(await readFile(path.join(root, 'src/lib/supabase.ts'), 'utf8')), {
  '@supabase/supabase-js': { createClient: () => supabase },
  '@/lib/authStorage': { providerSafeAuthStorage: {} },
  '@/lib/trustedOrigins': { isTrustedSupabaseOrigin: () => false },
  '@/lib/authSubjectGeneration': identity,
});
registeringSingleton = false;
assert.equal(auth.globalListeners.size, 1);
const { saveStoredPreferenceProfile } = await moduleFrom(`import { getAuthSubjectGeneration } from '@/lib/authSubjectGeneration'; const preferenceLearningStateForCloud = x => x; const PERSONALIZATION_CONSENT_VERSION = 'test-v1';\n${repoCode}`, { '@/lib/supabase': { supabase }, '@/lib/authSubjectGeneration': identity });
function resetAuth() { Object.assign(auth, { user: A, session: A, calls: [], headers: {}, signal: null, beforeUser: async () => {}, beforeSession: async () => {}, rpcWait: async () => ({ error: null }), beforeDispatch: async () => {}, unsubscribed: 0 }); assert.equal(auth.listeners.size, 0); switchAuth(A); }
function switchAuth(subject) { auth.user = subject; auth.session = subject; for (const listener of [...auth.globalListeners, ...auth.listeners]) listener('SIGNED_IN', sessionFor(subject)); }
function save(controller = new AbortController(), subjectId = A.id) { return saveStoredPreferenceProfile(snapshot, { profileExists: true, updatedAt: 'synthetic-revision' }, 'maps_takeout', { expectedSubjectId: subjectId, signal: controller.signal }); }
async function settle() { await new Promise(resolve => setImmediate(resolve)); }
await test('A -> B -> A before the first dynamic import completes cannot save', async () => {
  resetAuth(); const pending = save(); switchAuth(B); switchAuth(A);
  await assert.rejects(pending); assert.equal(auth.calls.length, 0); assert.equal(auth.listeners.size, 0);
});
await test('repository rejects Maps writes without payload owner boundary', async () => {
  resetAuth(); await assert.rejects(saveStoredPreferenceProfile(snapshot, { profileExists: false, updatedAt: null }, 'maps_takeout'));
  assert.equal(auth.calls.length, 0);
});
await test('repository rejects different current user before RPC', async () => {
  resetAuth(); auth.user = B; auth.session = B; await assert.rejects(save()); assert.equal(auth.calls.length, 0); assert.equal(auth.listeners.size, 0);
});
for (const stage of ['beforeUser', 'beforeSession']) await test(`A -> B -> A during ${stage} remains cancelled before RPC`, async () => {
  resetAuth(); const d = deferred(); auth[stage] = () => d.promise;
  const result = save(); const rejected = assert.rejects(result); await settle(); switchAuth(B); switchAuth(A); d.resolve(); await rejected;
  assert.equal(auth.calls.length, 0); assert.equal(auth.listeners.size, 0);
});
await test('caller operation cancellation while resolving user prevents RPC', async () => {
  resetAuth(); const d = deferred(); auth.beforeUser = () => d.promise; const c = new AbortController();
  const rejected = assert.rejects(save(c)); await settle(); c.abort(); d.resolve(); await rejected; assert.equal(auth.calls.length, 0);
});
await test('session lookup mismatch without auth event fails closed', async () => {
  resetAuth(); auth.session = B; await assert.rejects(save()); assert.equal(auth.calls.length, 0);
});
await test('no session fails closed', async () => {
  resetAuth(); auth.session = null; await assert.rejects(save()); assert.equal(auth.calls.length, 0);
});
await test('transport-time subject switch cannot replace the pinned request authorization', async () => {
  resetAuth(); auth.beforeDispatch = async () => { auth.user = B; auth.session = B; }; await save();
  assert.equal(auth.calls[0].currentSubject, B.id); assert.equal(auth.headers.Authorization, `Bearer synthetic-token-for-${A.id}`);
  assert.equal(auth.calls[0].payload.p_expected_updated_at, 'synthetic-revision'); assert.equal(auth.calls[0].payload.p_base_profile_exists, true);
});
await test('auth switch during dispatched RPC aborts and rejects stale completion, including A -> B -> A', async () => {
  resetAuth(); const d = deferred(); auth.rpcWait = () => d.promise; const rejected = assert.rejects(save()); await settle();
  assert.equal(auth.calls.length, 1); switchAuth(B); switchAuth(A); assert.equal(auth.signal.aborted, true); d.resolve({ error: null }); await rejected;
  assert.equal(auth.listeners.size, 0);
});
await test('caller unmount during RPC rejects even if transport ignores abort', async () => {
  resetAuth(); const d = deferred(); auth.rpcWait = () => d.promise; const c = new AbortController(); const rejected = assert.rejects(save(c)); await settle();
  c.abort(); assert.equal(auth.signal.aborted, true); d.resolve({ error: null }); await rejected;
});
await test('same-subject token refresh does not cancel; listener is removed on success', async () => {
  resetAuth(); auth.beforeSession = async () => switchAuth(A); await save(); assert.equal(auth.calls.length, 1); assert.equal(auth.signal.aborted, false); assert.equal(auth.unsubscribed, 1);
});
await test('CAS conflict remains an error and never bypasses owner fence', async () => {
  resetAuth(); auth.rpcWait = async () => ({ error: { code: '40001' } }); await assert.rejects(save(), /基準版|更新されました/); assert.equal(auth.listeners.size, 0);
});
await test('non-Maps existing caller retains RPC payload and no new session requirement', async () => {
  resetAuth(); await saveStoredPreferenceProfile(snapshot, { profileExists: true, updatedAt: 'synthetic-old-revision' }, 'account');
  assert.equal(auth.calls.length, 1); assert.equal(auth.calls[0].payload.p_expected_updated_at, 'synthetic-old-revision'); assert.equal(auth.unsubscribed, 0);
});
console.log(JSON.stringify({ passed: cases.length, cases, limits: 'Synthetic parser, merge, UI-native adapters and Supabase transport. Actual React DOM and production panel/save declarations. No full application, native runtime, provider, database or production validation.' }, null, 2));
dom.window.close();
