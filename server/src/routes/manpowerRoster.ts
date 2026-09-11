import { Router } from 'express';
import { db } from '../db/index.js';
import { assertRigAllowed, requireAuth, requireRight } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { manpowerRosterModel } from '../services/manpowerRoster.js';

/**
 * Admin CRUD for Manpower Roster assignments (Employee -> Rig rotation).
 * Gated the same way Equipment Master is (`canManageEquipment`) since this
 * is rig-scoped operational master data, not a separate permission concept.
 */
export const manpowerRosterRouter = Router();

function loadRigOr400(rigId: string): { id: string } {
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');
  return rig;
}

manpowerRosterRouter.get('/', requireAuth, wrap((req, res) => {
  const rigId = req.query.rigId as string | undefined;
  if (rigId) assertRigAllowed(req, rigId);
  const rows = manpowerRosterModel.list({ rigId, status: req.query.status as string | undefined });
  res.json({ roster: rows });
}));

manpowerRosterRouter.post('/', requireAuth, requireRight('canManageEquipment'), wrap((req, res) => {
  const body = req.body ?? {};
  const rigId = String(body.rigId ?? '');
  if (!rigId) throw badRequest('Select a rig.');
  loadRigOr400(rigId);
  assertRigAllowed(req, rigId);

  const record = manpowerRosterModel.create({
    employeeId: String(body.employeeId ?? ''), rigId, designation: String(body.designation ?? ''),
    rotationType: String(body.rotationType ?? 'Custom'), onDays: Number(body.onDays) || 0, offDays: Number(body.offDays) || 0,
    rotationStartDate: String(body.rotationStartDate ?? ''), shift: String(body.shift ?? 'Day'),
    effectiveFrom: String(body.effectiveFrom ?? ''), effectiveTo: body.effectiveTo || null,
    status: body.status === 'Inactive' ? 'Inactive' : 'Active',
  }, req.user!.username);

  audit({ user: req.user!.username, ip: req.clientIp, action: 'manpowerRoster.create', entity: 'manpower_roster', entityId: record.id, newValue: record });
  res.status(201).json({ roster: record });
}));

manpowerRosterRouter.put('/:id', requireAuth, requireRight('canManageEquipment'), wrap((req, res) => {
  const existing = manpowerRosterModel.get(req.params.id);
  if (!existing) throw notFound('That roster assignment does not exist.');
  assertRigAllowed(req, existing.rigId);

  const body = req.body ?? {};
  if (body.rigId) { loadRigOr400(String(body.rigId)); assertRigAllowed(req, String(body.rigId)); }

  const record = manpowerRosterModel.update(req.params.id, {
    employeeId: body.employeeId, rigId: body.rigId, designation: body.designation, rotationType: body.rotationType,
    onDays: body.onDays !== undefined ? Number(body.onDays) : undefined,
    offDays: body.offDays !== undefined ? Number(body.offDays) : undefined,
    rotationStartDate: body.rotationStartDate, shift: body.shift,
    effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo !== undefined ? (body.effectiveTo || null) : undefined,
    status: body.status,
  }, req.user!.username);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'manpowerRoster.update', entity: 'manpower_roster', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    record as unknown as Record<string, unknown>,
  );
  res.json({ roster: record });
}));
