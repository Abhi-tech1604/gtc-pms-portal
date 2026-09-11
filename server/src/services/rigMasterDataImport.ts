import * as XLSX from 'xlsx';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { rigKey, nameKey as excelNameKey, serialKey } from '../excel/normalize.js';
import { badRequest } from '../middleware/http.js';
import { audit } from './audit.js';
import { materialMasterModel } from './materialMaster.js';
import { createEquipment, matchCategory } from '../routes/equipment.js';

/**
 * Admin > Master > Equipment Master > Import Correct Master Data.
 *
 * Reads a multi-rig "Rig -> Equipment -> Make/Model/Sr.No -> Oil" workbook
 * (one row per machine, rig name only present on that rig's first row) and
 * reconciles it into the SAME tables every other screen already reads —
 * `equipment`, `oil_lubricants`, `equipment_oil_lubricants` — never a
 * separate Excel-only store.
 *
 * The two kinds of record are treated differently, on purpose:
 *
 * - `equipment` is what every historical DRR/PMS/ILM row points at by id, so
 *   a machine the workbook doesn't mention is only ever soft-deactivated
 *   (isActive = 0) — the exact flag every screen already filters on — and
 *   that history stays intact and viewable.
 * - The two global catalogs, `material_master` and `oil_lubricants`, carry no
 *   historical references (DRR stores the oil's NAME as a snapshot, and the
 *   only pointer to material_master is equipment.linkedEngine/TransmissionId,
 *   relinked before deletion), so records the workbook doesn't contain are
 *   deleted outright — they must not survive in any list, dropdown or search.
 */

export interface ParsedEquipmentRow {
  rigNameRaw: string;
  equipmentName: string;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  oilName: string | null;
  sourceRow: number;
}

const HEADER_HINTS = ['rig name', 'equipment', 's.no', 'sr. no', 'sr no'];

function findHeaderRow(raw: unknown[][]): number {
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const cells = (raw[i] ?? []).map((v) => String(v ?? '').trim().toLowerCase());
    if (cells.some((v) => HEADER_HINTS.includes(v))) return i;
  }
  return 0;
}

/** "-" and blank both mean "no value" throughout this workbook. */
function cell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '-' ? null : s;
}

export function parseRigEquipmentWorkbook(buffer: Buffer): ParsedEquipmentRow[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw badRequest(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false });
  const headerRow = findHeaderRow(raw);
  const headers = (raw[headerRow] ?? []).map((h) => String(h ?? '').trim().toLowerCase());

  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const rigCol = col('rig name', 'rig', 'rig no');
  const equipCol = col('equipment', 'equipment name', 'name');
  const makeCol = col('make', 'manufacturer');
  const modelCol = col('model');
  const serialCol = col('sr. no', 'sr no', 'serial no', 'serial number');
  const oilCol = col('oil', 'oil/lubricant', 'lubricant');
  if (equipCol === -1) {
    throw badRequest('Could not find an "Equipment" column in this workbook — check it matches the expected layout.');
  }

  const rows: ParsedEquipmentRow[] = [];
  let currentRigName: string | null = null;
  for (let i = headerRow + 1; i < raw.length; i++) {
    const r = raw[i] ?? [];
    const rigNameCell = rigCol !== -1 ? cell(r[rigCol]) : null;
    if (rigNameCell) currentRigName = rigNameCell;
    const equipmentName = equipCol !== -1 ? cell(r[equipCol]) : null;
    if (!equipmentName) continue; // blank separator row
    if (!currentRigName) continue; // equipment row before any rig name has ever appeared — unparseable, silently skipped
    rows.push({
      rigNameRaw: currentRigName,
      equipmentName,
      make: makeCol !== -1 ? cell(r[makeCol]) : null,
      model: modelCol !== -1 ? cell(r[modelCol]) : null,
      serialNumber: serialCol !== -1 ? cell(r[serialCol]) : null,
      oilName: oilCol !== -1 ? cell(r[oilCol]) : null,
      sourceRow: i + 1,
    });
  }
  return rows;
}

export interface PreviewRigGroup {
  rigNameRaw: string;
  matchedRigId: string | null;
  matchedRigNumber: string | null;
  matchedRigName: string | null;
  equipmentCount: number;
  equipment: { equipmentName: string; make: string | null; model: string | null; serialNumber: string | null; oilName: string | null }[];
  issues: string[];
}

export interface ImportPreview {
  totalRows: number;
  matchedRigs: number;
  unmatchedRigs: number;
  groups: PreviewRigGroup[];
}

/** Read-only — validates Rig names against Rig Master and required Equipment fields, writes nothing. */
export function buildImportPreview(rows: ParsedEquipmentRow[]): ImportPreview {
  const byRig = new Map<string, ParsedEquipmentRow[]>();
  for (const r of rows) {
    const list = byRig.get(r.rigNameRaw) ?? [];
    list.push(r);
    byRig.set(r.rigNameRaw, list);
  }

  const groups: PreviewRigGroup[] = [];
  for (const [rigNameRaw, group] of byRig) {
    const key = rigKey(rigNameRaw);
    const rig = key ? db.prepare<[string], { id: string; rigNumber: string; name: string }>(
      'SELECT id, rigNumber, name FROM rigs WHERE rigKey = ?',
    ).get(key) : undefined;

    const issues: string[] = [];
    if (!rig) issues.push(`"${rigNameRaw}" does not match any rig in Rig Master — this block will be skipped on import.`);
    const equipment = group.map((r) => ({ equipmentName: r.equipmentName, make: r.make, model: r.model, serialNumber: r.serialNumber, oilName: r.oilName }));
    const missingSerial = group.filter((r) => !r.serialNumber).length;
    if (missingSerial > 0) issues.push(`${missingSerial} row(s) have no Serial No. — imported anyway, just not uniquely identifiable by serial.`);

    groups.push({
      rigNameRaw,
      matchedRigId: rig?.id ?? null,
      matchedRigNumber: rig?.rigNumber ?? null,
      matchedRigName: rig?.name ?? null,
      equipmentCount: group.length,
      equipment,
      issues,
    });
  }
  groups.sort((a, b) => a.rigNameRaw.localeCompare(b.rigNameRaw));

  return {
    totalRows: rows.length,
    matchedRigs: groups.filter((g) => g.matchedRigId).length,
    unmatchedRigs: groups.filter((g) => !g.matchedRigId).length,
    groups,
  };
}

export interface CommitResult {
  rigsMatched: number;
  rigsUnmatched: number;
  unmatchedRigNames: string[];
  equipmentCreated: number;
  equipmentUpdated: number;
  equipmentDeactivated: number;
  oilLubricantsCreated: number;
  oilLubricantsRemoved: number;
  oilMappingsRemoved: number;
  materialsCreated: number;
  materialsUpdated: number;
  materialsRemoved: number;
  materialsRelinked: number;
  /** Equipment rows pointed at their Material Master record — what Location derives through. */
  equipmentLinked: number;
}

/** Oil Master dedupe key: same convention routes/oilLubricants.ts already uses for its own duplicate check. */
function oilNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Which workbook rows belong in Material Master, and as what.
 *
 * Transmission is tested first on purpose: every transmission row's name also
 * contains the word "engine" ("Rig Carrier Engine Transmission"), so an
 * engine-first test would file them all as engines. DG rows are engines — a
 * DG set is an engine-driven generator, and that is the bucket the existing
 * catalog already filed "DG Set - 1 (125 KVA)" under. Pump and BCU rows are
 * not Material Master records at all: they stay equipment-only.
 */
export function materialTypeFor(equipmentName: string): 'Engine' | 'Transmission' | null {
  const n = equipmentName.toLowerCase();
  if (n.includes('transmission')) return 'Transmission';
  if (n.includes('engine')) return 'Engine';
  if (/\bd\.?g\b/.test(n) || n.includes('kva')) return 'Engine';
  return null;
}

/** Material Master identity: the physical spec, so re-importing the same workbook updates rather than duplicates. */
function materialKey(type: string, name: string, make: string | null, model: string | null, serial: string | null): string {
  return [type, name, make ?? '', model ?? '', serial ?? '']
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
}

interface MaterialSyncCounts {
  created: number; updated: number; removed: number; relinked: number;
  /**
   * materialKey(...) -> material_master.id for everything this workbook
   * contains, so the equipment pass can point each machine at the catalog
   * record built from its OWN row. That link is what Material Master's
   * Location reads back through (Material -> Equipment -> Rig).
   */
  byKey: Map<string, string>;
}

/**
 * Rebuilds the global Engine/Transmission catalog from the workbook: every
 * engine/transmission row is upserted by its spec, and every record the
 * workbook does not contain is removed outright, so the catalog holds only
 * correct data. Nothing referenced is dropped blind: the ONLY thing pointing
 * at material_master anywhere in the schema is
 * equipment.linkedEngineId/linkedTransmissionId, and every such link is
 * repointed at the imported record for that same machine before its old
 * target is deleted (or cleared if the workbook has no equivalent). No
 * historical transaction references these rows at all — DRR/PMS/ILM records
 * reference `equipment`, which this import only ever soft-deactivates.
 * Admin can add/edit/deactivate normally afterwards — this runs only when an
 * import is confirmed.
 */
function syncMaterialMaster(rows: ParsedEquipmentRow[], user: string): MaterialSyncCounts {
  const counts: MaterialSyncCounts = { created: 0, updated: 0, removed: 0, relinked: 0, byKey: new Map() };
  const existing = db.prepare<[], {
    id: string; materialType: string; name: string; make: string | null; model: string | null; serialNumber: string | null; status: string;
  }>('SELECT id, materialType, name, make, model, serialNumber, status FROM material_master').all();
  const byKey = new Map(existing.map((m) => [materialKey(m.materialType, m.name, m.make, m.model, m.serialNumber), m.id]));

  const touched = new Set<string>();
  for (const row of rows) {
    const materialType = materialTypeFor(row.equipmentName);
    if (!materialType) continue;
    const key = materialKey(materialType, row.equipmentName, row.make, row.model, row.serialNumber);
    const existingId = byKey.get(key);
    const stamp = nowIso();
    if (existingId) {
      if (!touched.has(existingId)) {
        db.prepare("UPDATE material_master SET status = 'Active', source = 'Excel', updatedAt = @updatedAt WHERE id = @id")
          .run({ id: existingId, updatedAt: stamp });
        counts.updated += 1;
      }
      touched.add(existingId);
      counts.byKey.set(key, existingId);
      continue;
    }
    const created = materialMasterModel.createFromImport({
      materialType, name: row.equipmentName, make: row.make, model: row.model, serialNumber: row.serialNumber, status: 'Active',
    }, user);
    counts.created += 1;
    touched.add(created.id);
    byKey.set(key, created.id); // the same spec repeated on another rig reuses this one global record
    counts.byKey.set(key, created.id);
  }

  const obsolete = existing.filter((m) => !touched.has(m.id));
  for (const m of obsolete) {
    for (const column of ['linkedEngineId', 'linkedTransmissionId'] as const) {
      const linked = db.prepare<[string], { id: string; serialNumber: string | null; manufacturer: string | null; model: string | null }>(
        `SELECT id, serialNumber, manufacturer, model FROM equipment WHERE ${column} = ?`,
      ).all(m.id);
      for (const eq of linked) {
        // Prefer the imported record for this very machine (serial is the
        // physical identity); fall back to the same make+model spec.
        const wantType = column === 'linkedEngineId' ? 'Engine' : 'Transmission';
        const replacement = (eq.serialNumber
          ? db.prepare<[string, string], { id: string }>(
            'SELECT id FROM material_master WHERE materialType = ? AND serialNumber = ? LIMIT 1',
          ).get(wantType, eq.serialNumber)
          : undefined)
          ?? (eq.manufacturer && eq.model
            ? db.prepare<[string, string, string], { id: string }>(
              'SELECT id FROM material_master WHERE materialType = ? AND make = ? AND model = ? LIMIT 1',
            ).get(wantType, eq.manufacturer, eq.model)
            : undefined);
        const nextId = replacement && touched.has(replacement.id) ? replacement.id : null;
        db.prepare(`UPDATE equipment SET ${column} = @nextId, updatedAt = @updatedAt WHERE id = @id`)
          .run({ id: eq.id, nextId, updatedAt: nowIso() });
        if (nextId) counts.relinked += 1;
      }
    }
    db.prepare('DELETE FROM material_master WHERE id = ?').run(m.id);
    counts.removed += 1;
  }
  return counts;
}

/**
 * Makes the workbook's oils the only entries in Oil & Lubricant Master —
 * everything else is removed outright, so no old name can reach a dropdown,
 * search or new form.
 *
 * Historical DRR consumption is unaffected by design, not by luck:
 * drr_oil_lines stores `oilType` as the oil's NAME at the time the report was
 * saved (schema.sql), a snapshot, not a foreign key — so every past report
 * keeps reading exactly as it was filed. The one real reference is
 * equipment_oil_lubricants.oilLubricantId; those rows are the per-equipment
 * assignment this same import has just rebuilt from the workbook, so the ones
 * pointing at a removed oil are stale mappings and go with it (deleted
 * explicitly here rather than relying on the FK cascade, so they are counted
 * and the intent is visible).
 */
function syncOilMaster(rows: ParsedEquipmentRow[], user: string, createdCounter: { n: number }): { removed: number; mappingsRemoved: number } {
  const keep = new Set<string>();
  for (const row of rows) {
    if (!row.oilName) continue;
    keep.add(resolveOrCreateOil(row.oilName, user, createdCounter));
  }
  if (keep.size === 0) return { removed: 0, mappingsRemoved: 0 };

  const ids = [...keep];
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE oil_lubricants SET status = 'Active' WHERE id IN (${placeholders})`).run(...ids);
  const mappings = db.prepare(
    `DELETE FROM equipment_oil_lubricants WHERE oilLubricantId NOT IN (${placeholders})`,
  ).run(...ids);
  const oils = db.prepare(`DELETE FROM oil_lubricants WHERE id NOT IN (${placeholders})`).run(...ids);
  return { removed: oils.changes, mappingsRemoved: mappings.changes };
}

function resolveOrCreateOil(name: string, user: string, createdCounter: { n: number }): string {
  const key = oilNameKey(name);
  const existing = db.prepare<[string], { id: string }>('SELECT id FROM oil_lubricants WHERE nameKey = ?').get(key);
  if (existing) return existing.id;
  const id = newId('oil');
  db.prepare(`
    INSERT INTO oil_lubricants (id, name, nameKey, equipmentName, status, createdAt)
    VALUES (@id, @name, @nameKey, NULL, 'Active', @createdAt)
  `).run({ id, name: name.trim(), nameKey: key, createdAt: nowIso() });
  createdCounter.n += 1;
  return id;
}

/**
 * Commits the parsed workbook: for every rig block that matches Rig Master,
 * each equipment row is matched to an existing ACTIVE machine on that rig by
 * name (same nameKey convention equipment.ts already uses) and updated in
 * place, or created if no match exists. Any of that rig's previously-active
 * equipment this import never touched is deactivated (never deleted) — the
 * "replace the old incorrect mapping" step, done per rig so untouched rigs
 * are left alone entirely.
 */
export function commitImport(rows: ParsedEquipmentRow[], fileName: string, user: string, ip: string | null): CommitResult {
  const byRig = new Map<string, ParsedEquipmentRow[]>();
  for (const r of rows) {
    const list = byRig.get(r.rigNameRaw) ?? [];
    list.push(r);
    byRig.set(r.rigNameRaw, list);
  }

  let equipmentCreated = 0;
  let equipmentUpdated = 0;
  let equipmentDeactivated = 0;
  const oilCreatedCounter = { n: 0 };
  const unmatchedRigNames: string[] = [];
  let rigsMatched = 0;
  let materials: MaterialSyncCounts = { created: 0, updated: 0, removed: 0, relinked: 0, byKey: new Map() };
  let equipmentLinked = 0;
  let oils = { removed: 0, mappingsRemoved: 0 };

  transact(() => {
    // Master records first, then the equipment that references them — the
    // Excel -> Material/Oil Master -> Equipment Master order the app reads in.
    // Both are driven by every parsed row, not just the rows on matched rigs:
    // these two catalogs are global, not per-rig.
    materials = syncMaterialMaster(rows, user);
    oils = syncOilMaster(rows, user, oilCreatedCounter);

    for (const [rigNameRaw, group] of byRig) {
      const key = rigKey(rigNameRaw);
      const rig = key ? db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigKey = ?').get(key) : undefined;
      if (!rig) { unmatchedRigNames.push(rigNameRaw); continue; }
      rigsMatched += 1;

      const touchedEquipmentIds = new Set<string>();
      const existingActive = db.prepare<[string], { id: string; nameKey: string; serialKey: string | null }>(
        "SELECT id, nameKey, serialKey FROM equipment WHERE rigId = ? AND isActive = 1",
      ).all(rig.id);
      const byNameKey = new Map(existingActive.map((e) => [e.nameKey, e.id]));

      for (const row of group) {
        const category = matchCategory(row.equipmentName);
        const nk = excelNameKey(row.equipmentName);
        const sk = row.serialNumber ? (serialKey(row.serialNumber) || null) : null;

        // Serial first, name second. A rig can carry two machines sharing a
        // name but not a serial (Rig 100-01 has two "125 KVA DG"), and the
        // serial is what tells them apart — matching on name alone folded the
        // second into the first and lost a machine. The name fallback still
        // matters, and is why an existing machine whose serial the workbook
        // CORRECTS is updated in place (keeping its id, and the DRR/PMS/ILM
        // history hanging off it) instead of being replaced.
        const bySerial = sk ? existingActive.find((e) => e.serialKey === sk && !touchedEquipmentIds.has(e.id)) : undefined;
        const byName = byNameKey.get(nk);
        const existingId = bySerial?.id ?? (byName && !touchedEquipmentIds.has(byName) ? byName : undefined);

        let equipmentId: string;
        if (existingId) {
          const stamp = nowIso();
          // Name is updated too: matched by serial, this is the same physical
          // machine, so the workbook's name for it is the correct one.
          db.prepare(`
            UPDATE equipment SET name=@name, nameKey=@nameKey, manufacturer=@manufacturer, model=@model,
              serialNumber=@serialNumber, serialKey=@serialKey, category=@category, isActive=1, updatedAt=@updatedAt
            WHERE id=@id
          `).run({
            id: existingId, name: row.equipmentName, nameKey: nk,
            manufacturer: row.make, model: row.model, serialNumber: row.serialNumber,
            serialKey: sk, category, updatedAt: stamp,
          });
          equipmentUpdated += 1;
          equipmentId = existingId;
        } else {
          const created = createEquipment(rig.id, {
            name: row.equipmentName, category, manufacturer: row.make, model: row.model, serialNumber: row.serialNumber,
            isActive: true,
          }, user, ip);
          equipmentCreated += 1;
          equipmentId = created.id;
          // Visible to the rest of this rig block, so a repeat of the same
          // serial reuses it rather than creating another row.
          existingActive.push({ id: equipmentId, nameKey: nk, serialKey: sk });
          if (!byNameKey.has(nk)) byNameKey.set(nk, equipmentId);
        }
        touchedEquipmentIds.add(equipmentId);

        // Point this machine at the catalog record built from its own row.
        // One Excel row is ONE physical engine/transmission that appears both
        // as equipment (on a rig) and as a Material Master spec; without this
        // link the two sit side by side unconnected and Material Master's
        // Location has nothing to derive from. Pumps/BCU have no catalog
        // record, so their links are cleared rather than left stale.
        const materialType = materialTypeFor(row.equipmentName);
        const materialId = materialType
          ? materials.byKey.get(materialKey(materialType, row.equipmentName, row.make, row.model, row.serialNumber)) ?? null
          : null;
        db.prepare(`
          UPDATE equipment SET linkedEngineId = @engineId, linkedTransmissionId = @transmissionId, updatedAt = @updatedAt
          WHERE id = @id
        `).run({
          id: equipmentId,
          engineId: materialType === 'Engine' ? materialId : null,
          transmissionId: materialType === 'Transmission' ? materialId : null,
          updatedAt: nowIso(),
        });
        if (materialId) equipmentLinked += 1;

        if (row.oilName) {
          const oilId = resolveOrCreateOil(row.oilName, user, oilCreatedCounter);
          const mappingExists = db.prepare<[string, string], { id: string; status: string }>(
            'SELECT id, status FROM equipment_oil_lubricants WHERE equipmentId = ? AND oilLubricantId = ?',
          ).get(equipmentId, oilId);
          const stamp = nowIso();
          if (!mappingExists) {
            db.prepare(`
              INSERT INTO equipment_oil_lubricants (id, equipmentId, oilLubricantId, status, createdBy, createdAt, updatedAt)
              VALUES (@id, @equipmentId, @oilLubricantId, 'Active', @createdBy, @createdAt, @updatedAt)
            `).run({ id: newId('eqoil'), equipmentId, oilLubricantId: oilId, createdBy: user, createdAt: stamp, updatedAt: stamp });
          } else if (mappingExists.status !== 'Active') {
            db.prepare('UPDATE equipment_oil_lubricants SET status = @status, updatedAt = @updatedAt WHERE id = @id')
              .run({ id: mappingExists.id, status: 'Active', updatedAt: stamp });
          }
          // This equipment's OTHER oil mappings (e.g. from the old incorrect
          // setup, or a stale prior import) are no longer what the workbook
          // says — deactivate them, never delete, same "soft replace" rule
          // as equipment itself.
          db.prepare(`
            UPDATE equipment_oil_lubricants SET status = 'Inactive', updatedAt = @updatedAt
            WHERE equipmentId = @equipmentId AND oilLubricantId != @oilLubricantId AND status = 'Active'
          `).run({ equipmentId, oilLubricantId: oilId, updatedAt: stamp });
        }
      }

      // The "deactivate the old incorrect mapping" step — only for THIS rig, only rows this import never touched.
      const toDeactivate = existingActive.filter((e) => !touchedEquipmentIds.has(e.id));
      if (toDeactivate.length > 0) {
        const stamp = nowIso();
        const stmt = db.prepare('UPDATE equipment SET isActive = 0, updatedAt = @updatedAt WHERE id = @id');
        for (const e of toDeactivate) {
          stmt.run({ id: e.id, updatedAt: stamp });
          equipmentDeactivated += 1;
        }
      }
    }

    const historyId = newId('eqimp');
    db.prepare(`
      INSERT INTO equipment_master_imports (id, fileName, importedBy, importedAt, rigsMatched, rigsUnmatched,
        equipmentCreated, equipmentUpdated, equipmentDeactivated, oilLubricantsCreated, unmatchedRigNames,
        oilLubricantsRemoved, oilMappingsRemoved, materialsCreated, materialsUpdated, materialsRemoved, materialsRelinked)
      VALUES (@id, @fileName, @importedBy, @importedAt, @rigsMatched, @rigsUnmatched,
        @equipmentCreated, @equipmentUpdated, @equipmentDeactivated, @oilLubricantsCreated, @unmatchedRigNames,
        @oilLubricantsRemoved, @oilMappingsRemoved, @materialsCreated, @materialsUpdated, @materialsRemoved, @materialsRelinked)
    `).run({
      id: historyId, fileName, importedBy: user, importedAt: nowIso(),
      rigsMatched, rigsUnmatched: unmatchedRigNames.length,
      equipmentCreated, equipmentUpdated, equipmentDeactivated,
      oilLubricantsCreated: oilCreatedCounter.n, unmatchedRigNames: JSON.stringify(unmatchedRigNames),
      oilLubricantsRemoved: oils.removed, oilMappingsRemoved: oils.mappingsRemoved,
      materialsCreated: materials.created, materialsUpdated: materials.updated,
      materialsRemoved: materials.removed, materialsRelinked: materials.relinked,
    });
    audit({
      user, ip, action: 'equipment.masterImport', entity: 'equipment_master_imports', entityId: historyId,
      detail: `${fileName}: ${rigsMatched} rig(s), +${equipmentCreated}/${equipmentUpdated} upd/-${equipmentDeactivated} equipment, `
        + `material master +${materials.created}/-${materials.removed} (${materials.relinked} relinked), oil master +${oilCreatedCounter.n}/-${oils.removed}, ${equipmentLinked} equipment linked to catalog`,
    });
  });

  return {
    rigsMatched, rigsUnmatched: unmatchedRigNames.length, unmatchedRigNames,
    equipmentCreated, equipmentUpdated, equipmentDeactivated, oilLubricantsCreated: oilCreatedCounter.n,
    oilLubricantsRemoved: oils.removed, oilMappingsRemoved: oils.mappingsRemoved,
    materialsCreated: materials.created, materialsUpdated: materials.updated,
    materialsRemoved: materials.removed, materialsRelinked: materials.relinked,
    equipmentLinked,
  };
}

export interface ImportHistoryRow {
  id: string; fileName: string; importedBy: string; importedAt: string;
  rigsMatched: number; rigsUnmatched: number;
  equipmentCreated: number; equipmentUpdated: number; equipmentDeactivated: number;
  oilLubricantsCreated: number; oilLubricantsRemoved: number; oilMappingsRemoved: number;
  materialsCreated: number; materialsUpdated: number; materialsRemoved: number; materialsRelinked: number;
  unmatchedRigNames: string;
}

export function listImportHistory(): (Omit<ImportHistoryRow, 'unmatchedRigNames'> & { unmatchedRigNames: string[] })[] {
  const rows = db.prepare<[], ImportHistoryRow>(
    'SELECT * FROM equipment_master_imports ORDER BY importedAt DESC LIMIT 50',
  ).all();
  return rows.map((r) => ({ ...r, unmatchedRigNames: JSON.parse(r.unmatchedRigNames || '[]') }));
}
