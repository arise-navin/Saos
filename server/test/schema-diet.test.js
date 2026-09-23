/**
 * D-7 — the tool-result diet, which is a correctness fix wearing a size fix's
 * clothes.
 *
 *   node --test server/test/
 *
 * MEASURED against dev442675. `incident` inherits from `task` and carries 91
 * fields; serialised in full that is 29,152 characters, about 8,330 estimated
 * tokens. The agent's history budget at the time was 5,452 — so one schema read
 * was 153% of everything the conversation was allowed to hold.
 *
 * The orchestrator's 8,000-character result cap hid that instead of fixing it,
 * and hid it in the worst way available. Fields are sorted alphabetically, so
 * the truncation landed after `company`: the agent saw 26 of 91 fields. It
 * never saw `state`, `priority`, `description` or `assignment_group`, and
 * because `u_` fields sort last it could not observe that a custom field was
 * ABSENT. It was being asked to check for fields it was structurally incapable
 * of seeing — and "I checked and they are not there" and "I could not see far
 * enough to tell" are indistinguishable from the outside.
 *
 * The fixture below is the real shape, trimmed: alphabetical, with the fields
 * that matter deliberately placed late.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toCompactSchema } from '../src/servicenow/schema.js';
import { estimateTextTokens } from '../src/memory/tokens.js';

/** Enough fields, with enough choices, to reproduce the truncation. */
function fixture() {
  const fields = [];
  // 40 leading fields, alphabetically before the interesting ones, each padded
  // the way a real dictionary row is (label, defaults, max length).
  for (let i = 0; i < 40; i++) {
    fields.push({
      name: `a_field_${String(i).padStart(2, '0')}`,
      label: `A rather long human readable column label number ${i}`,
      type: 'string',
      reference: null,
      maxLength: 4000,
      mandatory: false,
      readOnly: false,
      defaultValue: null,
      definedOn: 'task',
      choices: null,
    });
  }
  fields.push({
    name: 'assignment_group', label: 'Assignment group', type: 'reference', reference: 'sys_user_group',
    maxLength: 32, mandatory: false, readOnly: false, defaultValue: null, definedOn: 'task', choices: null,
  });
  fields.push({
    name: 'short_description', label: 'Short description', type: 'string',
    reference: null, maxLength: 160, mandatory: true, readOnly: false, defaultValue: null, definedOn: 'task', choices: null,
  });
  fields.push({
    name: 'state', label: 'State', type: 'integer', reference: null, maxLength: 40,
    mandatory: false, readOnly: false, defaultValue: '1', definedOn: 'task',
    choices: [
      { label: 'New', value: '1' }, { label: 'In Progress', value: '2' },
      { label: 'On Hold', value: '3' }, { label: 'Resolved', value: '6' },
      { label: 'Closed', value: '7' }, { label: 'Canceled', value: '8' },
    ],
  });
  fields.push({
    name: 'sys_created_on', label: 'Created', type: 'glide_date_time', reference: null, maxLength: 40,
    mandatory: false, readOnly: true, defaultValue: null, definedOn: 'sys_metadata', choices: null,
  });
  return { table: 'incident', hierarchy: ['incident', 'task'], fields };
}

/* ------------------------------------------------------------------ *
 * The correctness half
 * ------------------------------------------------------------------ */

test('every field name survives, so absence is a conclusion the agent can reach', () => {
  const schema = fixture();
  const compact = toCompactSchema(schema);
  assert.equal(compact.fields.length, schema.fields.length);
  assert.equal(compact.fieldCount, schema.fields.length);

  // The specific failure: these sort after the truncation point and were
  // invisible. A stress spec that asks the agent to check for u_sla_* fields
  // cannot be answered honestly without them.
  const serialised = JSON.stringify(compact);
  for (const late of ['assignment_group', 'short_description', 'state', 'sys_created_on']) {
    assert.ok(serialised.includes(late), `${late} must be visible — it sorts after the old cut`);
  }
});

test('the compact form fits under the 8,000-character result cap', () => {
  // Not a nicety: over the cap the result is truncated mid-field, and the tail
  // of an alphabetical field list is where custom `u_` fields live.
  const out = JSON.stringify(toCompactSchema(fixture()), null, 1);
  assert.ok(out.length < 8_000, `compact schema is ${out.length} chars and would still be truncated`);
});

test('a full schema of this size would NOT fit, which is why the default flipped', () => {
  // The control. If this ever starts fitting, the fixture has drifted away from
  // the shape that caused the defect and the test above proves nothing.
  const out = JSON.stringify(fixture(), null, 1);
  assert.ok(out.length > 8_000, `fixture is only ${out.length} chars — too small to reproduce the truncation`);
});

/* ------------------------------------------------------------------ *
 * The size half
 * ------------------------------------------------------------------ */

test('compact mode is several times smaller than full', () => {
  const schema = fixture();
  const full = estimateTextTokens(JSON.stringify(schema, null, 1));
  const compact = estimateTextTokens(JSON.stringify(toCompactSchema(schema), null, 1));
  assert.ok(compact * 3 < full, `expected a large reduction, got ${full} -> ${compact} tokens`);
});

test('choices are counted, not listed, until asked for', () => {
  const compact = toCompactSchema(fixture());
  const stateRow = compact.fields.find((f) => f.startsWith('state:'));
  assert.match(stateRow, /\+6 choices/);
  // The values themselves are absent — that is the saving.
  assert.ok(!JSON.stringify(compact).includes('In Progress'));
  assert.match(compact.note, /expand/);
});

test('expand returns the values for named fields only', () => {
  const compact = toCompactSchema(fixture(), { expand: ['state'] });
  assert.deepEqual(compact.choices.state, [
    '1 = New', '2 = In Progress', '3 = On Hold', '6 = Resolved', '7 = Closed', '8 = Canceled',
  ]);
  assert.ok(!compact.note, 'the nudge to expand is pointless once something has been expanded');
});

test('expanding a field with no choice list says so rather than returning nothing', () => {
  const compact = toCompactSchema(fixture(), { expand: ['assignment_group'] });
  assert.match(compact.choices.assignment_group, /no choice list/);
});

/* ------------------------------------------------------------------ *
 * The acceptance-critical case
 * ------------------------------------------------------------------ */

test('expanding a field that does not exist reports its absence', () => {
  /*
   * This is the shape the SLA stress spec turns on. Asked to build a flow
   * against u_sla_start / u_sla_deadline / u_sla_active / u_sla_status /
   * u_sla_breached — none of which exist on this instance's incident table —
   * the correct output is a question, not a flow. Returning an empty result
   * would read as "that field has no choices", which is a different claim and
   * a false one.
   */
  const missing = ['u_sla_start', 'u_sla_deadline', 'u_sla_active', 'u_sla_status', 'u_sla_breached'];
  const compact = toCompactSchema(fixture(), { expand: missing });
  assert.deepEqual(compact.expandNotFound, missing);
  assert.match(compact.expandNote, /do not exist on incident/);
  // And it says the list is complete, so "not found" means absent rather than
  // omitted for space — the distinction the truncated schema destroyed.
  assert.match(compact.expandNote, /complete/);
});

test('a mix of real and missing fields reports both halves', () => {
  const compact = toCompactSchema(fixture(), { expand: ['state', 'u_sla_status'] });
  assert.ok(compact.choices.state, 'the real field still expands');
  assert.deepEqual(compact.expandNotFound, ['u_sla_status']);
});

test('mandatory, read-only and reference targets survive the diet', () => {
  // What the agent writes with. Dropping these would trade a context problem
  // for a correctness one.
  const rows = toCompactSchema(fixture()).fields;
  assert.match(rows.find((f) => f.startsWith('short_description:')), /\*mandatory/);
  assert.match(rows.find((f) => f.startsWith('sys_created_on:')), /\bro\b/);
  assert.match(rows.find((f) => f.startsWith('assignment_group:')), /-> sys_user_group/);
});
