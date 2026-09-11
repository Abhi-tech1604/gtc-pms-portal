import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { monthOf, nowIso, today } from '../util/date.js';
import { parseWorkbook } from '../excel/parseWorkbook.js';
import { commitIngestion, planIngestion, type IngestPlan } from '../excel/ingest.js';
import { buildTemplateWorkbook, templateFileName, type TemplateMachine } from '../excel/template.js';
import { assertRigAllowed, requireAuth, requireRight, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';

export const logsRouter = Router();

const ALLOWED_EXT = new Set(['.xlsx', '.xls', '.xlsm']);

/** Uploads are restricted by extension and size and parsed defensively (spec 11.4). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      cb(new HttpError(400, `"${file.originalname}" is not an Excel workbook. Upload a .xlsx or .xls file.`));
      return;
    }
    cb(null, true);
  },
});

/**
 * Parsed-but-uncommitted uploads. The file itself is already on disk; only the
 * plan is held in memory, and nothing is written to the database until the user
 * presses Import.
 */
interface PendingUpload {
  plan: IngestPlan;
  userId: string;
  createdAt: number;
}
const pending = new Map<string, PendingUpload>();
const PENDING_TTL_MS = 60 * 60 * 1000;

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) {
      pending.delete(id);
      safeUnlink(entry.plan.storedFileName);
    }
  }
}

function safeUnlink(storedFileName: string | null): void {
  if (!storedFileName) return;
  const full = path.join(config.uploadDir, storedFileName);
  if (fs.existsSync(full)) {
    try { fs.unlinkSync(full); } catch { /* the file is already gone */ }
  }
}

/* ---------------------------- template ---------------------------- */

logsRouter.get('/template/:rigId', requireAuth, wrap(async (req, res) => {
  const rig = db.prepare<[string], { id: string; name: string; rigNumber: string }>(
    'SELECT id, name, rigNumber FROM rigs WHERE id = ?',
  ).get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');
  assertRigAllowed(req, rig.id);

  const logMonth = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month
    : monthOf(today());

  // Equipment Master is the single source of truth for what a fresh template
  // offers; a machine marked inactive there is left out of new templates
  // entirely, though its historical log rows are never touched.
  const machines = db.prepare<[string], TemplateMachine>(`
    SELECT name, model AS makeModel, serialNumber, currentRunningHours, lastServiceHours,
           serviceInterval, section
    FROM equipment WHERE rigId = ? AND isActive = 1 ORDER BY section, name
  `).all(rig.id);

  const buffer = await buildTemplateWorkbook({
    rigNumber: rig.rigNumber,
    rigName: rig.name,
    logMonth,
    wellNumber: '',
    machines: machines.map((m) => ({ ...m, section: m.section === 'generator' ? 'generator' : 'diesel' })),
  });

  audit({
    user: req.user!.username, ip: req.clientIp, action: 'template.download',
    entity: 'rigs', entityId: rig.id, detail: `${rig.rigNumber} ${logMonth}`,
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${templateFileName(rig.rigNumber, logMonth)}"`);
  res.send(buffer);
}));

/* ---------------------------- preview ---------------------------- */

logsRouter.post('/preview', requireAuth, requireRight('canUploadMechanicalLogs'),
  upload.single('file'), wrap((req, res) => {
    sweepPending();
    if (!req.file) throw badRequest('Attach a Daily Mechanical Report workbook to upload.');

    const parsed = parseWorkbook(req.file.buffer, {
      fallbackLogMonth: typeof req.body?.logMonth === 'string' ? req.body.logMonth : undefined,
    });

    const storedFileName = `${Date.now()}_${newId('f')}${path.extname(req.file.originalname).toLowerCase()}`;
    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    // Only auto-default the target rig when this account is scoped to exactly
    // one — a multi-rig account has no single implied default.
    const uploadScope = rigScope(req);
    const selectedRigId = str(req.body?.rigId) ?? (uploadScope?.length === 1 ? uploadScope[0] : null);
    const plan = planIngestion({
      parsed,
      fileName: req.file.originalname,
      storedFileName,
      selectedRigId,
      confirmedRigId: str(req.body?.confirmedRigId),
      logMonthOverride: str(req.body?.logMonth),
      acknowledged: parseAck(req.body?.acknowledged),
      lastFilledDayOverride: parseDay(req.body?.lastFilledDayOverride),
    });

    // A rig-scoped user may not file a workbook against another rig (spec 11.4).
    if (plan.rig) assertRigAllowed(req, plan.rig.id);

    pending.set(plan.planId, { plan, userId: req.user!.id, createdAt: Date.now() });
    res.json({ preview: toPreview(plan) });
  }));

/** Re-plans an already-uploaded file after the user answers a confirmation gate. */
logsRouter.post('/preview/:planId/resolve', requireAuth, requireRight('canUploadMechanicalLogs'),
  wrap((req, res) => {
    const entry = pending.get(req.params.planId);
    if (!entry) throw notFound('That preview has expired. Upload the workbook again.');
    if (entry.userId !== req.user!.id) throw new HttpError(403, 'That preview belongs to another user.');

    const filePath = path.join(config.uploadDir, entry.plan.storedFileName);
    if (!fs.existsSync(filePath)) throw notFound('The uploaded file is no longer available. Upload it again.');

    const parsed = parseWorkbook(fs.readFileSync(filePath), {
      fallbackLogMonth: str(req.body?.logMonth) ?? entry.plan.logMonth ?? undefined,
    });
    const plan = planIngestion({
      parsed,
      fileName: entry.plan.fileName,
      storedFileName: entry.plan.storedFileName,
      selectedRigId: entry.plan.rig?.id ?? null,
      confirmedRigId: str(req.body?.confirmedRigId) ?? (entry.plan.rigResolvedFrom === 'user' ? entry.plan.rig?.id : null),
      logMonthOverride: str(req.body?.logMonth) ?? entry.plan.logMonth,
      acknowledged: parseAck(req.body?.acknowledged),
      lastFilledDayOverride: 'lastFilledDayOverride' in (req.body ?? {})
        ? parseDay(req.body?.lastFilledDayOverride)
        : entry.plan.lastFilledDayOverride,
    });
    if (plan.rig) assertRigAllowed(req, plan.rig.id);

    pending.delete(entry.plan.planId);
    pending.set(plan.planId, { plan, userId: req.user!.id, createdAt: Date.now() });
    res.json({ preview: toPreview(plan) });
  }));

/* ---------------------------- import ---------------------------- */

logsRouter.post('/import/:planId', requireAuth, requireRight('canUploadMechanicalLogs'), wrap((req, res) => {
  const entry = pending.get(req.params.planId);
  if (!entry) throw notFound('That preview has expired. Upload the workbook again.');
  if (entry.userId !== req.user!.id) throw new HttpError(403, 'That preview belongs to another user.');

  const { plan } = entry;
  if (!plan.rig) {
    throw badRequest('Choose the rig this workbook belongs to before importing.');
  }
  assertRigAllowed(req, plan.rig.id);

  const fatal = plan.issues.filter((i) => i.level === 'fatal');
  if (fatal.length > 0) {
    // If any fatal validation error exists, nothing is imported (spec 11.2).
    throw badRequest('This workbook has validation errors that must be resolved first.', { issues: fatal });
  }

  // Each gate of section 8.7 blocks the import until the user answers it.
  const mismatch = plan.gates.find((g) => g.kind === 'rigMismatch');
  if (mismatch && plan.rigResolvedFrom !== 'user') {
    throw new HttpError(409, mismatch.message, { gates: [mismatch] });
  }
  const lastDay = plan.gates.find((g) => g.kind === 'lastFilledDay');
  if (lastDay && !req.body?.confirmLastFilledDay) {
    throw new HttpError(409, lastDay.message, { gates: [lastDay] });
  }
  const dup = plan.gates.find((g) => g.kind === 'duplicateUpload');
  if (dup && !req.body?.confirmOverwrite) {
    throw new HttpError(409, dup.message, { gates: [dup] });
  }

  const excludedKeys = Array.isArray(req.body?.excludedKeys)
    ? new Set<string>((req.body.excludedKeys as unknown[]).filter((k): k is string => typeof k === 'string'))
    : undefined;

  const result = commitIngestion(plan, { user: req.user!.username, ip: req.clientIp ?? null }, excludedKeys);
  pending.delete(plan.planId);

  res.json({ result, preview: toPreview(plan) });
}));

logsRouter.delete('/preview/:planId', requireAuth, wrap((req, res) => {
  const entry = pending.get(req.params.planId);
  if (entry && entry.userId === req.user!.id) {
    safeUnlink(entry.plan.storedFileName);
    pending.delete(req.params.planId);
  }
  res.json({ ok: true });
}));

/* ---------------------------- registry ---------------------------- */

logsRouter.get('/uploads', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (scope) {
    if (scope.length === 0) filters.push('1 = 0');
    else { filters.push(`u.rigId IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  }
  else if (req.query.rigId) { filters.push('u.rigId = ?'); params.push(req.query.rigId); }
  if (req.query.from) { filters.push('date(u.uploadDate) >= date(?)'); params.push(req.query.from); }
  if (req.query.to) { filters.push('date(u.uploadDate) <= date(?)'); params.push(req.query.to); }
  if (req.query.month) { filters.push('u.logMonth = ?'); params.push(req.query.month); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const uploads = db.prepare(`
    SELECT u.*, r.name AS rigName, r.rigNumber AS rigNumber
    FROM mechanical_log_uploads u
    JOIN rigs r ON r.id = u.rigId
    ${where}
    ORDER BY u.uploadDate DESC
  `).all(...params);
  res.json({ uploads });
}));

logsRouter.get('/uploads/:id/file', requireAuth, wrap((req, res) => {
  const row = db.prepare<[string], { fileName: string; storedFileName: string | null; rigId: string }>(
    'SELECT fileName, storedFileName, rigId FROM mechanical_log_uploads WHERE id = ?',
  ).get(req.params.id);
  if (!row) throw notFound('That upload does not exist.');
  assertRigAllowed(req, row.rigId);
  if (!row.storedFileName) throw notFound('The original file for this upload is no longer stored.');
  const full = path.join(config.uploadDir, row.storedFileName);
  if (!fs.existsSync(full)) throw notFound('The original file for this upload is no longer on disk.');
  res.download(full, row.fileName);
}));

/**
 * Deletes exactly one upload and its own log rows, by primary key. No other
 * upload for this or any other rig is touched (defect D10).
 */
logsRouter.delete('/uploads/:id', requireAuth, requireRight('canUploadMechanicalLogs'), wrap((req, res) => {
  const row = db.prepare<[string], {
    id: string; rigId: string; fileName: string; recordsImported: number;
  }>('SELECT id, rigId, fileName, recordsImported FROM mechanical_log_uploads WHERE id = ?')
    .get(req.params.id);
  if (!row) throw notFound('That upload does not exist.');
  assertRigAllowed(req, row.rigId);

  transact(() => {
    db.prepare('DELETE FROM mechanical_log_rows WHERE uploadId = ?').run(row.id);
    db.prepare('DELETE FROM mechanical_log_uploads WHERE id = ?').run(row.id);
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'upload.delete',
      entity: 'mechanical_log_uploads', entityId: row.id, oldValue: row,
      detail: `Deleted ${row.fileName} and its ${row.recordsImported} log rows`,
    });
  });
  res.json({ ok: true });
}));

/* ---------------------------- log data ---------------------------- */

logsRouter.get('/rows', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (scope) {
    if (scope.length === 0) filters.push('1 = 0');
    else { filters.push(`l.rigId IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  }
  else if (req.query.rigId) { filters.push('l.rigId = ?'); params.push(req.query.rigId); }
  if (req.query.month) { filters.push("strftime('%Y-%m', l.logDate) = ?"); params.push(req.query.month); }
  if (req.query.day) { filters.push('l.sheetDay = ?'); params.push(Number(req.query.day)); }
  if (req.query.date) { filters.push('l.logDate = ?'); params.push(req.query.date); }
  if (req.query.uploadId) { filters.push('l.uploadId = ?'); params.push(req.query.uploadId); }
  if (req.query.equipmentId) { filters.push('l.equipmentId = ?'); params.push(req.query.equipmentId); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit ?? 500), 2000);
  const rows = db.prepare(`
    SELECT l.*, e.name AS equipmentName, e.category AS equipmentCategory,
           r.rigNumber AS rigNumber, r.name AS rigName, u.fileName
    FROM mechanical_log_rows l
    JOIN equipment e ON e.id = l.equipmentId
    JOIN rigs r ON r.id = l.rigId
    JOIN mechanical_log_uploads u ON u.id = l.uploadId
    ${where}
    ORDER BY l.logDate DESC, e.section, e.name
    LIMIT ${limit}
  `).all(...params);
  res.json({ rows });
}));

/* ---------------------------- helpers ---------------------------- */

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

function parseAck(v: unknown): Record<string, boolean> {
  if (!v) return {};
  if (typeof v === 'object') return v as Record<string, boolean>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

function parseDay(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

/** The shape the preview screen renders: a day selector plus every parsed row. */
function toPreview(plan: IngestPlan) {
  const byDay = new Map<number, unknown[]>();
  for (const machine of plan.machines) {
    for (const row of machine.rows) {
      if (!byDay.has(row.sheetDay)) byDay.set(row.sheetDay, []);
      byDay.get(row.sheetDay)!.push({
        ...row,
        groupKey: machine.groupKey,
        machine: machine.name,
        serial: machine.serial,
        section: machine.section,
        isNew: machine.isNew,
        matchedBy: machine.matchedBy,
      });
    }
  }
  return {
    planId: plan.planId,
    fileName: plan.fileName,
    rig: plan.rig,
    rigResolvedFrom: plan.rigResolvedFrom,
    rigNumberInFile: plan.rigNumberInFile,
    logMonth: plan.logMonth,
    lastFilledDay: plan.lastFilledDay,
    lastFilledDate: plan.lastFilledDate,
    availableDays: plan.availableDays,
    lastFilledDayOverride: plan.lastFilledDayOverride,
    totals: plan.totals,
    gates: plan.gates,
    issues: plan.issues,
    machines: plan.machines.map((m) => ({
      groupKey: m.groupKey,
      name: m.name,
      serial: m.serial,
      makeModel: m.makeModel,
      section: m.section,
      isNew: m.isNew,
      matchedBy: m.matchedBy,
      dayCount: m.rows.length,
      update: m.update,
    })),
    days: [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, rows]) => ({ day, rows })),
    generatedAt: nowIso(),
  };
}
