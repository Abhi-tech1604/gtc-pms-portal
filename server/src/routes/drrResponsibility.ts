import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { wrap } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { drrResponsibilityModel } from '../services/drrResponsibility.js';

/**
 * Admin > DRR > Rig Responsibility — assigning the Primary/Backup
 * Storekeeper and Operational Manager for each rig. Admin-only to manage;
 * any authenticated user can read back their OWN assignment (GET /my), which
 * is what the DRR dashboard/form use to decide which boxes and Approve/
 * Reject actions to show.
 */
export const drrResponsibilityRouter = Router();

drrResponsibilityRouter.get('/', requireAuth, requireAdmin, wrap((req, res) => {
  const rigId = req.query.rigId as string | undefined;
  res.json({ assignments: drrResponsibilityModel.list({ rigId }) });
}));

drrResponsibilityRouter.get('/my', requireAuth, wrap((req, res) => {
  if (req.user!.role === 'Admin') {
    // Admin's own report/count queries are already unrestricted (drrRigIds()
    // returns null for Admin) — isAdmin alone is enough for the client to
    // show both Storekeeper- and Manager-style boxes, fleet-wide.
    res.json({ storekeeperRigIds: [], managerRigIds: [], isAdmin: true });
    return;
  }
  const roles = drrResponsibilityModel.getUserRigRoles(req.user!.id);
  res.json({ ...roles, isAdmin: false });
}));

drrResponsibilityRouter.post('/', requireAuth, requireAdmin, wrap((req, res) => {
  const body = req.body ?? {};
  const record = drrResponsibilityModel.assign({
    rigId: String(body.rigId ?? ''), roleType: String(body.roleType ?? ''),
    tier: String(body.tier ?? ''), userId: String(body.userId ?? ''),
  }, req.user!.username);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'drrResponsibility.assign',
    entity: 'drr_rig_responsibility', entityId: record.id, newValue: record,
    detail: `${record.rigNumber}: ${record.tier} ${record.roleType} = ${record.userName}`,
  });
  res.status(201).json({ assignment: record });
}));

drrResponsibilityRouter.delete('/:id', requireAuth, requireAdmin, wrap((req, res) => {
  drrResponsibilityModel.remove(req.params.id);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'drrResponsibility.remove',
    entity: 'drr_rig_responsibility', entityId: req.params.id,
  });
  res.json({ ok: true });
}));
