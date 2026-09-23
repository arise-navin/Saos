/**
 * WI-4 — exact-match ranking in `lookup_reference`.
 *
 * The defect (E3): searching `sys_user` for "admin" returned
 * dd9b3742… "Certification Admin", because the lookup did a contains-match on
 * the DISPLAY field (`name`) sorted alphabetically, and never searched
 * `user_name` at all. The real admin — sys_id 6816f79c…, `user_name = admin`,
 * displayed as "System Administrator" — could not win a search for its own key.
 * Two incidents were then created with caller ≠ opener, silently.
 *
 * Offline: `table.query` is stubbed with rows recorded from dev442675
 * (fixtures/E3-lookup-shadowing.json), so the ranking is asserted without an
 * instance and without a PDI flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const E3 = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'E3-lookup-shadowing.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * A fake instance built from the recorded rows
 * ------------------------------------------------------------------ */

const USERS = [
  { sys_id: '6816f79cc0a8016401c5a33be04be441', name: 'System Administrator', user_name: 'admin', email: 'admin@example.com' },
  { sys_id: 'dd9b3742c37030009b5efcfc5bba8fb6', name: 'Certification Admin', user_name: 'certification_admin', email: 'ca@example.com' },
  { sys_id: '8ff5b254b33213005e3de13516a8dcf7', name: 'CMDB Admin', user_name: 'cmdb_admin', email: 'cmdb@example.com' },
  { sys_id: '860a4d35eb32010045e1a5115206fe54', name: 'Credential Admin', user_name: 'cred.admin', email: 'cred@example.com' },
];
const SCOPES = [
  { sys_id: 'global', name: 'Global', scope: 'global' },
  { sys_id: 'dc1fcaa2c3032200f7d1ca3adfba8f1a', name: 'Enhanced Global Search UI', scope: 'sn_global_searchui' },
  { sys_id: '68ed3c3fd5c9b79cc0673a1552d23c8f', name: 'sn-component-workspace-global-search', scope: 'sn_ui_globalsearch' },
];
const GROUPS = [
  { sys_id: '287ebd7da9fe198100f92cc8d1d2154e', name: 'Network' },
  { sys_id: '5418973d93a0220050bef157b67ffbe6', name: 'Network CAB Managers' },
  { sys_id: '3cc3c7680b982300cac6c08393673a03', name: 'ATF_TestGroup_Network' },
];
const DATA = { sys_user: USERS, sys_scope: SCOPES, sys_user_group: GROUPS };

/** The subset of encoded-query syntax referenceLookup actually emits. */
function runQuery(rows, query) {
  const clause = String(query || '').split('^ORDERBY')[0];
  if (!clause) return rows;
  let m;
  // Measured on dev442675: `=` on a string field (and on sys_id) is
  // CASE-INSENSITIVE. `user_name=Admin` and `user_name=ADMIN` both return the
  // `admin` row. The fake matches the platform, or the test asserts a stricter
  // world than the one the code runs in.
  const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  if ((m = /^sys_id=(.+)$/.exec(clause))) return rows.filter((r) => eq(r.sys_id, m[1]));
  if ((m = /^(\w+)STARTSWITH(.+)$/.exec(clause))) {
    return rows.filter((r) => String(r[m[1]] ?? '').toLowerCase().startsWith(m[2].toLowerCase()));
  }
  if ((m = /^(\w+)LIKE(.+)$/.exec(clause))) {
    return rows.filter((r) => String(r[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase()));
  }
  if ((m = /^(\w+)=(.+)$/.exec(clause))) {
    if (!(m[1] in (rows[0] || {}))) throw new Error(`no such field ${m[1]}`);
    return rows.filter((r) => eq(r[m[1]], m[2]));
  }
  return rows;
}

const clientMod = await import('../src/servicenow/client.js');
const schemaMod = await import('../src/servicenow/schema.js');
const { referenceLookup, clearSchemaCaches } = schemaMod;

const realQuery = clientMod.table.query;
clientMod.table.query = async (t, { query, limit = 15 } = {}) => {
  if (t === 'sys_dictionary') {
    // getDisplayField walks this; `name` is the display field for all three.
    return [{ element: 'name', name: 'sys_user' }, { element: 'name', name: 'sys_scope' }, { element: 'name', name: 'sys_user_group' }];
  }
  if (t === 'sys_db_object') return [];                    // hierarchy walk terminates
  const rows = DATA[t];
  if (!rows) return realQuery(t, { query, limit });
  return runQuery(rows, query).slice(0, limit);
};
clearSchemaCaches();

/* ------------------------------------------------------------------ *
 * E3, replayed
 * ------------------------------------------------------------------ */

test('E3 — "admin" resolves to the user whose user_name IS admin', async () => {
  // What the old lookup did, straight from the recorded fixture.
  assert.equal(E3.cases[0].currentTop[0].display, 'Certification Admin', 'fixture drifted');
  assert.equal(E3.cases[0].correct.sys_id, '6816f79cc0a8016401c5a33be04be441');

  const r = await referenceLookup('sys_user', 'admin', 10);
  assert.equal(r[0].sys_id, '6816f79cc0a8016401c5a33be04be441', 'the real admin is still not first');
  assert.equal(r[0].display, 'System Administrator');
  assert.equal(r[0].matchType, 'exact');
  assert.equal(r[0].key, 'user_name');
  assert.equal(r[0].keyValue, 'admin');
  assert.equal(r.ambiguous, false, 'an exact key match is not ambiguous');
});

test('E3 — Certification Admin is still returned, just ranked below as a contains', async () => {
  const r = await referenceLookup('sys_user', 'admin', 10);
  const cert = r.find((x) => x.sys_id === 'dd9b3742c37030009b5efcfc5bba8fb6');
  assert.ok(cert, 'a valid candidate was dropped rather than ranked');
  assert.equal(cert.matchType, 'contains');
  assert.ok(r.indexOf(cert) > 0, 'Certification Admin must not be first');
});

test('E3 — "global" on sys_scope resolves via the literal sys_id probe', async () => {
  assert.equal(E3.cases[1].currentTop[0].display, 'Enhanced Global Search UI', 'fixture drifted');
  const r = await referenceLookup('sys_scope', 'global', 10);
  assert.equal(r[0].sys_id, 'global', 'the Global scope, whose sys_id IS the literal "global"');
  assert.equal(r[0].display, 'Global');
  assert.equal(r[0].matchType, 'id');
  assert.equal(r.ambiguous, false);
});

/* ------------------------------------------------------------------ *
 * Ranking and ambiguity
 * ------------------------------------------------------------------ */

test('the four ranks come back in order', async () => {
  const r = await referenceLookup('sys_user_group', 'Network', 10);
  assert.deepEqual(r.map((x) => x.display), ['Network', 'Network CAB Managers', 'ATF_TestGroup_Network']);
  assert.deepEqual(r.map((x) => x.matchType), ['exact-display', 'starts-with', 'contains']);
});

test('an exact match on a table whose key IS its display is not ambiguous', async () => {
  // sys_user_group.name is both. Flagging "Network" ambiguous would make the
  // agent confirm something it got exactly right.
  const r = await referenceLookup('sys_user_group', 'Network', 10);
  assert.equal(r.ambiguous, false);
  assert.equal(r.confirmBefore, undefined);
});

test('no exact match anywhere means ambiguous, with an instruction attached', async () => {
  const noExact = await referenceLookup('sys_user_group', 'Net', 10);
  assert.equal(noExact.ambiguous, true);
  assert.match(noExact.confirmBefore, /Do not use this in a mutation payload without confirming/);
});

test('case and surrounding whitespace do not cost an exact match', async () => {
  // Encoded-query `=` is case-insensitive on the instance, and the term is
  // trimmed before it is sent — so all three of these are the same search.
  for (const term of ['admin', 'Admin ', ' ADMIN']) {
    const r = await referenceLookup('sys_user', term, 10);
    assert.equal(r[0].sys_id, '6816f79cc0a8016401c5a33be04be441', `"${term}" did not resolve exactly`);
    assert.equal(r.ambiguous, false, `"${term}" was flagged ambiguous`);
  }
});

test('a term matching nothing returns an empty, unambiguous-by-absence result', async () => {
  const r = await referenceLookup('sys_user', 'nobody-by-that-name', 10);
  assert.equal(r.length, 0);
  assert.equal(r.resolved, null);
});

test('an empty search browses, and browsing is never flagged ambiguous', async () => {
  const r = await referenceLookup('sys_user_group', '', 10);
  assert.ok(r.length > 0);
  assert.equal(r.ambiguous, false);
  assert.equal(r[0].matchType, 'browse');
});

test('duplicates across ranks are returned once, at their best rank', async () => {
  const r = await referenceLookup('sys_user', 'admin', 10);
  assert.equal(new Set(r.map((x) => x.sys_id)).size, r.length, 'the same record appeared twice');
});

test('a 32-hex term is probed as a sys_id first, on any table', async () => {
  const r = await referenceLookup('sys_user', '6816f79cc0a8016401c5a33be04be441', 5);
  assert.equal(r[0].matchType, 'id');
  assert.equal(r[0].display, 'System Administrator');
  assert.equal(r.ambiguous, false);
});

test('a key field that does not exist on the table is skipped, not fatal', async () => {
  // sys_user_group has no `user_name`; the configured keys for other tables
  // must never make a lookup throw.
  const r = await referenceLookup('sys_user_group', 'Network', 5);
  assert.ok(r.length > 0);
});

test('the result carries the key that matched, so a caller can show WHY', async () => {
  const r = await referenceLookup('sys_scope', 'sn_global_searchui', 5);
  assert.equal(r[0].matchType, 'exact');
  assert.equal(r[0].key, 'scope');
  assert.equal(r[0].keyValue, 'sn_global_searchui');
});

test.after(() => { clientMod.table.query = realQuery; clearSchemaCaches(); });
