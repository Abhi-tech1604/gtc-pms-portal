import { Router } from 'express';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { equipmentOilLubricantsModel } from '../services/equipmentOilLubricants.js';

/**
 * Admin > Master > Oil & Lubricant Master: a simple named reference list
 * (e.g. "Engine Oil 15W40"), shared by every module. Mirrors departments.ts,
 * the closest existing precedent for a simple admin-managed named list.
 * `equipmentName` is optional free text (matches equipment.name across rigs,
 * not a FK) — most lubricants apply to a whole class of machine, not one
 * physical unit, and are frequently not equipment-specific at all.
 */
export const oilLubricantsRouter = Router();

const STATUSES = ['Active', 'Inactive'];

interface OilLubricantRow {
  id: string; name: string; nameKey: string; equipmentName: string | null; status: string; createdAt: string;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

oilLubricantsRouter.get('/', requireAuth, requirePage('ADMIN','oil_lubricant_master','view'), wrap((req, res) => {
  const where = String(req.query.activeOnly ?? '') === 'true' ? "WHERE status = 'Active'" : '';
  const rows = db.prepare<[], OilLubricantRow>(`SELECT * FROM oil_lubricants ${where} ORDER BY name`).all();
  // `usage` is derived live from equipment_oil_lubricants -> equipment -> rigs,
  // the same relationship Equipment Master and DRR read, so this screen shows
  // where each oil is actually in use rather than a copy that can go stale.
  const usage = equipmentOilLubricantsModel.usageByOil();
  res.json({ oilLubricants: rows.map((r) => ({ ...r, usage: usage.get(r.id) ?? [] })) });
}));

oilLubricantsRouter.get('/:id', requireAuth, requirePage('ADMIN','oil_lubricant_master','view'), wrap((req, res) => {
  const row = db.prepare<[string], OilLubricantRow>('SELECT * FROM oil_lubricants WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('That oil/lubricant does not exist.');
  res.json({ oilLubricant: row });
}));

/**
 * Reconciles this oil's equipment assignments against the ids the form sent.
 * Equipment is chosen from Equipment Master, so ids are validated against it —
 * never a typed-in name. The (equipmentId, oilLubricantId) unique index plus
 * addMapping's own check make a duplicate mapping impossible; anything the
 * form dropped is deleted, so the assignment list can't accumulate ghosts.
 */
function syncOilEquipment(oilLubricantId: string, equipmentIds: unknown, user: string): void {
  if (!Array.isArray(equipmentIds)) return;
  const wanted = new Set(equipmentIds.map((id) => String(id)).filter(Boolean));
  for (const equipmentId of wanted) {
    const equipment = db.prepare<[string], { id: string }>(
      'SELECT id FROM equipment WHERE id = ? AND isActive = 1',
    ).get(equipmentId);
    if (!equipment) throw badRequest('Pick equipment from Equipment Master — one of the selected machines no longer exists or is inactive.');
  }

  const current = db.prepare<[string], { id: string; equipmentId: string }>(
    'SELECT id, equipmentId FROM equipment_oil_lubricants WHERE oilLubricantId = ?',
  ).all(oilLubricantId);
  const held = new Set(current.map((m) => m.equipmentId));

  for (const equipmentId of wanted) {
    if (!held.has(equipmentId)) equipmentOilLubricantsModel.addMapping(equipmentId, oilLubricantId, user);
  }
  for (const mapping of current) {
    if (!wanted.has(mapping.equipmentId)) {
      db.prepare('DELETE FROM equipment_oil_lubricants WHERE id = ?').run(mapping.id);
    }
  }
}

oilLubricantsRouter.post('/', requireAuth, requirePage('ADMIN','oil_lubricant_master','create'), wrap((req, res) => {
  const record = createOilLubricant(req.body ?? {}, req.user!.username, req.clientIp ?? null);
  syncOilEquipment(record.id, req.body?.equipmentIds, req.user!.username);
  res.status(201).json({ oilLubricant: record });
}));

/** Shared by the single-record POST and bulk import. */
export function createOilLubricant(body: Record<string, unknown>, user: string, ip: string | null): OilLubricantRow {
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('A name is required.');
  const key = nameKey(name);

  const clash = db.prepare<[string], { name: string }>('SELECT name FROM oil_lubricants WHERE nameKey = ?').get(key);
  if (clash) throw badRequest(`"${clash.name}" already exists.`);

  const record: OilLubricantRow = {
    id: newId('oil'),
    name,
    nameKey: key,
    equipmentName: (body.equipmentName as string)?.trim() || null,
    status: STATUSES.includes(body.status as string) ? (body.status as string) : 'Active',
    createdAt: nowIso(),
  };
  db.prepare(`
    INSERT INTO oil_lubricants (id, name, nameKey, equipmentName, status, createdAt)
    VALUES (@id, @name, @nameKey, @equipmentName, @status, @createdAt)
  `).run(record);

  audit({ user, ip, action: 'oilLubricant.create', entity: 'oil_lubricants', entityId: record.id, newValue: record });
  return record;
}

oilLubricantsRouter.put('/:id', requireAuth, requirePage('ADMIN','oil_lubricant_master','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], OilLubricantRow>('SELECT * FROM oil_lubricants WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That oil/lubricant does not exist.');

  const body = req.body ?? {};
  const name = String(body.name ?? existing.name).trim();
  if (!name) throw badRequest('A name is required.');
  const key = nameKey(name);

  const clash = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM oil_lubricants WHERE nameKey = ? AND id != ?',
  ).get(key, existing.id);
  if (clash) throw badRequest(`"${name}" already exists.`);

  const next: OilLubricantRow = {
    id: existing.id,
    name,
    nameKey: key,
    equipmentName: 'equipmentName' in body ? ((body.equipmentName as string)?.trim() || null) : existing.equipmentName,
    status: STATUSES.includes(body.status) ? body.status : existing.status,
    createdAt: existing.createdAt,
  };
  db.prepare(`
    UPDATE oil_lubricants SET name=@name, nameKey=@nameKey, equipmentName=@equipmentName, status=@status WHERE id=@id
  `).run(next);

  syncOilEquipment(existing.id, body.equipmentIds, req.user!.username);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'oilLubricant.update', entity: 'oil_lubricants', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  res.json({ oilLubricant: next });
}));

oilLubricantsRouter.delete('/:id', requireAuth, requirePage('ADMIN','oil_lubricant_master','delete'), wrap((req, res) => {
  const existing = db.prepare<[string], OilLubricantRow>('SELECT * FROM oil_lubricants WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That oil/lubricant does not exist.');

  db.prepare('DELETE FROM oil_lubricants WHERE id = ?').run(existing.id);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'oilLubricant.delete', entity: 'oil_lubricants', entityId: existing.id, oldValue: existing });
  res.json({ ok: true });
}));

/*
 * Oil & Lubricant Master has no Excel import of its own by design. The list is
 * populated once from the master workbook confirmed at Admin > Master >
 * Equipment Master > Import Correct Master Data (services/rigMasterDataImport.ts),
 * which writes the oils here and links them to equipment in the same
 * transaction. After that the database is the only source: Admin manages
 * entries through New entry / Edit / Active-Inactive above.
 */
