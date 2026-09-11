import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { buildDrrTemplateWorkbook, drrTemplateFileName } from '../excel/drrTemplate.js';
import { parseDrrWorkbook, type DrrIssue, type ParsedDrr } from '../excel/drrIngest.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import {
  saveReport, type DrrPayload, type EquipmentLineInput, type OilLineInput, type HydraulicLineInput,
  validate as validateDrrPayload,
} from './dailyRigReport.js';
import { getPreviousEquipmentHours, getPreviousHydraulicLevel, getPreviousOilBalance } from '../services/drrCarryForward.js';

/**
 * Admin-only Excel Import for DRR — a bulk alternative to the manual form
 * that reuses saveReport() (routes/dailyRigReport.ts) for every write, so an
 * imported report is indistinguishable, downstream, from one typed by hand:
 * same drr_reports row, same DPR/HSD/Mechanical-Log/service-record
 * distribution, same dashboards. This router only parses a workbook into a
 * DrrPayload and hands it to that one function — requireAdmin on every
 * route (not requireModulePermission) keeps it unreachable for Rig Users
 * regardless of any DRR module flags they hold.
 */
export const drrImportRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.xlsx', '.xls'].includes(ext)) {
      cb(new HttpError(400, `"${file.originalname}" is not an Excel workbook. Upload a .xlsx or .xls file.`));
      return;
    }
    cb(null, true);
  },
});

interface RigRow { id: string; rigNumber: string; rigKey: string; name: string; }

/* ---------------------------- template ---------------------------- */

drrImportRouter.get('/template/:rigId', requireAuth, requireAdmin, wrap(async (req, res) => {
  const rig = db.prepare<[string], RigRow>('SELECT id, rigNumber, rigKey, name FROM rigs WHERE id = ?').get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');

  const reportDate = String(req.query.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw badRequest('Choose the date this DRR covers.');

  const buffer = await buildDrrTemplateWorkbook({ rigId: rig.id, rigNumber: rig.rigNumber, reportDate });
  audit({ user: req.user!.username, ip: req.clientIp, action: 'drr.template.download', entity: 'rigs', entityId: rig.id, detail: reportDate });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${drrTemplateFileName(rig.rigNumber, reportDate)}"`);
  res.send(buffer);
}));

/* ---------------------------- preview / commit ---------------------------- */

interface PendingDrrImport {
  planId: string;
  fileName: string;
  storedFileName: string;
  rigId: string;
  reportDate: string;
  payload: DrrPayload;
  issues: DrrIssue[];
  existingReportId: string | null;
  userId: string;
  createdAt: number;
}

const pending = new Map<string, PendingDrrImport>();
const PENDING_TTL_MS = 60 * 60 * 1000;

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pending) if (entry.createdAt < cutoff) pending.delete(id);
}

/** Turns a parsed workbook into the exact payload shape saveReport() validates and writes. */
function buildPayload(rigId: string, parsed: ParsedDrr, issues: DrrIssue[]): DrrPayload {
  const equipmentLines: EquipmentLineInput[] = [];
  for (const line of parsed.equipmentLines) {
    const eq = db.prepare<[string, string], { id: string }>(
      'SELECT id FROM equipment WHERE id = ? AND rigId = ? AND isActive = 1',
    ).get(line.equipmentId, rigId);
    if (!eq) {
      issues.push({ level: 'warning', message: `A row's equipment is no longer active on this rig and was skipped (id ${line.equipmentId}).` });
      continue;
    }
    const opening = getPreviousEquipmentHours(line.equipmentId, parsed.reportDate ?? '');
    equipmentLines.push({
      equipmentId: line.equipmentId, openingRunningHours: opening.openingRunningHours,
      dayHours: line.dayHours, nightHours: line.nightHours, hsdConsumption: line.hsdConsumption,
      status: line.status ?? 'Running', remarks: line.remarks,
      serviceDoneToday: line.serviceDoneToday, serviceHours: line.serviceHours,
    });
  }

  const oilLines: OilLineInput[] = [];
  for (const line of parsed.oilLines) {
    const oil = db.prepare<[string], { name: string }>(
      "SELECT name FROM oil_lubricants WHERE id = ? AND status = 'Active'",
    ).get(line.oilLubricantId);
    if (!oil) {
      issues.push({ level: 'warning', message: `A row's oil/lubricant is no longer active and was skipped (id ${line.oilLubricantId}).` });
      continue;
    }
    const openingBalance = getPreviousOilBalance(null, oil.name, rigId, parsed.reportDate ?? '') ?? 0;
    oilLines.push({ equipmentId: null, oilType: oil.name, openingBalance, oilAdded: line.oilAdded, oilConsumed: line.oilConsumed, remark: line.remark });
  }

  const hydraulicLines: HydraulicLineInput[] = parsed.hydraulicLines.map((line) => ({
    tankName: line.tankName,
    openingLevel: getPreviousHydraulicLevel(rigId, line.tankName, parsed.reportDate ?? '') ?? 0,
    topUp: line.topUp, loss: line.loss, remark: line.remark,
  }));

  return {
    rigId, reportDate: parsed.reportDate ?? '', wellNo: parsed.wellNo ?? '', shift: parsed.shift ?? '',
    fieldLocation: parsed.fieldLocation, hsdReceived: parsed.hsdReceived ?? 0, hsdRemarks: parsed.hsdRemarks,
    equipmentLines, oilLines, hydraulicLines, dprLines: parsed.dprLines,
  };
}

drrImportRouter.post('/preview', requireAuth, requireAdmin, upload.single('file'), wrap((req, res) => {
  sweepPending();
  if (!req.file) throw badRequest('Attach a completed DRR Excel template to upload.');
  const rigId = String(req.body?.rigId ?? '');
  if (!rigId) throw badRequest('Select which rig this file belongs to before uploading.');

  const rig = db.prepare<[string], RigRow>('SELECT id, rigNumber, rigKey, name FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  const parsed = parseDrrWorkbook(req.file.buffer);

  // Rig-match check runs even when other issues exist, so a wrong-rig upload
  // is never masked by an unrelated validation error (mirrors ilm.ts's
  // withRigMatchCheck convention).
  if (parsed.rigKeyInFile && parsed.rigKeyInFile !== rig.rigKey) {
    parsed.issues.unshift({
      level: 'fatal',
      message: `Incorrect Rig Template.\nSelected Rig: ${rig.rigNumber}\nUploaded Template Rig: ${parsed.rigTextInFile}\nDownload the template for the correct rig and try again.`,
    });
  }

  const fatalSoFar = parsed.issues.some((i) => i.level === 'fatal');
  const payload = fatalSoFar ? null : buildPayload(rigId, parsed, parsed.issues);
  const formIssues = payload ? validateDrrPayload(payload, true) : [];
  const allIssues: DrrIssue[] = [...parsed.issues, ...formIssues.map((i) => ({ level: 'fatal' as const, message: `${i.field}: ${i.message}` }))];

  let existingReportId: string | null = null;
  let duplicate: { existingReportId: string; message: string } | null = null;
  if (payload && !allIssues.some((i) => i.level === 'fatal')) {
    const existing = db.prepare<[string, string, string], { id: string }>(
      'SELECT id FROM drr_reports WHERE rigId = ? AND reportDate = ? AND shift = ?',
    ).get(rigId, payload.reportDate, payload.shift ?? '');
    if (existing) {
      existingReportId = existing.id;
      duplicate = {
        existingReportId: existing.id,
        message: `A Daily Rig Report for ${rig.rigNumber} on ${payload.reportDate} (${payload.shift}) already exists. Confirming will replace it.`,
      };
    }
  }

  const storedFileName = `${Date.now()}_${newId('drrimp')}${path.extname(req.file.originalname).toLowerCase()}`;
  fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

  const planId = newId('drrplan');
  if (payload) {
    pending.set(planId, {
      planId, fileName: req.file.originalname, storedFileName, rigId,
      reportDate: payload.reportDate, payload, issues: allIssues, existingReportId,
      userId: req.user!.id, createdAt: Date.now(),
    });
  }

  res.json({
    planId: payload ? planId : null,
    rig: { id: rig.id, rigNumber: rig.rigNumber, name: rig.name },
    issues: allIssues,
    duplicate,
    preview: payload,
  });
}));

drrImportRouter.post('/import/:planId', requireAuth, requireAdmin, wrap((req, res) => {
  sweepPending();
  const entry = pending.get(req.params.planId);
  if (!entry) throw notFound('That preview has expired. Upload the workbook again.');
  if (entry.userId !== req.user!.id) throw new HttpError(403, 'That preview belongs to another admin.');
  if (entry.issues.some((i) => i.level === 'fatal')) throw badRequest('This preview still has unresolved errors — it cannot be imported.');

  let recordCount = 0;
  let report;
  try {
    report = saveReport(entry.existingReportId, { ...entry.payload, status: 'Submitted' }, req.user!.username, req.clientIp ?? null);
    recordCount = entry.payload.equipmentLines.length + entry.payload.oilLines.length
      + entry.payload.hydraulicLines.length + entry.payload.dprLines.length;

    db.prepare(`
      INSERT INTO drr_import_batches (id, fileName, storedFileName, rigId, reportDate, uploadedBy, uploadedAt,
        status, templateVersion, recordCount, errorCount, errorDetail)
      VALUES (@id, @fileName, @storedFileName, @rigId, @reportDate, @user, @stamp, 'Successful', @version, @recordCount, @errorCount, @errorDetail)
    `).run({
      id: newId('drrimpb'), fileName: entry.fileName, storedFileName: entry.storedFileName, rigId: entry.rigId,
      reportDate: entry.reportDate, user: req.user!.username, stamp: nowIso(), version: '1.0',
      recordCount, errorCount: entry.issues.length,
      errorDetail: entry.issues.length ? JSON.stringify(entry.issues) : null,
    });
  } catch (err) {
    db.prepare(`
      INSERT INTO drr_import_batches (id, fileName, storedFileName, rigId, reportDate, uploadedBy, uploadedAt,
        status, templateVersion, recordCount, errorCount, errorDetail)
      VALUES (@id, @fileName, @storedFileName, @rigId, @reportDate, @user, @stamp, 'Failed', '1.0', 0, 1, @errorDetail)
    `).run({
      id: newId('drrimpb'), fileName: entry.fileName, storedFileName: entry.storedFileName, rigId: entry.rigId,
      reportDate: entry.reportDate, user: req.user!.username, stamp: nowIso(),
      errorDetail: JSON.stringify([{ level: 'fatal', message: (err as Error).message }]),
    });
    throw err;
  }

  audit({
    user: req.user!.username, ip: req.clientIp, action: 'drr.import', entity: 'drr_reports', entityId: report.id,
    detail: `${entry.fileName} -> ${entry.rigId} ${entry.reportDate}: ${recordCount} record(s)${entry.existingReportId ? ' (replaced existing)' : ''}`,
  });

  pending.delete(entry.planId);
  res.json({ report });
}));

/* ---------------------------- history ---------------------------- */

interface DrrBatchRow {
  id: string; fileName: string; storedFileName: string | null; rigId: string; reportDate: string | null;
  uploadedBy: string; uploadedAt: string; status: string;
  recordCount: number; errorCount: number; errorDetail: string | null;
  rigNumber: string; rigName: string;
}

drrImportRouter.get('/history', requireAuth, requireAdmin, wrap((_req, res) => {
  const rows = db.prepare(`
    SELECT b.*, r.rigNumber, r.name AS rigName
    FROM drr_import_batches b JOIN rigs r ON r.id = b.rigId
    ORDER BY b.uploadedAt DESC LIMIT 200
  `).all() as DrrBatchRow[];
  res.json({
    batches: rows.map((r) => ({ ...r, errorDetail: r.errorDetail ? JSON.parse(r.errorDetail) as DrrIssue[] : null })),
  });
}));

