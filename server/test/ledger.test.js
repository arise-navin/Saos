/**
 * WI-2 — the mutation ledger, and the invariant it exists to make mechanical:
 * an executed mutation cannot be absent from the turn's report.
 *
 * The defect being replayed (E4): a compaction fired mid-turn, 13,348 → 3,062
 * tokens, immediately before the closing summary — and that summary omitted an
 * approved, executed record creation entirely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { createSession, appendMessage, replaceSpanWithDigest, loadHistory, latestUserSeq } from '../src/memory/sessions.js';
import {
  appendMutation, annotateLatestCapture, mutationsForTurn, mutationsForSession,
  renderMutationReport, ledgerDigestForModel,
} from '../src/memory/ledger.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-ledger-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const NOOP = {
  status: 'no-op', verified: false, summary: 'no-op: the platform discarded this write — application unchanged',
  dropped: [{ field: 'application', requested: '73cd8416', actual: 'global' }], transformed: [], unverifiable: [],
};
const APPLIED = { status: 'applied', verified: true, summary: 'all 1 requested field stored as sent', dropped: [], transformed: [], unverifiable: [] };
const PARTIAL = {
  status: 'partial', verified: false, summary: 'partial: the platform dropped 1 field (application)',
  dropped: [{ field: 'application', requested: '73cd8416', actual: 'global' }], transformed: [], unverifiable: [],
};

test('migration 7 creates the ledger table', () => {
  const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mutation_ledger'").get();
  assert.equal(row?.name, 'mutation_ledger');
});

test('an executed mutation is recorded with what a human would search for', () => {
  const s = createSession({ id: 'led-1', title: 'ledger' });
  appendMutation({
    sessionId: s.id, turnSeq: 1, tool: 'create_incident',
    descriptor: { table: 'incident', operation: 'insert', requested: { short_description: 'x' }, sys_id: 'abc' },
    result: { number: { value: 'INC0010047' }, sys_id: { value: 'abc' } },
    verification: APPLIED, approval: 'approved',
  });
  const [e] = mutationsForTurn('led-1', 1);
  assert.equal(e.tool, 'create_incident');
  assert.equal(e.displayId, 'INC0010047', 'the number is what a user types into a search box');
  assert.equal(e.sys_id, 'abc');
  assert.equal(e.status, 'applied');
  assert.equal(e.approval, 'approved');
});

test('a composite builder\'s nested primary record still yields an identifier', () => {
  appendMutation({
    sessionId: 'led-1', turnSeq: 2, tool: 'create_catalog_item',
    descriptor: { table: 'sc_cat_item', operation: 'insert', requested: { name: 'Laptop' } },
    result: { item: { sys_id: 'itm1', name: 'Laptop Request' }, variables: [] },
    verification: APPLIED, approval: 'approved',
  });
  assert.equal(mutationsForTurn('led-1', 2)[0].displayId, 'Laptop Request');
});

/* ------------------------------------------------------------------ *
 * The invariant
 * ------------------------------------------------------------------ */

test('E4 — three mutations survive a mid-turn compaction and all reach the report', () => {
  const s = createSession({ id: 'led-compact', title: 'compaction' });
  const userSeq = appendMessage(s.id, { role: 'user', text: 'do three things' });
  for (let i = 0; i < 12; i++) appendMessage(s.id, { role: 'assistant', text: `filler turn ${i}` });

  appendMutation({ sessionId: s.id, turnSeq: userSeq, tool: 'create_record',
    descriptor: { table: 'sys_update_set', operation: 'insert', requested: { name: 'AGAMYA_Test_Incidents', application: '73cd8416' } },
    result: { sys_id: { value: '22bf4c56' }, name: { value: 'AGAMYA_Test_Incidents' } }, verification: PARTIAL, approval: 'approved' });
  appendMutation({ sessionId: s.id, turnSeq: userSeq, tool: 'update_record',
    descriptor: { table: 'sys_update_set', operation: 'update', requested: { application: '73cd8416' }, sys_id: '29b56489' },
    result: { sys_id: { value: '29b56489' }, name: { value: 'AGAMYA_Scope' } }, verification: NOOP, approval: 'approved' });
  appendMutation({ sessionId: s.id, turnSeq: userSeq, tool: 'create_incident',
    descriptor: { table: 'incident', operation: 'insert', requested: { short_description: 'test' } },
    result: { number: { value: 'INC0010048' }, sys_id: { value: 'inc2' } }, verification: APPLIED, approval: 'approved' });

  const before = mutationsForTurn(s.id, userSeq).length;
  assert.equal(before, 3);

  // Force exactly what happened in the transcript: fold the turn's history away.
  replaceSpanWithDigest(s.id, 0, 10, 'a digest that mentions none of the above');
  assert.ok(loadHistory(s.id).length < 13, 'history was not actually compacted');

  const after = mutationsForTurn(s.id, userSeq);
  assert.equal(after.length, 3, 'compaction removed ledger entries');
  const report = renderMutationReport(after);
  assert.match(report, /AGAMYA_Test_Incidents/);
  assert.match(report, /AGAMYA_Scope/);
  assert.match(report, /INC0010048/);
});

test('compaction cannot reach the ledger table at all — it is structural, not defended', () => {
  const s = createSession({ id: 'led-struct', title: 'x' });
  const seq = appendMessage(s.id, { role: 'user', text: 'hello' });
  appendMutation({ sessionId: s.id, turnSeq: seq, tool: 'create_record',
    descriptor: { table: 'incident', operation: 'insert', requested: {} }, result: { sys_id: { value: 'z' } },
    verification: APPLIED, approval: 'approved' });
  for (let i = 0; i < 6; i++) appendMessage(s.id, { role: 'assistant', text: `x${i}` });
  replaceSpanWithDigest(s.id, 0, 5, 'digest');
  assert.equal(mutationsForTurn(s.id, seq).length, 1);
  assert.equal(latestUserSeq(s.id) >= 0, true);
});

/* ------------------------------------------------------------------ *
 * The report — the glyph comes from the verification, never from a guess
 * ------------------------------------------------------------------ */

test('a discarded write can never carry a success glyph', () => {
  const report = renderMutationReport([
    { tool: 'update_record', table: 'sys_update_set', sys_id: '29b56489', displayId: 'AGAMYA_Scope',
      status: 'no-op', approval: 'approved', verification: NOOP, requested: {} },
  ]);
  assert.match(report, /❌/);
  assert.doesNotMatch(report, /✅/, 'a no-op rendered a success glyph');
  assert.match(report, /The platform discarded this write/);
  assert.match(report, /`application`/);
});

test('a partial is amber and says which fields survived', () => {
  const report = renderMutationReport([
    { tool: 'create_record', table: 'sys_update_set', sys_id: '22bf4c56', displayId: 'AGAMYA_Test_Incidents',
      status: 'partial', approval: 'approved', verification: PARTIAL, requested: {} },
  ]);
  assert.match(report, /⚠️/);
  assert.doesNotMatch(report, /✅/);
  assert.match(report, /Partially applied/);
  assert.match(report, /the other fields landed/);
});

test('an applied write is the only thing that gets a success glyph', () => {
  const report = renderMutationReport([
    { tool: 'create_incident', table: 'incident', sys_id: 'abc', displayId: 'INC0010047',
      status: 'applied', approval: 'approved', verification: APPLIED, requested: {} },
  ]);
  assert.match(report, /✅/);
  assert.doesNotMatch(report, /❌/);
});

test('an auto-approved mutation says no human saw the gate', () => {
  const report = renderMutationReport([
    { tool: 'create_incident', table: 'incident', sys_id: 'a', displayId: 'INC1', status: 'applied', approval: 'auto', verification: APPLIED, requested: {} },
  ]);
  assert.match(report, /no human saw the gate/);
});

test('the capture annotation rides along on the ledger entry', () => {
  const s = createSession({ id: 'led-cap', title: 'cap' });
  appendMutation({ sessionId: s.id, turnSeq: 5, tool: 'create_incident',
    descriptor: { table: 'incident', operation: 'insert', requested: {} }, result: { number: { value: 'INC9' } },
    verification: APPLIED, approval: 'approved' });
  annotateLatestCapture(s.id, 5, { captured: false, message: 'not captured — data, not configuration (incident does not extend sys_metadata)' });
  const [e] = mutationsForTurn(s.id, 5);
  assert.equal(e.capture.captured, false);
  assert.match(renderMutationReport([e]), /data, not configuration/);
});

test('an empty turn renders no report rather than an empty heading', () => {
  assert.equal(renderMutationReport([]), '');
  assert.equal(renderMutationReport(null), '');
});

/* ------------------------------------------------------------------ *
 * The model-facing digest
 * ------------------------------------------------------------------ */

test('the digest tells the model a no-op is not something to report as done', () => {
  const d = ledgerDigestForModel([
    { tool: 'update_record', table: 'sys_update_set', sys_id: '29b56489', displayId: 'AGAMYA_Scope', status: 'no-op', verification: NOOP },
  ]);
  assert.match(d, /MUTATIONS EXECUTED THIS TURN/);
  assert.match(d, /DISCARDED by the platform/);
  assert.match(d, /do not report this as done/);
  assert.match(d, /never as a success/);
});

test('the digest is empty when nothing was mutated, so it costs no tokens', () => {
  assert.equal(ledgerDigestForModel([]), '');
});

test('the session view returns newest first across turns', () => {
  const all = mutationsForSession('led-1');
  assert.ok(all.length >= 2);
  assert.ok(all[0].id > all[1].id, 'not newest-first');
});

test('a ledger write never throws, whatever it is handed', () => {
  assert.equal(appendMutation({ sessionId: null, tool: null, descriptor: null, result: null, verification: null }), false);
  assert.equal(annotateLatestCapture('nope', 999, null), false);
});
