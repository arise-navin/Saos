/**
 * Two regressions, one bug report.
 *
 *   node --test server/test/
 *
 * A session could brick itself permanently. One assistant turn with no text
 * and no tool calls got stored, and from then on EVERY later turn in that
 * conversation failed at the wire with `invalid message content type: <nil>`
 * — an error naming neither the session nor the message. The user could only
 * see a red box; the terminal said nothing at all.
 *
 * Measured against gpt-oss:120b-cloud through Ollama's /v1 shim, because the
 * first hypothesis (that a null content beside tool_calls was the problem) was
 * WRONG and only the probe showed it:
 *
 *   assistant content:null, WITH tool_calls   200
 *   assistant content:null, NO tool_calls     400  invalid message content type
 *   assistant content:'',   NO tool_calls     200
 *
 * So both halves are pinned here: the wire never emits null (which repairs
 * histories that already contain the poison message), and the log never emits
 * a secret (because the fix for "we could not see it" is a log, and a log is
 * how a stored password escapes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { chat } from '../src/agent/providers/openaiCompat.js';
import { redact } from '../src/logging.js';

/** Capture the request body instead of sending it. */
function captureBody(response = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) {
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = String(url);
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => response };
  };
  return seen;
}

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

const POISONED_HISTORY = [
  { role: 'user', text: 'create a subflow' },
  // The exact shape found at seq 53 of the broken session: the model returned
  // nothing at all, and it was stored.
  { role: 'assistant', text: '', toolCalls: [] },
  { role: 'user', text: 'is it done?' },
];

test('a blank assistant turn is DROPPED, not sent as an empty string', async () => {
  /*
   * The contract tightened in D-7, and the earlier one is why.
   *
   * §29 coerced a null content to '' to stop the 400 that bricked a session.
   * That worked, and it also made the degenerate message SENDABLE — so the row
   * kept going out, turn after turn, contributing nothing but a slot. The
   * stronger rule: a message with no content and no tool calls is not a
   * message, and does not reach the wire at all.
   */
  const seen = captureBody();
  await chat({ provider: 'ollama', system: 'sys', history: POISONED_HISTORY, tools: [] });

  const assistants = seen.body.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 0, 'the blank assistant turn should have been dropped entirely');
  // The turns either side must survive — repairing the request must not cost
  // the conversation.
  assert.deepEqual(
    seen.body.messages.map((m) => m.role),
    ['system', 'user', 'user'],
    'dropping the blank turn must not take the real ones with it'
  );
});

test('a whitespace-only assistant turn is blank too', async () => {
  // The exact defect: a bare newline is truthy, so it passed every guard,
  // rendered as an empty bubble, and rode along in every later request.
  const seen = captureBody();
  await chat({
    provider: 'ollama',
    system: 'sys',
    history: [
      { role: 'user', text: 'go' },
      // A real newline and spaces — a template literal, so no escape can be
      // helpfully normalised away by a tool between here and the file.
      { role: 'assistant', text: `
  `, toolCalls: [] },
      { role: 'user', text: 'still there?' },
    ],
    tools: [],
  });
  assert.equal(seen.body.messages.filter((m) => m.role === 'assistant').length, 0);
});

test('an orphaned tool result never reaches the wire', async () => {
  // The shape a half-folded compaction leaves behind: results whose tool_call
  // was folded into a digest. The wire format rejects these outright.
  const seen = captureBody();
  await chat({
    provider: 'ollama',
    system: 'sys',
    history: [
      { role: 'user', text: 'go' },
      { role: 'tool', results: [{ id: 'vanished', name: 'query_records', output: '[]' }] },
    ],
    tools: [],
  });
  assert.equal(seen.body.messages.filter((m) => m.role === 'tool').length, 0);
});

test('no message of any role is ever sent with a null or missing content', async () => {
  const seen = captureBody();
  await chat({
    provider: 'ollama',
    system: 'sys',
    history: [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'query_records', input: { table: 'incident' } }] },
      // A tool result that never got an output — the other way a null reaches
      // the wire, and the one the first probe reproduced.
      { role: 'tool', results: [{ id: 'c1', name: 'query_records' }] },
      { role: 'user', text: 'is it done?' },
    ],
    tools: [],
  });

  for (const m of seen.body.messages) {
    assert.equal(typeof m.content, 'string', `${m.role} sent content of type ${typeof m.content}`);
  }
});

test('tool calls still survive the coercion', async () => {
  const seen = captureBody();
  await chat({
    provider: 'ollama',
    system: 'sys',
    history: [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'query_records', input: { table: 'incident' } }] },
      { role: 'tool', results: [{ id: 'c1', output: '[]' }] },
    ],
    tools: [],
  });
  const assistant = seen.body.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, 'query_records');
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).table, 'incident');
  // Emptying the content must not orphan the tool result that answers it.
  const toolMsg = seen.body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
});

/* ------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------ */

test('secrets never reach the log, at any depth', () => {
  const out = redact({
    connection: { instanceUrl: 'https://dev428633.service-now.com', username: 'admin', password: 'hunter2!' },
    llm: { provider: 'ollama', apiKey: 'sk-live-abcdef' },
    nested: { a: { b: { client_secret: 'shh' } } },
    headers: { Authorization: 'Bearer abc' },
  });
  const flat = JSON.stringify(out);
  for (const secret of ['hunter2!', 'sk-live-abcdef', 'shh', 'Bearer abc']) {
    assert.ok(!flat.includes(secret), `${secret} leaked into the log`);
  }
  // The useful, non-secret context has to survive, or redaction just breaks logging.
  assert.equal(out.connection.instanceUrl, 'https://dev428633.service-now.com');
  assert.equal(out.connection.username, 'admin');
  assert.equal(out.llm.provider, 'ollama');
});

test('an absent secret is not reported as redacted', () => {
  // "<redacted>" against an empty field would read as "a password is stored"
  // on a connection that has none.
  assert.equal(redact({ password: '' }).password, '');
  assert.equal(redact({ password: null }).password, null);
});

test('redaction terminates on deep and long values', () => {
  let deep = { v: 'end' };
  for (let i = 0; i < 12; i++) deep = { next: deep };
  assert.doesNotThrow(() => JSON.stringify(redact(deep)));
  assert.equal(redact({ s: 'x'.repeat(1000) }).s.length, 301);   // 300 + the ellipsis
  assert.equal(redact({ list: Array.from({ length: 90 }, (_, i) => i) }).list.length, 20);
});
