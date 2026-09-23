/**
 * Colliding Now.ID keys are IMPOSED, not asked for.
 *
 *   node --test server/test/
 *
 * From a real failure. The user had a deployed flow "Add Demo Comment on
 * Incident Creation" and asked to add if/then branching to it. The agent could
 * only create, never edit, so it built a *new* flow — which reused the same
 * `adc_flow` and `adc_trigger` keys the deployed one already owned.
 *
 * `Now.ID` keys are a project-wide namespace (trap #1), so that collides
 * instead of creating. The diagnostic was good: it named the key, both
 * definition sites, and the fix. The model ignored it three times in a row,
 * with byte-identical results, and the build died having done nothing.
 *
 * Which is A2's lesson again — identity the platform matches on is too
 * important to leave to a model that is right most of the time. So the rename
 * happens in code, and only what a rewrite cannot fix reaches the validator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { namespaceCollidingIds, validateCandidateIds, collectElementIds } from '../src/servicenow/fluent.js';

/** The deployed source, reduced to what matters. */
const DEPLOYED = {
  file: 'add-demo-comment-on-incident-creation.now.ts',
  source: `
Flow({ $id: Now.ID['adc_flow'], name: 'Add Demo Comment on Incident Creation' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['adc_trigger'] }, { table: 'incident' }),
  () => { wfa.action(action.core.updateRecord, { $id: Now.ID['adc_update_initial'] }, {}) })
`,
};

/** What the model produced on all three attempts. */
const CANDIDATE = `
Flow({ $id: Now.ID['adc_flow'], name: 'Add Demo Comment' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['adc_trigger'] }, { table: 'incident' }),
  () => {
    wfa.action(action.core.updateRecord, { $id: Now.ID['adc_update_initial'] }, {})
    wfa.flowLogic.if({ $id: Now.ID['adc_if_critical'] }, () => {})
    wfa.flowLogic.endFlow({ $id: Now.ID['adc_end'] })
  })
`;

const keysOf = (src) => new Set(collectElementIds(src).map((k) => k.key));

test('the exact collision from the transcript is rewritten, not reported', () => {
  const before = validateCandidateIds(CANDIDATE, [DEPLOYED], { file: 'candidate.now.ts' });
  assert.ok(!before.ok, 'fixture is wrong — this candidate is supposed to collide');
  assert.equal(before.errors.filter((e) => /Duplicate \$id across the project/.test(e)).length, 3);

  const { source, renames } = namespaceCollidingIds(CANDIDATE, [DEPLOYED], { file: 'candidate.now.ts' });
  const after = validateCandidateIds(source, [DEPLOYED], { file: 'candidate.now.ts' });
  assert.ok(after.ok, `still colliding after the rewrite: ${after.errors.join(' | ')}`);
  assert.equal(renames.length, 3);
});

test('only the colliding keys move — the model keeps the names it got right', () => {
  const { source, renames } = namespaceCollidingIds(CANDIDATE, [DEPLOYED], { file: 'candidate.now.ts' });
  const moved = new Set(renames.map((r) => r.from));

  // These three are owned by the deployed source.
  for (const k of ['adc_flow', 'adc_trigger', 'adc_update_initial']) assert.ok(moved.has(k), `${k} should have moved`);
  // These two are this candidate's own, and are perfectly good keys.
  for (const k of ['adc_if_critical', 'adc_end']) {
    assert.ok(!moved.has(k), `${k} is unique and must be left alone`);
    assert.ok(keysOf(source).has(k));
  }
});

test('every occurrence of a renamed key is rewritten, not just the declaration', () => {
  // A half-rewritten key is worse than none: the flow would build and wire an
  // action to the wrong element.
  const { source } = namespaceCollidingIds(CANDIDATE, [DEPLOYED], { file: 'candidate.now.ts' });
  assert.ok(!source.includes("Now.ID['adc_flow']"), 'the old key survives somewhere in the source');
  assert.ok(!source.includes("Now.ID['adc_trigger']"));
});

test('a candidate that collides with nothing is returned untouched', () => {
  const { source, renames } = namespaceCollidingIds(CANDIDATE, [], { file: 'candidate.now.ts' });
  assert.equal(renames.length, 0);
  assert.equal(source, CANDIDATE);
});

test('editing a flow in place does not collide with itself', () => {
  // The real fix for the transcript: when the request names an existing flow,
  // that file is the target and is excluded from `others`, so its own keys are
  // not "taken" by anyone.
  const { renames } = namespaceCollidingIds(CANDIDATE, [DEPLOYED], { file: DEPLOYED.file });
  assert.equal(renames.length, 0, 'a flow must not be namespaced away from its own deployed identity');
});

test('the rewrite terminates even when the prefixed key is also taken', () => {
  const alsoTaken = {
    file: 'other.now.ts',
    // Both `adc_flow` and the obvious prefixed form are already owned.
    source: "Now.ID['adc_flow'] Now.ID['adc_adc_flow'] Now.ID['adc_adc_flow_2']",
  };
  const { source, renames } = namespaceCollidingIds(
    "Flow({ $id: Now.ID['adc_flow'], name: 'Add Demo Comment' })", [alsoTaken], { file: 'candidate.now.ts' }
  );
  assert.equal(renames.length, 1);
  const to = renames[0].to;
  assert.ok(!['adc_flow', 'adc_adc_flow', 'adc_adc_flow_2'].includes(to), `landed on a taken key: ${to}`);
  assert.ok(source.includes(`Now.ID['${to}']`));
});

test('a duplicate INSIDE one candidate is still rejected — a rewrite cannot fix it', () => {
  // Two elements sharing a key in the same file is a modelling mistake, not a
  // namespace clash. Renaming both would silently merge two flow elements.
  const selfDupe = "Now.ID['x_a'] ... Now.ID['x_a']";
  const { renames } = namespaceCollidingIds(selfDupe, [], { file: 'candidate.now.ts' });
  assert.equal(renames.length, 0);
  const check = validateCandidateIds(selfDupe, [], { file: 'candidate.now.ts' });
  assert.ok(!check.ok);
  assert.match(check.errors.join(' '), /defined 2 times in candidate\.now\.ts/);
});
