import { Router } from 'express';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { notFound, wrap } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { materialMasterModel } from '../services/materialMaster.js';

export const materialMasterRouter = Router();

materialMasterRouter.get('/', requireAuth, wrap((req, res) => {
  const q = (key: string) => (req.query[key] as string | undefined)?.trim() || undefined;
  const items = materialMasterModel.list({
    materialType: q('materialType'),
    status: q('status'),
    search: q('search')?.toLowerCase(),
    name: q('name'),
    make: q('make'),
    model: q('model'),
    serialNumber: q('serialNumber'),
    location: q('location'),
  });
  res.json({ items });
}));

materialMasterRouter.post('/', requireAuth, requirePage('ADMIN','material_master','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const record = materialMasterModel.create({
    materialType: body.materialType === 'Transmission' ? 'Transmission' : 'Engine',
    name: String(body.name ?? ''),
    make: body.make || null,
    model: body.model || null,
    serialNumber: body.serialNumber || null,
    status: body.status === 'Inactive' ? 'Inactive' : 'Active',
    manualLocation: body.manualLocation ?? null,
  }, req.user!.username);

  audit({
    user: req.user!.username, ip: req.clientIp, action: 'material_master.create',
    entity: 'material_master', entityId: record.id, newValue: record,
  });
  res.status(201).json({ item: record });
}));

materialMasterRouter.put('/:id', requireAuth, requirePage('ADMIN','material_master','edit'), wrap((req, res) => {
  const existing = materialMasterModel.get(req.params.id);
  if (!existing) throw notFound('That record does not exist.');

  const body = req.body ?? {};
  const record = materialMasterModel.update(req.params.id, {
    name: body.name !== undefined ? String(body.name) : undefined,
    make: body.make !== undefined ? body.make : undefined,
    model: body.model !== undefined ? body.model : undefined,
    serialNumber: body.serialNumber !== undefined ? body.serialNumber : undefined,
    status: body.status !== undefined ? body.status : undefined,
    manualLocation: body.manualLocation !== undefined ? body.manualLocation : undefined,
  });

  audit({
    user: req.user!.username, ip: req.clientIp, action: 'material_master.update',
    entity: 'material_master', entityId: record.id, newValue: record,
  });
  res.json({ item: record });
}));

/*
 * Material Master has no Excel import of its own by design. The catalog is
 * populated once from the master workbook confirmed at Admin > Master >
 * Equipment Master > Import Correct Master Data (services/rigMasterDataImport.ts),
 * which writes Engine/Transmission records here in the same transaction as the
 * equipment they belong to. After that the database is the only source: Admin
 * manages records through Add New / Edit / Active-Inactive above.
 */
