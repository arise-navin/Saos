import { Router } from 'express';
import { startBuildRun, finishBuildRun, auditedEmit } from '../memory/audit.js';
import { listSlas, getSla, slaMeta, createSla, updateSla, deleteSla, validateSlaInput, verifySla } from '../servicenow/sla.js';

export const slaRouter = Router();

/* Registered before '/:sysId' so these names are not read as sys_ids. */

slaRouter.get('/meta', async (_req, res, next) => {
  try { res.json(await slaMeta()); } catch (err) { next(err); }
});

/** Dry run: the same checks createSla applies, without writing anything. */
slaRouter.post('/validate', async (req, res, next) => {
  try { res.json(await validateSlaInput(req.body || {})); } catch (err) { next(err); }
});

/**
 * POST /api/sla/verify { name, toleranceSec, waitSec }
 * Creates a record matching the definition's own start condition, asserts the
 * task_sla that attaches, and deletes the record again. Writes real data, so
 * it is its own step with its own approval — never part of creating an SLA.
 */
slaRouter.post('/verify', async (req, res) => {
  const { name, toleranceSec, waitSec } = req.body || {};
  if (!name) return res.status(400).json({ message: 'name (or sys_id) is required' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ } };
  const run = startBuildRun({ kind: 'sla_verify', label: name, request: { name, toleranceSec, waitSec } });
  const emit = auditedEmit(run, write);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
  try {
    const result = await verifySla(name, emit, {
      toleranceSec: Number(toleranceSec) || undefined,
      waitSec: Number(waitSec) || undefined,
    });
    emit({ type: 'done', result });
    finishBuildRun(run, { status: result?.ok === false ? 'error' : 'ok', summary: result });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    finishBuildRun(run, { status: 'error', summary: { message: err.message } });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

slaRouter.get('/', async (req, res, next) => {
  try {
    res.json(await listSlas({
      search: req.query.search || '',
      collection: req.query.collection || '',
      activeOnly: req.query.active === 'true',
      limit: Number(req.query.limit) || 50,
    }));
  } catch (err) { next(err); }
});

slaRouter.post('/', async (req, res, next) => {
  try {
    const result = await createSla(req.body || {});
    res.status(result.ok ? 201 : 422).json(result);
  } catch (err) { next(err); }
});

slaRouter.get('/:sysId', async (req, res, next) => {
  try { res.json(await getSla(req.params.sysId)); } catch (err) { next(err); }
});

slaRouter.patch('/:sysId', async (req, res, next) => {
  try {
    const result = await updateSla(req.params.sysId, req.body || {});
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) { next(err); }
});

slaRouter.delete('/:sysId', async (req, res, next) => {
  try {
    const result = await deleteSla(req.params.sysId);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) { next(err); }
});
