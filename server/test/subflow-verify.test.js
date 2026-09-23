import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSubflowVerifySpec, validateVerifySpec } from '../src/servicenow/fluent.js';

/**
 * A subflow spec is validated harder than a flow spec, and for a reason worth
 * stating: a flow's trigger condition has to be read out of source and
 * mirrored, which is a judgement a weak model can get subtly wrong twice in
 * the same direction. A subflow's inputs are a DECLARED contract, so "you
 * invented an input" and "you left out a mandatory one" are arithmetic.
 */

const CONTRACT = {
  name: 'Escalate To Duty Manager',
  inputs: [
    { name: 'task', type: 'reference', reference: 'task', mandatory: true },
    { name: 'message', type: 'string', mandatory: true },
    { name: 'quiet', type: 'boolean', mandatory: false },
  ],
  outputs: [
    { name: 'notified', type: 'boolean' },
    { name: 'managerEmail', type: 'string' },
  ],
};

const base = () => ({
  kind: 'subflow',
  subflow: 'Escalate To Duty Manager',
  setup: { table: 'incident', payload: { short_description: 'harness test', impact: '1', urgency: '1' } },
  inputs: { task: '{{setup.sys_id}}', message: 'P1 on vendor hold' },
  wait: { timeoutSec: 120 },
  assert: [{
    table: 'incident',
    locate: { bySetupRecord: true },
    field: 'work_notes',
    expect: { value: 'Escalated to the duty manager' },
    note: 'the escalation work note',
  }],
  expectOutputs: [{ name: 'notified', expect: { value: 'true' }, note: 'the manager was notified' }],
  cleanup: [{ table: 'incident', locate: { bySetupRecord: true } }],
});

const errorsFor = (mutate, opts = { contract: CONTRACT }) => {
  const spec = base();
  mutate(spec);
  return validateSubflowVerifySpec(spec, opts).errors.join('\n');
};

test('a well-formed subflow spec passes', () => {
  assert.deepEqual(validateSubflowVerifySpec(base(), { contract: CONTRACT }), { ok: true, errors: [] });
});

test('validateVerifySpec dispatches on kind rather than demanding a trigger', () => {
  const r = validateVerifySpec(base(), { contract: CONTRACT });
  assert.equal(r.ok, true, r.errors.join('; '));
  // Without the discriminator it is judged as a flow spec and fails on wait.flowName.
  const asFlow = { ...base() };
  delete asFlow.kind;
  assert.equal(validateVerifySpec(asFlow).ok, false);
});

test('an input the subflow does not declare is refused, and the real ones are listed', () => {
  const e = errorsFor((s) => { s.inputs.taskSysId = 'abc'; });
  assert.match(e, /inputs\."taskSysId" is not an input of "Escalate To Duty Manager"/);
  assert.match(e, /"task", "message", "quiet"/);
});

test('a missing mandatory input is refused; an optional one is not', () => {
  assert.match(errorsFor((s) => { delete s.inputs.message; }), /inputs\."message" is mandatory/);
  assert.equal(errorsFor((s) => { delete s.inputs.quiet; }), '');
});

test('{{setup.sys_id}} is allowed in an input value and nowhere else', () => {
  assert.equal(errorsFor(() => {}), '');
  assert.match(errorsFor((s) => { s.inputs.message = '{{setup.number}}'; }), /does not substitute/);
  assert.match(
    errorsFor((s) => { s.assert[0].expect = { value: 'note for {{setup.sys_id}}' }; }),
    /compared literally and FAILS a correct subflow/
  );
});

test('a token that has nothing to substitute is refused rather than resolved to empty', () => {
  const e = errorsFor((s) => { delete s.setup; s.cleanup = []; });
  assert.match(e, /uses \{\{setup\.sys_id\}\} but the spec has no setup record/);
});

test('an assertion on a field the setup payload writes proves nothing and is refused', () => {
  const e = errorsFor((s) => {
    s.assert[0].field = 'short_description';
    s.assert[0].expect = { value: 'harness test' };
  });
  assert.match(e, /already sets it to "harness test"/);
});

test('a non-literal expected value is refused — comparison has no wildcards', () => {
  assert.match(errorsFor((s) => { s.assert[0].expect = { value: 'Escalated*' }; }), /not a literal value/);
  assert.match(errorsFor((s) => { s.assert[0].expect = { value: 'not empty' }; }), /not a literal value/);
});

test('an expected output must be one the subflow declares', () => {
  const e = errorsFor((s) => { s.expectOutputs.push({ name: 'emailSent', expect: { value: 'true' } }); });
  assert.match(e, /"emailSent" is not an output of "Escalate To Duty Manager"/);
  assert.match(e, /"notified", "managerEmail"/);
});

test('an expected output is read as a raw value, so display is not enough', () => {
  assert.match(errorsFor((s) => { s.expectOutputs[0].expect = { display: 'true' }; }), /expect\.value is required/);
});

test('running a subflow and checking nothing is refused', () => {
  const e = errorsFor((s) => { s.assert = []; s.expectOutputs = []; });
  assert.match(e, /needs at least one assertion or one expected output/);
});

test('every promised effect needs its own check', () => {
  const spec = base();
  spec.expectOutputs = [];
  const r = validateSubflowVerifySpec(spec, {
    contract: CONTRACT,
    promisedEffects: ['adds an escalation work note', 'notifies the duty manager', 'sets a flag'],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /promises 3 observable effects but only 1 check/);
});

test('a setup record must be cleaned up', () => {
  assert.match(errorsFor((s) => { s.cleanup = [{ table: 'problem', locate: { byQuery: 'x=1' } }]; }), /cleanup must include the setup record/);
});

test('bySetupRecord without a setup record is refused rather than silently matching nothing', () => {
  const e = errorsFor((s) => { delete s.setup; s.inputs.task = 'literal_sys_id'; s.cleanup = []; });
  assert.match(e, /bySetupRecord needs a setup record/);
});

test('the subflow name is required — a spec that names nothing proves nothing', () => {
  assert.match(errorsFor((s) => { delete s.subflow; }), /subflow is required/);
});

test('without a contract the shape is still checked, and the contract rules simply do not fire', () => {
  const spec = base();
  spec.inputs.invented = 'x';
  assert.equal(validateSubflowVerifySpec(spec, {}).ok, true);
});

test('a promise this instance cannot show is excusable — but only once the excuse is confirmed', () => {
  const spec = base();
  spec.expectOutputs = [];
  spec.unverifiable = [{
    effect: 'notifies the duty manager',
    kind: 'source_empty',
    table: 'sys_user_group',
    field: 'manager',
    sys_id: '8a5055c9c61122780043563ef53438e3',
    note: 'the group on this instance has no manager, so no notification can be sent',
  }];
  const promisedEffects = ['adds an escalation work note', 'notifies the duty manager'];

  // Claiming the excuse is not enough: verifiedExcuses is what the instance confirmed.
  assert.equal(validateSubflowVerifySpec(spec, { contract: CONTRACT, promisedEffects }).ok, false);
  assert.equal(validateSubflowVerifySpec(spec, { contract: CONTRACT, promisedEffects, verifiedExcuses: 1 }).ok, true);
});

test('a malformed excuse is rejected on its own shape', () => {
  const spec = base();
  spec.unverifiable = [{ effect: 'something', kind: 'source_empty', table: 'sys_user_group', field: 'manager' }];
  const r = validateSubflowVerifySpec(spec, { contract: CONTRACT });
  assert.equal(r.ok, false);
});
