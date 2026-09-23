/**
 * F3 — the outbound conversation must contain a user message.
 *
 *   node --test server/test/
 *
 * Every other guard in the degenerate-request family checks for a shape that
 * must not be PRESENT: a blank assistant turn, an orphaned tool result, a null
 * content. This one checks for a row that must not be MISSING, and it exists
 * because the missing row is invisible from the wire: a request of
 * `[system, assistant(tool_calls), tool, ...]` is perfectly well-formed, and
 * Ollama answers it with a 200, `finish_reason: "load"` and no content. That
 * read as a broken model for six attempts.
 *
 * Two properties are pinned here, and the second is the one that matters:
 *
 *   - it is REFUSED, not repaired. Injecting a synthetic user message would
 *     make the send succeed on a conversation nobody had, and the turn would
 *     carry on into the approval gate with mutations;
 *   - it is TERMINAL. Not one HTTP attempt is made, so the failure cannot be
 *     mistaken for the flaky upstream and cannot be turned into three
 *     identical retries the way the original defect was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { chat, toOpenAiMessages } from '../src/agent/providers/openaiCompat.js';
import { sanitizeHistory } from '../src/memory/sanitize.js';

const OK_BODY = { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };

/** Counts every HTTP attempt, warm-ups included — none should happen at all. */
function countingFetch() {
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    state.calls += 1;
    return { ok: true, status: 200, json: async () => OK_BODY };
  };
  return state;
}

/* The shape the live defect produced: a fold that took the user row with it. */
const USERLESS = [
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'get_table_schema', input: { table: 'sc_cat_item' } }] },
  { role: 'tool', results: [{ id: 'c1', name: 'get_table_schema', output: '{"table":"sc_cat_item"}' }] },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c2', name: 'create_record', input: { table: 'item_option_new' } }] },
  { role: 'tool', results: [{ id: 'c2', name: 'create_record', output: '{"sys_id":"abc"}' }] },
];

const HEALTHY = [
  { role: 'user', text: 'create or update the remaining shared variables' },
  ...USERLESS,
];

/* ------------------------------------------------------------------ *
 * The translator reports it
 * ------------------------------------------------------------------ */

test('toOpenAiMessages reports whether a user turn survived', () => {
  assert.equal(toOpenAiMessages('sys', HEALTHY).hasUserTurn, true);
  assert.equal(toOpenAiMessages('sys', USERLESS).hasUserTurn, false);
  // The system message is not a user turn, and an empty history is not one either.
  assert.equal(toOpenAiMessages('sys', []).hasUserTurn, false);
});

test('a user turn dropped for being blank does not count as present', () => {
  // The sanitizer drops a whitespace-only user row, so "there was a user
  // message in the history" and "one went out" are different facts.
  const { hasUserTurn, repairs } = toOpenAiMessages('sys', [{ role: 'user', text: '   ' }, ...USERLESS]);
  assert.equal(hasUserTurn, false);
  assert.ok(repairs.some((r) => /blank user message/.test(r)));
});

test('sanitizeHistory carries hasUserTurn alongside dropped and reasons', () => {
  const clean = sanitizeHistory(HEALTHY);
  assert.equal(clean.hasUserTurn, true);
  assert.equal(clean.dropped, 0, 'a healthy history is still passed through untouched');

  const orphaned = sanitizeHistory(USERLESS);
  assert.equal(orphaned.hasUserTurn, false);
  assert.deepEqual(Object.keys(orphaned).sort(), ['dropped', 'hasUserTurn', 'history', 'reasons']);
});

/* ------------------------------------------------------------------ *
 * The adapter refuses it, once
 * ------------------------------------------------------------------ */

test('a user-less conversation is refused before any request is made', async () => {
  const state = countingFetch();
  await assert.rejects(
    () => chat({ provider: 'ollama', model: 'gpt-oss:120b-cloud', system: 's', history: USERLESS, tools: [] }),
    (err) => {
      assert.match(err.message, /contains no user message — refusing to send/);
      assert.match(err.message, /compaction\/sanitation must preserve the active user turn/);
      return true;
    }
  );
  assert.equal(state.calls, 0, 'nothing may go to the upstream on a conversation this broken');
});

test('the refusal is terminal — it is never retried', async () => {
  const state = countingFetch();
  await assert.rejects(() => chat({ provider: 'ollama', system: 's', history: USERLESS, tools: [] }), (err) => {
    // Not marked retryable, so `withRetry` never decorates it with a count and
    // the UI never offers a Retry that would replay the same corrupt history.
    assert.equal(err.retryable, undefined);
    assert.doesNotMatch(err.message, /after \d+ attempts/);
    return true;
  });
  assert.equal(state.calls, 0);
});

test('nothing is invented to make the send succeed', async () => {
  // The tempting repair — splice in a synthetic user message — would let a turn
  // built on corrupt state proceed all the way to the approval gate.
  const state = countingFetch();
  await assert.rejects(() => chat({ provider: 'ollama', system: 's', history: USERLESS, tools: [] }));
  assert.equal(state.calls, 0, 'a repaired request would have been sent; a refused one is not');
});

test('a healthy conversation is unaffected and goes out exactly once', async () => {
  const state = countingFetch();
  const res = await chat({ provider: 'ollama', system: 's', history: HEALTHY, tools: [] });
  assert.equal(res.text, 'done');
  assert.equal(state.calls, 1, 'the guard must cost a healthy turn nothing');
});
