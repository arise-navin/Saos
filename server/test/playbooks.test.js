/**
 * WI-7 — data-vs-config surfacing, and the business-rule playbook.
 *
 * Two things the transcript got wrong. The pipeline knew "incident does not
 * extend sys_metadata" and the prose never said it, so the user believed an
 * incident had been created inside an update set. And a business-rule abort was
 * answered by silently dropping the blocked fields from every later write —
 * while reporting a rule sys_id (bfdd88168376c750b939cc65eeaad39f) that exists
 * on no table on that instance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBusinessRuleAbort, dataVsConfigNote } from '../src/agent/playbooks.js';

const ABORT = "Operation against file 'incident' was aborted by Business Rule 'Abort changes on group^6a2e9d14'. Business Rule Stack:Abort changes on group";

test('the rule name is parsed out of the abort, stopping at the caret', () => {
  assert.equal(parseBusinessRuleAbort(ABORT), 'Abort changes on group');
});

test('a detail that is not an abort yields nothing rather than a guess', () => {
  assert.equal(parseBusinessRuleAbort('Failed API level ACL Validation'), null);
  assert.equal(parseBusinessRuleAbort(''), null);
  assert.equal(parseBusinessRuleAbort(null), null);
});

test('a data table gets the sentence the agent has to say out loud', () => {
  const n = dataVsConfigNote({ reason: 'data', table: 'incident', captured: false }, 'incident');
  assert.equal(n.captured, false);
  assert.match(n.explain, /incident is DATA, not configuration/);
  assert.match(n.explain, /only descendants of sys_metadata/);
  assert.match(n.sayToUser, /cannot be/);
});

test('a configuration table gets no note — there is nothing to correct', () => {
  assert.equal(dataVsConfigNote({ reason: null, captured: true }, 'sc_cat_item'), null);
  assert.equal(dataVsConfigNote(null, 'incident'), null);
});

test('the note names the table it was given rather than a generic one', () => {
  assert.match(dataVsConfigNote({ reason: 'data', table: 'sc_req_item' }, null).explain, /^sc_req_item is DATA/);
  assert.match(dataVsConfigNote({ reason: 'data' }, 'problem').explain, /^problem is DATA/);
});
