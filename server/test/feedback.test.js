/**
 * D-2 regression proof — the feedback seams.
 *
 *   node --test server/test/
 *
 * Both modules under test are dependency-free plain JS, which is the whole
 * reason the toast store is a store and the confirm seam is a registry: the
 * parts that carry a rule worth keeping can be exercised without a browser,
 * and only the rendering sits behind JSX.
 *
 * The rules being pinned here are the ones that would fail quietly:
 *
 *  - a toast raised before the host mounts must be QUEUED, not dropped. React
 *    runs effects child-first, so a page toasting from its own mount effect
 *    fires before the app-root host has subscribed.
 *  - `confirmDestructive` with no dialog mounted must THROW. Falling back to
 *    window.confirm would silently restore the thing D-2 removed, on the one
 *    code path where being wrong deletes a record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = (rel) => pathToFileURL(path.resolve(here, '../../client/src/components', rel)).href;

const { toast, subscribeToasts, dismissToast, _resetToasts } = await import(mod('toast.js'));
const confirmMod = await import(mod('confirm.js'));
const { confirmDestructive, confirmAction, promptFor, registerConfirmHost, CONSEQUENCE } = confirmMod;

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

test('a toast raised before any host subscribes is queued, not dropped', () => {
  _resetToasts();
  toast.success('Connection saved.');

  // The host mounts afterwards — this is the real ordering, not a contrivance.
  let seen = null;
  const off = subscribeToasts((items) => { seen = items; });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'Connection saved.');
  assert.equal(seen[0].level, 'success');
  off();
});

test('subscribers see every subsequent raise, and dismissal removes exactly one', () => {
  _resetToasts();
  const frames = [];
  const off = subscribeToasts((items) => frames.push(items));

  toast.info('Disconnected.');
  toast.error('Request failed (403)');
  assert.equal(frames.at(-1).length, 2);

  dismissToast(frames.at(-1)[0].id);
  const left = frames.at(-1);
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'Request failed (403)');

  // Dismissing something already gone must not re-notify — a no-op that
  // still emitted would re-render the stack on every stray timer.
  const before = frames.length;
  dismissToast('nope');
  assert.equal(frames.length, before);
  off();
});

test('errors linger longer than successes, and empty text raises nothing', () => {
  _resetToasts();
  let items = [];
  const off = subscribeToasts((x) => { items = x; });

  toast.success('ok');
  toast.error('bad');
  const [ok, bad] = items;
  assert.ok(bad.ms > ok.ms, 'an error must stay readable longer than a success');

  const before = items.length;
  toast.info('   ');
  toast.success('');
  assert.equal(items.length, before, 'blank messages must not open an empty toast');
  off();
});

test('an Error object is accepted where a string is, so .catch(toast.error) works', () => {
  _resetToasts();
  let items = [];
  const off = subscribeToasts((x) => { items = x; });
  toast.error(new Error('sys_security_acl is not readable'));
  assert.equal(items[0].text, 'sys_security_acl is not readable');
  off();
});

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

test('a destructive confirm with no dialog mounted throws instead of falling back', () => {
  assert.throws(
    () => confirmDestructive({ action: 'Delete variable', subject: 'justification' }),
    /No confirmation dialog is mounted/
  );
});

test('every call routes through the single registered host, carrying the exact target', async () => {
  const seen = [];
  const off = registerConfirmHost((req) => { seen.push(req); return Promise.resolve(true); });

  await confirmDestructive({
    action: 'Delete variable',
    subject: 'justification',
    sysId: '8b3ae7fe1b2c4610a1b2c3d4e5f60789',
    detail: CONSEQUENCE.variable,
  });
  assert.equal(seen[0].kind, 'confirm');
  assert.equal(seen[0].danger, true);
  assert.equal(seen[0].sysId, '8b3ae7fe1b2c4610a1b2c3d4e5f60789');
  // The label alone is not enough to decide with: names are not unique here.
  assert.ok(seen[0].sysId, 'the dialog must be given the sys_id, not just the label');

  await confirmAction({ action: 'Create an equivalent Business Rule for', subject: 'Vendor hold' });
  assert.equal(seen[1].danger, false, 'an ordinary confirmation must not cry wolf in red');

  await promptFor({ action: 'Rename this chat', label: 'Title', value: 'old' });
  assert.equal(seen[2].kind, 'prompt');
  assert.equal(seen[2].value, 'old');
  off();
});

test('unregistering restores the loud failure, so a torn-down host cannot pass silently', () => {
  const off = registerConfirmHost(() => Promise.resolve(true));
  off();
  assert.throws(() => confirmDestructive({ action: 'Delete', subject: 'x' }), /No confirmation dialog is mounted/);
});

test('the consequence lines cover every delete the UI offers', () => {
  for (const key of [
    'variable', 'policy', 'item', 'choice', 'guide', 'producer',
    'flow', 'incident', 'sla', 'session', 'connection',
  ]) {
    assert.equal(typeof CONSEQUENCE[key], 'string', `CONSEQUENCE.${key} is missing`);
    assert.ok(CONSEQUENCE[key].length > 20, `CONSEQUENCE.${key} says nothing useful`);
  }
  // The load-bearing one: deleting a variable does not fail, it silently
  // breaks every UI policy that names it (fluent-research trap #25).
  assert.match(CONSEQUENCE.variable, /UI policy/);
});
