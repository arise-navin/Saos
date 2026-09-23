/**
 * WI-1 — post-mutation write verification.
 *
 * Fixtures in test/fixtures/ are RECORDED from dev442675, not hand-written, so
 * these assert against platform behaviour rather than against a belief about
 * it. E1 is the transcript's own record (`29b5648983be0f10b939cc65eeaad36b`,
 * "AGAMYA_Scope") replayed live during this sprint — the no-op is still there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffWrite, normalizeValue, detectNoOpSignal, verificationForModel } from '../src/servicenow/write-verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', n), 'utf8'));

/* ------------------------------------------------------------------ *
 * The two defects, replayed
 * ------------------------------------------------------------------ */

test('E1 — a silently dropped update is reported as a no-op, not a success', () => {
  const f = fixture('E1-update-silent-drop.json');
  const v = diffWrite({
    table: f.table, operation: f.operation,
    requested: f.requested, returned: f.returned, before: f.before,
  });
  assert.equal(v.verified, false, 'a discarded write must never verify');
  assert.equal(v.status, 'no-op');
  assert.equal(v.dropped.length, 1);
  assert.equal(v.dropped[0].field, 'application');
  assert.equal(v.dropped[0].requested, 'c44f3c6c37c24793be9f8b759c7818e4');
  assert.equal(v.dropped[0].actual, 'global');
  assert.match(v.summary, /no-op: the platform discarded this write/);
});

test('E1 — the cheap corroborating signal fires before the field diff', () => {
  const f = fixture('E1-update-silent-drop.json');
  const sig = detectNoOpSignal(f.before, f.returned);
  assert.equal(sig.unchanged, true, 'sys_mod_count and sys_updated_on both frozen');
  assert.equal(sig.sys_mod_count.before, sig.sys_mod_count.after);
  assert.equal(sig.sys_updated_on.before, sig.sys_updated_on.after);
});

test('E2 — a silently overridden insert is partial, with the field itemized', () => {
  const f = fixture('E2-insert-silent-override.json');
  const v = diffWrite({ table: f.table, operation: f.operation, requested: f.requested, returned: f.returned });
  assert.equal(v.verified, false);
  assert.equal(v.status, 'partial', v.summary);
  const drop = v.dropped.find((d) => d.field === 'application');
  assert.ok(drop, `application not in dropped: ${JSON.stringify(v.dropped)}`);
  assert.equal(drop.actual, 'global');
  // name and state DID land — a partial must not be reported as a total loss.
  assert.ok(v.applied.some((a) => a.field === 'name'), 'name should be applied');
  assert.match(v.summary, /partial: the platform dropped 1 field/);
});

test('the model-facing block carries the verdict and the offending fields', () => {
  const f = fixture('E1-update-silent-drop.json');
  const out = verificationForModel(diffWrite({ ...f, requested: f.requested, returned: f.returned, before: f.before }));
  assert.equal(out.verified, false);
  assert.equal(out.status, 'no-op');
  assert.equal(out.dropped[0].field, 'application');
  assert.match(out.noOpSignal, /unchanged/);
  // The applied list is deliberately absent — on a large payload it is the
  // payload again, and the model needs the verdict, not an echo.
  assert.equal(out.applied, undefined);
});

/* ------------------------------------------------------------------ *
 * Normalization — every rule WI-1 names
 * ------------------------------------------------------------------ */

test('booleans normalize to the strings the platform returns', () => {
  const shapes = fixture('E-shapes-normalization.json');
  assert.equal(shapes.insert.returned.active.value, 'true', 'fixture drifted');
  const v = diffWrite({ table: 'incident', operation: 'insert', requested: { active: true }, returned: { active: shapes.insert.returned.active } });
  assert.equal(v.status, 'applied', v.summary);
  assert.equal(normalizeValue(true), 'true');
  assert.equal(normalizeValue(false), 'false');
});

test('numbers compare loosely — "3" and 3 are the same stored value', () => {
  assert.equal(normalizeValue('3'), normalizeValue(3));
  const v = diffWrite({ table: 'incident', operation: 'update', requested: { impact: 3 }, returned: { impact: { value: '3' } } });
  assert.equal(v.status, 'applied');
});

test('empty, null and absent-from-request are the same fact', () => {
  for (const empty of [null, undefined, '']) assert.equal(normalizeValue(empty), '');
  const v = diffWrite({ table: 'incident', operation: 'update', requested: { description: '' }, returned: { description: { value: null } } });
  assert.equal(v.status, 'applied');
});

test('a reference compares the requested sys_id against the returned value, never the display', () => {
  const v = diffWrite({
    table: 'incident', operation: 'update',
    requested: { assignment_group: '019ad92ec7230010393d265c95c260dd' },
    returned: { assignment_group: { value: '019ad92ec7230010393d265c95c260dd', display_value: 'Network' } },
  });
  assert.equal(v.status, 'applied', v.summary);
});

test('a reference that came back as a DIFFERENT sys_id is dropped, display notwithstanding', () => {
  const v = diffWrite({
    table: 'incident', operation: 'update',
    requested: { assignment_group: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    returned: { assignment_group: { value: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', display_value: 'Network' } },
    before: { assignment_group: { value: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  });
  assert.equal(v.status, 'no-op');
  assert.equal(v.dropped[0].field, 'assignment_group');
});

test('a choice LABEL the platform resolved is transformed, never dropped', () => {
  // Recorded: state "On Hold" is stored as "3" and echoes display "On Hold".
  const f = fixture('E-shapes-normalization.json');
  assert.equal(f.choiceLabel.returned.state.value, '3', 'fixture drifted');
  const v = diffWrite({
    table: 'incident', operation: 'update',
    requested: f.choiceLabel.requested, returned: f.choiceLabel.returned,
    before: { state: { value: '2' } },
  });
  assert.equal(v.status, 'transformed', v.summary);
  assert.equal(v.dropped.length, 0, 'a resolved label must not count as a lost write');
  assert.equal(v.transformed[0].field, 'state');
  assert.match(v.transformed[0].reason, /label was resolved/);
});

test('journal fields are unverifiable by echo, not dropped', () => {
  const f = fixture('E-shapes-normalization.json');
  assert.equal(f.insert.returned.comments.value, '', 'fixture drifted: journal echoed a value');
  const v = diffWrite({
    table: 'incident', operation: 'insert',
    requested: { comments: 'journal text' },
    returned: { comments: f.insert.returned.comments },
    fieldTypes: { comments: 'journal_input' },
  });
  assert.equal(v.dropped.length, 0, 'a journal write that landed must not read as dropped');
  assert.equal(v.unverifiable.length, 1);
  assert.equal(v.unverifiable[0].field, 'comments');
  assert.equal(v.status, 'unverified');
});

test('priority is platform-computed — surfaced as transformed, never an error', () => {
  const v = diffWrite({
    table: 'incident', hierarchy: ['task'], operation: 'update',
    requested: { priority: '1' },
    returned: { priority: { value: '4', display_value: '4 - Low' } },
    before: { priority: { value: '3' } },
  });
  assert.equal(v.status, 'transformed', v.summary);
  assert.equal(v.dropped.length, 0);
  assert.match(v.transformed[0].reason, /platform-computed/);
});

test('a requested field absent from the response is dropped, and says why', () => {
  const f = fixture('E-shapes-normalization.json');
  assert.equal(f.unknownField.returnedHasKey, false, 'fixture drifted');
  const v = diffWrite({ table: 'incident', operation: 'update', requested: { u_nha_not_a_field: 'x' }, returned: { sys_id: { value: 'a' } } });
  assert.equal(v.status, 'no-op');
  assert.match(v.dropped[0].reason, /not a column on this table/);
});

test('server-controlled fields are never diffed', () => {
  const v = diffWrite({
    table: 'incident', operation: 'update',
    requested: { sys_updated_on: 'whenever', sys_mod_count: '99', short_description: 'x' },
    returned: { sys_updated_on: { value: 'other' }, sys_mod_count: { value: '2' }, short_description: { value: 'x' } },
  });
  assert.equal(v.status, 'applied', v.summary);
  assert.equal(v.applied.length, 1);
});

test('a fully applied write verifies', () => {
  const v = diffWrite({
    table: 'incident', operation: 'update',
    requested: { short_description: 'hello', impact: '2' },
    returned: { short_description: { value: 'hello' }, impact: { value: '2', display_value: '2 - Medium' } },
    before: { short_description: { value: 'old' }, impact: { value: '3' } },
  });
  assert.equal(v.verified, true);
  assert.equal(v.status, 'applied');
  assert.match(v.summary, /all 2 requested fields stored as sent/);
});

test('a mixed write is partial and names only the field that was lost', () => {
  const v = diffWrite({
    table: 'sys_update_set', operation: 'update',
    requested: { name: 'renamed', application: 'c44f3c6c37c24793be9f8b759c7818e4' },
    returned: { name: { value: 'renamed' }, application: { value: 'global', display_value: 'Global' } },
    before: { name: { value: 'old' }, application: { value: 'global' }, sys_mod_count: { value: '0' }, sys_updated_on: { value: 'T0' } },
  });
  assert.equal(v.status, 'partial', v.summary);
  assert.equal(v.dropped.length, 1);
  assert.equal(v.applied.length, 1);
});

test('the no-op signal PROMOTES a partial to a no-op — nothing on the record moved', () => {
  // The field diff alone would say "partial"; sys_mod_count says nothing was
  // stored at all, and that is the more trustworthy of the two.
  const v = diffWrite({
    table: 'sys_update_set', operation: 'update',
    requested: { name: 'renamed', application: 'x' },
    returned: { name: { value: 'renamed' }, application: { value: 'global' }, sys_mod_count: { value: '0' }, sys_updated_on: { value: 'T0' } },
    before: { name: { value: 'renamed' }, application: { value: 'global' }, sys_mod_count: { value: '0' }, sys_updated_on: { value: 'T0' } },
  });
  assert.equal(v.status, 'no-op', v.summary);
});

test('without a before record the no-op signal reports "not checked", not "fine"', () => {
  assert.equal(detectNoOpSignal(null, { sys_mod_count: { value: '1' } }), null);
  const v = diffWrite({ table: 'incident', operation: 'insert', requested: { short_description: 'x' }, returned: { short_description: { value: 'x' } } });
  assert.equal(v.noOpSignal, null);
});
