import { Router } from 'express';
import { aclReport, aclDiff, explainAclReport } from '../servicenow/acl.js';

export const accessRouter = Router();

/** GET /api/access/acl/:table?inherited=false */
accessRouter.get('/acl/:table', async (req, res, next) => {
  try {
    res.json(await aclReport(req.params.table, { includeInherited: req.query.inherited !== 'false' }));
  } catch (err) { next(err); }
});

/** GET /api/access/diff/:table?a=admin&b=itil */
accessRouter.get('/diff/:table', async (req, res, next) => {
  try {
    res.json(await aclDiff(req.params.table, req.query.a, req.query.b, {
      includeInherited: req.query.inherited !== 'false',
    }));
  } catch (err) { next(err); }
});

/**
 * POST /api/access/explain { table } | { report }
 * Read-only: the report is read off the instance, the paragraph is generated
 * from it. The response says which is which so the UI cannot blur them.
 */
accessRouter.post('/explain', async (req, res, next) => {
  try {
    const report = req.body?.report || (req.body?.table ? await aclReport(req.body.table) : null);
    if (!report) return res.status(400).json({ message: 'table (or a report object) is required' });
    res.json(await explainAclReport(report));
  } catch (err) { next(err); }
});
