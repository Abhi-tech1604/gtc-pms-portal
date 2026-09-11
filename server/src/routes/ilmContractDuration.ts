import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { badRequest, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { ilmContractDurationRuleModel, resolveContractDuration } from '../services/ilmContractDuration.js';

/**
 * Admin > Master > ILM Contract Duration Rules. Gated requireAdmin for
 * mutations, matching every other module Rig Master (each module's Rig
 * Master, and its configuration, is admin-only — not gated by a PMS
 * permission flag, which has no meaning for ILM-specific rig data).
 */
export const ilmContractDurationRouter = Router();

function loadIlmRigOr400(ilmRigId: string): { id: string } {
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM ilm_rigs WHERE id = ?').get(ilmRigId);
  if (!rig) throw badRequest('That ILM rig does not exist.');
  return rig;
}

ilmContractDurationRouter.get('/', requireAuth, wrap((req, res) => {
  const ilmRigId = req.query.ilmRigId as string | undefined;
  const rules = ilmContractDurationRuleModel.list({ ilmRigId, status: req.query.status as string | undefined });
  res.json({ rules });
}));

/**
 * Live preview used by ILM entry's "Add Trailer Movement" form — shows what
 * would be calculated before the movement is actually saved. Read-only,
 * no side effects; the authoritative calculation happens again, once, inside
 * addTrailerMovement() at save time (services/ilmLifecycle.ts).
 */
ilmContractDurationRouter.get('/resolve', requireAuth, wrap((req, res) => {
  const ilmRigId = String(req.query.ilmRigId ?? '');
  if (!ilmRigId) throw badRequest('Specify the rig.');
  const distanceKm = req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;
  res.json(resolveContractDuration(ilmRigId, distanceKm === null || Number.isNaN(distanceKm) ? null : distanceKm));
}));

ilmContractDurationRouter.post('/', requireAuth, requireAdmin, wrap((req, res) => {
  const body = req.body ?? {};
  const ilmRigId = String(body.ilmRigId ?? '');
  if (!ilmRigId) throw badRequest('Select a rig.');
  loadIlmRigOr400(ilmRigId);

  const rule = ilmContractDurationRuleModel.create({
    ilmRigId,
    fromDistanceKm: Number(body.fromDistanceKm),
    toDistanceKm: body.toDistanceKm === '' || body.toDistanceKm === null || body.toDistanceKm === undefined
      ? null : Number(body.toDistanceKm),
    baseHours: Number(body.baseHours),
    extraHoursPerKm: body.extraHoursPerKm !== undefined ? Number(body.extraHoursPerKm) : 0,
    roundPerKm: body.roundPerKm !== false,
    status: body.status === 'Inactive' ? 'Inactive' : 'Active',
  }, req.user!.username);

  audit({ user: req.user!.username, ip: req.clientIp, action: 'ilmContractDurationRule.create', entity: 'ilm_contract_duration_rules', entityId: rule.id, newValue: rule });
  res.status(201).json({ rule });
}));

ilmContractDurationRouter.put('/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const existing = ilmContractDurationRuleModel.get(req.params.id);
  if (!existing) throw badRequest('That contract duration rule does not exist.');

  const body = req.body ?? {};
  if (body.ilmRigId) loadIlmRigOr400(String(body.ilmRigId));

  const rule = ilmContractDurationRuleModel.update(req.params.id, {
    ilmRigId: body.ilmRigId,
    fromDistanceKm: body.fromDistanceKm !== undefined ? Number(body.fromDistanceKm) : undefined,
    toDistanceKm: body.toDistanceKm !== undefined ? (body.toDistanceKm === '' || body.toDistanceKm === null ? null : Number(body.toDistanceKm)) : undefined,
    baseHours: body.baseHours !== undefined ? Number(body.baseHours) : undefined,
    extraHoursPerKm: body.extraHoursPerKm !== undefined ? Number(body.extraHoursPerKm) : undefined,
    roundPerKm: body.roundPerKm !== undefined ? !!body.roundPerKm : undefined,
    status: body.status,
  }, req.user!.username);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'ilmContractDurationRule.update', entity: 'ilm_contract_duration_rules', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    rule as unknown as Record<string, unknown>,
  );
  res.json({ rule });
}));
