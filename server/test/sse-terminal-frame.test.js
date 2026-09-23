/**
 * A truncated SSE stream must be LOUD.
 *
 *   node --test server/test/
 *
 * The defect this closes was measured, not imagined. On 2026-08-24 a chat turn
 * died mid-tool: the `--watch` supervisor restarted the API, the new process
 * lost the port race to the old one, `EADDRINUSE` reached the
 * `uncaughtException` handler, and the server exited. The browser saw
 *
 *   [vite] http proxy error: /api/agent/chat
 *   Error: read ECONNRESET
 *
 * and the UI saw NOTHING. `sse()` read to end-of-stream, resolved, the caller's
 * `finally` cleared the spinner, and the transcript simply stopped after the
 * assistant's tool call — with no error bubble and no Retry. The session in
 * SQLite proves it: seq 7 is an assistant row calling `design_flow_blueprint`,
 * and there is no seq 8. A completed turn and an abandoned one were
 * indistinguishable.
 *
 * Every SSE route in this app terminates with `done` or `error` on every path,
 * failure paths included — agent chat, the three catalog builds, both flow
 * routes and the SLA verifier. So the absence of a terminal frame is not a
 * possibility to tolerate, it is a broken connection, and it is asserted here
 * as an invariant rather than left as a convention nothing checks.
 *
 * Offline: `fetch` and `window` are stubbed, so this reaches no instance, no
 * model and no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiModule = path.resolve(here, '../../client/src/api.js');

/**
 * `client/src/api.js` reports every call through client/src/logging.js, which
 * reads `window.location` and posts with `fetch`. Both are stubbed before the
 * import so the module under test is the REAL one the browser ships — stubbing
 * the module itself would test a copy.
 */
globalThis.window = {
  location: { pathname: '/agent', search: '' },
  addEventListener() {},
};
// `navigator` is a real read-only global on Node 24 and is not needed: the
// beacon path only runs on page unload, which no test here reaches.
globalThis.document = { addEventListener() {} };

/** Frames -> a Response whose body streams them, then ends. */
function streamOf(frames) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < frames.length
          ? { done: false, value: enc.encode(`data: ${JSON.stringify(frames[i++])}\n\n`) }
          : { done: true, value: undefined }),
      }),
    },
  };
}

const logPosts = [];
function install(response) {
  globalThis.fetch = async (url, init) => {
    // The logging transport posts here; swallow it and record it.
    if (String(url).endsWith('/api/logs')) {
      logPosts.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return response;
  };
}

const { sse } = await import(pathToFileURL(apiModule).href);

test('a stream ending with `done` resolves, and delivers every event', async () => {
  install(streamOf([{ type: 'meta' }, { type: 'assistant_text', text: 'hi' }, { type: 'done' }]));
  const seen = [];
  await sse('/agent/chat', { sessionId: 's', message: 'm' }, (e) => seen.push(e.type));
  assert.deepEqual(seen, ['meta', 'assistant_text', 'done']);
});

test('a stream ending with `error` resolves — the caller renders the error event', async () => {
  install(streamOf([{ type: 'meta' }, { type: 'error', message: 'upstream fell over' }]));
  const seen = [];
  await sse('/agent/chat', {}, (e) => seen.push(e.type));
  assert.deepEqual(seen, ['meta', 'error']);
});

test('a stream that STOPS with no terminal frame throws — this is the regression', async () => {
  // Exactly the measured shape: meta, a tool call announced, then the socket
  // dies. Nothing says the turn is over, because from the server's side it
  // never was.
  install(streamOf([{ type: 'meta' }, { type: 'tool_use', id: 'c1', name: 'design_flow_blueprint' }]));
  const seen = [];
  await assert.rejects(
    () => sse('/agent/chat', {}, (e) => seen.push(e.type)),
    (err) => {
      assert.match(err.message, /ended before this finished/i);
      // It must say what to do, not merely that something went wrong.
      assert.match(err.message, /server terminal/i);
      return true;
    },
  );
  // The events that DID arrive were still delivered — the turn's partial
  // progress is not thrown away along with the connection.
  assert.deepEqual(seen, ['meta', 'tool_use']);
});

test('an empty stream throws too — zero frames is the same broken connection', async () => {
  install(streamOf([]));
  await assert.rejects(() => sse('/agent/chat', {}, () => {}), /ended before this finished/i);
});

test('the truncation is written to the server terminal, not only to the caller', async () => {
  logPosts.length = 0;
  install(streamOf([{ type: 'meta' }]));
  await sse('/agent/chat', {}, () => {}).catch(() => {});
  // The transport batches on a timer; give it its flush.
  await new Promise((r) => setTimeout(r, 900));
  const messages = logPosts.flatMap((p) => p.entries.map((e) => e.message));
  assert.ok(
    messages.some((m) => /ended without a done\/error frame/i.test(m)),
    `expected a truncation line in the forwarded log, got: ${JSON.stringify(messages)}`,
  );
});

test('a non-ok response still throws before any streaming is attempted', async () => {
  install({ ok: false, status: 400, body: null, json: async () => ({ message: 'sessionId and message are required' }) });
  await assert.rejects(() => sse('/agent/chat', {}, () => {}), /sessionId and message are required/);
});
