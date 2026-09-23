/**
 * D-1 regression proof — agent bubbles render markdown.
 *
 *   node --test server/test/
 *
 * The defect being closed is specific and was visible on the page: the model
 * writes GFM, the bubble printed the source, so `**bold**` kept its asterisks
 * and a comparison table arrived as ASCII pipes. Asserting "we added
 * react-markdown" would prove nothing — these assertions render the SAME
 * plugin list and element overrides the chat ships (client/src/components/
 * markdownConfig.js) and read the HTML back.
 *
 * The two sharp edges here were both found by running it rather than reading
 * the types: react-markdown passes an mdast `node` prop into every override,
 * which lands in the DOM as `node="[object Object]"` and makes React warn on
 * every message; and raw HTML has to STAY escaped, because this text comes
 * from a language model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.resolve(here, '../../client/test/renderMarkdown.js');
const clientDeps = path.resolve(here, '../../client/node_modules/react-markdown');

/**
 * The renderer lives in the client package, so it needs the client's
 * dependencies. Stated out loud rather than silently passing: a skip that
 * prints its reason is honest, a green tick that rendered nothing is not.
 */
const missing = fs.existsSync(clientDeps)
  ? null
  : 'client dependencies are not installed — run `npm install --prefix client`';

let renderMarkdown = null;
if (!missing) ({ renderMarkdown } = await import(pathToFileURL(helper).href));

const opts = missing ? { skip: missing } : {};

test('bold and inline code stop arriving as source text', opts, () => {
  const html = renderMarkdown('The prefix **Vendor issue:** is set by `create_flow_live`.');
  assert.match(html, /<strong>Vendor issue:<\/strong>/);
  assert.match(html, /<code>create_flow_live<\/code>/);
  assert.doesNotMatch(html, /\*\*/, 'asterisks survived — the bubble is still printing markdown source');
});

/**
 * Written because the first draft of the test above used `**Vendor issue: **`
 * — the literal from the A3 guard, trailing space and all — and it did not
 * render. That is CommonMark working as specified: a closing `**` preceded by
 * whitespace is not a closer. Pinned here so nobody later reads leftover
 * asterisks on the page as this feature being broken.
 */
test('a trailing space before the closing ** is not emphasis, by spec', opts, () => {
  const html = renderMarkdown('The prefix **Vendor issue: ** is set.');
  assert.match(html, /\*\*Vendor issue: \*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

test('an ASCII pipe table becomes a real table, inside its own scroll container', opts, () => {
  const html = renderMarkdown(
    ['| field | value |', '|---|---|', '| sys_id | 8b3ae7fe |', '| state | active |'].join('\n')
  );
  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<th>field<\/th>/);
  assert.match(html, /<td>8b3ae7fe<\/td>/);
  // The pipes are structure now, not characters on the page.
  assert.doesNotMatch(html, /\|---\|/);
});

test('fenced code, lists and headings render as elements', opts, () => {
  const html = renderMarkdown(
    ['## Result', '', '- created', '- verified', '', '```', 'sys_id: 8b3ae7fe', '```'].join('\n')
  );
  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<li>created<\/li>/);
  assert.match(html, /<pre><code>sys_id: 8b3ae7fe/);
});

test('GFM extensions that remark alone would not handle', opts, () => {
  const strike = renderMarkdown('~~dropped~~');
  assert.match(strike, /<del>dropped<\/del>/, 'remark-gfm is not in the pipeline');
  const task = renderMarkdown('- [x] deployed\n- [ ] verified');
  assert.match(task, /type="checkbox"/);
});

test('links leave in a new tab and carry no `node` attribute', opts, () => {
  const html = renderMarkdown('[the flow](https://dev442675.service-now.com/flow)');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  // react-markdown hands overrides the mdast node; spreading it renders a bogus
  // attribute and makes React warn on every single message.
  assert.doesNotMatch(html, /node="/);
});

test('raw HTML from the model stays escaped', opts, () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> and <b>bold</b>');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;img/);
});
