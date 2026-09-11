import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';

/**
 * Rig -> Equipment -> Oil/Lubricant assignment: which oils/lubricants from
 * the global oil_lubricants list (Admin > Master > Oil & Lubricant Master)
 * are in use on a given physical equipment row. A join table, since one
 * equipment can use many oils and one oil type can be assigned to many
 * equipment -- unlike material_master's single-valued linkedEngineId/
 * linkedTransmissionId columns on equipment.
 */

export interface EquipmentOilMapping {
  id: string;
  equipmentId: string;
  oilLubricantId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const BASE_SELECT = `
  SELECT m.id, m.equipmentId, m.oilLubricantId, o.name, m.status, m.createdAt, m.updatedAt
  FROM equipment_oil_lubricants m
  JOIN oil_lubricants o ON o.id = m.oilLubricantId
`;

function listForEquipment(equipmentId: string): EquipmentOilMapping[] {
  return db.prepare<[string], EquipmentOilMapping>(`${BASE_SELECT} WHERE m.equipmentId = ? ORDER BY o.name`).all(equipmentId);
}

function get(id: string): EquipmentOilMapping | undefined {
  return db.prepare<[string], EquipmentOilMapping>(`${BASE_SELECT} WHERE m.id = ?`).get(id);
}

/** One equipment this oil is assigned to, together with the rig that equipment is currently on. */
export interface OilUsage {
  mappingId: string;
  equipmentId: string;
  equipmentName: string;
  rigId: string;
  rigName: string;
}

/**
 * Which equipment (and therefore which rig) uses each oil — read live from the
 * same join table Equipment Master and DRR use, so Oil & Lubricant Master
 * always agrees with them. Keyed by oilLubricantId for a single round trip
 * instead of one query per row. Only ACTIVE equipment and mappings count: an
 * assignment to a decommissioned machine is history, not current usage.
 */
function usageByOil(): Map<string, OilUsage[]> {
  const rows = db.prepare<[], OilUsage & { oilLubricantId: string }>(`
    SELECT m.id AS mappingId, m.oilLubricantId, e.id AS equipmentId, e.name AS equipmentName,
           r.id AS rigId, r.name AS rigName
      FROM equipment_oil_lubricants m
      JOIN equipment e ON e.id = m.equipmentId
      JOIN rigs r ON r.id = e.rigId
     WHERE m.status = 'Active' AND e.isActive = 1
     ORDER BY r.name, e.name
  `).all();
  const byOil = new Map<string, OilUsage[]>();
  for (const { oilLubricantId, ...usage } of rows) {
    const list = byOil.get(oilLubricantId) ?? [];
    list.push(usage);
    byOil.set(oilLubricantId, list);
  }
  return byOil;
}

function addMapping(equipmentId: string, oilLubricantId: string, user: string): EquipmentOilMapping {
  const oil = db.prepare<[string], { id: string }>('SELECT id FROM oil_lubricants WHERE id = ?').get(oilLubricantId);
  if (!oil) throw badRequest('That oil/lubricant does not exist in the Global Oil & Lubricant Master.');

  const clash = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM equipment_oil_lubricants WHERE equipmentId = ? AND oilLubricantId = ?',
  ).get(equipmentId, oilLubricantId);
  if (clash) throw badRequest('That oil/lubricant is already assigned to this equipment.');

  const id = newId('eqoil');
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO equipment_oil_lubricants (id, equipmentId, oilLubricantId, status, createdBy, createdAt, updatedAt)
    VALUES (@id, @equipmentId, @oilLubricantId, 'Active', @createdBy, @createdAt, @updatedAt)
  `).run({ id, equipmentId, oilLubricantId, createdBy: user, createdAt: stamp, updatedAt: stamp });

  return db.prepare<[string], EquipmentOilMapping>(`${BASE_SELECT} WHERE m.id = ?`).get(id)!;
}

function removeMapping(id: string): EquipmentOilMapping {
  const existing = db.prepare<[string], EquipmentOilMapping>(`${BASE_SELECT} WHERE m.id = ?`).get(id);
  if (!existing) throw notFound('That assignment does not exist.');
  db.prepare('DELETE FROM equipment_oil_lubricants WHERE id = ?').run(id);
  return existing;
}

export const equipmentOilLubricantsModel = { listForEquipment, get, addMapping, removeMapping, usageByOil };
