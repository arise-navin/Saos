import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchBrace,
  objectEntries,
  literalValue,
  parseColumns,
  parseArtifactContracts,
  parseSubflowContract,
  parseSubflowCalls,
  parseOutputAssignments,
  buildCatalog,
  catalogPromptBlock,
  lintArtifactType,
  lintSubflowReuse,
  buildDependencyGraph,
  callersOf,
} from '../src/servicenow/subflows.js';

/* ------------------------------------------------------------------ *
 * Fixtures — shaped like real generated sources, including the awkward
 * bits (a brace inside a description, a template-literal condition).
 * ------------------------------------------------------------------ */

const ESCALATE_SUBFLOW = `
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn, ReferenceColumn } from '@servicenow/sdk/core'

export const escalateToDutyManager = Subflow(
    {
        $id: Now.ID['etdm_subflow'],
        name: 'Escalate To Duty Manager',
        description: 'Notifies the assignment group manager and records the escalation {on the task}.',
        runAs: 'system',
        inputs: {
            task: ReferenceColumn({ label: 'Task', referenceTable: 'task', mandatory: true }),
            message: StringColumn({ label: 'Message', mandatory: true }),
        },
        outputs: {
            notified: BooleanColumn({ label: 'Notified' }),
        },
    },
    (params) => {
        const t = wfa.action(action.core.lookUpRecord, { $id: Now.ID['etdm_lookup'] }, {
            table: 'task',
            conditions: \`sys_id=\${wfa.dataPill(params.inputs.task, 'string')}\`,
        })
        wfa.action(action.core.updateRecord, { $id: Now.ID['etdm_note'] }, {
            table_name: 'task',
            record: wfa.dataPill(t.Record, 'reference'),
            values: TemplateValue({ work_notes: 'Escalated.' }),
        })
        wfa.dataPill(params.inputs.message, 'string')
        wfa.flowLogic.assignSubflowOutputs({ $id: Now.ID['etdm_out'] }, params.outputs, { notified: true })
    }
)
`;

const CALLER_FLOW = `
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { escalateToDutyManager } from './escalate-to-duty-manager.now'

Flow(
    { $id: Now.ID['vh_flow'], name: 'P1 Vendor Hold Escalation', runAs: 'system' },
    wfa.trigger(trigger.record.updated, { $id: Now.ID['vh_trigger'] }, {
        table: 'incident', condition: 'priority=1^state=3', trigger_strategy: 'unique_changes',
    }),
    (params) => {
        wfa.subflow(escalateToDutyManager, { $id: Now.ID['vh_call'] }, {
            task: wfa.dataPill(params.trigger.current, 'reference'),
            message: 'P1 on vendor hold',
            waitForCompletion: true,
        })
    }
)
`;

const sourcesOf = (...pairs) => pairs.map(([file, source]) => ({ file, source }));

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

test('the brace matcher walks past braces that live inside strings', () => {
  const text = "{ a: 'has } a brace', b: { c: 1 } }";
  assert.equal(matchBrace(text, 0), text.length - 1);
});

test('the brace matcher walks past a template literal hole', () => {
  const text = '{ condition: `sys_id=${wfa.dataPill(x, \'string\')}`, next: 1 }';
  assert.equal(matchBrace(text, 0), text.length - 1);
});

test('objectEntries keeps top-level pairs and ignores nested commas', () => {
  const entries = objectEntries("a: Col({ x: 1, y: 2 }), b: 'two, three', c: [1, 2]");
  assert.deepEqual(entries.map((e) => e.key), ['a', 'b', 'c']);
  assert.equal(entries[1].value, "'two, three'");
});

test('literalValue reads a quoted string and refuses an expression', () => {
  assert.equal(literalValue("'Escalate To Duty Manager'"), 'Escalate To Duty Manager');
  assert.equal(literalValue(`"it\\'s fine"`), "it's fine");
  assert.equal(literalValue('someVariable'), null);
});

test('parseColumns reports the type, the label, the reference table and mandatory', () => {
  const cols = parseColumns(
    "task: ReferenceColumn({ label: 'Task', referenceTable: 'task', mandatory: true }), " +
    "note: StringColumn({ label: 'Note' })"
  );
  assert.deepEqual(cols[0], {
    name: 'task', columnType: 'ReferenceColumn', type: 'reference', label: 'Task', reference: 'task', mandatory: true,
  });
  assert.deepEqual(cols[1], {
    name: 'note', columnType: 'StringColumn', type: 'string', label: 'Note', reference: null, mandatory: false,
  });
});

test('a subflow contract survives a description containing a brace', () => {
  const c = parseSubflowContract(ESCALATE_SUBFLOW);
  assert.equal(c.name, 'Escalate To Duty Manager');
  assert.equal(c.exportName, 'escalateToDutyManager');
  assert.equal(c.idKey, 'etdm_subflow');
  assert.deepEqual(c.inputs.map((i) => i.name), ['task', 'message']);
  assert.equal(c.inputs[0].reference, 'task');
  assert.deepEqual(c.outputs.map((o) => o.name), ['notified']);
});

test('a flow+subflow pair yields both artifacts, and only the subflow carries a contract', () => {
  const both = parseArtifactContracts(`${ESCALATE_SUBFLOW}\n${CALLER_FLOW}`);
  assert.deepEqual(both.map((a) => a.kind), ['subflow', 'flow']);
  assert.equal(both[1].inputs, undefined);
});

test('parseOutputAssignments bracket-matches past nested calls', () => {
  const src = `wfa.flowLogic.assignSubflowOutputs({ $id: Now.ID['o'] }, params.outputs, {
      email: wfa.dataPill(t.Record.manager.email, 'string'),
      notified: true,
  })`;
  const [a] = parseOutputAssignments(src);
  assert.equal(a.schemaArg, 'params.outputs');
  assert.deepEqual(a.assigned, ['email', 'notified']);
});

/* ------------------------------------------------------------------ *
 * Artifact-type lint
 * ------------------------------------------------------------------ */

test('a well-formed subflow passes its own lint', () => {
  assert.equal(lintArtifactType(ESCALATE_SUBFLOW, 'subflow').ok, true);
});

test('a subflow with a trigger is rejected — the platform would store it as a flow', () => {
  const withTrigger = ESCALATE_SUBFLOW.replace(
    '    (params) => {',
    "    wfa.trigger(trigger.record.created, { $id: Now.ID['x'] }, { table: 'incident' }),\n    (params) => {"
  );
  const r = lintArtifactType(withTrigger, 'subflow');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /A Subflow has NO trigger/);
});

test('a subflow that is not exported cannot be called, and is rejected', () => {
  const r = lintArtifactType(ESCALATE_SUBFLOW.replace('export const escalateToDutyManager =', 'const escalateToDutyManager ='), 'subflow');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /is not exported/);
});

test('a declared output that is never assigned is a promise the caller cannot see broken', () => {
  const r = lintArtifactType(ESCALATE_SUBFLOW.replace('{ notified: true }', '{ }'), 'subflow');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /Output "notified" is declared but never assigned/);
});

test('assignSubflowOutputs must be handed params.outputs, not a hand-built object', () => {
  const r = lintArtifactType(ESCALATE_SUBFLOW.replace('params.outputs, { notified: true }', '{ notified: true }, { notified: true }'), 'subflow');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /must be\s+params\.outputs/s);
});

test('a declared input that is never read is a contract the subflow does not honour', () => {
  const r = lintArtifactType(ESCALATE_SUBFLOW.replace("wfa.dataPill(params.inputs.message, 'string')", ''), 'subflow');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /Input "message" is declared but never read/);
});

test('a flow needs exactly one trigger, and a subflow request must not return a flow', () => {
  assert.equal(lintArtifactType(CALLER_FLOW, 'flow').ok, true);
  assert.match(lintArtifactType(ESCALATE_SUBFLOW, 'flow').errors.join('\n'), /declares no Flow/);
  assert.match(lintArtifactType(CALLER_FLOW, 'subflow').errors.join('\n'), /also declares a Flow/);
});

/* ------------------------------------------------------------------ *
 * Reuse catalog + prefer-call lint
 * ------------------------------------------------------------------ */

test('the catalog carries the contract a caller has to satisfy', () => {
  const [entry] = buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW]));
  assert.equal(entry.name, 'Escalate To Duty Manager');
  assert.equal(entry.importPath, './escalate-to-duty-manager.now');
  assert.deepEqual(entry.inputs.map((i) => `${i.name}:${i.type}`), ['task:reference', 'message:string']);
});

test('the prompt block spells out the import and the call, not just the name', () => {
  const block = catalogPromptBlock(buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW])));
  assert.match(block, /import \{ escalateToDutyManager \} from '\.\/escalate-to-duty-manager\.now'/);
  assert.match(block, /waitForCompletion: true/);
});

test('a subflow that is not exported is listed as not callable rather than offered', () => {
  const block = catalogPromptBlock(buildCatalog(sourcesOf(['x.now.ts', ESCALATE_SUBFLOW.replace('export const', 'const')])));
  assert.match(block, /NOT CALLABLE from generated code/);
});

test('re-creating an existing subflow by name is rejected, and the existing one is named', () => {
  const catalog = buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW]));
  const renamedInputs = ESCALATE_SUBFLOW.replace('task: ReferenceColumn', 'thing: ReferenceColumn').replace('params.inputs.task', 'params.inputs.thing');
  const r = lintSubflowReuse(renamedInputs, catalog, { file: 'p1-vendor-hold.now.ts' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /duplicates the existing subflow "Escalate To Duty Manager"/);
  assert.match(r.errors[0], /the same name/);
});

test('re-creating one with the same inputs under a new name is rejected too', () => {
  const catalog = buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW]));
  const renamed = ESCALATE_SUBFLOW.replace("name: 'Escalate To Duty Manager'", "name: 'Tell The Duty Manager'");
  const r = lintSubflowReuse(renamed, catalog, { file: 'tell-the-duty-manager.now.ts' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /the same inputs \(task, message\)/);
  assert.match(r.errors[0], /import \{ escalateToDutyManager \}/);
});

test('regenerating the subflow itself is not a duplicate of itself', () => {
  const catalog = buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW]));
  assert.equal(lintSubflowReuse(ESCALATE_SUBFLOW, catalog, { file: 'escalate-to-duty-manager.now.ts' }).ok, true);
});

test('a genuinely different contract is left alone', () => {
  const catalog = buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW]));
  const different = ESCALATE_SUBFLOW
    .replace("name: 'Escalate To Duty Manager'", "name: 'Close Stale Problems'")
    .replace('task: ReferenceColumn({ label: \'Task\', referenceTable: \'task\', mandatory: true })', "olderThanDays: StringColumn({ label: 'Older Than Days' })")
    .replace('params.inputs.task', 'params.inputs.olderThanDays');
  assert.equal(lintSubflowReuse(different, catalog, { file: 'close-stale-problems.now.ts' }).ok, true);
});

/* ------------------------------------------------------------------ *
 * Dependency graph
 * ------------------------------------------------------------------ */

test('calls and callers are both recorded, from the import and the wfa.subflow binding', () => {
  const sources = sourcesOf(
    ['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW],
    ['p1-vendor-hold.now.ts', CALLER_FLOW]
  );
  const { nodes } = buildDependencyGraph(sources);
  const sub = nodes.find((n) => n.name === 'Escalate To Duty Manager');
  const flow = nodes.find((n) => n.name === 'P1 Vendor Hold Escalation');
  assert.deepEqual(sub.calledBy, ['P1 Vendor Hold Escalation']);
  assert.deepEqual(flow.calls, ['Escalate To Duty Manager']);
  assert.deepEqual(callersOf('Escalate To Duty Manager', sources), ['P1 Vendor Hold Escalation']);
  assert.deepEqual(callersOf('P1 Vendor Hold Escalation', sources), []);
});

test('a same-file flow+subflow pair records the edge without importing anything', () => {
  const paired = `${ESCALATE_SUBFLOW}\n${CALLER_FLOW.replace(/import \{ escalateToDutyManager \}[^\n]*\n/, '')}`;
  const { nodes } = buildDependencyGraph(sourcesOf(['pair.now.ts', paired]));
  assert.deepEqual(nodes.find((n) => n.name === 'Escalate To Duty Manager').calledBy, ['P1 Vendor Hold Escalation']);
});

test('a sys_id call is kept as an unresolved edge rather than dropped', () => {
  const bySysId = CALLER_FLOW
    .replace(/import \{ escalateToDutyManager \}[^\n]*\n/, '')
    .replace('wfa.subflow(escalateToDutyManager,', "wfa.subflow('af90366362d04879b7ab39f6dc66bcc1',");
  const { nodes } = buildDependencyGraph(sourcesOf(['p1-vendor-hold.now.ts', bySysId]));
  const flow = nodes.find((n) => n.name === 'P1 Vendor Hold Escalation');
  assert.deepEqual(flow.calls, []);
  assert.deepEqual(flow.unresolved, [{ via: 'sys_id', sysId: 'af90366362d04879b7ab39f6dc66bcc1' }]);
});

test('the catalog tells a caller what the subflow DOES, not only what it takes', () => {
  // Measured in section 32 A3: the agent held "Escalate To Duty Manager",
  // could see an input named `task`, and still stopped to ask who the duty
  // manager was — a question the subflow's own description answers.
  const block = catalogPromptBlock(buildCatalog(sourcesOf(['escalate-to-duty-manager.now.ts', ESCALATE_SUBFLOW])));
  assert.match(block, /it does: Notifies the assignment group manager and records the escalation/);
});

test('a subflow with no description still renders cleanly', () => {
  const noDesc = ESCALATE_SUBFLOW.replace(/\n\s*description: '[^']*',/, '');
  const block = catalogPromptBlock(buildCatalog(sourcesOf(['x.now.ts', noDesc])));
  assert.ok(!block.includes('it does:'));
  assert.match(block, /inputs:  task: reference/);
});
