import { Router } from 'express';
import { log } from '../logging.js';

export const logsRouter = Router();

const ALLOWED = new Set(['debug', 'info', 'warn', 'error']);

/**
 * The browser's half of the log, printed in the server's terminal.
 *
 * Both halves of this app fail in ways the other cannot see: a render error or
 * a rejected fetch is invisible to the server, and a stack trace in a devtools
 * console nobody has open is not evidence. One stream, one place to look.
 *
 * Entries arrive batched. They are logged under the `ui` scope and carry the
 * route they happened on, so a report like "it broke on the Agent page" can be
 * matched to a line without asking anyone to reproduce it.
 *
 * Deliberately unauthenticated and deliberately non-fatal: this is a local dev
 * tool, and a logging endpoint that can 500 is a logging endpoint that hides
 * the thing it was added to show.
 */
logsRouter.post('/', (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 100) : [];
  for (const e of entries) {
    const level = ALLOWED.has(e?.level) ? e.level : 'info';
    const where = e?.route ? ` ${'\x1b[90m'}(${e.route})${'\x1b[0m'}` : '';
    log[level]('ui', `${String(e?.message ?? '').slice(0, 500)}${log.color ? where : (e?.route ? ` (${e.route})` : '')}`,
      e?.detail ?? undefined);
  }
  res.json({ received: entries.length });
});
