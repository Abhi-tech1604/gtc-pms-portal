import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import type { DprIssue } from '../excel/dprIngest.js';
import { parseHsdWorkbook, type ParsedHsdDay, type ParsedHsdWorkbook } from '../excel/hsdIngest.js';
import { buildHsdTemplateWorkbook, hsdTemplateFileName } from '../excel/hsdTemplate.js';
import { requireAuth, requireModulePermission, requirePage } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { buildHsdReportExportWorkbook, getHsdReport } from '../services/hsdReport.js';
import { getDprRigScope, scopedQuery } from '../services/rigScope.js';

/**
 * HSD (diesel consumption) import — the second stream in the DPR module's
 * Import Center, alongside the existing DPR upload. Deliberately a separate
 * router mounted at /api/hsd rather than new handlers inside routes/dpr.ts,
 * so nothing in the DPR import path is touched; it reuses that module's
 * rig master (dpr_rigs), its DPR permission gate, and the same multer
 * memory-storage + all-or-nothing validation shape.
 */
export const hsdRouter = Router();

const ALLOWED_EXT = new Set(['.xlsx', '.xls']);
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

interface RigRow { id: string; rigNumber: string; rigKey: string }

/* ---------------------------- template ---------------------------- */

hsdRouter.get('/template/:rigId', requireAuth, requireModulePermission('DPR', 'view'), wrap(async (req, res) => {
  const rig = db.prepare<[string], RigRow>('SELECT id, rigNumber, rigKey FROM dpr_rigs WHERE id = ?').get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');

  const logMonth = String(req.query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(logMonth)) throw badRequest('Choose the month this HSD sheet covers.');

  const buffer = await buildHsdTemplateWorkbook({ rigNumber: rig.rigNumber, logMonth });
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'hsd.template.download',
    entity: 'dpr_rigs', entityId: rig.id, detail: logMonth,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${hsdTemplateFileName(rig.rigNumber, logMonth)}"`);
  res.send(buffer);
}));

/* ---------------------------- import ---------------------------- */

hsdRouter.post('/import', requireAuth, requirePage('DPR','hsd_report','create'),
  upload.single('file'), wrap((req, res) => {
    if (!req.file) throw badRequest('Attach an HSD Excel workbook to upload.');
    const rigId = String(req.body?.rigId ?? '');
    if (!rigId) throw badRequest('Select which rig this file belongs to before uploading.');

    const rig = db.prepare<[string], RigRow>('SELECT id, rigNumber, rigKey FROM dpr_rigs WHERE id = ?').get(rigId);
    if (!rig) throw badRequest('That rig does not exist.');

    const storedFileName = `${Date.now()}_${newId('f')}${path.extname(req.file.originalname).toLowerCase()}`;

    let parsed: ParsedHsdWorkbook;
    try {
      parsed = parseHsdWorkbook(req.file.buffer);
    } catch (err) {
      recordFailedBatch(req, req.file.originalname, rigId, [{ level: 'fatal', message: (err as Error).message }]);
      throw badRequest((err as Error).message);
    }

    // All-or-nothing across the month, matching the DPR importer: one fatal
    // issue anywhere rejects the whole workbook rather than importing the
    // good days and silently dropping the rest.
    const issues = withRigMatchCheck(parsed, rig);
    const fatal = issues.filter((i) => i.level === 'fatal');
    if (fatal.length > 0) {
      const batchId = recordFailedBatch(req, req.file.originalname, rigId, issues);
      throw new HttpError(400, 'Import failed. Correct the file and upload again.', { issues, batchId });
    }

    const existingRows = db.prepare(
      `SELECT id, hsdDate FROM hsd_reports WHERE rigId = ? AND hsdDate IN (${parsed.days.map(() => '?').join(',')})`,
    ).all(rig.id, ...parsed.days.map((d) => d.date)) as { id: string; hsdDate: string }[];
    const existingByDate = new Map(existingRows.map((r) => [r.hsdDate, r.id]));
    if (existingByDate.size > 0 && !parseAck(req.body?.confirmReplace)) {
      const dates = [...existingByDate.keys()].sort();
      throw new HttpError(409,
        `HSD data for ${rig.rigNumber} already exists on: ${dates.join(', ')}. Continuing replaces those days.`,
        { duplicateDates: dates });
    }

    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    const batchId = newId('hsdimp');
    transact(() => {
      db.prepare(`
        INSERT INTO hsd_import_batches (id, fileName, storedFileName, rigId, uploadedBy, uploadedAt, status, recordCount, errorCount, errorDetail)
        VALUES (@id, @fileName, @storedFileName, @rigId, @uploadedBy, @uploadedAt, 'Successful', @recordCount, 0, NULL)
      `).run({
        id: batchId, fileName: req.file!.originalname, storedFileName, rigId: rig.id,
        uploadedBy: req.user!.username, uploadedAt: nowIso(), recordCount: parsed.days.length,
      });

      for (const day of parsed.days) {
        saveHsdReport({
          existingReportId: existingByDate.get(day.date) ?? null,
          rigId: rig.id, day, importBatchId: batchId, user: req.user!.username,
        });
      }
    });

    audit({
      user: req.user!.username, ip: req.clientIp, action: 'hsd.import',
      entity: 'hsd_reports', entityId: batchId,
      detail: `${req.file.originalname} -> ${rig.rigNumber} ${parsed.logMonth}: ${parsed.days.length} day(s) imported`,
    });

    res.status(201).json({
      batchId,
      daysImported: parsed.days.length,
      equipmentRows: parsed.days.reduce((n, d) => n + d.equipment.length, 0),
      warnings: parsed.issues.filter((i) => i.level === 'warning'),
    });
  }));

/* ---------------------------- history & reads ---------------------------- */

interface HsdBatchRow {
  id: string; fileName: string; storedFileName: string | null; rigId: string;
  uploadedBy: string; uploadedAt: string; status: string;
  recordCount: number; errorCount: number; errorDetail: string | null;
  rigNumber: string; rigName: string;
}

hsdRouter.get('/import/history', requireAuth, requireModulePermission('DPR', 'view'), wrap((_req, res) => {
  const rows = db.prepare(`
    SELECT b.*, r.rigNumber, r.name AS rigName
    FROM hsd_import_batches b
    JOIN dpr_rigs r ON r.id = b.rigId
    ORDER BY b.uploadedAt DESC
    LIMIT 200
  `).all() as HsdBatchRow[];
  res.json({
    batches: rows.map((r) => ({
      ...r,
      errorDetail: r.errorDetail ? JSON.parse(r.errorDetail) as DprIssue[] : null,
    })),
  });
}));

/** Rig-wise HSD reports, newest first — backs the result panel after an import. */
hsdRouter.get('/reports', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (req.query.rigId) { where.push('h.rigId = @rigId'); params.rigId = req.query.rigId; }
  if (req.query.dateFrom) { where.push('h.hsdDate >= @dateFrom'); params.dateFrom = req.query.dateFrom; }
  if (req.query.dateTo) { where.push('h.hsdDate <= @dateTo'); params.dateTo = req.query.dateTo; }

  const reports = db.prepare(`
    SELECT h.id, h.rigId, h.hsdDate, h.wellName, h.r1Hours, h.r2Hours, h.r3Hours, h.ilmHours, h.totalHours,
           r.rigNumber, r.name AS rigName,
           (SELECT COUNT(*) FROM hsd_equipment_lines e WHERE e.reportId = h.id) AS equipmentCount,
           (SELECT COALESCE(SUM(e.consumedHsd), 0) FROM hsd_equipment_lines e WHERE e.reportId = h.id) AS totalConsumedHsd
    FROM hsd_reports h
    JOIN dpr_rigs r ON r.id = h.rigId
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY h.hsdDate DESC
    LIMIT 500
  `).all(params);
  res.json({ reports });
}));

/* ---------------------------- HSD report (Opening/Received/Used/Closing) ---------------------------- */

hsdRouter.get('/report', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  res.json(getHsdReport(q));
}));

hsdRouter.get('/report/export.xlsx', requireAuth, requireModulePermission('DPR', 'view'), wrap(async (req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  const buffer = await buildHsdReportExportWorkbook(q);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="hsd-report.xlsx"');
  res.send(buffer);
}));

/* ---------------------------- helpers ---------------------------- */

/**
 * Exported for tests: the rig the user picked must match the rig the workbook
 * declares. Mirrors withRigMatchCheck() in routes/dpr.ts — kept as its own
 * copy so the DPR importer's behaviour cannot be changed by an HSD edit.
 */
export function withRigMatchCheck(
  parsed: Pick<ParsedHsdWorkbook, 'rigKeyInFile' | 'rigTextInFile' | 'issues'>,
  rig: { rigNumber: string; rigKey: string },
): DprIssue[] {
  const hasFatal = parsed.issues.some((i) => i.level === 'fatal');
  if (hasFatal || !parsed.rigKeyInFile || parsed.rigKeyInFile === rig.rigKey) {
    return parsed.issues;
  }
  return [
    {
      level: 'fatal',
      message: `Incorrect Rig Template. This file belongs to ${parsed.rigTextInFile} but ${rig.rigNumber} was selected.`,
    },
    ...parsed.issues,
  ];
}

function parseAck(v: unknown): boolean {
  return v === true || v === 'true' || v === '1';
}

/** Writes one day's HSD sheet, replacing any existing report for that rig+date. */
export function saveHsdReport(input: {
  existingReportId: string | null;
  rigId: string;
  day: ParsedHsdDay;
  importBatchId: string | null;
  user: string;
}): string {
  const { day } = input;
  const now = nowIso();
  const id = input.existingReportId ?? newId('hsd');

  if (input.existingReportId) {
    db.prepare(`
      UPDATE hsd_reports SET wellName = @wellName, r1Hours = @r1Hours, r2Hours = @r2Hours,
             r3Hours = @r3Hours, ilmHours = @ilmHours, totalHours = @totalHours,
             importBatchId = @importBatchId, updatedBy = @user, updatedAt = @now
      WHERE id = @id
    `).run({
      id, wellName: day.wellName, r1Hours: day.r1Hours, r2Hours: day.r2Hours,
      r3Hours: day.r3Hours, ilmHours: day.ilmHours, totalHours: day.totalHours,
      importBatchId: input.importBatchId, user: input.user, now,
    });
    // Lines are replaced wholesale rather than diffed — the sheet is the
    // source of truth for the day, same as the DPR importer's behaviour.
    db.prepare('DELETE FROM hsd_equipment_lines WHERE reportId = ?').run(id);
    db.prepare('DELETE FROM hsd_site_lines WHERE reportId = ?').run(id);
  } else {
    db.prepare(`
      INSERT INTO hsd_reports (id, rigId, hsdDate, wellName, r1Hours, r2Hours, r3Hours, ilmHours,
                               totalHours, importBatchId, createdBy, createdAt, updatedBy, updatedAt)
      VALUES (@id, @rigId, @hsdDate, @wellName, @r1Hours, @r2Hours, @r3Hours, @ilmHours,
              @totalHours, @importBatchId, @user, @now, NULL, @now)
    `).run({
      id, rigId: input.rigId, hsdDate: day.date, wellName: day.wellName,
      r1Hours: day.r1Hours, r2Hours: day.r2Hours, r3Hours: day.r3Hours, ilmHours: day.ilmHours,
      totalHours: day.totalHours, importBatchId: input.importBatchId, user: input.user, now,
    });
  }

  const insertEquipment = db.prepare(`
    INSERT INTO hsd_equipment_lines (id, reportId, lineNo, equipment, equipmentId, openingStock, topUp, totalHsd,
                                     consumedHsd, consumedHours, openingRunningHours, closingHours,
                                     closingStock, average, remark)
    VALUES (@id, @reportId, @lineNo, @equipment, @equipmentId, @openingStock, @topUp, @totalHsd,
            @consumedHsd, @consumedHours, @openingRunningHours, @closingHours,
            @closingStock, @average, @remark)
  `);
  for (const line of day.equipment) {
    insertEquipment.run({ id: newId('hsdl'), reportId: id, ...line, equipmentId: line.equipmentId ?? null });
  }

  const insertSite = db.prepare(`
    INSERT INTO hsd_site_lines (id, reportId, lineNo, label, openingBalance, received, totalBalance,
                                topUp, totalConsumption, closingBalance, remark)
    VALUES (@id, @reportId, @lineNo, @label, @openingBalance, @received, @totalBalance,
            @topUp, @totalConsumption, @closingBalance, @remark)
  `);
  for (const line of day.site) {
    insertSite.run({ id: newId('hsds'), reportId: id, ...line });
  }

  return id;
}

function recordFailedBatch(
  req: { user?: { username: string } },
  fileName: string, rigId: string, issues: DprIssue[],
): string {
  const id = newId('hsdimp');
  db.prepare(`
    INSERT INTO hsd_import_batches (id, fileName, storedFileName, rigId, uploadedBy, uploadedAt, status, recordCount, errorCount, errorDetail)
    VALUES (@id, @fileName, NULL, @rigId, @uploadedBy, @uploadedAt, 'Failed', 0, @errorCount, @errorDetail)
  `).run({
    id, fileName, rigId, uploadedBy: req.user?.username ?? 'unknown', uploadedAt: nowIso(),
    errorCount: issues.filter((i) => i.level === 'fatal').length,
    errorDetail: JSON.stringify(issues),
  });
  return id;
}
