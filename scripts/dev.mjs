/**
 * Start BOTH halves of NowHelpAssist with one command.
 *
 * This exists because of a real support trace, not tidiness. The client was
 * started on its own and the server never was, so vite's proxy answered every
 * call with
 *
 *   [vite] http proxy error: /api/incidents/stats
 *   AggregateError [ECONNREFUSED]
 *
 * — which names neither NowHelpAssist nor the missing process, and reads like
 * the app is broken rather than half-started. The README's two-terminal recipe
 * is still correct and still works; this removes the failure mode where the
 * second terminal is simply forgotten.
 *
 * No dependency (no concurrently/npm-run-all): this app's whole storage layer
 * is dependency-free on purpose, and a dev launcher is not the place to break
 * that. ~60 lines of child_process does the job.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

// Each line is prefixed so two interleaved streams stay readable. Colour is
// dropped when stdout is not a TTY, matching server/src/logging.js.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const TARGETS = [
  { name: 'server', cwd: path.join(ROOT, 'server'), color: '36' },
  { name: 'client', cwd: path.join(ROOT, 'client'), color: '35' },
];

const children = [];
let shuttingDown = false;

function prefixed(name, color) {
  const tag = paint(color, name.padEnd(6));
  let carry = '';
  return (chunk) => {
    const lines = (carry + chunk.toString()).split('\n');
    // The last element is a partial line until the next chunk completes it —
    // printing it now would break the server's box-drawn banner in half.
    carry = lines.pop();
    for (const l of lines) process.stdout.write(`${tag} ${paint('90', '│')} ${l}\n`);
  };
}

for (const t of TARGETS) {
  /*
   * A shell is unavoidable here: on Windows `npm` is a .cmd shim, which Node
   * has refused to spawn directly since the CVE-2024-27980 fix.
   *
   * The command is passed as ONE literal string rather than as (file, args) —
   * that combination is what raises DEP0190, because with a shell the args are
   * concatenated unescaped rather than passed through. There is nothing here to
   * escape: every character of this command is a literal written above, and no
   * caller can reach it. Same rule as the SDK invocation in
   * servicenow/fluent.js — fixed arguments only, never user input.
   */
  const child = spawn('npm run dev', {
    cwd: t.cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', prefixed(t.name, t.color));
  child.stderr.on('data', prefixed(t.name, t.color));
  child.on('error', (err) => {
    process.stdout.write(`${paint('31', 'FATAL ')} could not start the ${t.name}: ${err.message}\n`);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    // Half of this app is not a working app. If one side dies the other is
    // serving requests nothing can answer, which is exactly the ECONNREFUSED
    // confusion this script was written to end — so both go down together.
    process.stdout.write(`${paint('31', 'FATAL ')} the ${t.name} exited with code ${code}; stopping the other half too.\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // /T kills the shell wrapper's children too; without it npm dies and the
    // node server it spawned is orphaned, keeps port 4000, and the next
    // `npm run dev` cannot bind. Measured — that is how four stray servers
    // accumulated during the investigation this script came out of.
    if (isWin) spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

/*
 * The API watchdog, and why exit codes are not enough.
 *
 * `npm run dev` in server/ is `node --watch`, and a watcher SUPERVISOR does not
 * exit when its child dies — it prints "Waiting for file changes before
 * restarting..." and parks. So the `exit` handler above never fires for the one
 * failure that matters most: the API going away while the client stays up and
 * happily proxies into nothing.
 *
 * That is precisely the state behind the report this script came from. The only
 * thing that said so was vite, in its own words:
 *
 *   [vite] http proxy error: /api/incidents/stats
 *   AggregateError [ECONNREFUSED]
 *
 * which names a URL and a syscall and nothing else. Polling the health endpoint
 * costs one local request every three seconds and lets the launcher say the
 * true thing instead.
 *
 * It only ever REPORTS. Killing the client on a blip would turn a two-second
 * watcher restart into a full stop, and the browser already degrades correctly:
 * useHealth() flips and the disconnected banner appears on its own.
 */
const HEALTH_URL = `http://127.0.0.1:${process.env.PORT || 4000}/api/system/health`;
const HEALTH_EVERY_MS = 3000;
let apiUp = null;   // null until the first answer, so startup is not "recovered"

async function pollHealth() {
  let up = false;
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    up = res.ok;
  } catch { up = false; }
  if (apiUp === null) { apiUp = up; return; }
  if (up === apiUp) return;
  apiUp = up;
  process.stdout.write(up
    ? `${paint('32', 'API   ')} ${paint('90', '│')} back up on ${HEALTH_URL.replace('/api/system/health', '')}
`
    : `${paint('31', 'API   ')} ${paint('90', '│')} the API server is NOT RESPONDING. Every /api call from the browser will fail until it is back. `
      + `Look at the "server" lines above for the reason — a syntax error parks 'node --watch' until the next save.
`);
}
const healthTimer = setInterval(() => { pollHealth(); }, HEALTH_EVERY_MS);
healthTimer.unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
