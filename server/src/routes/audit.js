import { Router } from 'express';
import { auditRows, auditSessions, auditCsv, loadBuildEvents } from '../memory/audit.js';

export const auditRouter = Router();

const parseLimit = (v, fallback = 500) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : fallback;
};

/**
 * D-5 — one timeline over both sources.
 *
 * `session=ui` is the synthetic bucket for builds driven from the module UIs,
 * which belong to no conversation. It is a real filter rather than a UI-side
 * guess, because "which of these did a human drive by hand" is exactly the
 * kind of question an audit page has to answer without inference.
 */
auditRouter.get('/', (req, res, next) => {
  try {
    res.json({
      rows: auditRows({
        session: req.query.session || null,
        mutatingOnly: req.query.mutating === 'true',
        limit: parseLimit(req.query.limit),
      }),
      ...auditSessions(),
    });
  } catch (err) { next(err); }
});

/** The streamed evidence behind one build run, fetched when a row is expanded. */
auditRouter.get('/runs/:id', (req, res, next) => {
  try { res.json({ events: loadBuildEvents(req.params.id) }); } catch (err) { next(err); }
});

/**
 * The same rows the page is showing, under the same filters — never "everything
 * in the database". An export that silently differs from what was on screen is
 * worse than no export.
 */
auditRouter.get('/export.csv', (req, res, next) => {
  try {
    const rows = auditRows({
      session: req.query.session || null,
      mutatingOnly: req.query.mutating === 'true',
      limit: parseLimit(req.query.limit),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nowhelpassist-audit-${stamp}.csv"`);
    res.send(auditCsv(rows));
  } catch (err) { next(err); }
});
