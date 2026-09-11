import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { notFound, badRequest } from '../middleware/http.js';

/**
 * Material Master: a single global Engine/Transmission catalog, independent
 * of any rig (schema.sql: material_master). The same physical-spec record is
 * reusable across many rigs' equipment — equipment links to a material
 * record via equipment.linkedEngineId/linkedTransmissionId, not the other
 * way around, so one material row can be linked from many equipment rows.
 */

export type MaterialType = 'Engine' | 'Transmission';

export interface MaterialMasterRecord {
  id: string;
  materialType: MaterialType;
  name: string;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  status: 'Active' | 'Inactive';
  source: 'Manual' | 'Excel';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * What every screen shows: `derivedLocation` when the record is in use,
   * otherwise the manual fallback. Null means "Not Assigned".
   */
  location: string | null;
  /**
   * The rig(s) of the ACTIVE equipment currently linked to this record,
   * DERIVED on every read from Material Master -> Equipment -> Rig and never
   * stored — link the material to equipment on another rig, or transfer that
   * equipment, and this follows automatically. Null when nothing uses it.
   */
  derivedLocation: string | null;
  /**
   * Admin-entered location, only meaningful while `derivedLocation` is null
   * (a spare sitting in a yard). It is never allowed to contradict the real
   * thing: the moment the record is linked to equipment, `derivedLocation`
   * takes over and this is cleared.
   */
  manualLocation: string | null;
}

export interface MaterialMasterInput {
  materialType: MaterialType;
  name: string;
  make?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  status?: 'Active' | 'Inactive';
  /** Accepted only while the record is not linked to equipment — see MaterialMasterRecord.manualLocation. */
  manualLocation?: string | null;
}

/**
 * `derivedLocation` is computed here rather than stored: the rigs of the
 * ACTIVE equipment currently linked to this material. A material fitted to
 * equipment that has since been deactivated, or never linked at all, reads as
 * null — the "Not Assigned" case, where `manualLocation` may stand in.
 * (group_concat handles the rare case of one spec linked from equipment on
 * more than one rig, rather than silently hiding it.)
 */
const DERIVED_LOCATION = `
  (SELECT group_concat(DISTINCT r.name)
     FROM equipment e JOIN rigs r ON r.id = e.rigId
    WHERE e.isActive = 1
      AND (e.linkedEngineId = m.id OR e.linkedTransmissionId = m.id))
`;

const BASE_SELECT = `
  SELECT m.id, m.materialType, m.name, m.make, m.model, m.serialNumber, m.status, m.source,
         m.createdBy, m.createdAt, m.updatedAt,
         m.manualLocation,
         ${DERIVED_LOCATION} AS derivedLocation,
         COALESCE(${DERIVED_LOCATION}, m.manualLocation) AS location
  FROM material_master m
`;

export interface MaterialMasterFilters {
  materialType?: string;
  status?: string;
  /** Matches across name, make, model, serial and location — the one "search everything" box. */
  search?: string;
  name?: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  location?: string;
}

/** Case-insensitive "contains", with a null field never matching a non-empty needle. */
function has(value: string | null, needle: string): boolean {
  return String(value ?? '').toLowerCase().includes(needle);
}

function list(filters: MaterialMasterFilters): MaterialMasterRecord[] {
  let rows = db.prepare<[], MaterialMasterRecord>(`${BASE_SELECT} ORDER BY m.name`).all();
  if (filters.materialType) rows = rows.filter((r) => r.materialType === filters.materialType);
  if (filters.status) rows = rows.filter((r) => r.status === filters.status);

  const field: [keyof MaterialMasterFilters, (r: MaterialMasterRecord) => string | null][] = [
    ['name', (r) => r.name], ['make', (r) => r.make], ['model', (r) => r.model],
    ['serialNumber', (r) => r.serialNumber], ['location', (r) => r.location],
  ];
  for (const [key, read] of field) {
    const raw = filters[key];
    if (!raw) continue;
    const needle = String(raw).trim().toLowerCase();
    if (!needle) continue;
    // "Not Assigned" is a real, searchable state, not a missing value.
    if (key === 'location' && 'not assigned'.includes(needle)) {
      rows = rows.filter((r) => !r.location || has(r.location, needle));
      continue;
    }
    rows = rows.filter((r) => has(read(r), needle));
  }

  if (filters.search) {
    const needle = filters.search.toLowerCase();
    rows = rows.filter((r) =>
      [r.name, r.make, r.model, r.serialNumber, r.location]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)));
  }
  return rows;
}

function get(id: string): MaterialMasterRecord | undefined {
  return db.prepare<[string], MaterialMasterRecord>(`${BASE_SELECT} WHERE m.id = ?`).get(id);
}

function create(input: MaterialMasterInput, user: string): MaterialMasterRecord {
  const name = input.name?.trim();
  if (!name) throw badRequest('A name is required.');
  if (input.materialType !== 'Engine' && input.materialType !== 'Transmission') {
    throw badRequest('Material type must be Engine or Transmission.');
  }
  const id = newId('mat');
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO material_master (id, rigId, equipmentId, materialType, name, make, model, serialNumber, status, source, manualLocation, createdBy, createdAt, updatedAt)
    VALUES (@id, NULL, NULL, @materialType, @name, @make, @model, @serialNumber, @status, @source, @manualLocation, @createdBy, @createdAt, @updatedAt)
  `).run({
    id, materialType: input.materialType, name,
    make: input.make ?? null, model: input.model ?? null, serialNumber: input.serialNumber ?? null,
    status: input.status === 'Inactive' ? 'Inactive' : 'Active',
    // A brand-new record is by definition not linked to equipment yet.
    manualLocation: input.manualLocation?.trim() || null,
    source: 'Manual', createdBy: user, createdAt: stamp, updatedAt: stamp,
  });
  return get(id)!;
}

function createFromImport(input: MaterialMasterInput, user: string): MaterialMasterRecord {
  const record = create(input, user);
  db.prepare('UPDATE material_master SET source = \'Excel\' WHERE id = ?').run(record.id);
  return { ...record, source: 'Excel' };
}

function update(id: string, input: Partial<MaterialMasterInput>): MaterialMasterRecord {
  const existing = get(id);
  if (!existing) throw notFound('That record does not exist.');

  // The single rule that keeps Location honest: a record in use on a rig takes
  // its location from that equipment, so a manual value is neither accepted
  // nor kept for it. Only an unassigned record can carry one.
  const manualLocation = input.manualLocation === undefined
    ? (existing.derivedLocation ? null : undefined)
    : (existing.derivedLocation ? null : (input.manualLocation?.trim() || null));

  const next = {
    manualLocation,
    name: input.name !== undefined ? String(input.name).trim() || null : undefined,
    make: input.make !== undefined ? (input.make || null) : undefined,
    model: input.model !== undefined ? (input.model || null) : undefined,
    serialNumber: input.serialNumber !== undefined ? (input.serialNumber || null) : undefined,
    status: input.status !== undefined ? (input.status === 'Inactive' ? 'Inactive' : 'Active') : undefined,
  };
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    sets.push(`${key} = @${key}`);
    params[key] = value;
  }
  sets.push('updatedAt = @updatedAt');
  params.updatedAt = nowIso();
  db.prepare(`UPDATE material_master SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id)!;
}

export const materialMasterModel = { list, get, create, createFromImport, update };
