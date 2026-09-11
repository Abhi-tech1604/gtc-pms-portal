import { Router } from 'express';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { rigKey } from '../excel/normalize.js';
import { requireAnyPage, requireAuth, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { config } from '../config.js';

export const rigsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

const RIG_STATUSES = ['Active', 'Idle', 'Maintenance'];
/** Admin > Rig Master's "Type" dropdown. Existing rows may still carry the older 'Work-Over' spelling — grandfathered through on save, never rewritten. */
const RIG_TYPES = ['Workover', 'Drilling'];
/** "Remarks" dropdown. Existing/imported rows may carry a value outside this list — grandfathered through on save, never rewritten. */
const REMARKS_OPTIONS = ['On Going Project', 'Rig Under Commissioning', 'Project will start further'];

interface RigRecord {
  id: string; name: string; rigNumber: string; rigKey: string; companyId: string | null;
  location: string | null; rigType: string | null; status: string;
  commissionDate: string | null;
  client: string | null; startDate: string | null; completionDate: string | null;
  remarksStatus: string | null; projectCoordinator: string | null;
  createdAt: string;
}

function assertRigNameUnique(name: string, excludeId: string | null): void {
  const clash = excludeId
    ? db.prepare<[string, string], { id: string }>('SELECT id FROM rigs WHERE lower(name) = lower(?) AND id != ?').get(name, excludeId)
    : db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE lower(name) = lower(?)').get(name);
  if (clash) throw badRequest(`A rig named "${name}" already exists. Rig Name must be unique.`);
}

/** Grandfathers through whatever value a rig already has (or an import supplies) even if it no longer matches the current dropdown list — never silently rewritten, only newly-typed values are constrained. */
function assertInListOrExisting(value: string, list: string[], existingValue: string | null | undefined, fieldLabel: string): void {
  if (list.includes(value) || value === existingValue) return;
  throw badRequest(`"${value}" is not a valid ${fieldLabel}.`);
}

function assertCompletionNotBeforeStart(startDate: string | null, completionDate: string | null): void {
  if (startDate && completionDate && completionDate < startDate) {
    throw badRequest('Completion Date cannot be before Start Date.');
  }
}

/** "WO"/"Work-Over"/etc. -> the form's canonical 'Workover'; anything else passes through unchanged (grandfathered, never guessed at). */
function normaliseRigTypeImport(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'wo' || v === 'w.o' || v === 'w.o.' || v === 'workover' || v === 'work-over' || v === 'work over') return 'Workover';
  if (v === 'drilling' || v === 'drlg') return 'Drilling';
  return value.trim();
}

/** Parses "9/7/24", "9/7/2024" (US M/D/Y, as this workbook displays them) or an already-ISO date into YYYY-MM-DD. "-" or blank means no date. */
function parseDateLoose(value: string | null): string | null {
  if (!value) return null;
  const s = value.trim();
  if (!s || s === '-') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mo, d, y] = m;
    let year = Number(y);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return `${year}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

/**
 * Some rig-master workbooks carry a merged title row above the real header
 * row (e.g. "Details of All Projects - GTC" spanning row 1, with "RIG Name",
 * "Type", "Client"... starting on row 2). Scanning for a row that actually
 * looks like a header — rather than always trusting row 1 — makes both
 * layouts work without asking the user to strip the title row first.
 */
function parseRowsSkippingTitle(ws: XLSX.WorkSheet): Record<string, unknown>[] {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false });
  const HEADER_HINTS = ['rig name', 'rig number', 'name', 'sl no', 'sr no'];
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const rowVals = (raw[i] ?? []).map((v) => String(v ?? '').trim().toLowerCase());
    if (rowVals.some((v) => HEADER_HINTS.includes(v))) { headerRowIndex = i; break; }
  }
  const headers = (raw[headerRowIndex] ?? []).map((h) => String(h ?? '').trim());
  return raw.slice(headerRowIndex + 1)
    .map((r) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, idx) => { if (h) obj[h] = (r as unknown[])[idx] ?? null; });
      return obj;
    })
    .filter((o) => Object.values(o).some((v) => v !== null && String(v).trim() !== ''));
}

/** Each rig row carries its equipment count and last reporting date (spec 6.3). */
const LIST_SQL = `
  SELECT r.*, c.name AS companyName,
         (SELECT COUNT(*) FROM equipment e WHERE e.rigId = r.id) AS equipmentCount,
         (SELECT MAX(l.logDate) FROM mechanical_log_rows l WHERE l.rigId = r.id) AS lastReportedDate,
         (SELECT COUNT(*) FROM mechanical_log_uploads u WHERE u.rigId = r.id) AS uploadCount
  FROM rigs r
  LEFT JOIN companies c ON c.id = r.companyId
`;

rigsRouter.get('/', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  if (scope?.length === 0) { res.json({ rigs: [] }); return; }
  const sql = scope
    ? `${LIST_SQL} WHERE r.id IN (${scope.map(() => '?').join(',')}) ORDER BY r.rigNumber`
    : `${LIST_SQL} ORDER BY r.rigNumber`;
  const stmt = db.prepare(sql);
  res.json({ rigs: scope ? stmt.all(...scope) : stmt.all() });
}));

rigsRouter.get('/:id', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  if (scope && !scope.includes(req.params.id)) throw new HttpError(403, 'This account is limited to its assigned rig(s).');
  const rig = db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(req.params.id);
  if (!rig) throw notFound('That rig does not exist.');
  res.json({ rig });
}));

/** The interactive Add Rig form's own required-field/date validation, ahead of createRig()'s shared insert logic — bulk import (POST /import) intentionally skips this so a legacy spreadsheet with no Client/Type column keeps working. */
rigsRouter.post('/', requireAuth, requireAnyPage(['PMS','rig_master','create'],['ADMIN','rig_master','create']), wrap((req, res) => {
  const body = req.body ?? {};
  if (!String(body.name ?? '').trim()) throw badRequest('Rig Name is required.');
  const rigType = String(body.rigType ?? '').trim();
  if (!rigType) throw badRequest('Type is required.');
  assertInListOrExisting(rigType, RIG_TYPES, null, 'Type');
  if (!String(body.client ?? '').trim()) throw badRequest('Client is required.');
  assertCompletionNotBeforeStart((body.startDate as string) || null, (body.completionDate as string) || null);
  const remarksStatus = String(body.remarksStatus ?? '').trim();
  if (remarksStatus) assertInListOrExisting(remarksStatus, REMARKS_OPTIONS, null, 'Remarks option');

  const rig = createRig(body, req.user!.username, req.clientIp ?? null);
  res.status(201).json({ rig });
}));

rigsRouter.put('/:id', requireAuth, requireAnyPage(['PMS','rig_master','edit'],['ADMIN','rig_master','edit']), wrap((req, res) => {
  const existing = db.prepare<[string], RigRecord>('SELECT * FROM rigs WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That rig does not exist.');

  const body = req.body ?? {};
  const name = String(body.name ?? existing.name).trim();
  if (!name) throw badRequest('Rig Name is required.');
  assertRigNameUnique(name, existing.id);

  // Rig Name is the rig's single identity: the form has no Rig Number field,
  // and createRig() already derives the number from the name. Editing had kept
  // the OLD number, so a rename left the two disagreeing ("GTC 160-01" the
  // number vs "RIG 160-01" the name) and every screen that pairs them showed
  // the rig twice. Deriving it here too keeps one name across the whole app.
  // An explicit rigNumber (bulk import) still wins.
  const rigNumber = String(body.rigNumber ?? name).trim();
  if (!rigNumber) throw badRequest('A rig number is required.');
  const key = rigKey(rigNumber);
  if (!key) throw badRequest(`"${rigNumber}" is not a usable rig name.`);
  const clash = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM rigs WHERE rigKey = ? AND id != ?',
  ).get(key, existing.id);
  if (clash) throw badRequest(`Another rig is already registered with a name that matches "${rigNumber}".`);

  const rigType = String(body.rigType ?? existing.rigType ?? '').trim();
  if (!rigType) throw badRequest('Type is required.');
  assertInListOrExisting(rigType, RIG_TYPES, existing.rigType, 'Type');

  const client = String(body.client ?? existing.client ?? '').trim();
  if (!client) throw badRequest('Client is required.');

  const startDate = body.startDate !== undefined ? ((body.startDate as string) || null) : (existing.startDate ?? null);
  const completionDate = body.completionDate !== undefined ? ((body.completionDate as string) || null) : (existing.completionDate ?? null);
  assertCompletionNotBeforeStart(startDate, completionDate);

  const remarksStatus = (body.remarksStatus as string) ?? existing.remarksStatus ?? null;
  if (remarksStatus) assertInListOrExisting(remarksStatus, REMARKS_OPTIONS, existing.remarksStatus, 'Remarks option');

  const next = {
    id: existing.id,
    name,
    rigNumber,
    rigKey: key,
    companyId: body.companyId ?? existing.companyId ?? null,
    location: body.location ?? existing.location ?? null,
    rigType,
    status: RIG_STATUSES.includes(body.status) ? body.status : existing.status,
    commissionDate: body.commissionDate ?? existing.commissionDate ?? null,
    client, startDate, completionDate, remarksStatus,
    projectCoordinator: (body.projectCoordinator as string) ?? existing.projectCoordinator ?? null,
  };

  db.prepare(`
    UPDATE rigs SET name=@name, rigNumber=@rigNumber, rigKey=@rigKey, companyId=@companyId,
      location=@location, rigType=@rigType, status=@status, commissionDate=@commissionDate,
      client=@client, startDate=@startDate, completionDate=@completionDate,
      remarksStatus=@remarksStatus, projectCoordinator=@projectCoordinator
    WHERE id=@id
  `).run(next);

  renameModuleRigs(existing.rigKey, next);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'rig.update', entity: 'rigs', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  res.json({ rig: db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(existing.id) });
}));

/**
 * Deleting a rig that still has equipment is blocked unless the caller explicitly
 * confirms the cascade, and the message names exactly what would be removed.
 */
rigsRouter.delete('/:id', requireAuth, requireAnyPage(['PMS','rig_master','delete'],['ADMIN','rig_master','delete']), wrap((req, res) => {
  const rig = db.prepare<[string], RigRecord>('SELECT * FROM rigs WHERE id = ?').get(req.params.id);
  if (!rig) throw notFound('That rig does not exist.');

  const counts = db.prepare<[string, string, string], { equipment: number; uploads: number; logRows: number }>(`
    SELECT (SELECT COUNT(*) FROM equipment WHERE rigId = ?) AS equipment,
           (SELECT COUNT(*) FROM mechanical_log_uploads WHERE rigId = ?) AS uploads,
           (SELECT COUNT(*) FROM mechanical_log_rows WHERE rigId = ?) AS logRows
  `).get(rig.id, rig.id, rig.id)!;

  const cascade = String(req.query.cascade ?? '') === 'true';
  if ((counts.equipment > 0 || counts.uploads > 0) && !cascade) {
    throw new HttpError(
      409,
      `${rig.rigNumber} still has ${counts.equipment} machine(s), ${counts.uploads} upload(s) and ` +
      `${counts.logRows} log row(s). Deleting the rig removes all of them. Confirm to continue.`,
      { requiresConfirmation: true, ...counts },
    );
  }

  transact(() => {
    // Scoped deletes, in dependency order. Never a broad predicate over a whole
    // table (spec 3.2 / 11.1).
    db.prepare('DELETE FROM mechanical_log_rows WHERE rigId = ?').run(rig.id);
    db.prepare('DELETE FROM health_check_records WHERE rigId = ?').run(rig.id);
    db.prepare('DELETE FROM mechanical_log_uploads WHERE rigId = ?').run(rig.id);
    db.prepare('DELETE FROM health_check_uploads WHERE rigId = ?').run(rig.id);
    db.prepare('DELETE FROM equipment WHERE rigId = ?').run(rig.id);
    db.prepare('DELETE FROM rig_holidays WHERE rigId = ?').run(rig.id);
    db.prepare('UPDATE users SET rigId = NULL WHERE rigId = ?').run(rig.id);
    db.prepare('DELETE FROM rigs WHERE id = ?').run(rig.id);
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'rig.delete',
      entity: 'rigs', entityId: rig.id, oldValue: rig,
      detail: `Removed ${counts.equipment} machines, ${counts.uploads} uploads, ${counts.logRows} log rows`,
    });
  });
  res.json({ ok: true, removed: counts });
}));

/* ---------------------------- bulk import ---------------------------- */

rigsRouter.get('/template/download', requireAuth, requireAnyPage(['PMS','rig_master','create'],['ADMIN','rig_master','create']), wrap(async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rigs');
  ws.columns = [
    { header: 'Rig Name', key: 'name', width: 22 },
    { header: 'Type', key: 'rigType', width: 14 },
    { header: 'Client', key: 'client', width: 18 },
    { header: 'Location', key: 'location', width: 22 },
    { header: 'Start Date', key: 'startDate', width: 14 },
    { header: 'Completion Date', key: 'completionDate', width: 16 },
    { header: 'Remarks', key: 'remarksStatus', width: 26 },
    { header: 'Project Coordinator', key: 'projectCoordinator', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({
    name: 'Rig 300-01', rigType: 'Drilling', client: 'ONGC', location: 'Sanand',
    startDate: '2026-09-01', completionDate: '', remarksStatus: 'On Going Project', projectCoordinator: 'Jane Doe',
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Rig_Master_Template.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

/**
 * Matches each row to an existing rig by the same rigKey normalisation used
 * everywhere else in this codebase ("GTC 50-01", "Rig 50-01" and "RIG-50-01"
 * are all the same rig) and UPDATES it in place — Rig Name, id, rigNumber
 * and Status are never touched by a match, only Type/Client/Location/Start
 * Date/Completion Date/Remarks/Project Coordinator, and only for cells the
 * sheet actually supplies (a blank cell never erases existing data). A row
 * with no match creates a new rig, exactly as before.
 */
rigsRouter.post('/import', requireAuth, requireAnyPage(['PMS','rig_master','create'],['ADMIN','rig_master','create']), upload.single('file'), wrap((req, res) => {
  if (!req.file) throw badRequest('Attach an Excel file to import.');
  let rows: Record<string, unknown>[];
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = parseRowsSkippingTitle(ws);
  } catch (err) {
    throw badRequest(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }

  const created: unknown[] = [];
  const updated: unknown[] = [];
  const skipped: { row: number; reason: string }[] = [];

  transact(() => {
    rows.forEach((row, i) => {
      const rigNumberCol = pick(row, ['Rig Number', 'rigNumber', 'RigNumber', 'Rig No']);
      const rigName = pick(row, ['Name', 'name', 'Rig Name', 'RIG Name']);
      const rigNumber = rigNumberCol ?? rigName;
      if (!rigNumber) {
        skipped.push({ row: i + 2, reason: 'No rig name/number in the row.' });
        return;
      }

      const fields = {
        location: pick(row, ['Location', 'location', 'Asset', 'asset']),
        rigType: normaliseRigTypeImport(pick(row, ['Rig Type', 'rigType', 'Type', 'type'])),
        commissionDate: pick(row, ['Commission Date', 'commissionDate']),
        client: pick(row, ['Client', 'client']),
        startDate: parseDateLoose(pick(row, ['Start Date', 'startDate'])),
        completionDate: parseDateLoose(pick(row, ['Completion Date', 'completionDate'])),
        remarksStatus: pick(row, ['Remarks', 'remarks', 'remarksStatus']),
        projectCoordinator: pick(row, ['Project Coordinator', 'projectCoordinator', 'Coordinator']),
      };

      try {
        const key = rigKey(rigNumber);
        const existing = key ? db.prepare<[string], RigRecord>('SELECT * FROM rigs WHERE rigKey = ?').get(key) : undefined;
        if (existing) {
          assertCompletionNotBeforeStart(
            fields.startDate ?? existing.startDate, fields.completionDate ?? existing.completionDate,
          );
          const next = {
            id: existing.id,
            location: fields.location ?? existing.location,
            rigType: fields.rigType ?? existing.rigType,
            commissionDate: fields.commissionDate ?? existing.commissionDate,
            client: fields.client ?? existing.client,
            startDate: fields.startDate ?? existing.startDate,
            completionDate: fields.completionDate ?? existing.completionDate,
            remarksStatus: fields.remarksStatus ?? existing.remarksStatus,
            projectCoordinator: fields.projectCoordinator ?? existing.projectCoordinator,
          };
          db.prepare(`
            UPDATE rigs SET location=@location, rigType=@rigType, commissionDate=@commissionDate,
              client=@client, startDate=@startDate, completionDate=@completionDate,
              remarksStatus=@remarksStatus, projectCoordinator=@projectCoordinator
            WHERE id=@id
          `).run(next);
          auditDiff(
            { user: req.user!.username, ip: req.clientIp, action: 'rig.import.update', entity: 'rigs', entityId: existing.id },
            existing as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>,
          );
          updated.push({ ...existing, ...next });
        } else {
          created.push(
            createRig(
              { rigNumber, name: rigName ?? rigNumber, ...fields },
              req.user!.username,
              req.clientIp ?? null,
            ),
          );
        }
      } catch (err) {
        skipped.push({ row: i + 2, reason: (err as Error).message });
      }
    });
  });

  res.json({ created: created.length, updated: updated.length, skipped, rigs: [...created, ...updated] });
}));

/** A lone "-" is this workbook's (and many others') placeholder for "no value yet" — treated the same as a blank cell, never stored literally. */
function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== '' && s !== '-') return s;
  }
  return null;
}

/**
 * Shared by both the interactive Add Rig form (POST /) and bulk Excel import
 * (POST /import). Rig Name uniqueness is enforced unconditionally here since
 * duplicate names are never acceptable regardless of source. Type/Client are
 * NOT hard-required here — the interactive form's own handler validates
 * those before calling this, so a legacy bulk-import spreadsheet with no
 * Client/Type column keeps working exactly as before.
 */
export function createRig(body: Record<string, unknown>, user: string, ip: string | null) {
  // The Add Rig form no longer has a Rig Number field — it's derived from
  // Rig Name so Excel workbook matching keeps working unchanged underneath.
  // Bulk import still supplies its own explicit rigNumber column.
  const rigNumber = String(body.rigNumber ?? body.name ?? '').trim();
  if (!rigNumber) throw badRequest('A rig number is required.');
  const key = rigKey(rigNumber);
  if (!key) throw badRequest(`"${rigNumber}" is not a usable rig number.`);

  const clash = db.prepare<[string], { rigNumber: string }>('SELECT rigNumber FROM rigs WHERE rigKey = ?').get(key);
  if (clash) throw badRequest(`"${clash.rigNumber}" is already registered and matches "${rigNumber}".`);

  const name = String(body.name ?? rigNumber).trim() || rigNumber;
  assertRigNameUnique(name, null);

  const record = {
    id: newId('rig'),
    name,
    rigNumber,
    rigKey: key,
    companyId: (body.companyId as string) ?? null,
    location: (body.location as string) ?? null,
    rigType: (body.rigType as string) ?? null,
    status: RIG_STATUSES.includes(body.status as string) ? (body.status as string) : 'Active',
    commissionDate: (body.commissionDate as string) ?? null,
    client: (body.client as string) ?? null,
    startDate: (body.startDate as string) ?? null,
    completionDate: (body.completionDate as string) ?? null,
    remarksStatus: (body.remarksStatus as string) ?? null,
    projectCoordinator: (body.projectCoordinator as string) ?? null,
    createdAt: nowIso(),
  };

  db.prepare(`
    INSERT INTO rigs (id, name, rigNumber, rigKey, companyId, location, rigType, status, commissionDate,
      client, startDate, completionDate, remarksStatus, projectCoordinator, createdAt)
    VALUES (@id, @name, @rigNumber, @rigKey, @companyId, @location, @rigType, @status, @commissionDate,
      @client, @startDate, @completionDate, @remarksStatus, @projectCoordinator, @createdAt)
  `).run(record);

  ensureModuleRigs(record);

  audit({ user, ip, action: 'rig.create', entity: 'rigs', entityId: record.id, newValue: record });
  return record;
}

/**
 * Gives a newly created rig its counterpart in the DPR and ILM rig masters.
 *
 * DPR and ILM keep their own rig tables (dpr_rigs/ilm_rigs), seeded once from
 * `rigs` and edited independently afterwards (db/index.ts). Nothing was
 * carrying a LATER addition across, so every rig added after that seed existed
 * in PMS only — and DRR, which bridges the two masters by rigKey, refused to
 * file a report for it ("the PMS and DPR rig masters have drifted apart").
 *
 * The counterpart is created with the SAME id, which is the convention the
 * original split relied on so ids stay interchangeable across the modules.
 * `INSERT OR IGNORE` on the unique rigKey means an existing counterpart (or a
 * rig the module already knows under that key) is left exactly as it is —
 * this only ever fills a gap, it never overwrites or re-creates.
 */
/**
 * Carries a rename through to the DPR and ILM rig masters, matched on the rig's
 * PREVIOUS key so the counterpart is found even when the new name changes it.
 * Without this a rename in PMS would leave those two showing the old name —
 * and, if the key moved, would break the rigKey bridge DRR/DPR/ILM resolve
 * through, which is the "rig masters have drifted apart" failure again.
 * A module row that has since been renamed independently (no key match) is
 * left alone rather than overwritten.
 */
function renameModuleRigs(previousKey: string, rig: { name: string; rigNumber: string; rigKey: string }): void {
  for (const table of ['dpr_rigs', 'ilm_rigs'] as const) {
    const target = db.prepare<[string], { id: string }>(`SELECT id FROM ${table} WHERE rigKey = ?`).get(previousKey);
    if (!target) continue;
    const taken = db.prepare<[string, string], { id: string }>(
      `SELECT id FROM ${table} WHERE rigKey = ? AND id != ?`,
    ).get(rig.rigKey, target.id);
    if (taken) continue; // another rig in that module already holds the new key — leave both untouched
    db.prepare(`UPDATE ${table} SET name = @name, rigNumber = @rigNumber, rigKey = @rigKey WHERE id = @id`)
      .run({ id: target.id, name: rig.name, rigNumber: rig.rigNumber, rigKey: rig.rigKey });
  }
}

function ensureModuleRigs(rig: { id: string; name: string; rigNumber: string; rigKey: string; status: string; createdAt: string }): void {
  for (const table of ['dpr_rigs', 'ilm_rigs'] as const) {
    db.prepare(`
      INSERT OR IGNORE INTO ${table} (id, name, rigNumber, rigKey, status, createdAt)
      VALUES (@id, @name, @rigNumber, @rigKey, @status, @createdAt)
    `).run({
      id: rig.id, name: rig.name, rigNumber: rig.rigNumber, rigKey: rig.rigKey,
      status: rig.status, createdAt: rig.createdAt,
    });
  }
}
