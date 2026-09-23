/**
 * One log stream for the whole application — server and browser both.
 *
 * The problem this solves is the one that produced the `invalid message
 * content type: <nil>` bug report: the failure was visible only as a red box
 * in the UI, with no session id, no message, and nothing in the terminal at
 * all. Finding it meant reading the database by hand. Everything the app does
 * now says so where a developer is already looking.
 *
 * Three rules it follows:
 *
 *  - **Secrets never reach the log.** Request bodies are not printed, and the
 *    few places that log structured data run through `redact()`. This app
 *    holds a ServiceNow password and an API key; a debug log is exactly how
 *    those escape.
 *  - **Volume is controlled by level, not by silence.** `LOG_LEVEL=debug`
 *    adds the health poll and every SQL-backed read; the default `info` keeps
 *    the stream readable while still showing every request, tool call,
 *    approval and error.
 *  - **Colour is optional.** Disabled when stdout is not a TTY or when
 *    `NO_COLOR` is set, so piping to a file gives clean text.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => paint('90', s);
const bold = (s) => paint('1', s);

const LEVEL_STYLE = {
  debug: (s) => dim(s),
  info: (s) => paint('36', s),   // cyan
  warn: (s) => paint('33', s),   // amber, as in the app
  error: (s) => paint('31', s),  // red
};

/** Keys whose values must never be printed, at any depth. */
const SECRET = /^(password|apikey|api_key|clientsecret|client_secret|secret|token|authorization|access_token|refresh_token|pwd)$/i;

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // A falsy secret is passed through as itself rather than coerced:
      // "<redacted>" against an absent password would read as one being
      // stored, and '' for a null loses the distinction for no gain.
      out[k] = SECRET.test(k) ? (v ? '<redacted>' : v) : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

const stamp = () => new Date().toISOString().slice(11, 23);

function emit(level, scope, message, meta) {
  if (LEVELS[level] < threshold) return;
  const line =
    `${dim(stamp())} ${LEVEL_STYLE[level](level.toUpperCase().padEnd(5))} ` +
    `${paint('35', String(scope).padEnd(9))} ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
  if (meta !== undefined && meta !== null) {
    // A string detail is a stack or a message — print it as lines. Only
    // structured data is JSON-encoded, and only after redaction.
    const body = meta instanceof Error
      ? (meta.stack || String(meta))
      : typeof meta === 'string' ? meta
        : JSON.stringify(redact(meta));
    // Indented under its line so a scan down the left column still works.
    for (const l of String(body).split('\n')) stream.write(`${dim('      │ ')}${l}\n`);
  }
}

export const log = {
  debug: (scope, msg, meta) => emit('debug', scope, msg, meta),
  info: (scope, msg, meta) => emit('info', scope, msg, meta),
  warn: (scope, msg, meta) => emit('warn', scope, msg, meta),
  error: (scope, msg, meta) => emit('error', scope, msg, meta),
  level: Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) || 'info',
  color: useColor,
};

export const ms = (start) => {
  const d = Date.now() - start;
  return d >= 1000 ? `${(d / 1000).toFixed(1)}s` : `${d}ms`;
};

/** Short, stable handle for a session/run uuid — full ids are in the audit trail. */
export const shortId = (id) => (id ? String(id).slice(0, 8) : '—');

/**
 * Express request logging.
 *
 * The status colour is the point: a wall of 200s should be skimmable and a 4xx
 * should not be. The health poll drops to debug because it fires every 20s per
 * open tab and would otherwise be most of the log.
 */
export function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();
    // originalUrl, not req.path: this middleware runs before the routers, and
    // by the time `finish` fires Express has restored baseUrl to ''. Checking
    // req.path here silently never matched, so the poll logged at info.
    const poll = req.originalUrl.startsWith('/api/system/health');
    res.on('finish', () => {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : poll ? 'debug' : 'info';
      const code = res.statusCode >= 400 ? paint('31', res.statusCode) : paint('32', res.statusCode);
      const q = req.originalUrl.includes('?') ? dim(req.originalUrl.slice(req.originalUrl.indexOf('?'))) : '';
      const path = req.originalUrl.split('?')[0];
      emit(level, 'http', `${bold(req.method.padEnd(6))} ${path}${q} ${dim('→')} ${code} ${dim(ms(start))}`);
    });
    next();
  };
}

/** Startup banner — what is bound, which model, where the data is. */
export function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length), 34);
  process.stdout.write(`${dim('┌' + '─'.repeat(width + 2) + '┐')}\n`);
  for (const l of lines) process.stdout.write(`${dim('│')} ${l.padEnd(width)} ${dim('│')}\n`);
  process.stdout.write(`${dim('└' + '─'.repeat(width + 2) + '┘')}\n`);
}
