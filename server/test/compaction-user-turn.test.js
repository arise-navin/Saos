/**
 * F2 — compaction must never fold the active turn's user message.
 *
 *   node --test server/test/
 *
 * THE DEFECT, from the session that produced this branch. A long tool loop ran
 * thirteen assistant/tool rows past its opening user message. Compaction fired
 * mid-turn on iteration seven, `rows.length - KEEP_LAST_TURNS` landed AFTER
 * that message, and the fold deleted it. What went to the model was
 * `[system, assistant(tool_calls), tool, ...]` — a conversation with nothing in
 * it asking for anything. Ollama answered 200 with `finish_reason: "load"` and
 * empty content, six times over, because the adapter's retry and the UI's
 * Retry both re-send the same history.
 *
 * The fix is one clamp: the cut never crosses the newest `role === 'user'` row.
 * These tests pin both halves of that — the fold still happens and the user row
 * survives, and where the clamp leaves nothing worth folding the fold is
 * SKIPPED with a reason rather than done anyway or done silently.
 *
 * Entirely offline: scratch SQLite, injected summariser, no LLM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-cut-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { createSession, appendMessage, loadHistory, loadDigests } =
  await import('../src/memory/sessions.js');
const { compactIfNeeded, estimateTokens, KEEP_LAST_TURNS } =
  await import('../src/memory/compaction.js');

const DIGEST = [
  'ARTIFACTS BUILT OR CHANGED', '- none',
  'RECORDS ONLY LOOKED AT', '- none',
  'DECISIONS', '- none',
  'OPEN THREADS', '- none',
].join('\n');

const neverCalled = () => { throw new Error('the summariser must not be called on a skipped fold'); };

/** One assistant(tool_calls) + tool round-trip, sized by `pad`. */
function appendRoundTrip(id, n, pad) {
  appendMessage(id, {
    role: 'assistant', text: '',
    toolCalls: [{ id: `call_${n}`, name: 'query_records', input: { table: 'item_option_new' } }],
  });
  appendMessage(id, {
    role: 'tool',
    results: [{ id: `call_${n}`, name: 'query_records', output: 'x'.repeat(pad), isError: false }],
  });
}

const newestUserIndex = (history) =>
  history.reduce((acc, m, i) => (m?.role === 'user' ? i : acc), -1);

/* ================================================================== *
 * The fold still fires, and the user row survives it
 * ================================================================== */

test('F2: a mid-turn fold keeps the active turn\'s user message', async () => {
  const id = 'cut-midturn';
  createSession({ id });

  // Twenty rows of settled earlier turns — the span that SHOULD be folded.
  for (let i = 0; i < 10; i++) {
    appendMessage(id, { role: 'user', text: `earlier turn ${i} ` + 'e'.repeat(1200) });
    appendMessage(id, { role: 'assistant', text: `answered ${i} ` + 'a'.repeat(1200) });
  }
  // The active turn: its user message, then a long tool loop past it.
  appendMessage(id, { role: 'user', text: 'ACTIVE TURN: create or update the remaining shared variables' });
  const userIndex = loadHistory(id).length - 1;
  for (let n = 0; n < 7; n++) appendRoundTrip(id, n, 1600);

  const history = loadHistory(id);
  assert.equal(newestUserIndex(history), userIndex);
  // The precondition that made the live session fail: the row-count cut lands
  // AFTER the user message, so without the clamp the fold deletes it.
  assert.ok(
    userIndex < history.length - KEEP_LAST_TURNS,
    'fixture does not reproduce the defect — the user row is inside the kept window anyway'
  );

  const budget = 2_000;
  assert.ok(estimateTokens(history) > budget, 'fixture must be over budget');

  const res = await compactIfNeeded(id, { budget, summarize: async () => DIGEST });

  assert.equal(res.compacted, true, 'the clamp must not stop compaction happening at all');
  assert.equal(res.entries, userIndex, 'the fold should stop exactly at the user row');
  assert.equal(loadDigests(id).length, 1);

  const kept = loadHistory(id);
  const survivor = kept.find((m) => m.role === 'user');
  assert.ok(survivor, 'the active turn\'s user message was folded away — this is the defect');
  assert.match(survivor.text, /ACTIVE TURN/);
  assert.equal(kept[0].role, 'user', 'the fold should land on the turn boundary, not mid-pair');
  assert.ok(kept.length > KEEP_LAST_TURNS, 'the clamp keeps more than the row count would have');
});

test('F2: the clamp is a floor, not a rewrite — a fold that already respects it is unchanged', async () => {
  const id = 'cut-unclamped';
  createSession({ id });
  // User rows throughout, so the newest one sits inside the kept window and the
  // clamp has nothing to do. This is the ordinary session shape.
  for (let i = 0; i < 30; i++) {
    appendMessage(id, { role: 'user', text: `turn ${i} ` + 'u'.repeat(2000) });
  }

  const history = loadHistory(id);
  const expectedCut = history.length - KEEP_LAST_TURNS;
  assert.ok(newestUserIndex(history) > expectedCut, 'fixture must not need the clamp');

  const res = await compactIfNeeded(id, { budget: 2_000, summarize: async () => DIGEST });
  assert.equal(res.compacted, true);
  assert.equal(res.entries, expectedCut, 'an unclamped fold must still cut on the row count');
  assert.equal(loadHistory(id).length, KEEP_LAST_TURNS);
});

/* ================================================================== *
 * Where the clamp leaves nothing worth folding, the fold is SKIPPED
 * ================================================================== */

test('F2: clamping to a pointless fold skips it, and says so, rather than folding anyway', async () => {
  const id = 'cut-pointless';
  createSession({ id });

  // Three small settled rows, then the active turn and a long, heavy tool loop.
  // The clamp pulls the cut back onto those three rows, which are not worth a
  // digest — so the existing minimum-gain floor takes over.
  for (let i = 0; i < 3; i++) appendMessage(id, { role: 'assistant', text: `small ${i}` });
  appendMessage(id, { role: 'user', text: 'ACTIVE TURN: build the catalog item' });
  for (let n = 0; n < 7; n++) appendRoundTrip(id, n, 6000);

  const history = loadHistory(id);
  const budget = 2_000;
  assert.ok(estimateTokens(history) > budget, 'fixture must be over budget');
  assert.ok(newestUserIndex(history) < history.length - KEEP_LAST_TURNS, 'fixture must trigger the clamp');

  const res = await compactIfNeeded(id, { budget, summarize: neverCalled });

  assert.equal(res.compacted, false, 'a pointless fold must not be paid for');
  assert.equal(res.skipped, 'min-gain');
  assert.match(res.warning, /Skipped compaction/);
  assert.equal(loadDigests(id).length, 0, 'nothing was summarised');
  assert.equal(loadHistory(id).length, history.length, 'and not one row was discarded');
});

test('F2: when everything older than the user turn is already folded, the skip has a reason', async () => {
  const id = 'cut-exhausted';
  createSession({ id });

  // The active turn opens the surviving history — an earlier fold already took
  // everything before it. There is nothing left to compact that is not the user
  // message itself, and the honest answer is to stay over budget and say so.
  appendMessage(id, { role: 'user', text: 'ACTIVE TURN: add the remaining variables' });
  for (let n = 0; n < 7; n++) appendRoundTrip(id, n, 6000);

  const history = loadHistory(id);
  const budget = 2_000;
  assert.ok(estimateTokens(history) > budget, 'fixture must be over budget');
  assert.equal(newestUserIndex(history), 0);

  const res = await compactIfNeeded(id, { budget, summarize: neverCalled });

  assert.equal(res.compacted, false);
  assert.equal(res.skipped, 'user-turn-clamp');
  assert.match(res.warning, /nothing left to compact/);
  assert.equal(loadHistory(id).length, history.length);
  assert.equal(loadDigests(id).length, 0);
});
