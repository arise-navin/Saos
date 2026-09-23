/**
 * Regression proof for the CLASS C duplicate-identity failure
 * (docs/fluent-research.md §12). Entirely offline — no instance, no SDK, no LLM.
 *
 *   node --test server/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  collectElementIds,
  validateCandidateIds,
  sanitizeIds,
  restoreIds,
  sanitizeExampleIds,
  specFingerprint,
  slugify,
  snapshotSources,
  restoreSources,
  diffAgainstSnapshot,
} from '../src/servicenow/fluent.js';

/* ------------------------------------------------------------------ *
 * Fixtures — shaped like the real sources that collided.
 * ------------------------------------------------------------------ */

const DEPLOYED_ESCALATE = `// nowforge-spec: 760d0f37ea51f7e5
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    { $id: Now.ID['escalate_network_p1_incident_flow'], name: 'Escalate Network P1 Incident', runAs: 'system' },
    wfa.trigger(trigger.record.created, { $id: Now.ID['escalate_network_p1_trigger'] }, { table: 'incident' }),
    (params) => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['add_work_note'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
        })
    }
)
`;

const DEPLOYED_DEMO = `// nowforge-spec: a761451fbca44f21
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    { $id: Now.ID['demo_incident_flow_main'], name: 'Demo Incident Flow', runAs: 'system' },
    wfa.trigger(trigger.record.created, { $id: Now.ID['demo_incident_created_trigger'] }, { table: 'incident' }),
    (params) => {
        wfa.flowLogic.if({ $id: Now.ID['if_priority_critical'], condition: 'x=1' }, () => {})
    }
)
`;

const PROJECT = [
  { file: 'escalate-network-p1-incident.now.ts', source: DEPLOYED_ESCALATE },
  { file: 'demo-incident-flow.now.ts', source: DEPLOYED_DEMO },
];

/** A candidate that reuses both keys — the exact shape of the live failure. */
const CANDIDATE_CLASS_C = `// nowforge-spec: deadbeefdeadbeef
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    { $id: Now.ID['vendor_hold_flow'], name: 'Vendor Hold Problem', runAs: 'system' },
    wfa.trigger(trigger.record.updated, { $id: Now.ID['vh_trigger'] }, { table: 'incident' }),
    (params) => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['add_work_note'] }, { table_name: 'incident' })
        wfa.flowLogic.if({ $id: Now.ID['if_priority_critical'], condition: 'y=1' }, () => {})
    }
)
`;

/* ------------------------------------------------------------------ *
 * Guard 1 — pre-build static validation
 * ------------------------------------------------------------------ */

test('collectElementIds finds every Now.ID key with its line number', () => {
  const ids = collectElementIds(DEPLOYED_ESCALATE);
  assert.deepEqual(
    ids.map((i) => i.key),
    ['escalate_network_p1_incident_flow', 'escalate_network_p1_trigger', 'add_work_note']
  );
  assert.equal(ids[2].line, 8);
});

test('a candidate with a duplicate $id INSIDE it is rejected, naming both lines', () => {
  const dup = `import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
Flow(
    { $id: Now.ID['vhp_flow'], name: 'Vendor Hold Problem', runAs: 'system' },
    wfa.trigger(trigger.record.updated, { $id: Now.ID['vhp_trigger'] }, { table: 'incident' }),
    () => {
        wfa.action(action.core.createRecord, { $id: Now.ID['vhp_note'] }, { table_name: 'problem' })
        wfa.action(action.core.updateRecord, { $id: Now.ID['vhp_note'] }, { table_name: 'incident' })
    }
)
`;
  const res = validateCandidateIds(dup, [], { file: 'candidate-deadbeefdeadbeef.now.ts' });

  assert.equal(res.ok, false, 'the duplicate must be rejected');
  assert.equal(res.errors.length, 1);

  const e = res.errors[0];
  assert.match(e, /Now\.ID\['vhp_note'\]/, 'names the duplicated key');
  assert.match(e, /is defined 2 times/, 'uses the wording the SDK itself would use');
  assert.match(e, /line 6 and line 7/, 'names BOTH definition sites');

  // The diagnostic is shaped like compiler output so the retry prompt feeds it
  // back to the model unchanged.
  assert.match(res.diagnostic, /^ERROR: identity validation failed before build\./);
  assert.match(res.diagnostic, /ERROR: Duplicate \$id/);
});

test('CLASS C: a candidate reusing keys owned by OTHER sources is rejected with both sites', () => {
  const res = validateCandidateIds(CANDIDATE_CLASS_C, PROJECT, {
    file: 'candidate-deadbeefdeadbeef.now.ts',
  });

  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2, 'one error per colliding key');

  const workNote = res.errors.find((e) => e.includes("'add_work_note'"));
  assert.ok(workNote, 'reports the add_work_note collision');
  assert.match(workNote, /candidate-deadbeefdeadbeef\.now\.ts:8/, 'names the candidate site');
  assert.match(workNote, /escalate-network-p1-incident\.now\.ts:8/, 'names the owning source');
  assert.match(workNote, /PROJECT-WIDE namespace/);
  assert.match(workNote, /vhp_add_work_note/, 'suggests a flow-prefixed replacement key');

  const ifCritical = res.errors.find((e) => e.includes("'if_priority_critical'"));
  assert.ok(ifCritical, 'reports the if_priority_critical collision');
  assert.match(ifCritical, /demo-incident-flow\.now\.ts:8/, 'names the owning source');
});

test('a candidate with freshly minted, flow-prefixed keys passes', () => {
  const clean = CANDIDATE_CLASS_C
    .replace("'add_work_note'", "'vhp_add_work_note'")
    .replace("'if_priority_critical'", "'vhp_if_priority_critical'");
  const res = validateCandidateIds(clean, PROJECT, { file: 'candidate-deadbeefdeadbeef.now.ts' });
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.equal(res.diagnostic, null);
});

test('a source is never judged a collision with itself', () => {
  // Regeneration writes over the artifact's own file; its own keys must not
  // read as duplicates or every update would be rejected.
  const res = validateCandidateIds(DEPLOYED_ESCALATE, PROJECT, {
    file: 'escalate-network-p1-incident.now.ts',
  });
  assert.equal(res.ok, true, res.errors.join('\n'));
});

test('a literal sys_id used as an $id is rejected', () => {
  const bad = `Flow({ $id: '10c0ec9dcf0c486ab1e40f73c0edbe8d', name: 'Bad' })`;
  const res = validateCandidateIds(bad, [], { file: 'c.now.ts' });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /Literal sys_id used as an \$id/);
});

test('an unresolved __ID_n__ placeholder is rejected', () => {
  const bad = `Flow({ $id: Now.ID['__ID_1__'], name: 'Leaked placeholder' })`;
  const res = validateCandidateIds(bad, [], { file: 'c.now.ts' });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /Unresolved placeholder \$id/);
});

/* ------------------------------------------------------------------ *
 * Guard 2 — retry hygiene: one filename per request
 * ------------------------------------------------------------------ */

test('a retry that renames the flow still writes the SAME candidate filename', () => {
  // The Phase 3 defect: the filename was slugified from the model's chosen
  // artifact name, so a renamed flow on attempt 2 wrote a SECOND file. The
  // candidate name now comes from the spec fingerprint alone.
  const spec =
    'When an incident is updated to state On Hold with hold reason Awaiting Vendor, create a problem record.';

  const attempt1Name = 'Vendor Hold Problem Creation';
  const attempt2Name = 'Create Problem On Vendor Hold'; // model renamed it mid-retry
  const attempt3Name = 'Vendor Hold → Problem';

  const fingerprint = specFingerprint(spec);
  const candidateFor = (fp) => `candidate-${fp}.now.ts`;

  // What the pipeline actually writes on each attempt.
  const written = [attempt1Name, attempt2Name, attempt3Name].map(() => candidateFor(fingerprint));

  assert.equal(new Set(written).size, 1, 'all three attempts target one filename');
  assert.equal(written[0], `candidate-${fingerprint}.now.ts`);
  assert.match(written[0], /^candidate-[0-9a-f]{16}\.now\.ts$/);

  // And prove the old behaviour would NOT have: name-derived paths diverge.
  const nameDerived = [attempt1Name, attempt2Name, attempt3Name].map((n) => `${slugify(n)}.now.ts`);
  assert.equal(new Set(nameDerived).size, 3, 'name-derived filenames diverge — the original bug');
});

test('the fingerprint is stable for one spec and different for another', () => {
  const spec = 'When an incident is updated to state On Hold with hold reason Awaiting Vendor.';
  assert.equal(specFingerprint(spec), specFingerprint(`  ${spec.toUpperCase()}  `),
    'whitespace and case are normalised, so the same request re-finds its own file');
  assert.notEqual(specFingerprint(spec), specFingerprint(`${spec} Also page the on-call.`));
});

test('a failed run restores src/ to its pre-request state, and the diff proves it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nowhelpassist-hygiene-'));
  try {
    await fsp.writeFile(path.join(dir, 'deployed.now.ts'), DEPLOYED_ESCALATE, 'utf8');
    await fsp.writeFile(path.join(dir, 'deployed.verify.json'), '{"assert":[]}', 'utf8');
    const before = await snapshotSources(dir);

    // What a failing run does to src/: it writes a candidate, and on a
    // REGENERATION it overwrites the deployed artifact's own source in place.
    await fsp.writeFile(path.join(dir, 'candidate-deadbeefdeadbeef.now.ts'), CANDIDATE_CLASS_C, 'utf8');
    await fsp.writeFile(path.join(dir, 'deployed.now.ts'), '// clobbered by a failed attempt', 'utf8');

    const dirty = await diffAgainstSnapshot(before, dir);
    assert.deepEqual(
      dirty.sort(),
      ['left behind: candidate-deadbeefdeadbeef.now.ts', 'modified: deployed.now.ts'],
      'the assertion detects both kinds of drift'
    );

    await restoreSources(before, dir);

    assert.deepEqual(await diffAgainstSnapshot(before, dir), [],
      'src/ is byte-identical to its pre-request state');
    assert.equal(fs.existsSync(path.join(dir, 'candidate-deadbeefdeadbeef.now.ts')), false,
      'the candidate is gone');
    assert.equal(await fsp.readFile(path.join(dir, 'deployed.now.ts'), 'utf8'), DEPLOYED_ESCALATE,
      'the deployed source is RESTORED, not deleted — a failed regeneration must not drop a live flow');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Guard 3 — context sanitation
 * ------------------------------------------------------------------ */

test('sanitizeIds hides every live key behind a placeholder', () => {
  const { text, map } = sanitizeIds(DEPLOYED_ESCALATE);
  assert.ok(!text.includes('add_work_note'), 'no live key survives into the prompt');
  assert.ok(!text.includes('escalate_network_p1_trigger'));
  assert.match(text, /Now\.ID\['__ID_1__'\]/);
  assert.equal(map.size, 3);
  assert.equal(map.get('__ID_3__'), 'add_work_note');
  assert.ok(text.includes("name: 'Escalate Network P1 Incident'"),
    'names are NOT touched — the verbatim-name survival mechanism stays');
});

test('restoreIds puts identity back exactly, so regeneration stays idempotent', () => {
  const { text, map } = sanitizeIds(DEPLOYED_ESCALATE);
  assert.equal(restoreIds(text, map), DEPLOYED_ESCALATE, 'a full round trip is lossless');

  // The realistic case: the model keeps the placeholders and adds one new
  // element of its own.
  const edited = text.replace(
    "(params) => {",
    "(params) => {\n        wfa.action(action.core.log, { $id: Now.ID['enp_new_log'] }, { log_level: 'info' })"
  );
  const restored = restoreIds(edited, map);
  assert.ok(restored.includes("Now.ID['add_work_note']"), 'existing records keep their identity');
  assert.ok(restored.includes("Now.ID['enp_new_log']"), 'a freshly minted key is left alone');
  assert.ok(!restored.includes('__ID_'), 'no placeholder leaks into the written source');
});

test('one shared map keeps a record on the same placeholder across both fed-back sources', () => {
  const map = new Map();
  const a = sanitizeIds(DEPLOYED_ESCALATE, map).text;
  const b = sanitizeIds(DEPLOYED_ESCALATE.replace('Escalate Network P1 Incident', 'Renamed'), map).text;
  assert.equal(map.size, 3, 'the second pass reuses the first pass placeholders');
  assert.equal(
    a.match(/__ID_\d+__/g).join(),
    b.match(/__ID_\d+__/g).join(),
    'the deployed source and the retry source agree on every identity'
  );
});

test('cheatsheet example keys are neutralised before the model sees them', () => {
  const cheat = "wfa.action(action.core.log, { $id: Now.ID['log'] }, {})\n{ $id: Now.ID['nm_send_email'] }";
  const out = sanitizeExampleIds(cheat);
  assert.ok(out.includes("Now.ID['ex_log']"));
  assert.ok(out.includes("Now.ID['ex_nm_send_email']"));
  assert.equal(sanitizeExampleIds(out), out, 'already-prefixed keys are left alone');
});

/* ------------------------------------------------------------------ *
 * Verification runner — create-then-update setups
 *
 * A record-UPDATED trigger cannot be reached by an insert, so the runner
 * needs a second setup step. These prove the spec-level contract; the live
 * run is what proves the runner end to end.
 * ------------------------------------------------------------------ */

const UPDATE_TRIGGERED_SPEC = {
  setup: {
    table: 'incident',
    payload: { short_description: 'Vendor hold test', impact: '1', urgency: '1' },
    update: { state: '3', hold_reason: '4' },
  },
  wait: { flowName: 'Vendor Hold Problem', timeoutSec: 120 },
  assert: [
    { table: 'problem', locate: { byQuery: 'parent={{setup.sys_id}}' }, field: 'short_description',
      expect: { value: 'Vendor issue: Vendor hold test' }, note: 'problem created with the prefix' },
    { table: 'incident', locate: { bySetupRecord: true }, field: 'work_notes',
      expect: { value: 'PRB' }, note: 'work note carries the problem number' },
  ],
  cleanup: [{ table: 'incident', locate: { bySetupRecord: true } }],
};

test('a create-then-update setup is accepted', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  const res = validateVerifySpec(UPDATE_TRIGGERED_SPEC);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

test('setup.update must be a non-empty object when present', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  for (const bad of [{}, [], 'state=3', null]) {
    const res = validateVerifySpec({ ...UPDATE_TRIGGERED_SPEC, setup: { ...UPDATE_TRIGGERED_SPEC.setup, update: bad } });
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.ok(res.errors.some((e) => e.includes('setup.update')), res.errors.join('\n'));
  }
});

test('the anti-trivial rule covers fields written by setup.update, not just payload', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  // Asserting `state` is trivially true: setup.update itself set it to 3.
  const smuggled = {
    ...UPDATE_TRIGGERED_SPEC,
    assert: [
      ...UPDATE_TRIGGERED_SPEC.assert,
      { table: 'incident', locate: { bySetupRecord: true }, field: 'state',
        expect: { value: '3' }, note: 'incident is on hold' },
    ],
  };
  const res = validateVerifySpec(smuggled);
  assert.equal(res.ok, false);
  const e = res.errors.find((x) => x.includes('"state"'));
  assert.ok(e, res.errors.join('\n'));
  assert.match(e, /setup\.update already sets "state"/, 'names the step that smuggled it in');
  assert.match(e, /true regardless of what the flow does/);
});

test('omitting setup.update stays valid — created triggers are unaffected', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  const { update, ...payloadOnly } = UPDATE_TRIGGERED_SPEC.setup;
  const res = validateVerifySpec({ ...UPDATE_TRIGGERED_SPEC, setup: payloadOnly });
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

/* ------------------------------------------------------------------ *
 * Verification specs must not raise FALSE alarms
 *
 * Both of these fired on the live run: a correct flow was reported as failing
 * because the spec asserted something the runner could never satisfy.
 * ------------------------------------------------------------------ */

test('an unsubstituted {{token}} in an expected value is rejected', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  const spec = {
    ...UPDATE_TRIGGERED_SPEC,
    assert: [
      { table: 'incident', locate: { bySetupRecord: true }, field: 'work_notes',
        expect: { value: 'Problem {{lookup.problem_number}} created' }, note: 'work note' },
      { table: 'incident', locate: { bySetupRecord: true }, field: 'problem',
        expect: { display: '{{lookup.problem_number}}' }, note: 'link' },
    ],
  };
  const res = validateVerifySpec(spec);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2, 'both halves of expect are checked');

  const e = res.errors[0];
  assert.match(e, /\{\{lookup\.problem_number\}\}/, 'quotes the offending token back');
  assert.match(e, /compared literally and FAIL a correct flow/);
  assert.match(e, /only supported token is \{\{setup\.sys_id\}\}/);
  assert.match(e, /put the proof in the LOCATOR instead/, 'teaches the repair');
});

test('{{setup.sys_id}} is still allowed in a locator', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  const res = validateVerifySpec({
    ...UPDATE_TRIGGERED_SPEC,
    assert: [
      { table: 'problem', locate: { byQuery: 'parent={{setup.sys_id}}' }, field: 'short_description',
        expect: { value: 'Vendor issue: Test incident' }, note: 'created problem' },
    ],
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

test('a proper noun that keeps its trailing common noun still resolves', async () => {
  const { stripTrailingCommonNoun } = await import('../src/servicenow/fluent.js');
  // The intent extractor kept "group" on one run and dropped it on the next,
  // for the SAME spec. The second spelling matched nothing, and the flow's
  // lookUpRecord then ERRORed on every execution.
  assert.equal(stripTrailingCommonNoun('Hardware group'), 'Hardware');
  assert.equal(stripTrailingCommonNoun('Service Desk Team'), 'Service Desk');
  assert.equal(stripTrailingCommonNoun('  Network  '), 'Network');
  // A name whose last word is genuinely part of it is left alone by the retry:
  // the literal lookup is always tried first, so this only ever adds a chance.
  assert.equal(stripTrailingCommonNoun('Hardware'), 'Hardware');
  assert.equal(stripTrailingCommonNoun(''), '');
});

test('a wildcard or prose expected value is rejected as a false-alarm source', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  const cases = [
    ['Problem PRB* created', /Drop the generated part/],
    ['not empty', /put that in the locator instead/],
    ['<the problem number>', /put that in the locator instead/],
  ];
  for (const [bad, hint] of cases) {
    const res = validateVerifySpec({
      ...UPDATE_TRIGGERED_SPEC,
      assert: [{ table: 'incident', locate: { bySetupRecord: true }, field: 'work_notes',
        expect: { value: bad }, note: 'n' }],
    });
    assert.equal(res.ok, false, `"${bad}" must be rejected`);
    assert.match(res.errors[0], /is not a literal value/);
    assert.match(res.errors[0], hint);
  }
});

test('ordinary literal values — including the empty string — still pass', async () => {
  const { validateVerifySpec } = await import('../src/servicenow/fluent.js');
  const res = validateVerifySpec({
    ...UPDATE_TRIGGERED_SPEC,
    assert: [
      { table: 'incident', locate: { bySetupRecord: true }, field: 'work_notes',
        expect: { value: ' created' }, note: 'fixed fragment of the work note' },
      { table: 'problem', locate: { byQuery: 'parent={{setup.sys_id}}' }, field: 'assigned_to',
        expect: { value: '' }, note: 'empty because the group has no manager' },
    ],
  });
  assert.deepEqual(res.errors, []);
});

/* ------------------------------------------------------------------ *
 * The false-GREEN guard
 *
 * Measured on the live instance: an encoded-query condition naming a field
 * that does not exist is silently DROPPED, not rejected. Both
 * "problemISNOTEMPTY" and "problemISEMPTY" matched the same incident, as did
 * "zzz_totally_madeupISNOTEMPTY", while the real "work_notesISNOTEMPTY"
 * correctly did not. A locator built on an absent field therefore matches
 * whatever the flow did, and its assertion passes vacuously.
 * ------------------------------------------------------------------ */

test('queryFieldRoots extracts the fields an encoded query constrains on', async () => {
  const { queryFieldRoots } = await import('../src/servicenow/fluent.js');
  assert.deepEqual(queryFieldRoots('sys_id={{setup.sys_id}}^problemISNOTEMPTY'), ['sys_id', 'problem']);
  assert.deepEqual(queryFieldRoots('short_description=Vendor issue: X^assigned_toISEMPTY'),
    ['short_description', 'assigned_to']);
  assert.deepEqual(queryFieldRoots('parent={{setup.sys_id}}'), ['parent']);
  // dot-walks are checked at their root, and ORDERBY is not a constraint
  assert.deepEqual(queryFieldRoots('assignment_group.name=Hardware^ORDERBYnumber'), ['assignment_group']);
  assert.deepEqual(queryFieldRoots('state!=6^ORpriority=1'), ['state', 'priority']);
  assert.deepEqual(queryFieldRoots(''), []);
  assert.deepEqual(queryFieldRoots(undefined), []);
});

/* ------------------------------------------------------------------ *
 * The field-existence checker, offline
 *
 * A guard that BLOCKS work has to be as falsifiable as the assertions it
 * blocks: it must pass a field that exists just as reliably as it fails one
 * that does not. The schema resolver is injected so this runs with no network.
 * The field lists mirror what the live instance actually returns.
 * ------------------------------------------------------------------ */

const FAKE_SCHEMA = {
  // Measured on dev442675: 91 fields, no problem_id, no rfc, no caused_by.
  incident: ['sys_id', 'number', 'short_description', 'work_notes', 'state', 'incident_state',
             'hold_reason', 'impact', 'urgency', 'priority', 'assignment_group', 'assigned_to',
             'parent', 'parent_incident', 'universal_request'],
  problem: ['sys_id', 'number', 'short_description', 'assignment_group', 'assigned_to',
            'first_reported_by_task', 'parent'],
};
const schemaFor = async (t) => {
  if (!FAKE_SCHEMA[t]) throw new Error(`no schema for ${t}`);
  return { fields: FAKE_SCHEMA[t].map((name) => ({ name })) };
};
const specWith = (assertions) => ({
  setup: { table: 'incident', payload: { short_description: 'x' } },
  wait: { flowName: 'x' },
  assert: assertions,
  cleanup: [{ table: 'incident', locate: { bySetupRecord: true } }],
});

test('a field that EXISTS passes the checker', async () => {
  const { checkVerifySpecFields } = await import('../src/servicenow/fluent.js');
  const r = await checkVerifySpecFields(specWith([
    { table: 'incident', locate: { byQuery: 'sys_id=abc^work_notesISNOTEMPTY' }, field: 'short_description',
      expect: { value: 'x' }, note: 'real field in both places' },
    { table: 'incident', locate: { byQuery: 'sys_id=abc^parentISNOTEMPTY' }, field: 'parent',
      expect: { display: 'PRB0001' }, note: 'the real link mechanism on this instance' },
    { table: 'problem', locate: { byQuery: 'first_reported_by_task=abc' }, field: 'assignment_group',
      expect: { display: 'Hardware' }, note: 'problem side of the link' },
  ]), { schemaFor });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('a field that is ABSENT fails the checker, in the assertion and in the locator', async () => {
  const { checkVerifySpecFields } = await import('../src/servicenow/fluent.js');
  const r = await checkVerifySpecFields(specWith([
    { table: 'incident', locate: { bySetupRecord: true }, field: 'problem_id',
      expect: { value: 'x' }, note: 'asserted field does not exist' },
    { table: 'incident', locate: { byQuery: 'sys_id=abc^problemISNOTEMPTY' }, field: 'short_description',
      expect: { value: 'x' }, note: 'locator field does not exist' },
  ]), { schemaFor });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /"problem_id" does not exist on incident/);
  assert.match(r.errors[1], /constrains on "problem", which does not exist on incident/);
  assert.match(r.errors[1], /passes vacuously/);
});

test('an unreadable schema never fails a spec — the guard does not block on our own outage', async () => {
  const { checkVerifySpecFields } = await import('../src/servicenow/fluent.js');
  const r = await checkVerifySpecFields(specWith([
    { table: 'sc_req_item', locate: { byQuery: 'anythingISNOTEMPTY' }, field: 'whatever',
      expect: { value: 'x' }, note: 'schemaFor throws for this table' },
  ]), { schemaFor });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});
