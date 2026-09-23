/**
 * F6 — a model call that never comes back is a failure, not a wait.
 *
 *   node --test server/test/
 *
 * There was no timeout on the LLM fetch at all: no AbortController, no signal,
 * nothing. A queued or wedged upstream held a turn open on whatever the
 * platform's socket defaults happen to be, and a hang is the one failure the
 * retry cannot help with, because it never gets as far as failing.
 *
 * A timeout is now shaped like the 408 it stands in for, so it travels the
 * retry path an upstream-reported timeout would — retried, bounded, and named
 * as a timeout rather than as a dead daemon.
 *
 * ON FAKE TIMERS, and why there are none. `AbortSignal.timeout` is implemented
 * natively and does not go through `globalThis.setTimeout`, so node's mock
 * timers cannot drive it and a test built on them would assert nothing while
 * looking thorough. What is asserted instead is the two halves that are really
 * ours: that every fetch carries a signal, and that the rejection undici raises
 * when one fires is mapped to a retryable 408. The firing itself is the
 * platform's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chat, LLM_REQUEST_TIMEOUT_MS, WARMUP_TIMEOUT_MS,
} from '../src/agent/providers/openaiCompat.js';
import { RETRY_ATTEMPTS, isRetryableStatus } from '../src/agent/providers/retry.js';

const HISTORY = [{ role: 'user', text: 'go' }];
const OK_BODY = { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };

/** What undici raises when an AbortSignal.timeout fires mid-request. */
const timeoutError = () => {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
};

/** The same thing as undici sometimes surfaces it: wrapped as a `cause`. */
const wrappedTimeoutError = () => {
  const e = new TypeError('fetch failed');
  e.cause = timeoutError();
  return e;
};

test('the timeouts are bounded, and the warm-up is the tighter of the two', () => {
  // 120s is not a latency budget — a real request measures 1.0-1.5s up to 51k
  // prompt tokens. It is the line past which slow has become not coming back.
  assert.equal(LLM_REQUEST_TIMEOUT_MS, 120_000);
  // The warm-up is an optimisation; one that hangs would add its own wait to
  // every attempt it exists to make cheaper.
  assert.equal(WARMUP_TIMEOUT_MS, 15_000);
  assert.ok(WARMUP_TIMEOUT_MS < LLM_REQUEST_TIMEOUT_MS);
});

test('every model call goes out with an abort signal on it', async () => {
  let seen = null;
  globalThis.fetch = async (_url, init) => {
    seen = init.signal;
    return { ok: true, status: 200, json: async () => OK_BODY };
  };
  await chat({ provider: 'ollama', system: 's', history: HISTORY, tools: [] });
  assert.ok(seen instanceof AbortSignal, 'the request went out unbounded');
  assert.equal(seen.aborted, false);
});

test('the warm-up is bounded too', async () => {
  // A cold start is the one path that fires a second request, and it was the
  // other unbounded fetch in this file.
  const signals = [];
  globalThis.fetch = async (_url, init) => {
    signals.push({ warmUp: JSON.parse(init.body).max_tokens === 1, signal: init.signal });
    if (JSON.parse(init.body).max_tokens === 1) return { ok: true, status: 200, json: async () => OK_BODY };
    return signals.filter((s) => !s.warmUp).length === 1
      ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'load' }] }) }
      : { ok: true, status: 200, json: async () => OK_BODY };
  };
  await chat({ provider: 'ollama', system: 's', history: HISTORY, tools: [] });
  const warmUp = signals.find((s) => s.warmUp);
  assert.ok(warmUp, 'the cold-start path did not run — this test is asserting nothing');
  assert.ok(warmUp.signal instanceof AbortSignal, 'the warm-up went out unbounded');
});

test('a timeout is reported as a timeout, not as an unreachable daemon', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw timeoutError(); };
  await assert.rejects(
    () => chat({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', system: 's', history: HISTORY, tools: [] }),
    (err) => {
      assert.match(err.message, /did not respond within 120000ms/);
      assert.doesNotMatch(err.message, /unreachable/, 'a hang and a dead daemon must not read the same');
      // Shaped like the 408 it stands in for, so it travels the same path.
      assert.equal(err.status, 408);
      assert.ok(isRetryableStatus(err.status));
      assert.equal(err.retryable, true);
      assert.match(err.message, new RegExp(`after ${RETRY_ATTEMPTS} attempts`));
      return true;
    }
  );
  assert.equal(calls, RETRY_ATTEMPTS, 'a timeout is transient and gets the full budget');
});

test('a timeout wrapped as a TypeError cause is still a timeout', async () => {
  // Reading only the outer error reports a timeout as a dead daemon, which is
  // how someone ends up restarting a service that was fine.
  globalThis.fetch = async () => { throw wrappedTimeoutError(); };
  await assert.rejects(
    () => chat({ provider: 'ollama', system: 's', history: HISTORY, tools: [] }),
    (err) => {
      assert.match(err.message, /did not respond within/);
      assert.equal(err.status, 408);
      return true;
    }
  );
});

test('a genuine network failure still reads as unreachable', async () => {
  // The regression guard for the branch above: not every fetch rejection is a
  // timeout, and mislabelling one would be the same defect in the other
  // direction.
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => chat({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', system: 's', history: HISTORY, tools: [] }),
    (err) => {
      assert.match(err.message, /unreachable at http:\/\/localhost:11434/);
      assert.equal(err.status, undefined);
      assert.equal(err.retryable, true);
      return true;
    }
  );
});
