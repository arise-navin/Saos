/**
 * F4 — the empty-completion dump survives the session that produced it.
 *
 *   node --test server/test/
 *
 * THE DEFECT. `openaiCompat.js` already dumps everything it knows about a
 * request that came back empty — the message shapes, the token estimate, the
 * provider's verbatim body. It dumps it to STDERR. In the session behind this
 * branch that block was the one thing that would have answered "was the
 * request degenerate, or was the upstream unlucky?", and by the time anyone
 * looked it was gone, so the question had to be re-asked of SQLite by hand.
 * A diagnostic that only hits stderr does not exist.
 *
 * Two halves:
 *
 *   1. the adapter attaches the dump to the error it throws, including
 *      `roleSequence` — the field the live incident actually needed and the
 *      log did not have, because it is what says whether a user turn was in
 *      the request at all;
 *   2. that dump round-trips through `tool_events`, and — the reason that
 *      table and not `messages` — survives the compaction that is usually
 *      implicated in whatever it is recording.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { chat } from '../src/agent/providers/openaiCompat.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-dump-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { createSession, appendMessage, recordToolEvent, loadToolEvents, loadHistory } =
  await import('../src/memory/sessions.js');
const { compactIfNeeded } = await import('../src/memory/compaction.js');

const HISTORY = [
  { role: 'user', text: 'create or update the remaining shared variables' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'query_records', input: { table: 'item_option_new' } }] },
  { role: 'tool', results: [{ id: 'c1', name: 'query_records', output: '[]' }] },
];

/** A 200 that carries no content — the exact shape Ollama answered with. */
function alwaysEmpty(finishReason, raw = null) {
  const state = { calls: 0 };
  globalThis.fetch = async (_url, init) => {
    if (JSON.parse(init.body).max_tokens === 1) return { ok: true, status: 200, json: async () => ({}) };
    state.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => raw || { choices: [{ message: { content: '' }, finish_reason: finishReason }] },
    };
  };
  return state;
}

/* ------------------------------------------------------------------ *
 * 1. The adapter attaches it
 * ------------------------------------------------------------------ */

test('a "load" empty completion carries its dump on the error', async () => {
  alwaysEmpty('load');
  await assert.rejects(
    () => chat({ provider: 'ollama', model: 'gpt-oss:120b-cloud', system: 'sys', history: HISTORY, tools: [] }),
    (err) => {
      assert.ok(err.guardDump, 'the error arrived with nothing attached — the dump is stderr-only again');
      assert.equal(err.guardDump.finishReason, 'load');
      assert.equal(err.guardDump.roleSequence, 'system>user>assistant>tool');
      assert.ok(err.guardDump.shapes.length > 0);
      assert.equal(err.guardDump.outboundMessages, 4);
      assert.ok(err.guardDump.estRequestTokens > 0);
      assert.equal(err.guardDump.model, 'gpt-oss:120b-cloud');
      return true;
    }
  );
});

test('roleSequence is what says a user turn was missing', async () => {
  // The live failure, in one field. `system>assistant>tool>...` with no `user`
  // is the whole diagnosis, and no other logged value showed it. Driven through
  // the terminal `length` reason rather than `load` purely so the test does not
  // sit through the cold-start backoff to assert a string.
  alwaysEmpty('length');
  const userless = HISTORY.slice(1);
  await assert.rejects(
    () => chat({ provider: 'ollama', system: 'sys', history: [{ role: 'user', text: 'go' }, ...userless], tools: [] }),
    (err) => {
      assert.match(err.guardDump.roleSequence, /^system>user>/);
      return true;
    }
  );
});

test('a "length" empty completion is terminal and still carries its dump', async () => {
  // Not retryable, but every bit as worth keeping: it names a budget that has
  // to be raised.
  const state = alwaysEmpty('length');
  await assert.rejects(
    () => chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [], maxTokens: 4096 }),
    (err) => {
      assert.equal(err.guardDump.finishReason, 'length');
      assert.equal(err.guardDump.maxTokens, 4096);
      return true;
    }
  );
  assert.equal(state.calls, 1, 'still not retried');
});

test('the raw response is captured, and bounded', async () => {
  // A failure path is the worst place for an unbounded write.
  const huge = { choices: [{ message: { content: '' }, finish_reason: 'length' }], padding: 'p'.repeat(80_000) };
  alwaysEmpty('length', huge);
  await assert.rejects(
    () => chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [] }),
    (err) => {
      assert.equal(typeof err.guardDump.rawResponse, 'string');
      assert.ok(err.guardDump.rawResponse.includes('"finish_reason":"length"'), 'the useful part is at the front');
      assert.equal(err.guardDump.rawResponse.length, 16_384, 'a raw body must not be written unbounded');
      return true;
    }
  );
});

/* ------------------------------------------------------------------ *
 * 2. It lands, and it stays
 * ------------------------------------------------------------------ */

test('the dump lands as one guard row with roleSequence populated', async () => {
  const id = 'dump-lands';
  createSession({ id });
  alwaysEmpty('load');

  let dump = null;
  await chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [] })
    .catch((err) => { dump = err.guardDump; });
  assert.ok(dump, 'nothing to persist — the adapter half regressed');

  // The write the orchestrator's chatTurn catch makes, verbatim.
  recordToolEvent(id, {
    kind: 'guard',
    name: 'f4_empty_completion',
    payload: { iteration: 7, ...dump },
    result: 'ollama returned an empty completion (finish reason: load) (after 3 attempts)',
    resultStatus: 'empty-completion',
    mutating: false,
    approval: null,
  });

  const guards = loadToolEvents(id).filter((e) => e.kind === 'guard');
  assert.equal(guards.length, 1, 'exactly one row per failed call');
  assert.equal(guards[0].name, 'f4_empty_completion');
  assert.equal(guards[0].result_status, 'empty-completion');
  assert.equal(guards[0].mutating, false);
  // The payload survives the JSON round-trip through SQLite intact.
  assert.equal(guards[0].payload.roleSequence, 'system>user>assistant>tool');
  assert.equal(guards[0].payload.finishReason, 'load');
  assert.equal(guards[0].payload.iteration, 7);
  assert.match(guards[0].result, /after 3 attempts/);
});

test('the guard row survives the compaction it is usually about', async () => {
  // This is why tool_events and not messages. A dump folded away by the same
  // compaction that caused the failure would be worse than useless.
  const id = 'dump-survives';
  createSession({ id });
  for (let i = 0; i < 30; i++) appendMessage(id, { role: 'user', text: `turn ${i} ` + 'z'.repeat(2000) });
  recordToolEvent(id, {
    kind: 'guard', name: 'f4_empty_completion',
    payload: { roleSequence: 'system>assistant>tool>assistant>tool' },
    resultStatus: 'empty-completion', mutating: false, approval: null,
  });

  const res = await compactIfNeeded(id, {
    budget: 2_000,
    summarize: async () => 'ARTIFACTS BUILT OR CHANGED\n- none\nRECORDS ONLY LOOKED AT\n- none\nDECISIONS\n- none\nOPEN THREADS\n- none',
  });
  assert.equal(res.compacted, true, 'the fixture must actually compact for this to prove anything');
  assert.ok(loadHistory(id).length < 30, 'messages were folded');

  const guards = loadToolEvents(id).filter((e) => e.kind === 'guard');
  assert.equal(guards.length, 1);
  assert.equal(guards[0].payload.roleSequence, 'system>assistant>tool>assistant>tool');
});
