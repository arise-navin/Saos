/**
 * The browser's half of the log, forwarded to the server's terminal.
 *
 * Why this exists: the bug report that prompted it was a red box reading
 * `invalid message content type: <nil>` and nothing else. The server terminal
 * was silent, because the failure was an SSE `error` event the client rendered
 * and dropped. A stack trace in a devtools console nobody has open is not
 * evidence, so both halves of the app now write to one stream.
 *
 * Four rules, each of which is a way this could otherwise make things worse:
 *
 *  - **It never recurses.** A failure of the log transport is never itself
 *    logged over the transport, or one dropped request becomes a loop.
 *  - **It never swallows.** The original `console.error` is always called
 *    first, so devtools behaves exactly as before.
 *  - **It batches.** Entries queue and flush on a timer, so a render loop
 *    producing hundreds of warnings costs a handful of requests.
 *  - **It never blocks a page.** Every failure path is a no-op.
 */

const ENDPOINT = '/api/logs';
const FLUSH_MS = 700;
const MAX_QUEUE = 200;

let queue = [];
let timer = null;
let sending = false;
/** Set while posting to the log endpoint, so its own failures cannot re-enter. */
let inTransport = false;

const route = () => `${window.location.pathname}${window.location.search}`;

function flush(useBeacon = false) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length || sending) return;
  const entries = queue.map((e) => (e.repeats > 1 ? { ...e, message: `${e.message}  ×${e.repeats}` } : e));
  queue = [];
  const body = JSON.stringify({ entries });

  if (useBeacon && navigator.sendBeacon) {
    // On unload a fetch is cancelled; a beacon is not. This is how the last
    // error before a crash-and-reload actually reaches the terminal.
    try { navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' })); } catch { /* gone */ }
    return;
  }

  sending = true;
  inTransport = true;
  fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .catch(() => { /* the terminal is the nice-to-have; never the app's problem */ })
    .finally(() => { sending = false; inTransport = false; });
}

/**
 * Queue one entry. Safe to call from anywhere, including an error handler.
 *
 * Consecutive identical entries collapse into one with a count. That is not
 * cosmetic: StrictMode double-invokes every effect in dev, so each navigation
 * logged twice, and a render loop would otherwise fill the terminal with the
 * same line a hundred times and push the cause off the top.
 */
export function logToServer(level, message, detail) {
  if (inTransport) return;
  const text = String(message ?? '').slice(0, 1000);
  const at = route();

  const last = queue[queue.length - 1];
  if (last && last.level === level && last.message === text && last.route === at) {
    last.repeats = (last.repeats || 1) + 1;
    return;
  }

  if (queue.length >= MAX_QUEUE) return;
  queue.push({ level, message: text, detail: detail === undefined ? undefined : detail, route: at });
  if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
}

function describe(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

let installed = false;

/**
 * Mirror console errors/warnings, uncaught exceptions and rejected promises
 * into the server terminal. Called once, from main.jsx.
 */
export function installClientLogging() {
  if (installed) return;
  installed = true;

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);   // devtools first, and unconditionally
      const err = args.find((a) => a instanceof Error);
      logToServer(level, `[console.${level}] ${args.map(describe).join(' ')}`, err?.stack);
    };
  }

  window.addEventListener('error', (e) => {
    // Also fires for failed <img>/<script> loads, where `error` is absent.
    if (e.error) logToServer('error', `uncaught ${describe(e.error)}`, e.error.stack);
    else if (e.target?.tagName) logToServer('warn', `failed to load ${e.target.tagName.toLowerCase()}: ${e.target.src || e.target.href || '?'}`);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    logToServer('error', `unhandled rejection: ${describe(e.reason)}`, e.reason?.stack);
  });

  // Flush what is queued before the tab goes away.
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });

  logToServer('info', `client started  ${navigator.userAgent.split(') ').pop()}`);
}
