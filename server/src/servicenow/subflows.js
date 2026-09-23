/**
 * Subflows as first-class artifacts: contracts, a reuse catalog, and a
 * dependency graph — all derived from the managed Fluent sources.
 *
 * Everything here is a PURE function over source text, so the whole set is
 * exercised offline by server/test/subflows.test.js. The instance is the
 * authority for what is deployed; the source is the authority for what the
 * next install will deploy, and these two are reported side by side rather
 * than one being inferred from the other.
 *
 * Why a contract is parsed rather than asked for:
 *   A subflow's inputs and outputs ARE its public interface. A caller wires
 *   itself to input names; a rename is a broken call, not a cosmetic change.
 *   The same reasoning that pinned artifact NAMES in codegen-guards.js (A2)
 *   applies here — anything the platform matches on is too important to take
 *   from a model's prose summary when the source states it exactly.
 */

/* ------------------------------------------------------------------ *
 * A brace matcher that knows about strings
 *
 * The existing matcher in codegen-guards.js counts braces blindly, which is
 * fine for finding a `name:` literal. A contract parser has to walk INTO the
 * config object, where a description containing a brace, or a template literal
 * with ${...} in it, would otherwise close the block early and silently yield
 * half a contract. Half a contract is exactly the shape of a confidently wrong
 * answer this repo keeps having to undo.
 * ------------------------------------------------------------------ */

/** Index of the bracket matching the one at `open`, or -1. Skips strings/comments. */
export function matchPair(text, open, openChar = '{', closeChar = '}') {
  if (text[open] !== openChar) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i); if (i < 0) return -1; i += 1; continue; }
    if (ch === "'" || ch === '"') { i = skipQuoted(text, i); if (i < 0) return -1; continue; }
    if (ch === '`') { i = skipTemplate(text, i); if (i < 0) return -1; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
export function matchBrace(text, open) {
  return matchPair(text, open, '{', '}');
}

/** Index of the closing quote for the string starting at `start`. */
function skipQuoted(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === quote) return i;
    if (text[i] === '\n') return -1; // unterminated — bail rather than guess
  }
  return -1;
}

/** Index of the closing backtick, walking through any ${ ... } holes. */
function skipTemplate(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '`') return i;
    if (text[i] === '$' && text[i + 1] === '{') {
      const close = matchBrace(text, i + 1);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

/** Split an object body into top-level `key: value` pairs, in order. */
export function objectEntries(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    // key
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (i >= body.length) break;
    if (body[i] === '/' && (body[i + 1] === '/' || body[i + 1] === '*')) {
      i = body[i + 1] === '/' ? (body.indexOf('\n', i) + 1 || body.length) : (body.indexOf('*/', i) + 2 || body.length);
      continue;
    }
    let key = null;
    if (body[i] === "'" || body[i] === '"') {
      const close = skipQuoted(body, i);
      if (close < 0) break;
      key = body.slice(i + 1, close);
      i = close + 1;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(body.slice(i));
      if (!m) break;
      key = m[0];
      i += m[0].length;
    }
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (body[i] !== ':') break;
    i += 1;
    // value — read to the comma at depth 0
    const startValue = i;
    let depth = 0;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "'" || ch === '"') { const c = skipQuoted(body, i); if (c < 0) { i = body.length; break; } i = c; continue; }
      if (ch === '`') { const c = skipTemplate(body, i); if (c < 0) { i = body.length; break; } i = c; continue; }
      if ('{[('.includes(ch)) depth += 1;
      else if ('}])'.includes(ch)) depth -= 1;
      else if (ch === ',' && depth === 0) break;
    }
    out.push({ key, value: body.slice(startValue, i).trim() });
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Contracts
 * ------------------------------------------------------------------ */

const COLUMN_TYPES = {
  StringColumn: 'string',
  IntegerColumn: 'integer',
  BooleanColumn: 'boolean',
  DecimalColumn: 'decimal',
  FloatColumn: 'float',
  DateTimeColumn: 'glide_date_time',
  ReferenceColumn: 'reference',
  GenericColumn: 'generic',
  JsonColumn: 'json',
  FlowObject: 'object',
  FlowArray: 'array',
};

const stringOption = (text, key) => {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(text);
  return m ? m[2] : null;
};

/** The value of a quoted literal, or null when the value is an expression. */
export function literalValue(value) {
  const text = String(value ?? '').trim();
  if (!text || (text[0] !== "'" && text[0] !== '"')) return null;
  const close = skipQuoted(text, 0);
  return close < 0 ? null : text.slice(1, close).replace(/\\(.)/g, '$1');
}

/** One `inputs:` / `outputs:` block, as a list of contract entries. */
export function parseColumns(blockBody) {
  return objectEntries(blockBody).map(({ key, value }) => {
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value);
    const columnType = call ? call[1] : null;
    const open = value.indexOf('{');
    const optionText = open >= 0 ? value.slice(open, matchBrace(value, open) + 1) : '';
    return {
      name: key,
      columnType,
      type: COLUMN_TYPES[columnType] || 'unknown',
      label: stringOption(optionText, 'label'),
      reference: stringOption(optionText, 'referenceTable'),
      mandatory: /\bmandatory\s*:\s*true\b/.test(optionText),
    };
  });
}

const ARTIFACT_RE = /(?:export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*)?\b(Subflow|Flow)\s*\(/g;

/**
 * Every Flow/Subflow declared in a source, with the subflows' full contracts.
 *
 * `exportName` is what a caller imports, and is therefore how a dependency edge
 * is resolved — a subflow that is not exported cannot be called from another
 * file at all, which is why the shape lint treats it as an error rather than a
 * style preference.
 */
export function parseArtifactContracts(source) {
  const text = String(source || '');
  const out = [];
  ARTIFACT_RE.lastIndex = 0;
  let m;
  while ((m = ARTIFACT_RE.exec(text))) {
    const open = text.indexOf('{', m.index);
    if (open < 0) continue;
    const close = matchBrace(text, open);
    if (close < 0) continue;
    const config = text.slice(open + 1, close);
    const entries = objectEntries(config);
    const byKey = new Map(entries.map((e) => [e.key, e.value]));
    const name = literalValue(byKey.get('name'));
    const idKey = /Now\.ID\[\s*['"]([^'"]+)['"]\s*\]/.exec(byKey.get('$id') || '')?.[1] || null;

    const block = (which) => {
      const raw = byKey.get(which);
      if (!raw || !raw.startsWith('{')) return [];
      const end = matchBrace(raw, 0);
      return end < 0 ? [] : parseColumns(raw.slice(1, end));
    };

    const artifact = {
      kind: m[2] === 'Subflow' ? 'subflow' : 'flow',
      name,
      exportName: m[1] || null,
      idKey,
      description: literalValue(byKey.get('description')),
    };
    if (artifact.kind === 'subflow') {
      artifact.inputs = block('inputs');
      artifact.outputs = block('outputs');
    }
    out.push(artifact);
  }
  return out;
}

/** The contract of the (single) subflow a source declares, or null. */
export function parseSubflowContract(source) {
  return parseArtifactContracts(source).find((a) => a.kind === 'subflow') || null;
}

/* ------------------------------------------------------------------ *
 * Calls — the edges of the dependency graph
 * ------------------------------------------------------------------ */

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/([^'"]+)['"]/g;
const CALL_RE = /wfa\.subflow\s*\(\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))/g;

/**
 * Which subflows a source calls.
 *
 * Two forms exist and both are recorded: the typed form (an imported or
 * same-file `export const`) and the sys_id fallback the SDK allows when the
 * definition cannot be imported. A sys_id call is reported as unresolved
 * rather than silently dropped — an edge nobody can see is how a delete gets
 * to break a live caller.
 */
export function parseSubflowCalls(source) {
  const text = String(source || '');
  const imports = new Map();
  IMPORT_RE.lastIndex = 0;
  let im;
  while ((im = IMPORT_RE.exec(text))) {
    const file = im[2].endsWith('.now') ? `${im[2]}.ts` : im[2];
    for (const raw of im[1].split(',')) {
      const nameOnly = raw.trim().split(/\s+as\s+/).pop().trim();
      if (nameOnly) imports.set(nameOnly, file);
    }
  }

  const calls = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text))) {
    if (m[2]) calls.push({ via: 'sys_id', sysId: m[2], binding: null, file: null });
    else calls.push({ via: 'binding', sysId: null, binding: m[3], file: imports.get(m[3]) || null });
  }
  return { imports: Object.fromEntries(imports), calls };
}

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

/**
 * Build the reuse catalog from managed sources.
 *
 * `sources` is [{ file, source }] — the same shape readProjectSources() already
 * produces in fluent.js, so there is one reader, not two.
 */
export function buildCatalog(sources = []) {
  const entries = [];
  for (const { file, source } of sources) {
    for (const a of parseArtifactContracts(source)) {
      if (a.kind !== 'subflow' || !a.name) continue;
      entries.push({
        name: a.name,
        file,
        exportName: a.exportName,
        idKey: a.idKey,
        description: a.description,
        inputs: a.inputs || [],
        outputs: a.outputs || [],
        importPath: `./${file.replace(/\.ts$/, '')}`,
      });
    }
  }
  return entries;
}

/**
 * The catalog as the codegen prompt sees it.
 *
 * Only subflows that are EXPORTED and importable appear as callable. One that
 * is not exported is listed as not-callable with the reason, because telling a
 * model to import something it cannot import produces a build failure that
 * looks like the model's fault.
 */
export function catalogPromptBlock(catalog = []) {
  if (!catalog.length) return '';
  const lines = catalog.map((c) => {
    const io = (list, kind) =>
      list.length
        ? list.map((f) => `${f.name}: ${f.type}${f.reference ? ` -> ${f.reference}` : ''}${f.mandatory ? ' (required)' : ''}`).join(', ')
        : `(no ${kind})`;
    const head = `- "${c.name}"`;
    const how = c.exportName
      ? `import { ${c.exportName} } from '${c.importPath}'  then  wfa.subflow(${c.exportName}, { $id: Now.ID['<your_new_key>'] }, { ... , waitForCompletion: true })`
      : `NOT CALLABLE from generated code: it is not exported as \`export const\`. Do not import it.`;
    return [
      head,
      // The description is what says what the subflow DOES. Without it a caller
      // can see that an input is called `task` and still not know the subflow
      // already derives the manager from it — measured live in §32 A3, where
      // the agent stopped to ask who the duty manager was while holding a
      // subflow whose whole job is to work that out.
      c.description ? `    it does: ${c.description}` : null,
      `    inputs:  ${io(c.inputs, 'inputs')}`,
      `    outputs: ${io(c.outputs, 'outputs')}`,
      `    call it: ${how}`,
    ].filter(Boolean).join('\n');
  });
  return (
    'EXISTING SUBFLOWS IN THIS PROJECT — CALL THEM, DO NOT RE-CREATE THEM.\n' +
    'If what this request needs is already one of these, the flow you write MUST invoke it with wfa.subflow(...). ' +
    'Writing a second subflow with the same job is rejected before the build, and re-implementing its steps inline ' +
    'duplicates logic that already exists as a deployed record.\n' +
    'The $id you give the CALL is a new key of your own (prefix it with this flow\'s slug); the subflow itself keeps its identity.\n' +
    lines.join('\n')
  );
}

/* ------------------------------------------------------------------ *
 * Lints
 * ------------------------------------------------------------------ */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const asError = (label, errors) => ({
  ok: errors.length === 0,
  errors,
  diagnostic: errors.length ? `ERROR: ${label}\n${errors.map((e) => `ERROR: ${e}`).join('\n')}` : null,
});

/**
 * The artifact the request asked for is the artifact that must come back.
 *
 * A subflow that is generated with a trigger is not a subflow — the platform
 * stores it as a flow, the Flows page badges it as a flow, and nothing
 * downstream notices. This is the same failure shape as A2: an identity the
 * platform matches on, decided by a model that is right most of the time.
 */
export function lintArtifactType(source, artifactType) {
  const text = String(source || '');
  const artifacts = parseArtifactContracts(text);
  const errors = [];

  if (artifactType === 'subflow') {
    const sub = artifacts.find((a) => a.kind === 'subflow');
    if (!sub) {
      errors.push(
        'This request asks for a SUBFLOW, but the source declares no Subflow(...). ' +
        'A subflow is `export const <name> = Subflow({ $id, name, inputs, outputs }, (params) => { ... })` ' +
        'with NO trigger — it is invoked by other flows.'
      );
    }
    if (artifacts.some((a) => a.kind === 'flow')) {
      errors.push('This request asks for a SUBFLOW, but the source also declares a Flow(...). Return the subflow alone.');
    }
    if (/wfa\.trigger\s*\(/.test(text)) {
      errors.push(
        'A Subflow has NO trigger, and this source calls wfa.trigger(...). Remove it: a subflow runs because ' +
        'something calls it, and the platform stores a triggered artifact as a flow, not a subflow.'
      );
    }
    if (sub && !sub.exportName) {
      errors.push(
        `The Subflow "${sub.name || '(unnamed)'}" is not exported. Write \`export const <camelCaseName> = Subflow(...)\` — ` +
        'without the export no other flow can import it, so it can never be called.'
      );
    }
    if (sub) errors.push(...contractErrors(sub, text));
  } else {
    if (!artifacts.some((a) => a.kind === 'flow')) {
      errors.push('This request asks for a FLOW, but the source declares no Flow(...).');
    }
    const triggers = text.match(/wfa\.trigger\s*\(/g)?.length || 0;
    if (triggers !== 1) {
      errors.push(`A Flow needs exactly one wfa.trigger(...); this source has ${triggers}.`);
    }
  }
  return asError('artifact type lint failed before build.', errors);
}

/**
 * Every `assignSubflowOutputs(...)` call in a source, parsed into its three
 * arguments. Regex alone cannot do this — the values object contains nested
 * calls with their own parentheses — so the argument list is bracket-matched.
 */
export function parseOutputAssignments(source) {
  const text = String(source || '');
  const out = [];
  const RE = /assignSubflowOutputs\s*\(/g;
  let m;
  while ((m = RE.exec(text))) {
    const open = text.indexOf('(', m.index);
    const close = matchPair(text, open, '(', ')');
    if (close < 0) continue;
    const inner = text.slice(open + 1, close);
    const args = splitTopLevel(inner);
    const values = args[2] ?? '';
    const objectAt = values.indexOf('{');
    const end = objectAt >= 0 ? matchBrace(values, objectAt) : -1;
    out.push({
      schemaArg: (args[1] ?? '').trim(),
      assigned: end >= 0 ? objectEntries(values.slice(objectAt + 1, end)).map((e) => e.key) : [],
    });
  }
  return out;
}

/** Split an argument list on the commas that sit at depth 0. */
function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" || ch === '"') { const c = skipQuoted(inner, i); if (c < 0) break; i = c; continue; }
    if (ch === '`') { const c = skipTemplate(inner, i); if (c < 0) break; i = c; continue; }
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));
  return parts;
}

/** The rules that make a declared contract an honoured one. */
function contractErrors(sub, text) {
  const errors = [];
  const outputs = sub.outputs || [];
  const inputs = sub.inputs || [];

  if (outputs.length) {
    const assigns = parseOutputAssignments(text);
    if (!assigns.length) {
      errors.push(
        `"${sub.name}" declares outputs (${outputs.map((o) => o.name).join(', ')}) but never calls ` +
        'wfa.flowLogic.assignSubflowOutputs. That is the ONLY way a subflow returns a value, so every ' +
        'output would come back empty to the caller.'
      );
    }
    for (const a of assigns) {
      if (a.schemaArg !== 'params.outputs') {
        errors.push(
          `assignSubflowOutputs was passed "${a.schemaArg || '(nothing)'}" as its second argument; it must be ` +
          'params.outputs. Constructing a custom object there compiles and assigns nothing.'
        );
      }
    }
    const assignedNames = new Set(assigns.flatMap((a) => a.assigned));
    for (const o of outputs) {
      // A declared output that is never named in a values object is a promise
      // the subflow silently does not keep: the caller reads it back empty and
      // cannot tell that from a legitimate empty value.
      if (!assignedNames.has(o.name)) {
        errors.push(
          `Output "${o.name}" is declared but never assigned. Every declared output must appear in an ` +
          'assignSubflowOutputs values object, or the caller reads it back empty and cannot tell that ' +
          'from a legitimate empty value.'
        );
      }
    }
  }

  for (const i of inputs) {
    const read = new RegExp(`params\\.inputs\\s*(?:\\.${i.name}\\b|\\[\\s*['"]${i.name}['"]\\s*\\])`).test(text);
    if (!read) {
      errors.push(
        `Input "${i.name}" is declared but never read. A caller that passes it would have no effect. ` +
        `Use it with wfa.dataPill(params.inputs.${i.name}, '${i.type === 'reference' ? 'reference' : i.type}') ` +
        'somewhere in the body, or do not declare it.'
      );
    }
  }
  return errors;
}

/**
 * The prefer-call rule, enforced rather than requested.
 *
 * Trap #53 in the ledger: a good diagnostic is not a fix, and a rule that can
 * be checked mechanically has to be checked mechanically. A generated flow that
 * re-creates a subflow this project already deploys does not just duplicate
 * code — it collides on nothing, builds cleanly, and quietly doubles the number
 * of records that have to be kept in step.
 *
 * "Same contract" is deliberately narrow and stated: the same NAME, or the same
 * set of input names. Two subflows that genuinely need identical inputs and
 * different behaviour are the false positive this accepts, and the diagnostic
 * says so, so a human reading the rejection can see what it decided.
 */
export function lintSubflowReuse(candidateSource, catalog = [], { file = 'candidate.now.ts' } = {}) {
  const declared = parseArtifactContracts(candidateSource).filter((a) => a.kind === 'subflow');
  const errors = [];
  const others = catalog.filter((c) => c.file !== file);

  for (const mine of declared) {
    const myInputs = new Set((mine.inputs || []).map((i) => norm(i.name)));
    for (const theirs of others) {
      const sameName = mine.name && norm(mine.name) === norm(theirs.name);
      const theirInputs = new Set((theirs.inputs || []).map((i) => norm(i.name)));
      const sameInputs =
        myInputs.size > 0 &&
        myInputs.size === theirInputs.size &&
        [...myInputs].every((n) => theirInputs.has(n));
      if (!sameName && !sameInputs) continue;

      errors.push(
        `This source declares a subflow "${mine.name}" that duplicates the existing subflow "${theirs.name}" ` +
        `(${theirs.file})` +
        (sameName ? ' — the same name' : ` — the same inputs (${[...theirInputs].join(', ')})`) + '. ' +
        `Do not create a second one. ` +
        (theirs.exportName
          ? `Import the existing subflow and CALL it: import { ${theirs.exportName} } from '${theirs.importPath}' and ` +
            `wfa.subflow(${theirs.exportName}, { $id: Now.ID['<new key for this call>'] }, { ` +
            `${(theirs.inputs || []).map((i) => `${i.name}: <value>`).join(', ')}${theirs.inputs?.length ? ', ' : ''}` +
            `waitForCompletion: true }).`
          : `The existing subflow is not exported, so fix that source rather than adding a second subflow here.`) +
        ' If this really is different work, it needs a different input contract and a different name.'
      );
    }
  }
  return asError('subflow reuse lint failed before build.', errors);
}

/* ------------------------------------------------------------------ *
 * Dependency graph
 * ------------------------------------------------------------------ */

/**
 * Which managed flows call which managed subflows.
 *
 * Resolution is by (file, exportName) for the typed form and by raw sys_id for
 * the fallback form. An edge that cannot be resolved is kept as `unresolved`
 * rather than dropped — deleting a subflow because "nothing appears to call it"
 * is precisely the outcome a dropped edge produces.
 */
export function buildDependencyGraph(sources = []) {
  const catalog = buildCatalog(sources);
  const byExport = new Map();
  for (const c of catalog) if (c.exportName) byExport.set(`${c.file}::${c.exportName}`, c.name);
  const byExportName = new Map();
  for (const c of catalog) if (c.exportName) byExportName.set(c.exportName, c.name);

  const nodes = new Map();
  const node = (name) => {
    if (!nodes.has(name)) nodes.set(name, { name, calls: [], calledBy: [], unresolved: [] });
    return nodes.get(name);
  };

  for (const { file, source } of sources) {
    const artifacts = parseArtifactContracts(source);
    for (const a of artifacts) if (a.name) node(a.name);

    const { calls } = parseSubflowCalls(source);
    if (!calls.length) continue;
    // A call belongs to whichever artifact in this file is not the subflow
    // being defined; in a flow+subflow pair that is the flow.
    const callers = artifacts.filter((a) => a.name).map((a) => a.name);
    const caller = artifacts.find((a) => a.kind === 'flow')?.name || callers[0];
    if (!caller) continue;

    for (const c of calls) {
      let target = null;
      if (c.via === 'binding') {
        target = byExport.get(`${c.file || file}::${c.binding}`) || byExportName.get(c.binding) || null;
      }
      if (!target) {
        node(caller).unresolved.push(c.via === 'sys_id' ? { via: 'sys_id', sysId: c.sysId } : { via: 'binding', binding: c.binding });
        continue;
      }
      if (target === caller) continue;
      if (!node(caller).calls.includes(target)) node(caller).calls.push(target);
      if (!node(target).calledBy.includes(caller)) node(target).calledBy.push(caller);
    }
  }
  return { nodes: [...nodes.values()], catalog };
}

/** Callers of one artifact, by name. Used to block a delete that would break them. */
export function callersOf(name, sources = []) {
  const { nodes } = buildDependencyGraph(sources);
  return nodes.find((n) => n.name === name)?.calledBy ?? [];
}

export const subflows = {
  parseArtifactContracts,
  parseSubflowContract,
  parseSubflowCalls,
  buildCatalog,
  catalogPromptBlock,
  lintArtifactType,
  lintSubflowReuse,
  buildDependencyGraph,
  callersOf,
};
