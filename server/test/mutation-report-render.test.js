/**
 * F1 — the mutation report is rendered, not swallowed.
 *
 *   node --test server/test/
 *
 * THE DEFECT. `<Markdown>{m.markdown}</Markdown>` passes the report as
 * CHILDREN, and `Markdown` (client/src/components/Markdown.jsx) destructures a
 * `text` prop and renders `{text || ''}`. So the harness-authored mutation
 * report — the whole of WI-2's "an executed mutation cannot be absent from the
 * report" — rendered as an empty bubble on every turn that mutated. In the
 * transcript that produced this fix it sat directly between the compaction
 * notice and the error card, and read as a blank assistant turn.
 *
 * Two halves, because the bug lives in the seam between them:
 *
 *   1. a CONTRACT check over the sources — `Markdown` takes `text`, and every
 *      call site passes it. This is the half that actually catches the defect,
 *      and it is a source assertion because `Markdown.jsx` is JSX and there is
 *      no transform in this suite to import it through;
 *   2. a RENDER check that the report string the ledger really produces is not
 *      itself empty markdown, through the same pipeline the bubble ships.
 *
 * Without (2), (1) would pass on a report that renders to nothing anyway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { renderMutationReport } from '../src/memory/ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = path.resolve(here, '../../client/src');
const read = (p) => fs.readFileSync(path.resolve(clientSrc, p), 'utf8');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-mutreport-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

/* ------------------------------------------------------------------ *
 * 1. The prop contract
 * ------------------------------------------------------------------ */

test('Markdown reads a `text` prop and ignores children', () => {
  const src = read('components/Markdown.jsx');
  assert.match(
    src,
    /export default function Markdown\(\s*\{\s*text\s*\}\s*\)/,
    'Markdown no longer takes a single `text` prop — the call-site assertion below is now meaningless'
  );
});

test('every <Markdown> call site passes text=, and none passes children', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(clientSrc);

  const sites = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<Markdown\b[^>]*>/g)) {
      sites.push({ file: path.relative(clientSrc, file), tag: m[0] });
    }
  }

  assert.ok(sites.length > 0, 'no <Markdown> usage found — this test has lost its subject');
  for (const site of sites) {
    assert.match(
      site.tag,
      /\btext=/,
      `${site.file}: ${site.tag} does not pass text= — its content will render as an empty bubble`
    );
    assert.ok(
      site.tag.trimEnd().endsWith('/>'),
      `${site.file}: ${site.tag} is not self-closing, so it passes children Markdown never reads`
    );
  }
});

test('the mutation-report bubble specifically passes its markdown as text', () => {
  const src = read('pages/AgentChat.jsx');
  const branch = src.slice(src.indexOf("m.kind === 'mutation_report'"));
  assert.ok(branch, "the mutation_report render branch is gone");
  const tag = branch.match(/<Markdown\b[^>]*>/)?.[0];
  assert.match(tag || '', /text=\{m\.markdown\}/, 'the mutation report is not passed as text=');
});

/* ------------------------------------------------------------------ *
 * 2. The report itself renders to something
 * ------------------------------------------------------------------ */

const helper = path.resolve(here, '../../client/test/renderMarkdown.js');
const clientDeps = path.resolve(here, '../../client/node_modules/react-markdown');
const missing = fs.existsSync(clientDeps)
  ? null
  : 'client dependencies are not installed — run `npm install --prefix client`';
let renderMarkdown = null;
if (!missing) ({ renderMarkdown } = await import(pathToFileURL(helper).href));
const opts = missing ? { skip: missing } : {};

const ENTRIES = [
  {
    tool: 'create_record', table: 'item_option_new', sys_id: '2e6b0552837ec750b939cc65eeaad3ea',
    displayId: 'requested_by', status: 'applied', approval: 'approved',
    verification: { status: 'applied' },
  },
  {
    tool: 'update_record', table: 'sys_update_set', sys_id: '29b5648983be0f10b939cc65eeaad36b',
    displayId: 'AGAMYA_Scope', status: 'no-op', approval: 'approved',
    verification: { status: 'no-op', dropped: [{ field: 'application', requested: 'c44f3c6c', actual: 'global' }] },
  },
];

test('a real mutation report is non-empty markdown', () => {
  const markdown = renderMutationReport(ENTRIES);
  assert.ok(markdown.trim().length > 0, 'the ledger produced an empty report');
  assert.match(markdown, /What changed on the instance this turn/);
});

test('a real mutation report renders to non-empty HTML through the shipped pipeline', opts, () => {
  const html = renderMarkdown(renderMutationReport(ENTRIES));
  // The defect rendered `<div class="md"></div>` — structure with no content.
  assert.ok(html.replace(/<[^>]*>/g, '').trim().length > 0, 'the report rendered to no visible text');
  assert.match(html, /AGAMYA_Scope/);
  assert.match(html, /The platform discarded this write/);
  assert.match(html, /<li>/, 'the per-mutation lines did not render as list items');
});

test('rendering nothing is what the defect looked like — pinned so it stays distinguishable', opts, () => {
  const html = renderMarkdown('');
  assert.equal(html.replace(/<[^>]*>/g, '').trim(), '');
});
