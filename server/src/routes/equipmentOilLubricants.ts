import { Router } from 'express';
import { assertRigAllowed, requireAnyPage, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { getEquipment } from '../services/equipmentView.js';
import { equipmentOilLubricantsModel } from '../services/equipmentOilLubricants.js';

/**
 * Rig -> Equipment -> Oil/Lubricant assignment endpoints, backing the
 * Admin > Master > Oil & Lubricant Master mapping view and any other place
 * in the app (e.g. Equipment Detail) that needs "which oils does this
 * equipment use".
 */
export const equipmentOilLubricantsRouter = Router();

function loadEquipmentOr404(equipmentId: string) {
  const item = getEquipment(equipmentId);
  if (!item) throw notFound('That machine does not exist.');
  return item;
}

equipmentOilLubricantsRouter.get('/', requireAuth, wrap((req, res) => {
  const equipmentId = req.query.equipmentId as string | undefined;
  if (!equipmentId) throw badRequest('equipmentId is required.');
  const item = loadEquipmentOr404(equipmentId);
  assertRigAllowed(req, item.rigId);

  res.json({ mappings: equipmentOilLubricantsModel.listForEquipment(equipmentId) });
}));

equipmentOilLubricantsRouter.post('/', requireAuth, requireAnyPage(['PMS','equipment','create'],['ADMIN','equipment_master','create']), wrap((req, res) => {
  const body = req.body ?? {};
  const equipmentId = String(body.equipmentId ?? '');
  const oilLubricantId = String(body.oilLubricantId ?? '');
  if (!equipmentId || !oilLubricantId) throw badRequest('equipmentId and oilLubricantId are required.');

  const item = loadEquipmentOr404(equipmentId);
  assertRigAllowed(req, item.rigId);

  const mapping = equipmentOilLubricantsModel.addMapping(equipmentId, oilLubricantId, req.user!.username);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'equipmentOilLubricant.assign',
    entity: 'equipment_oil_lubricants', entityId: mapping.id, newValue: mapping,
  });
  res.status(201).json({ mapping });
}));

equipmentOilLubricantsRouter.delete('/:id', requireAuth, requireAnyPage(['PMS','equipment','delete'],['ADMIN','equipment_master','delete']), wrap((req, res) => {
  const existing = equipmentOilLubricantsModel.get(req.params.id);
  if (!existing) throw notFound('That assignment does not exist.');
  const equipment = loadEquipmentOr404(existing.equipmentId);
  assertRigAllowed(req, equipment.rigId);

  const mapping = equipmentOilLubricantsModel.removeMapping(req.params.id);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'equipmentOilLubricant.unassign',
    entity: 'equipment_oil_lubricants', entityId: mapping.id, oldValue: mapping,
  });
  res.json({ ok: true });
}));
