/**
 * D-7 — a degenerate request must be structurally impossible.
 *
 *   node --test server/test/
 *
 * The incident: a 19-requirement flow spec produced, in ONE turn, three
 * compaction digests, several BLANK assistant rows between them, and then
 * `ollama returned an empty completion (finish reason: load) (after 3
 * attempts)`. The context window was never the problem — it was read off the
 * daemon at 131,072 tokens.
 *
 * The blank rows were the tell, and the cause was one character. §29's guard
 * was `!res.text && !res.toolCalls?.length`, which is truthiness — and a bare
 * newline is truthy. A whitespace-only completion, which this model emits when
 * hidden reasoning eats the token budget, walked past the guard, was stored as a real
 * assistant turn, rendered as an empty bubble, and then rode along in every
 * outbound request for the rest of the session.
 *
 * These tests pin the three layers that now make that shape unsendable, and
 * they pin them separately on purpose: any one of the three could be removed by
 * a well-meaning refactor, and the other two would hide it until a live session
 * found it again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHistory, isBlankTurn, isBlankText } from '../src/memory/sanitize.js';
import { toOpenAiMessages, describeOutbound } from '../src/agent/providers/openaiCompat.js';

/* ------------------------------------------------------------------ *
 * What counts as nothing
 * ------------------------------------------------------------------ */

test('whitespace is not content', () => {
  // The whole defect in one assertion. Every one of these was truthy, and
  // therefore a real assistant turn, before D-7.
  for (const blank of ['', ' ', '\n', '\n\n  \t', '   \r\n   ']) {
    assert.equal(isBlankText(blank), true, `${JSON.stringify(blank)} should be blank`);
  }
  assert.equal(isBlankText('ok'), false);
  assert.equal(isBlankText(' x '), false);
});

test('an assistant turn with tool calls and no prose is NOT blank', () => {
  // The commonest shape this model produces. Treating it as degenerate would
  // delete every tool-calling turn in the session — a far worse bug than the
  // one being fixed.
  assert.equal(isBlankTurn({ role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'q', input: {} }] }), false);
  assert.equal(isBlankTurn({ role: 'assistant', text: '\n', toolCalls: [] }), true);
  assert.equal(isBlankTurn({ role: 'assistant', text: 'done' }), false);
  // Only assistant turns are in scope; a user turn is the caller's business.
  assert.equal(isBlankTurn({ role: 'user', text: '' }), false);
});

/* ------------------------------------------------------------------ *
 * Layer 2 — the sanitizer, which is also the migration
 * ------------------------------------------------------------------ */

test('blank turns already persisted in SQLite are repaired on read', () => {
  // There is no migration script, deliberately: sessions are sanitized on
  // every load, so a session written before this guard is repaired the next
  // time it is used rather than the next time someone remembers to run a
  // script. The rows stay on disk; they simply never reach the wire.
  const legacy = [
    { role: 'user', text: 'create a subflow' },
    { role: 'assistant', text: '', toolCalls: [] },      // the seq-53 shape
    { role: 'assistant', text: '\n' },                    // the whitespace shape
    { role: 'user', text: 'is it done?' },
  ];
  const { history, dropped, reasons } = sanitizeHistory(legacy);
  assert.equal(dropped, 2);
  assert.deepEqual(history.map((m) => m.role), ['user', 'user']);
  assert.ok(reasons.every((r) => /blank assistant turn/.test(r)));
});

test('a healthy session is passed through untouched', () => {
  // This runs on every iteration of every turn. If it rewrote healthy history
  // it would be a liability, not a guard.
  const healthy = [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: 'looking', toolCalls: [{ id: 'c1', name: 'q', input: {} }] },
    { role: 'tool', results: [{ id: 'c1', name: 'q', output: '[]' }] },
    { role: 'assistant', text: 'nothing found' },
  ];
  const { history, dropped } = sanitizeHistory(healthy);
  assert.equal(dropped, 0);
  assert.deepEqual(history, healthy);
});

test('an orphaned tool result is dropped, and its siblings are not', () => {
  const { history, dropped } = sanitizeHistory([
    { role: 'user', text: 'go' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'good', name: 'q', input: {} }] },
    { role: 'tool', results: [{ id: 'good', output: 'kept' }, { id: 'vanished', output: 'dropped' }] },
  ]);
  assert.equal(dropped, 0, 'the tool message survives — only the orphaned result inside it goes');
  const results = history.find((m) => m.role === 'tool').results;
  assert.deepEqual(results.map((r) => r.id), ['good']);
});

test('a tool message left with nothing in it is removed entirely', () => {
  const { history } = sanitizeHistory([
    { role: 'user', text: 'go' },
    { role: 'tool', results: [{ id: 'vanished', output: 'x' }] },
  ]);
  assert.deepEqual(history.map((m) => m.role), ['user']);
});

/* ------------------------------------------------------------------ *
 * Layer 3 — the adapter, the backstop
 * ------------------------------------------------------------------ */

test('the adapter refuses to serialise a blank assistant turn', () => {
  // Belt and braces on purpose. The sanitizer runs upstream, but by the time a
  // request is being built, a degenerate message must be impossible rather
  // than merely unlikely — that is the difference between a guard and a habit.
  const { messages, repairs } = toOpenAiMessages('sys', [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: '   ', toolCalls: [] },
    { role: 'user', text: 'well?' },
  ]);
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 0);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /blank assistant turn/);
});

test('every repair is reported, because a silent one is how this came back', () => {
  const { repairs } = toOpenAiMessages('sys', [
    { role: 'assistant', text: '', toolCalls: [] },
    { role: 'tool', results: [{ id: 'nope', output: 'x' }] },
    { role: 'user', text: '  ' },
  ]);
  assert.equal(repairs.length, 3, 'three unsendable shapes, three reports');
});

test('no message of any role survives with a non-string content', () => {
  const { messages } = toOpenAiMessages('sys', [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: null, toolCalls: [{ id: 'c1', name: 'q', input: { a: 1 } }] },
    { role: 'tool', results: [{ id: 'c1', name: 'q' }] },   // no output at all
  ]);
  for (const m of messages) {
    assert.equal(typeof m.content, 'string', `${m.role} carried ${typeof m.content}`);
  }
  // An assistant with tool_calls and empty content is legal and measured to
  // return 200 — it must survive.
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.content, '');
  assert.equal(assistant.tool_calls.length, 1);
  // An output-less tool result says so rather than sending a blank.
  assert.match(messages.find((m) => m.role === 'tool').content, /no output/);
});

/* ------------------------------------------------------------------ *
 * The diagnostics
 * ------------------------------------------------------------------ */

test('the outbound description flags blanks and counts the request', () => {
  // This is what gets logged when a completion comes back empty. Its whole job
  // is to answer "was the request degenerate, or was the upstream unlucky?" —
  // the question the old error message could not answer.
  const desc = describeOutbound([
    { role: 'system', content: 'x'.repeat(70) },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
  ]);
  assert.equal(desc.count, 4);
  assert.equal(desc.blanks, 1, 'the bare empty assistant is blank; the one with tool calls is not');
  assert.ok(desc.estTokens > 0);
  assert.ok(desc.shapes.some((s) => s.includes('BLANK')));
  assert.ok(desc.shapes.some((s) => s.includes('calls=1')));
});
