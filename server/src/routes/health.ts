import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { config } from '../config.js';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { isIsoDate, nowIso, parseCellDate, today } from '../util/date.js';
import { nameKey, serialKey } from '../excel/normalize.js';
import { buildHealthTemplateWorkbook } from '../excel/template.js';
import { cleanText } from '../util/num.js';
import { assertRigAllowed, requireAuth, requirePage, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { equipmentStatus } from '../services/calc.js';
import { resolveEquipmentHealthCheckupPending, resolveHealthCheckDueSoon } from '../services/notifications.js';

export const healthRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.xlsx', '.xls', '.xlsm'].includes(ext)) {
      cb(new HttpError(400, `"${file.originalname}" is not an Excel workbook.`));
      return;
    }
    cb(null, true);
  },
});

interface PendingHealth {
  planId: string;
  rigId: string;
  rigNumber: string;
  fileName: string;
  storedFileName: string;
  checkDate: string;
  records: ParsedHealthRow[];
  issues: { level: 'fatal' | 'warning'; message: string }[];
  duplicateUploadId: string | null;
  userId: string;
  createdAt: number;
}

interface ParsedHealthRow {
  equipmentId: string | null;
  machineName: string;
  serialNumber: string | null;
  matched: boolean;
  status: 'Normal' | 'Breakdown';
  inspector: string | null;
  remarks: string | null;
  date: string;
}

const pending = new Map<string, PendingHealth>();

/* ---------------------------- template ---------------------------- */

healthRouter.get('/template/:rigId', requireAuth, wrap(async (req, res) => {
  const rig = db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM rigs WHERE id = ?',
  ).get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');
  assertRigAllowed(req, rig.id);

  const checkDate = isIsoDate(req.query.date) ? (req.query.date as string) : today();
  const machines = db.prepare<[string], { name: string; serialNumber: string | null; makeModel: string | null }>(
    'SELECT name, serialNumber, model AS makeModel FROM equipment WHERE rigId = ? AND isActive = 1 ORDER BY section, name',
  ).all(rig.id);

  const buffer = await buildHealthTemplateWorkbook({ rigNumber: rig.rigNumber, checkDate, machines });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Health_Checkup_${rig.rigNumber.replace(/[^A-Za-z0-9-]+/g, '_')}_${checkDate}.xlsx"`,
  );
  res.send(buffer);
}));

/* ---------------------------- excel upload ---------------------------- */

healthRouter.post('/preview', requireAuth, requirePage('PMS','healthcheckup','create'),
  upload.single('file'), wrap((req, res) => {
    if (!req.file) throw badRequest('Attach a health checkup workbook to upload.');
    // Only auto-default the target rig when this account is scoped to exactly
    // one — a multi-rig account (several assigned rigs) has no single implied
    // default and must say which rig the workbook belongs to.
    const uploadScope = rigScope(req);
    const rigId = String(req.body?.rigId ?? '') || (uploadScope?.length === 1 ? uploadScope[0] : '');
    const rig = db.prepare<[string], { id: string; rigNumber: string }>(
      'SELECT id, rigNumber FROM rigs WHERE id = ?',
    ).get(rigId);
    if (!rig) throw badRequest('Choose the rig this health checkup workbook belongs to.');
    assertRigAllowed(req, rig.id);

    let sheet: Record<string, unknown>[];
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // Header row 3 in the generated template; range:2 skips the rig/date block.
      sheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, range: 2 });
    } catch (err) {
      throw badRequest(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
    }

    const candidates = db.prepare<[string], {
      id: string; name: string; nameKey: string; serialKey: string | null;
    }>('SELECT id, name, nameKey, serialKey FROM equipment WHERE rigId = ?').all(rig.id);

    const issues: PendingHealth['issues'] = [];
    const records: ParsedHealthRow[] = [];
    let checkDate = isIsoDate(req.body?.date) ? String(req.body.date) : today();

    for (const [i, raw] of sheet.entries()) {
      const machineName = cleanText(pick(raw, ['Equipment', 'equipment', 'Machine', 'Name']));
      if (!machineName) continue;
      const serial = cleanText(pick(raw, ['M/C Serial No', 'Serial No', 'serialNumber', 'Serial']));
      const rowDate = parseCellDate(pick(raw, ['Check Date', 'Date', 'date']));
      if (rowDate) checkDate = rowDate;

      const conditionText = cleanText(
        pick(raw, ['Condition (Normal/Breakdown)', 'Condition', 'Status', 'status']),
      );
      const status: 'Normal' | 'Breakdown' =
        conditionText && /break/i.test(conditionText) ? 'Breakdown' : 'Normal';

      const sk = serialKey(serial);
      const nk = nameKey(machineName);
      // Matching is scoped to the rig, exactly as for mechanical logs (D11).
      const match =
        (sk ? candidates.find((c) => c.serialKey && c.serialKey === sk) : undefined) ??
        candidates.find((c) => c.nameKey === nk);

      if (!match) {
        issues.push({
          level: 'warning',
          message: `Row ${i + 4}: "${machineName}" is not registered on ${rig.rigNumber} and will be skipped.`,
        });
      }

      records.push({
        equipmentId: match?.id ?? null,
        machineName,
        serialNumber: serial,
        matched: !!match,
        status,
        inspector: cleanText(pick(raw, ['Inspector', 'inspector'])),
        remarks: cleanText(pick(raw, ['Findings / Remarks', 'Remarks', 'Findings', 'remarks'])),
        date: rowDate ?? checkDate,
      });
    }

    if (records.filter((r) => r.matched).length === 0) {
      issues.push({ level: 'fatal', message: 'No row in this workbook matches a machine registered on this rig.' });
    }

    const storedFileName = `${Date.now()}_${newId('hf')}${path.extname(req.file.originalname).toLowerCase()}`;
    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    // A second health check workbook for the same rig on the same day prompts
    // for confirmation before proceeding (spec 6.6).
    const duplicate = db.prepare<[string, string], { id: string; fileName: string; uploadDate: string }>(
      `SELECT id, fileName, uploadDate FROM health_check_uploads
       WHERE rigId = ? AND checkDate = ? ORDER BY uploadDate DESC LIMIT 1`,
    ).get(rig.id, checkDate);

    const entry: PendingHealth = {
      planId: newId('hplan'),
      rigId: rig.id,
      rigNumber: rig.rigNumber,
      fileName: req.file.originalname,
      storedFileName,
      checkDate,
      records,
      issues,
      duplicateUploadId: duplicate?.id ?? null,
      userId: req.user!.id,
      createdAt: Date.now(),
    };
    pending.set(entry.planId, entry);

    res.json({
      preview: {
        planId: entry.planId,
        rig,
        fileName: entry.fileName,
        checkDate,
        records,
        issues,
        matched: records.filter((r) => r.matched).length,
        unmatched: records.filter((r) => !r.matched).length,
        duplicate: duplicate
          ? {
              message:
                `${rig.rigNumber} already has a health checkup workbook for ${checkDate} ` +
                `("${duplicate.fileName}", uploaded ${duplicate.uploadDate}). Confirm to continue.`,
              uploadId: duplicate.id,
            }
          : null,
      },
    });
  }));

healthRouter.post('/import/:planId', requireAuth, requirePage('PMS','healthcheckup','create'), wrap((req, res) => {
  const entry = pending.get(req.params.planId);
  if (!entry) throw notFound('That preview has expired. Upload the workbook again.');
  if (entry.userId !== req.user!.id) throw new HttpError(403, 'That preview belongs to another user.');
  assertRigAllowed(req, entry.rigId);

  if (entry.issues.some((i) => i.level === 'fatal')) {
    throw badRequest('This workbook has validation errors that must be resolved first.', {
      issues: entry.issues.filter((i) => i.level === 'fatal'),
    });
  }
  if (entry.duplicateUploadId && !req.body?.confirmDuplicate) {
    throw new HttpError(
      409,
      `${entry.rigNumber} already has a health checkup workbook for ${entry.checkDate}. Confirm to continue.`,
      { duplicateUploadId: entry.duplicateUploadId },
    );
  }

  const result = transact(() => {
    const uploadId = newId('hupl');
    db.prepare(`
      INSERT INTO health_check_uploads
        (id, rigId, fileName, storedFileName, uploadDate, checkDate, uploadedBy, recordsImported, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'Uploaded')
    `).run(uploadId, entry.rigId, entry.fileName, entry.storedFileName, nowIso(), entry.checkDate,
      req.user!.username);

    let imported = 0;
    for (const record of entry.records) {
      if (!record.equipmentId) continue;
      insertHealthRecord({
        equipmentId: record.equipmentId,
        rigId: entry.rigId,
        date: record.date,
        status: record.status,
        remarks: record.remarks,
        inspector: record.inspector,
        method: 'Excel',
        uploadId,
        user: req.user!.username,
        ip: req.clientIp ?? null,
      });
      imported++;
    }
    db.prepare('UPDATE health_check_uploads SET recordsImported = ? WHERE id = ?').run(imported, uploadId);
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'healthcheck.import',
      entity: 'health_check_uploads', entityId: uploadId,
      detail: `${entry.fileName} -> ${entry.rigNumber}: ${imported} checkups on ${entry.checkDate}`,
    });
    return { uploadId, imported };
  });

  pending.delete(entry.planId);
  res.json({ result });
}));

/* ---------------------------- manual entry ---------------------------- */

healthRouter.post('/records', requireAuth, requirePage('PMS','healthcheckup','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const equipment = db.prepare<[string], { id: string; rigId: string; name: string }>(
    'SELECT id, rigId, name FROM equipment WHERE id = ?',
  ).get(String(body.equipmentId ?? ''));
  if (!equipment) throw badRequest('Choose the machine this checkup applies to.');
  assertRigAllowed(req, equipment.rigId);

  const date = isIsoDate(body.date) ? body.date : today();
  const status = body.status === 'Breakdown' ? 'Breakdown' : 'Normal';

  const record = transact(() => insertHealthRecord({
    equipmentId: equipment.id,
    rigId: equipment.rigId,
    date,
    status,
    remarks: cleanText(body.remarks),
    inspector: cleanText(body.inspector),
    method: 'Manual',
    uploadId: null,
    user: req.user!.username,
    ip: req.clientIp ?? null,
  }));

  res.status(201).json({ record });
}));

healthRouter.get('/records', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (scope) {
    if (scope.length === 0) filters.push('1 = 0');
    else { filters.push(`h.rigId IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  }
  else if (req.query.rigId) { filters.push('h.rigId = ?'); params.push(req.query.rigId); }
  if (req.query.from) { filters.push('h.date >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('h.date <= ?'); params.push(req.query.to); }
  if (req.query.method) { filters.push('h.method = ?'); params.push(req.query.method); }
  if (req.query.status) { filters.push('h.status = ?'); params.push(req.query.status); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const records = db.prepare(`
    SELECT h.*, e.name AS equipmentName, e.serialNumber AS serialNumber, e.category AS category,
           r.rigNumber AS rigNumber, r.name AS rigName
    FROM health_check_records h
    JOIN equipment e ON e.id = h.equipmentId
    JOIN rigs r ON r.id = h.rigId
    ${where}
    ORDER BY h.date DESC, h.createdAt DESC
    LIMIT 1000
  `).all(...params);
  res.json({ records });
}));

healthRouter.get('/uploads', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  if (scope?.length === 0) { res.json({ uploads: [] }); return; }
  const sql = `
    SELECT u.*, r.rigNumber AS rigNumber, r.name AS rigName
    FROM health_check_uploads u JOIN rigs r ON r.id = u.rigId
    ${scope ? `WHERE u.rigId IN (${scope.map(() => '?').join(',')})` : ''}
    ORDER BY u.uploadDate DESC
  `;
  const stmt = db.prepare(sql);
  res.json({ uploads: scope ? stmt.all(...scope) : stmt.all() });
}));

/* ---------------------------- shared ---------------------------- */

/**
 * Logging a checkup updates the machine's lastHealthCheckDate and so resets its
 * countdown (spec 6.6). A Breakdown result also flags the machine, which takes
 * precedence over every service-based status (spec 9.3).
 */
function insertHealthRecord(input: {
  equipmentId: string; rigId: string; date: string;
  status: 'Normal' | 'Breakdown'; remarks: string | null; inspector: string | null;
  method: 'Excel' | 'Manual'; uploadId: string | null; user: string; ip: string | null;
}) {
  const id = newId('hc');
  db.prepare(`
    INSERT INTO health_check_records
      (id, equipmentId, rigId, date, status, remarks, inspector, method, uploadId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.equipmentId, input.rigId, input.date, input.status, input.remarks,
    input.inspector, input.method, input.uploadId, nowIso());

  const current = db.prepare<[string], { lastHealthCheckDate: string | null; isBreakdown: number }>(
    'SELECT lastHealthCheckDate, isBreakdown FROM equipment WHERE id = ?',
  ).get(input.equipmentId)!;

  // Only move the countdown forward; a back-dated entry must not undo a newer one.
  const nextDate = !current.lastHealthCheckDate || input.date > current.lastHealthCheckDate
    ? input.date
    : current.lastHealthCheckDate;

  const isBreakdown = input.status === 'Breakdown' ? 1 : 0;
  const hours = db.prepare<[string], {
    currentRunningHours: number; lastServiceHours: number; serviceInterval: number;
  }>('SELECT currentRunningHours, lastServiceHours, serviceInterval FROM equipment WHERE id = ?')
    .get(input.equipmentId)!;

  db.prepare(`
    UPDATE equipment SET lastHealthCheckDate = ?, isBreakdown = ?, status = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    nextDate,
    isBreakdown,
    equipmentStatus({ ...hours, isBreakdown: !!isBreakdown }),
    nowIso(),
    input.equipmentId,
  );

  audit({
    user: input.user, ip: input.ip, action: 'healthcheck.log',
    entity: 'equipment', entityId: input.equipmentId,
    field: 'lastHealthCheckDate',
    oldValue: current.lastHealthCheckDate, newValue: nextDate,
    detail: `${input.method} health checkup recorded as ${input.status}`,
  });

  // The requirement this machine's overdue notification named is now met;
  // resolve it rather than delete it, so the history stays intact.
  resolveEquipmentHealthCheckupPending(input.equipmentId);
  resolveHealthCheckDueSoon(input.equipmentId);

  return db.prepare('SELECT * FROM health_check_records WHERE id = ?').get(id);
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== null && row[k] !== undefined && String(row[k]).trim() !== '') return row[k];
  }
  return null;
}
