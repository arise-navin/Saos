/**
 * WI-3 — the silent-drop registry.
 *
 * Replays the transcript's triple attempt: the same write on
 * `sys_update_set.application` submitted, approved and silently discarded three
 * times. Attempt 1 must execute and be recorded as dropped; attempts 2 and 3
 * must be blocked BEFORE the approval gate, so no human is asked to authorise a
 * write with proof against it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tupleHash, payloadHash, recordDrops, findKnownDrops, checkBeforeGate,
  recordRejection, findRejection, clearSession, _reset, _dropCount,
} from '../src/agent/write-guard.js';

const SESSION = 'guard-session';
const NW = '73cd84168376c750b939cc65eeaad3ff';
const SET = '29b5648983be0f10b939cc65eeaad36b';

const DROPPED = {
  status: 'no-op', verified: false,
  dropped: [{ field: 'application', requested: NW, actual: 'global', reason: 'unchanged — the record still holds its previous value' }],
  transformed: [], unverifiable: [],
};

const descriptorFor = (value = NW) => ({
  table: 'sys_update_set', operation: 'update', sys_id: SET, requested: { application: value },
});

test.beforeEach(() => _reset());

/* ------------------------------------------------------------------ *
 * The transcript's triple attempt
 * ------------------------------------------------------------------ */

test('E1 — attempt 1 runs, attempt 2 is blocked before the gate, attempt 3 too', () => {
  const d = descriptorFor();

  // Attempt 1: nothing known yet, so it must be allowed through to the gate.
  assert.equal(checkBeforeGate({ sessionId: SESSION, turnSeq: 1, tool: 'update_record', descriptor: d }).allowed, true);

  // ...it executes, and WI-1 proves the platform discarded it.
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: d.table, sys_id: d.sys_id, operation: d.operation, verification: DROPPED });

  // Attempt 2 and 3: blocked, and never reach a human.
  for (const turn of [1, 2]) {
    const v = checkBeforeGate({ sessionId: SESSION, turnSeq: turn, tool: 'update_record', descriptor: d });
    assert.equal(v.allowed, false, `attempt in turn ${turn} was not blocked`);
    assert.equal(v.reason, 'known-drop');
    assert.match(v.message, /already silently dropped by the platform this session/);
    assert.match(v.message, /turn 1/);
  }
});

test('the block tells the model where to go next, not just "no"', () => {
  const d = descriptorFor();
  recordDrops({ sessionId: SESSION, turnSeq: 4, table: d.table, sys_id: d.sys_id, operation: d.operation, verification: DROPPED });
  const { message } = checkBeforeGate({ sessionId: SESSION, turnSeq: 5, tool: 'update_record', descriptor: d });
  assert.match(message, /sys_script \(collection=sys_update_set\)/, 'no diagnosis path offered');
  assert.match(message, /sys_security_acl/);
  assert.match(message, /sysauto_script background-script harness/, 'no workaround path offered');
  assert.match(message, /a different value is not blocked/);
});

test('drops are SESSION-scoped — a new turn does not forget platform behaviour', () => {
  const d = descriptorFor();
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: d.table, sys_id: d.sys_id, operation: d.operation, verification: DROPPED });
  // Ten turns later the platform still behaves the same way.
  assert.equal(checkBeforeGate({ sessionId: SESSION, turnSeq: 11, tool: 'update_record', descriptor: d }).allowed, false);
});

test('a DIFFERENT value for the same field is not blocked', () => {
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: 'sys_update_set', sys_id: SET, operation: 'update', verification: DROPPED });
  const other = checkBeforeGate({ sessionId: SESSION, turnSeq: 2, tool: 'update_record', descriptor: descriptorFor('global') });
  assert.equal(other.allowed, true, 'trying a different value must stay open');
});

test('a different RECORD is not blocked — the proof was about this one', () => {
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: 'sys_update_set', sys_id: SET, operation: 'update', verification: DROPPED });
  const elsewhere = checkBeforeGate({
    sessionId: SESSION, turnSeq: 2, tool: 'update_record',
    descriptor: { table: 'sys_update_set', operation: 'update', sys_id: 'a-different-set', requested: { application: NW } },
  });
  assert.equal(elsewhere.allowed, true);
});

test('an INSERT drop blocks the next identical insert on that table', () => {
  // E2: sys_update_set.application forced to global on create. The next create
  // carrying the same field/value will be forced the same way.
  recordDrops({
    sessionId: SESSION, turnSeq: 1, table: 'sys_update_set', operation: 'insert',
    verification: { dropped: [{ field: 'application', requested: NW, actual: 'global' }] },
  });
  const again = checkBeforeGate({
    sessionId: SESSION, turnSeq: 2, tool: 'create_record',
    descriptor: { table: 'sys_update_set', operation: 'insert', requested: { name: 'another set', application: NW } },
  });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'known-drop');
});

test('another session is unaffected — registries are per session', () => {
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: 'sys_update_set', sys_id: SET, operation: 'update', verification: DROPPED });
  assert.equal(checkBeforeGate({ sessionId: 'other', turnSeq: 1, tool: 'update_record', descriptor: descriptorFor() }).allowed, true);
});

/* ------------------------------------------------------------------ *
 * The escape hatch
 * ------------------------------------------------------------------ */

test('force lets a blocked write through, and says it was forced', () => {
  const d = descriptorFor();
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: d.table, sys_id: d.sys_id, operation: d.operation, verification: DROPPED });
  const v = checkBeforeGate({ sessionId: SESSION, turnSeq: 2, tool: 'update_record', descriptor: d, force: true });
  assert.equal(v.allowed, true);
  assert.equal(v.forced, true);
  assert.equal(v.drops.length, 1, 'a forced write must still report what it is overriding');
});

/* ------------------------------------------------------------------ *
 * Rejections — turn-scoped, unlike drops
 * ------------------------------------------------------------------ */

test('a rejected call is blocked if resubmitted in the SAME turn', () => {
  const d = descriptorFor();
  recordRejection({ sessionId: SESSION, turnSeq: 7, tool: 'update_record', table: d.table, sys_id: d.sys_id, requested: d.requested });
  const v = checkBeforeGate({ sessionId: SESSION, turnSeq: 7, tool: 'update_record', descriptor: d });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'user-rejected');
});

test('a rejection does NOT persist into the next turn — asking again means it', () => {
  const d = descriptorFor();
  recordRejection({ sessionId: SESSION, turnSeq: 7, tool: 'update_record', table: d.table, sys_id: d.sys_id, requested: d.requested });
  assert.equal(checkBeforeGate({ sessionId: SESSION, turnSeq: 8, tool: 'update_record', descriptor: d }).allowed, true);
  assert.equal(findRejection({ sessionId: SESSION, turnSeq: 8, tool: 'update_record', table: d.table, sys_id: d.sys_id, requested: d.requested }), null);
});

test('rejection identity is the whole payload — one changed field is a new request', () => {
  const a = { table: 'incident', sys_id: 'x', requested: { short_description: 'one', urgency: '1' } };
  const b = { table: 'incident', sys_id: 'x', requested: { short_description: 'one', urgency: '2' } };
  recordRejection({ sessionId: SESSION, turnSeq: 1, tool: 'update_record', ...a });
  assert.ok(findRejection({ sessionId: SESSION, turnSeq: 1, tool: 'update_record', ...a }));
  assert.equal(findRejection({ sessionId: SESSION, turnSeq: 1, tool: 'update_record', ...b }), null);
});

test('payload hashing is order-insensitive — key order is not a difference', () => {
  const one = payloadHash({ tool: 't', table: 'incident', sys_id: 'x', requested: { a: '1', b: '2' } });
  const two = payloadHash({ tool: 't', table: 'incident', sys_id: 'x', requested: { b: '2', a: '1' } });
  assert.equal(one, two);
});

test('tuple hashing normalizes the way the verifier does', () => {
  assert.equal(tupleHash({ table: 't', sys_id: 'r', field: 'f', value: 3 }), tupleHash({ table: 't', sys_id: 'r', field: 'f', value: '3' }));
  assert.equal(tupleHash({ table: 't', sys_id: 'r', field: 'f', value: true }), tupleHash({ table: 't', sys_id: 'r', field: 'f', value: 'true' }));
  assert.notEqual(tupleHash({ table: 't', sys_id: 'r', field: 'f', value: 'a' }), tupleHash({ table: 't', sys_id: 'r', field: 'f', value: 'b' }));
});

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */

test('a mutation with no dropped fields registers nothing', () => {
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: 'incident', sys_id: 'a', operation: 'update', verification: { dropped: [] } });
  assert.equal(_dropCount(SESSION), 0);
});

test('the same drop recorded twice is stored once', () => {
  for (let i = 0; i < 3; i++) {
    recordDrops({ sessionId: SESSION, turnSeq: i, table: 'sys_update_set', sys_id: SET, operation: 'update', verification: DROPPED });
  }
  assert.equal(_dropCount(SESSION), 1);
});

test('deleting a session clears its registries', () => {
  recordDrops({ sessionId: SESSION, turnSeq: 1, table: 'sys_update_set', sys_id: SET, operation: 'update', verification: DROPPED });
  clearSession(SESSION);
  assert.equal(_dropCount(SESSION), 0);
  assert.equal(checkBeforeGate({ sessionId: SESSION, turnSeq: 2, tool: 'update_record', descriptor: descriptorFor() }).allowed, true);
});

test('a tool with no describeWrite is never blocked — nothing is known about it', () => {
  assert.equal(checkBeforeGate({ sessionId: SESSION, turnSeq: 1, tool: 'create_flow_live', descriptor: null }).allowed, true);
});
