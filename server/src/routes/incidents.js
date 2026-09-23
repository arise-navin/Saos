import { Router } from 'express';
import { table } from '../servicenow/client.js';

export const incidentsRouter = Router();

const LIST_FIELDS =
  'sys_id,number,short_description,state,priority,impact,urgency,category,caller_id,assignment_group,assigned_to,sys_updated_on,opened_at,active';

incidentsRouter.get('/', async (req, res, next) => {
  try {
    const { search = '', state = '', priority = '', assignment_group = '', active = '', limit = 25, offset = 0 } = req.query;
    const parts = [];
    if (active !== '') parts.push(`active=${active}`);
    if (state) parts.push(`state=${state}`);
    if (priority) parts.push(`priority=${priority}`);
    if (assignment_group) parts.push(`assignment_group=${assignment_group}`);
    if (search) {
      parts.push(/^inc\d*/i.test(search) ? `numberSTARTSWITH${search}` : `short_descriptionLIKE${search}`);
    }
    const rows = await table.query('incident', {
      query: parts.join('^'),
      fields: LIST_FIELDS,
      limit: Math.min(Number(limit) || 25, 100),
      offset: Number(offset) || 0,
      orderByDesc: 'sys_updated_on',
    });
    res.json(rows);
  } catch (err) { next(err); }
});

incidentsRouter.get('/stats', async (_req, res, next) => {
  try {
    const [open, critical, unassigned, newCount] = await Promise.all([
      table.count('incident', 'active=true'),
      table.count('incident', 'active=true^priority=1'),
      table.count('incident', 'active=true^assigned_toISEMPTY'),
      table.count('incident', 'state=1'),
    ]);
    res.json({ open, critical, unassigned, new: newCount });
  } catch (err) { next(err); }
});

incidentsRouter.get('/:sysId', async (req, res, next) => {
  try { res.json(await table.get('incident', req.params.sysId)); } catch (err) { next(err); }
});

incidentsRouter.post('/', async (req, res, next) => {
  try { res.status(201).json(await table.create('incident', req.body)); } catch (err) { next(err); }
});

incidentsRouter.patch('/:sysId', async (req, res, next) => {
  try { res.json(await table.update('incident', req.params.sysId, req.body)); } catch (err) { next(err); }
});

incidentsRouter.delete('/:sysId', async (req, res, next) => {
  try { res.json(await table.remove('incident', req.params.sysId)); } catch (err) { next(err); }
});
