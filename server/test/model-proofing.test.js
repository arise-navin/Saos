/**
 * Regression proof for the model-proofing floor, guards A1–A5.
 * Entirely offline — no instance, no SDK, no LLM.
 *
 *   node --test server/test/
 *
 * Every case below is a defect that was MEASURED against
 * `gpt-oss:120b-cloud` (docs/fluent-research.md §14, §19), not a hypothetical.
 * The point of the floor is that a weak model can still be wrong in all these
 * ways — it just cannot ship the result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { seedFrom, codegenDecoding, CODEGEN_TEMPERATURE, DECODING_SENT, SEED_HONOURED, decodingReality } from '../src/agent/decoding.js';
import { chat as openAiChat } from '../src/agent/providers/openaiCompat.js';
import { chat as anthropicChat } from '../src/agent/providers/anthropic.js';
import {
  findArtifactNames,
  pinArtifactNames,
  groundLiterals,
  checkPromisedLiterals,
  lintTriggerStrategy,
  describesTransition,
  RetryLedger,
  promptHash,
} from '../src/servicenow/codegen-guards.js';
import {
  buildRejectionEvidence,
  validateVerifySpec,
  validateUnverifiableShape,
  checkUnverifiableClaims,
} from '../src/servicenow/fluent.js';

/* ------------------------------------------------------------------ *
 * Fixtures — shaped like the sources this pipeline actually produced.
 * ------------------------------------------------------------------ */

const VENDOR_FLOW = `// nowforge-spec: 0a8c04f64afd4b31
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    { $id: Now.ID['vpo_flow'], name: 'Create Problem for On Hold Vendor Incidents', runAs: 'system' },
    wfa.trigger(
        trigger.record.updated,
        { $id: Now.ID['vpo_trigger_updated'] },
        { table: 'incident', condition: 'state=3^hold_reason=4', run_flow_in: 'background', trigger_strategy: 'unique_changes' }
    ),
    (params) => {
        const problem = wfa.action(action.core.createRecord, { $id: Now.ID['vpo_create_problem'] }, {
            table_name: 'problem',
            values: { short_description: \`Vendor issue: \${wfa.dataPill(params.trigger.current.short_description, 'string')}\` },
        })
        wfa.action(action.core.updateRecord, { $id: Now.ID['vpo_add_work_note'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: { work_notes: 'Linked Problem', name: 'not the artifact name' },
        })
    }
)
`;

const FLOW_AND_SUBFLOW = `
export const helper = Subflow(
    { $id: Now.ID['h_sub'], name: 'Vendor Hold Helper', inputs: {} },
    () => {}
)

Flow(
    { $id: Now.ID['h_flow'], name: 'Vendor Hold Main', runAs: 'system' },
    wfa.trigger(trigger.record.created, { $id: Now.ID['h_trig'] }, { table: 'incident' }),
    () => {}
)
`;

/* ================================================================== *
 * A1 — deterministic decoding
 * ================================================================== */

test('A1: the seed is a pure function of the spec fingerprint and attempt', () => {
  assert.equal(seedFrom('0a8c04f64afd4b31', 1), seedFrom('0a8c04f64afd4b31', 1));
  assert.equal(seedFrom('0a8c04f64afd4b31', 3), seedFrom('0a8c04f64afd4b31', 3));
  // A different spec must not collide with this one.
  assert.notEqual(seedFrom('0a8c04f64afd4b31', 1), seedFrom('760d0f37ea51f7e5', 1));
});

test('A1: a retry deliberately shifts the seed, so a re-ask is not entitled to the same sample', () => {
  const seeds = [1, 2, 3, 4].map((a) => seedFrom('0a8c04f64afd4b31', a));
  assert.equal(new Set(seeds).size, 4, 'every attempt of one request must ask for a different sample');
});

test('A1: every seed sits in the signed-32-bit range every provider accepts', () => {
  for (const attempt of [0, 1, 2, 3, 4, 99]) {
    const seed = seedFrom('deadbeefdeadbeef', attempt);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2147483647, `out of range: ${seed}`);
  }
});

test('A1: structured generation asks for the mode, not a sample', () => {
  assert.equal(CODEGEN_TEMPERATURE, 0);
  assert.equal(codegenDecoding('abc', 1).temperature, 0);
});

test('A1: the OpenAI-compatible adapter puts BOTH knobs on the wire', async () => {
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }) };
  };
  try {
    await openAiChat({
      provider: 'ollama',
      model: 'gpt-oss:120b-cloud',
      system: 's',
      history: [{ role: 'user', text: 'u' }],
      decoding: { temperature: 0, seed: 12345 },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.temperature, 0);
  assert.equal(sent.seed, 12345);
});

test('A1: the Anthropic adapter sends temperature and does NOT invent a seed parameter', async () => {
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }) };
  };
  try {
    await anthropicChat({
      apiKey: 'k',
      system: 's',
      history: [{ role: 'user', text: 'u' }],
      decoding: { temperature: 0, seed: 12345 },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.temperature, 0);
  assert.ok(!('seed' in sent), 'this API has no seed parameter; sending one would be a fabrication');
  assert.equal(DECODING_SENT.anthropic.seed, false, 'and the capability table must say so');
});

test('A1: the measured non-determinism of this backend is stated, not papered over', () => {
  // Measured 2026-08-18: identical seeded calls to gpt-oss:120b-cloud return
  // different completions on BOTH the /v1 and the native path.
  assert.equal(SEED_HONOURED.ollama, false);
  const said = decodingReality('ollama');
  assert.match(said, /NOT honoured/);
  assert.match(said, /non-reproducible/);
  // An unmeasured provider must say "unmeasured", never "works".
  assert.match(decodingReality('openai'), /has not been measured/);
});

/* ================================================================== *
 * A2 — pinned flow identity
 * ================================================================== */

test('A2: artifact names are found by brace matching, so an action parameter is not mistaken for one', () => {
  const found = findArtifactNames(VENDOR_FLOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'flow');
  assert.equal(found[0].name, 'Create Problem for On Hold Vendor Incidents');
  // The updateRecord action further down also has a `name:` key. A window-based
  // regex would have picked it up and pinned the wrong string.
  assert.ok(!found.some((f) => f.name === 'not the artifact name'));
});

test('A2: a renamed flow is rewritten back to the pinned name, and the rename is reported', () => {
  const renamed = VENDOR_FLOW.replace(
    "name: 'Create Problem for On Hold Vendor Incidents'",
    "name: 'Create Problem for On Hold Vendor Issues'"
  );
  const { source, rewrites } = pinArtifactNames(renamed, [
    { kind: 'flow', name: 'Create Problem for On Hold Vendor Incidents' },
  ]);
  assert.equal(rewrites.length, 1);
  assert.deepEqual(rewrites[0], {
    kind: 'flow',
    from: 'Create Problem for On Hold Vendor Issues',
    to: 'Create Problem for On Hold Vendor Incidents',
  });
  assert.ok(source.includes("name: 'Create Problem for On Hold Vendor Incidents'"));
  assert.ok(!source.includes('Vendor Issues'));
  // Nothing else in the file may move.
  assert.ok(source.includes("name: 'not the artifact name'"), 'the action parameter must be untouched');
  assert.ok(source.includes("Vendor issue: "), 'the promised literal must be untouched');
});

test('A2: a source that already carries the pinned name is returned unchanged', () => {
  const { source, rewrites } = pinArtifactNames(VENDOR_FLOW, [
    { kind: 'flow', name: 'Create Problem for On Hold Vendor Incidents' },
  ]);
  assert.equal(rewrites.length, 0);
  assert.equal(source, VENDOR_FLOW);
});

test('A2: flow and subflow pins match by kind, so a flow+subflow source cannot swap them', () => {
  const renamed = FLOW_AND_SUBFLOW
    .replace("name: 'Vendor Hold Helper'", "name: 'Renamed Helper'")
    .replace("name: 'Vendor Hold Main'", "name: 'Renamed Main'");
  // Pins are given flow-first while the SOURCE declares the subflow first.
  const { source, rewrites } = pinArtifactNames(renamed, [
    { kind: 'flow', name: 'Vendor Hold Main' },
    { kind: 'subflow', name: 'Vendor Hold Helper' },
  ]);
  assert.equal(rewrites.length, 2);
  assert.ok(source.includes("name: 'Vendor Hold Main'"));
  assert.ok(source.includes("name: 'Vendor Hold Helper'"));
  const kinds = findArtifactNames(source);
  assert.equal(kinds.find((k) => k.kind === 'subflow').name, 'Vendor Hold Helper');
  assert.equal(kinds.find((k) => k.kind === 'flow').name, 'Vendor Hold Main');
});

test('A2: with no pins, nothing is rewritten', () => {
  assert.equal(pinArtifactNames(VENDOR_FLOW, []).rewrites.length, 0);
  assert.equal(pinArtifactNames(VENDOR_FLOW, []).source, VENDOR_FLOW);
});

/* ================================================================== *
 * A3 — promised literals
 * ================================================================== */

const VENDOR_SPEC =
  'When an incident is put On Hold awaiting a vendor, create a Problem whose short description ' +
  'is prefixed with "Vendor issue: " and add a work note to the incident.';

test('A3: a literal the request actually spells out is enforced', () => {
  const grounded = groundLiterals(VENDOR_SPEC, ['Vendor issue: ']);
  assert.deepEqual(grounded, ['Vendor issue: ']);
  assert.ok(checkPromisedLiterals(VENDOR_FLOW, grounded).ok);
});

test('A3: the measured defect — a regeneration that drops the prefix is caught before build', () => {
  const dropped = VENDOR_FLOW.replace('Vendor issue: ', '');
  const check = checkPromisedLiterals(dropped, ['Vendor issue: ']);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, ['Vendor issue: ']);
  assert.match(check.diagnostic, /Vendor issue: /);
  assert.match(check.diagnostic, /character for character/);
});

test('A3: a literal the model invents cannot become a requirement', () => {
  // The intent extractor is the same weak model this guard polices. If its
  // claim is not in the spec, it is not enforceable — otherwise the guard
  // would block a correct flow, which is worse than not having the guard.
  const grounded = groundLiterals(VENDOR_SPEC, ['Vendor issue: ', 'Escalated by NowHelpAssist', 'URGENT']);
  assert.deepEqual(grounded, ['Vendor issue: ']);
});

test('A3: grounding cannot tell a choice LABEL from a literal — the known limit, pinned', () => {
  // The honest boundary of this guard, recorded so it is visible rather than
  // assumed away. A correct flow encodes "Awaiting Vendor" as hold_reason=4, so
  // the label never reaches the source. Grounding only proves the string is in
  // the REQUEST, which it is — so if the extractor mislabels it as text to
  // write, A3 rejects a flow that is behaving correctly.
  //
  // What actually prevents that is the extractor prompt ("a choice LABEL the
  // flow matches on is NOT a promised literal"), not this function. That makes
  // the model the guard's weak point, which is worth stating plainly: A3 can
  // only ever be as good as the list it is given, and it is deliberately built
  // so the model can NARROW the guard and never widen it.
  const spec = 'When hold reason is Awaiting Vendor, create a problem.';
  assert.deepEqual(groundLiterals(spec, ['Awaiting Vendor']), ['Awaiting Vendor']);
  const encodedCorrectly = "wfa.trigger(trigger.record.updated, {}, { condition: 'hold_reason=4' })";
  assert.equal(
    checkPromisedLiterals(encodedCorrectly, ['Awaiting Vendor']).ok,
    false,
    'a mislabelled literal WOULD reject a correct flow — the extractor prompt is the only thing preventing it'
  );
});

test('A3: literals shorter than three characters are ignored as coincidence', () => {
  assert.deepEqual(groundLiterals('set it to a', ['a', 'to']), []);
});

test('A3: with no promised literals the guard is silent', () => {
  const check = checkPromisedLiterals(VENDOR_FLOW, []);
  assert.equal(check.ok, true);
  assert.equal(check.diagnostic, null);
});

/* ================================================================== *
 * A4 — trigger_strategy lint
 * ================================================================== */

const CREATED_FLOW = `Flow({ $id: Now.ID['c_f'], name: 'X' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['c_t'] }, { table: 'incident' }), () => {})`;

const updatedFlow = (cfg) => `Flow({ $id: Now.ID['u_f'], name: 'X' },
  wfa.trigger(trigger.record.updated, { $id: Now.ID['u_t'] }, { table: 'incident', condition: 'state=3'${cfg} }), () => {})`;

test('A4: a created trigger is out of scope — the strategy does not apply to it', () => {
  const r = lintTriggerStrategy(CREATED_FLOW, 'when an incident is created, do something');
  assert.equal(r.ok, true);
  assert.equal(r.applicable, false);
});

test('A4: trap #10 — an updated trigger with no strategy at all is rejected', () => {
  const r = lintTriggerStrategy(updatedFlow(''), 'when an incident is updated, do something');
  assert.equal(r.ok, false);
  assert.equal(r.applicable, true);
  assert.equal(r.strategy, null);
  assert.match(r.diagnostic, /once EVER/);
});

test('A4: transition language plus the platform default `once` is rejected, and told why', () => {
  const r = lintTriggerStrategy(
    updatedFlow(", trigger_strategy: 'once'"),
    'when an incident is updated to On Hold awaiting a vendor, create a problem'
  );
  assert.equal(r.ok, false);
  assert.equal(r.strategy, 'once');
  assert.equal(r.transitionLanguage, true);
  assert.match(r.diagnostic, /unique_changes/);
  assert.match(r.diagnostic, /the second time it makes this transition, nothing happens/);
});

test('A4: transition language with unique_changes passes', () => {
  const r = lintTriggerStrategy(
    updatedFlow(", trigger_strategy: 'unique_changes'"),
    'when an incident is updated to On Hold awaiting a vendor, create a problem'
  );
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'unique_changes');
});

test("A4: 'every' is allowed when the request is NOT phrased as a transition", () => {
  const r = lintTriggerStrategy(
    updatedFlow(", trigger_strategy: 'every'"),
    'while an incident remains critical and unassigned, keep the watch list current'
  );
  assert.equal(r.ok, true);
  assert.equal(r.transitionLanguage, false);
});

test('A4: the phrasings that mean "transition" are recognised', () => {
  for (const spec of [
    'when the state changes to On Hold',
    'once the incident moves to Awaiting Vendor',
    'when an incident is set to resolved',
    'whenever a change is approved',
    'each time the record transitions',
    'when priority becomes 1',
  ]) {
    assert.equal(describesTransition(spec), true, `not recognised: ${spec}`);
  }
  assert.equal(describesTransition('while the incident is critical'), false);
});

/* ================================================================== *
 * A5 — retries must add evidence
 * ================================================================== */

test('A5: distinct prompts are accepted and counted', () => {
  const ledger = new RetryLedger('codegen');
  ledger.record('question one');
  ledger.record('question two');
  assert.equal(ledger.attempts, 2);
});

test('A5: an identical re-ask is refused loudly, naming the attempt it repeats', () => {
  const ledger = new RetryLedger('verification spec');
  ledger.record('same question');
  ledger.record('a different question');
  assert.throws(
    () => ledger.record('same question'),
    (err) => {
      assert.match(err.message, /verification spec retry 3/);
      assert.match(err.message, /identical to attempt 1/);
      assert.match(err.message, /defect in the evidence builder/);
      return true;
    }
  );
});

test('A5: the prompt hash is stable and discriminating', () => {
  assert.equal(promptHash('a'), promptHash('a'));
  assert.notEqual(promptHash('a'), promptHash('a '));
});

test('A5: a rejected spec becomes a measured field inventory, not a repeated claim', async () => {
  // The exact Test 1 Step 1 failure: the model insisted on `problem`, a field
  // that exists nowhere on this instance, three attempts running.
  const schemaFor = async (t) => {
    assert.equal(t, 'incident');
    return {
      fields: [
        { name: 'sys_id', type: 'GUID' },
        { name: 'work_notes', type: 'journal_input' },
        { name: 'short_description', type: 'string' },
        { name: 'parent', type: 'reference', reference: 'task' },
        { name: 'caller_id', type: 'reference', reference: 'sys_user' },
        { name: 'assignment_group', type: 'reference', reference: 'sys_user_group' },
      ],
    };
  };
  const rejected = {
    assert: [
      {
        table: 'incident',
        locate: { byQuery: 'sys_id={{setup.sys_id}}^problemISNOTEMPTY' },
        field: 'problem_id',
        expect: { value: 'PRB0040006' },
      },
    ],
  };

  const evidence = await buildRejectionEvidence(rejected, { schemaFor });
  assert.equal(evidence.length, 1);
  const block = evidence[0];
  // It names BOTH absent names — the asserted field and the locator root, since
  // a locator on an unknown field is the false-green vector.
  assert.match(block, /problem_id/);
  assert.match(block, /\bproblem\b/);
  // And it hands over the real inventory rather than repeating the claim.
  assert.match(block, /parent -> task/);
  assert.match(block, /caller_id -> sys_user/);
  assert.match(block, /false green/);
  assert.match(block, /Drop that assertion/);
});

test('A5: a spec whose fields all exist yields no evidence — the guard adds nothing when it has nothing', async () => {
  const schemaFor = async () => ({ fields: [{ name: 'work_notes', type: 'journal_input' }, { name: 'sys_id', type: 'GUID' }] });
  const fine = {
    assert: [{ table: 'incident', locate: { bySetupRecord: true }, field: 'work_notes', expect: { value: 'x' } }],
  };
  assert.deepEqual(await buildRejectionEvidence(fine, { schemaFor }), []);
});

test('A5: an unreadable schema produces no evidence rather than a fabricated one', async () => {
  const schemaFor = async () => { throw new Error('instance unreachable'); };
  const spec = { assert: [{ table: 'incident', field: 'whatever', locate: { bySetupRecord: true }, expect: { value: 'x' } }] };
  assert.deepEqual(await buildRejectionEvidence(spec, { schemaFor }), []);
});

/* ================================================================== *
 * CLASS D — the verified escape hatch for unsatisfiable promises
 *
 * Measured in docs/fluent-research.md §20: the field-existence check told the
 * model to drop two impossible assertions, and the coverage rule then rejected
 * it for dropping them. Mutually unsatisfiable guards, and no model could have
 * passed. The hatch resolves it WITHOUT weakening coverage — every excuse is
 * checked against the live instance.
 * ================================================================== */

const SIX_PROMISES = [
  'creates a Problem record',
  'sets short description prefixed with "Vendor issue: "',
  'assigns the Problem to the Hardware group',
  'links the Problem back to the Incident',
  'adds a work note containing the problem number',
  'assigns the Problem to the Hardware group manager when Critical',
];

const baseSpec = (assertCount, unverifiable) => ({
  setup: { table: 'incident', payload: { short_description: 'probe' } },
  wait: { flowName: 'Create Problem for On Hold Vendor Incidents', timeoutSec: 90 },
  assert: Array.from({ length: assertCount }, (_, i) => ({
    table: 'problem',
    locate: { byQuery: `parent={{setup.sys_id}}` },
    field: 'short_description',
    expect: { value: `probe ${i}` },
  })),
  cleanup: [{ table: 'incident', locate: { bySetupRecord: true } }],
  ...(unverifiable ? { unverifiable } : {}),
});

test('CLASS D: the exact deadlock — 4 assertions for 6 promises, no excuses, is rejected', () => {
  const r = validateVerifySpec(baseSpec(4), { promisedEffects: SIX_PROMISES });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /only 4 assertion\(s\)/.test(e)));
  // The rejection must now TEACH the way out, or the model cannot escape it.
  assert.ok(r.errors.some((e) => /list it under "unverifiable"/.test(e)));
});

const TWO_REAL_EXCUSES = [
  { effect: 'links the Problem back to the Incident', kind: 'field_absent', table: 'incident', field: 'problem', note: 'no such field here' },
  { effect: 'assigns the Problem to the Hardware group manager when Critical', kind: 'source_empty', table: 'sys_user_group', field: 'manager', sys_id: '8a5055c9c61122780043563ef53438e3', note: 'group has no manager' },
];

test('CLASS D: the same 4 assertions PASS coverage once two excuses are CONFIRMED', () => {
  const r = validateVerifySpec(baseSpec(4, TWO_REAL_EXCUSES), {
    promisedEffects: SIX_PROMISES,
    verifiedExcuses: 2, // what checkUnverifiableClaims actually confirmed
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('CLASS D: claiming an excuse is not enough — an unconfirmed one buys no coverage', () => {
  // The §20 bug: a spec listed two excuses, only one held up against the
  // instance, and the requirement dropped by two anyway. Counting claims rather
  // than confirmations let a promise vanish on the strength of an assertion
  // about the wrong table.
  const r = validateVerifySpec(baseSpec(4, TWO_REAL_EXCUSES), {
    promisedEffects: SIX_PROMISES,
    verifiedExcuses: 1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /1 excused as unverifiable, CONFIRMED/.test(e)));
});

test('CLASS D: the default is to subtract nothing, so an unchecked caller cannot be fooled', () => {
  const r = validateVerifySpec(baseSpec(4, TWO_REAL_EXCUSES), { promisedEffects: SIX_PROMISES });
  assert.equal(r.ok, false, 'no verifiedExcuses passed => no excuse counts');
});

test('CLASS D: an excuse with no checkable reason is refused', () => {
  const r = validateVerifySpec(
    baseSpec(4, [{ effect: 'links the Problem back to the Incident', kind: 'too_hard', table: 'incident', field: 'problem' }]),
    { promisedEffects: SIX_PROMISES }
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /kind must be one of/.test(e)));
});

test('CLASS D: a source_empty excuse must say WHICH record, or it cannot be checked', () => {
  const r = validateVerifySpec(
    baseSpec(4, [{ effect: 'x', kind: 'source_empty', table: 'sys_user_group', field: 'manager' }]),
    { promisedEffects: SIX_PROMISES }
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must say on WHICH record/.test(e)));
});

test('CLASS D: a TRUE field_absent excuse is confirmed against the dictionary', async () => {
  const schemaFor = async () => ({ fields: [{ name: 'sys_id' }, { name: 'work_notes' }, { name: 'parent' }] });
  const r = await checkUnverifiableClaims(
    { unverifiable: [{ effect: 'links back', kind: 'field_absent', table: 'incident', field: 'problem' }] },
    { schemaFor }
  );
  assert.equal(r.ok, true);
  assert.equal(r.verified.length, 1);
  assert.match(r.verified[0].confirmedBy, /no field named "problem"/);
});

test('CLASS D: a FALSE field_absent excuse is rejected — the dangerous direction', async () => {
  // If this were accepted, a promise the flow was supposed to keep would be
  // dropped silently and the run would still report a clean pass.
  const schemaFor = async () => ({ fields: [{ name: 'sys_id' }, { name: 'work_notes' }] });
  const r = await checkUnverifiableClaims(
    { unverifiable: [{ effect: 'adds a work note', kind: 'field_absent', table: 'incident', field: 'work_notes' }] },
    { schemaFor }
  );
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /but it DOES exist/);
  assert.match(r.errors[0], /assert it instead of excusing it/);
});

test('CLASS D: a TRUE source_empty excuse is confirmed by reading the record', async () => {
  const readRecord = async () => ({ manager: { display_value: '', value: '' } });
  const r = await checkUnverifiableClaims(
    { unverifiable: [{ effect: 'assign to manager', kind: 'source_empty', table: 'sys_user_group', field: 'manager', sys_id: '8a50' }] },
    { readRecord }
  );
  assert.equal(r.ok, true);
  assert.match(r.verified[0].confirmedBy, /is empty on the referenced record/);
});

test('CLASS D: a FALSE source_empty excuse is rejected, quoting what the field actually reads', async () => {
  const readRecord = async () => ({ manager: { display_value: 'Beth Anglin', value: '46d44a23a9fe19810012d100cca80666' } });
  const r = await checkUnverifiableClaims(
    { unverifiable: [{ effect: 'assign to manager', kind: 'source_empty', table: 'sys_user_group', field: 'manager', sys_id: '8a50' }] },
    { readRecord }
  );
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /46d44a23a9fe19810012d100cca80666|Beth Anglin/);
  assert.match(r.errors[0], /so assert it/);
});

test('CLASS D: an excuse we could not check fails CLOSED — the deliberate asymmetry', async () => {
  // checkVerifySpecFields never fails a spec on our own outage, because that
  // rule protects a correct ASSERTION from being blocked by our downtime.
  // This runs the opposite direction: an excuse REMOVES a requirement, so one
  // we could not verify must not quietly count. Two different rules, because
  // the two failure modes are not symmetric.
  const schemaFor = async () => { throw new Error('instance unreachable'); };
  const r = await checkUnverifiableClaims(
    { unverifiable: [{ effect: 'x', kind: 'field_absent', table: 'incident', field: 'problem' }] },
    { schemaFor }
  );
  assert.equal(r.verified.length, 0, 'must never confirm a claim it could not check');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /could not be checked/);
  assert.match(r.errors[0], /does not count toward coverage/);
});

test('CLASS D: an excuse naming the wrong table is caught, not swallowed', async () => {
  // Measured live in §20: the model excused a promise with table "problem" and
  // field "assigned_to" while passing the sys_id of a sys_user_group record.
  // The read failed, the error was swallowed by a bare catch, and the claim
  // silently reduced the coverage requirement anyway.
  const readRecord = async (t, id) => {
    if (t === 'problem') throw new Error(`No record found in problem for sys_id ${id}`);
    return { manager: { display_value: '', value: '' } };
  };
  const r = await checkUnverifiableClaims(
    {
      unverifiable: [
        { effect: 'assign to manager', kind: 'source_empty', table: 'problem', field: 'assigned_to', sys_id: '8a5055c9c61122780043563ef53438e3' },
      ],
    },
    { readRecord }
  );
  assert.equal(r.ok, false);
  assert.equal(r.verified.length, 0);
  assert.match(r.errors[0], /no problem record with sys_id 8a5055c9/);
  assert.match(r.errors[0], /the table the value is READ FROM/);
});

test('CLASS D: a spec with no unverifiable block is unaffected', () => {
  const r = validateVerifySpec(baseSpec(6), { promisedEffects: SIX_PROMISES });
  assert.equal(r.ok, true);
  assert.equal(validateUnverifiableShape(undefined).ok, true);
});
