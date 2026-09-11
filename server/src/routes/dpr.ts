import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso, today } from '../util/date.js';
import {
  computeTotalHours, parseDprWorkbook,
  type DprIssue, type ParsedDprLine, type ParsedDprWorkbook,
} from '../excel/dprIngest.js';
import { buildDprTemplateWorkbook, dprTemplateFileName } from '../excel/dprTemplate.js';
import { rigKey } from '../excel/normalize.js';
import { requireAuth, requireModulePermission, requirePage } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { getDprReport, listDprReports } from '../services/dprView.js';
import {
  buildDashboardExportPdf, buildDashboardExportWorkbook, getDashboardKpis, getDowntimeAnalysis,
  getEquipmentOptions, getEquipmentPerformance, getRigComparison, getTrends,
} from '../services/dprDashboard.js';
import {
  buildOperationalDataExportWorkbook, getOperationalLineItems, getRigHsdComparison, getRigTypes,
} from '../services/dprOperationalData.js';
import { assertModuleRigAllowed, getDprRigScope, NO_RIG_ACCESS, resolveModuleRigIds, scopedQuery } from '../services/rigScope.js';

export const dprRouter = Router();

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

/* ---------------------------- dashboard ---------------------------- */

/**
 * Extended in place (spec: upgrade the DPR Dashboard without breaking
 * anything) — same response shape as before (`{ kpis, rigWise }`) plus
 * additive fields: 8 KPI cards' worth of figures (including diesel, pulled
 * from the separate hsd_reports/hsd_equipment_lines tables and correlated by
 * rigId + date since there's no FK to dpr_reports) and richer per-rig
 * comparison columns. All aggregation logic itself lives in
 * services/dprDashboard.ts, alongside the new trend/equipment/downtime/export
 * endpoints below it.
 */
dprRouter.get('/dashboard', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  let query = req.query as Record<string, unknown>;
  // Admin Dashboard's Rig filter sends a PMS rig id (its own master rig list)
  // — bridge it to this DPR rig's own id by rigKey, the same bridge
  // getDprRigScope() already uses for account-based scoping. No match means
  // this rig has no DPR counterpart: force zero results, never fleet-wide.
  if (query.pmsRigId) {
    const [dprRigId] = resolveModuleRigIds([String(query.pmsRigId)], 'dpr_rigs');
    query = { ...query, rigId: dprRigId ?? NO_RIG_ACCESS };
  }
  const q = scopedQuery(getDprRigScope(req), query);
  const kpis = getDashboardKpis(q);
  const rigWise = getRigComparison(q);
  res.json({ kpis, rigWise });
}));

dprRouter.get('/dashboard/trends', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const granularity = req.query.granularity === 'week' || req.query.granularity === 'month'
    ? req.query.granularity : 'day';
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  res.json({ points: getTrends(q, granularity) });
}));

dprRouter.get('/dashboard/equipment', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  res.json({ rows: getEquipmentPerformance(q) });
}));

dprRouter.get('/dashboard/downtime', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  res.json(getDowntimeAnalysis(q));
}));

dprRouter.get('/dashboard/equipment-options', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const rigId = String(req.query.rigId ?? '');
  if (!rigId) { res.json({ equipment: [], linked: false }); return; }
  assertModuleRigAllowed(getDprRigScope(req), rigId);
  res.json(getEquipmentOptions(rigId));
}));

dprRouter.get('/dashboard/export.xlsx', requireAuth, requireModulePermission('DPR', 'view'), wrap(async (req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  const buffer = await buildDashboardExportWorkbook(q);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="dpr-dashboard.xlsx"');
  res.send(buffer);
}));

dprRouter.get('/dashboard/export.pdf', requireAuth, requireModulePermission('DPR', 'view'), wrap(async (req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  const buffer = await buildDashboardExportPdf(q);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="dpr-dashboard.pdf"');
  res.send(buffer);
}));

/* ---------------------------- operational data ---------------------------- */

/**
 * "Operational DPR": every activity line, flattened with its date and rig
 * context (not aggregated by rig, unlike /dashboard) — one row per real
 * dpr_line_items entry.
 */
dprRouter.get('/line-items', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  res.json(getOperationalLineItems(q));
}));

dprRouter.get('/line-items/export.xlsx', requireAuth, requireModulePermission('DPR', 'view'), wrap(async (req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  const buffer = await buildOperationalDataExportWorkbook(q);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="dpr-operational-data.xlsx"');
  res.send(buffer);
}));

/** Real PMS rig types (Drilling/Work-Over), bridged by rig number — for the Rig Type filter. */
dprRouter.get('/rig-types', requireAuth, requireModulePermission('DPR', 'view'), wrap((_req, res) => {
  res.json({ rigTypes: getRigTypes() });
}));

/** Rig-wise HSD consumption comparison chart, same filters as /line-items. */
dprRouter.get('/operational-data/hsd-comparison', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const q = scopedQuery(getDprRigScope(req), req.query as Record<string, unknown>);
  res.json({ rows: getRigHsdComparison(q) });
}));

/* ---------------------------- reports (progress report) ---------------------------- */

dprRouter.get('/reports', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const scope = getDprRigScope(req);
  // A multi-rig scope with no explicit rigId query param has no single value
  // to force here (listDprReports takes one rigId); fail safe rather than
  // silently return the wrong rig's or every rig's reports.
  const rigId = scope.restricted ? (scope.rigIds.length === 1 ? scope.rigIds[0] : NO_RIG_ACCESS) : (req.query.rigId as string | undefined);
  res.json({
    reports: listDprReports({
      rigId,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      well: req.query.well as string | undefined,
      search: req.query.search as string | undefined,
    }),
  });
}));

dprRouter.get('/reports/:id', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const report = getDprReport(req.params.id);
  if (!report) throw notFound('That DPR report does not exist.');
  assertModuleRigAllowed(getDprRigScope(req), report.rigId);
  res.json({ report });
}));

/**
 * A rig's full history — reusing audit_logs as-is (every saveDprReport() call
 * already writes one dpr.create/dpr.update/dpr.import row per report), not a
 * new history table. Joins through dpr_reports since audit_logs has no rigId
 * column of its own.
 */
dprRouter.get('/rig-history/:rigId', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  assertModuleRigAllowed(getDprRigScope(req), req.params.rigId);
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM dpr_rigs WHERE id = ?').get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');

  const entries = db.prepare(`
    SELECT a.id, a.user, a.time, a.action, a.entityId, a.detail
    FROM audit_logs a
    WHERE a.entity = 'dpr_reports' AND a.entityId IN (SELECT id FROM dpr_reports WHERE rigId = ?)
    ORDER BY a.time DESC
    LIMIT 200
  `).all(rig.id);
  res.json({ entries });
}));

/**
 * Equipment for the DPR form's "Breakdown Equipment" field, sourced live
 * from PMS's Equipment Master (the single equipment master in this app —
 * see server/src/db/schema.sql's `equipment` table) rather than a hardcoded
 * list. DPR keeps its own independent rig master (dpr_rigs), so there is no
 * direct FK from a DPR rig to `equipment`; the two are bridged by rigNumber,
 * the same way saveReport() in routes/dailyRigReport.ts already bridges
 * PMS rigs to DPR rigs for the Daily Rig Report form.
 *
 * A DPR rig with no same-numbered PMS rig (the masters have drifted apart)
 * degrades to an empty list rather than failing the whole DPR form — this
 * field is optional free text on every dpr_line_items row, not something
 * that should block DPR entry the way a Daily Rig Report save does.
 */
dprRouter.get('/equipment', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const dprRigId = String(req.query.rigId ?? '');
  if (!dprRigId) throw badRequest('Select a rig first.');
  assertModuleRigAllowed(getDprRigScope(req), dprRigId);

  const dprRig = db.prepare<[string], { rigNumber: string }>('SELECT rigNumber FROM dpr_rigs WHERE id = ?').get(dprRigId);
  if (!dprRig) throw notFound('That rig does not exist.');

  res.json(equipmentForDprRig(dprRig.rigNumber));
}));

/** Exported for tests: the PMS-rig bridge + live Equipment Master read, independent of the HTTP layer. */
export function equipmentForDprRig(dprRigNumber: string): { equipment: { id: string; name: string }[]; linked: boolean } {
  const pmsRig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigKey = ?').get(rigKey(dprRigNumber));
  if (!pmsRig) return { equipment: [], linked: false };

  const equipment = db.prepare<[string], { id: string; name: string }>(
    'SELECT id, name FROM equipment WHERE rigId = ? AND isActive = 1 ORDER BY section, name',
  ).all(pmsRig.id);
  return { equipment, linked: true };
}

dprRouter.post('/reports', requireAuth, requirePage('DPR','progress_report','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const rigId = String(body.rigId ?? '');
  const dprDate = String(body.dprDate ?? '');
  if (!rigId) throw badRequest('Select a rig.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dprDate)) throw badRequest('Select a valid DPR date.');

  assertModuleRigAllowed(getDprRigScope(req), rigId);
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM dpr_rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  const lines = normaliseManualLines(body.lines);
  if (lines.length === 0) throw badRequest('Add at least one activity row before saving.');

  const existing = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM dpr_reports WHERE rigId = ? AND dprDate = ?',
  ).get(rigId, dprDate);
  if (existing && !body.confirmReplace) {
    throw new HttpError(409,
      `A DPR for this rig on ${dprDate} already exists. Continuing replaces it.`,
      { duplicateReportId: existing.id });
  }

  const reportId = saveDprReport({
    existingReportId: existing?.id ?? null,
    rigId, dprDate, source: 'manual', importBatchId: null, lines,
    ctx: { user: req.user!.username, ip: req.clientIp ?? null },
  });
  res.status(201).json({ report: getDprReport(reportId) });
}));

dprRouter.put('/reports/:id', requireAuth, requirePage('DPR','progress_report','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; rigId: string; source: string; importBatchId: string | null }>(
    'SELECT id, rigId, source, importBatchId FROM dpr_reports WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That DPR report does not exist.');
  assertModuleRigAllowed(getDprRigScope(req), existing.rigId);

  const body = req.body ?? {};
  const dprDate = String(body.dprDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dprDate)) throw badRequest('Select a valid DPR date.');
  const lines = normaliseManualLines(body.lines);
  if (lines.length === 0) throw badRequest('Add at least one activity row before saving.');

  const reportId = saveDprReport({
    existingReportId: existing.id,
    rigId: existing.rigId, dprDate,
    source: existing.source as 'excel' | 'manual', importBatchId: existing.importBatchId,
    lines,
    ctx: { user: req.user!.username, ip: req.clientIp ?? null },
    isUpdate: true,
  });
  res.json({ report: getDprReport(reportId) });
}));

dprRouter.delete('/reports/:id', requireAuth, requirePage('DPR','progress_report','delete'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; rigId: string; dprDate: string }>(
    'SELECT id, rigId, dprDate FROM dpr_reports WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That DPR report does not exist.');
  assertModuleRigAllowed(getDprRigScope(req), existing.rigId);

  transact(() => {
    db.prepare('DELETE FROM dpr_reports WHERE id = ?').run(existing.id); // line items cascade
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'dpr.delete',
      entity: 'dpr_reports', entityId: existing.id, oldValue: existing,
    });
  });
  res.json({ ok: true });
}));

/* ---------------------------- template ---------------------------- */

dprRouter.get('/template/:rigId', requireAuth, requirePage('DPR','import','create'), wrap(async (req, res) => {
  assertModuleRigAllowed(getDprRigScope(req), req.params.rigId);
  const rig = db.prepare<[string], { id: string; rigNumber: string; name: string }>(
    'SELECT id, rigNumber, name FROM dpr_rigs WHERE id = ?',
  ).get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');

  const logMonth = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : today().slice(0, 7);
  const buffer = await buildDprTemplateWorkbook({ rigNumber: rig.rigNumber, logMonth });
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'dpr.template.download',
    entity: 'dpr_rigs', entityId: rig.id, detail: logMonth,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${dprTemplateFileName(rig.rigNumber, logMonth)}"`);
  res.send(buffer);
}));

/* ---------------------------- import ---------------------------- */

dprRouter.post('/import', requireAuth, requirePage('DPR','import','create'),
  upload.single('file'), wrap((req, res) => {
    if (!req.file) throw badRequest('Attach a DPR Excel workbook to upload.');
    const rigId = String(req.body?.rigId ?? '');
    if (!rigId) throw badRequest('Select which rig this file belongs to before uploading.');

    assertModuleRigAllowed(getDprRigScope(req), rigId);
    const rig = db.prepare<[string], { id: string; rigNumber: string; rigKey: string }>(
      'SELECT id, rigNumber, rigKey FROM dpr_rigs WHERE id = ?',
    ).get(rigId);
    if (!rig) throw badRequest('That rig does not exist.');

    const storedFileName = `${Date.now()}_${newId('f')}${path.extname(req.file.originalname).toLowerCase()}`;

    let parsed: ParsedDprWorkbook;
    try {
      parsed = parseDprWorkbook(req.file.buffer);
    } catch (err) {
      recordFailedBatch(req, req.file.originalname, storedFileName, rigId,
        [{ level: 'fatal', message: (err as Error).message }]);
      throw badRequest((err as Error).message);
    }

    // All-or-nothing across the whole month: every day-sheet is validated
    // first; a single fatal issue anywhere rejects the entire upload rather
    // than importing the valid days and silently dropping the rest.
    const issues = withRigMatchCheck(parsed, rig);
    const fatal = issues.filter((i) => i.level === 'fatal');
    if (fatal.length > 0) {
      const batchId = recordFailedBatch(req, req.file.originalname, storedFileName, rigId, issues);
      throw new HttpError(400, 'Import failed. Correct the file and upload again.', {
        issues, batchId,
      });
    }
    if (parsed.days.length === 0) {
      const batchId = recordFailedBatch(req, req.file.originalname, storedFileName, rigId,
        [{ level: 'fatal', message: 'No DPR data was found in this workbook. Fill in at least one day before uploading.' }]);
      throw new HttpError(400, 'Import failed. Correct the file and upload again.', {
        issues: [{ level: 'fatal', message: 'No DPR data was found in this workbook. Fill in at least one day before uploading.' }],
        batchId,
      });
    }

    const existingRows = db.prepare(`SELECT id, dprDate FROM dpr_reports WHERE rigId = ? AND dprDate IN (${parsed.days.map(() => '?').join(',')})`)
      .all(rig.id, ...parsed.days.map((d) => d.date)) as { id: string; dprDate: string }[];
    const existingByDate = new Map(existingRows.map((r) => [r.dprDate, r.id]));
    if (existingByDate.size > 0 && !parseAck(req.body?.confirmReplace)) {
      const dates = [...existingByDate.keys()].sort();
      throw new HttpError(409,
        `A DPR for ${rig.rigNumber} already exists on: ${dates.join(', ')}. Continuing replaces those days.`,
        { duplicateDates: dates });
    }

    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    const batchId = newId('dprimp');
    const reportIds = transact(() => {
      db.prepare(`
        INSERT INTO dpr_import_batches (id, fileName, storedFileName, rigId, uploadedBy, uploadedAt, status, recordCount, errorCount, errorDetail)
        VALUES (@id, @fileName, @storedFileName, @rigId, @uploadedBy, @uploadedAt, 'Successful', @recordCount, 0, NULL)
      `).run({
        id: batchId, fileName: req.file!.originalname, storedFileName, rigId: rig.id,
        uploadedBy: req.user!.username, uploadedAt: nowIso(), recordCount: parsed.days.length,
      });

      return parsed.days.map((d) => saveDprReport({
        existingReportId: existingByDate.get(d.date) ?? null,
        rigId: rig.id, dprDate: d.date, source: 'excel', importBatchId: batchId,
        lines: d.lines,
        ctx: { user: req.user!.username, ip: req.clientIp ?? null },
        skipTransaction: true,
      }));
    });

    audit({
      user: req.user!.username, ip: req.clientIp, action: 'dpr.import',
      entity: 'dpr_reports', entityId: reportIds[0],
      detail: `${req.file.originalname} -> ${rig.rigNumber} ${parsed.logMonth}: ${parsed.days.length} day(s) imported`,
    });

    res.status(201).json({
      reports: reportIds.map((id) => getDprReport(id)), batchId,
      daysImported: parsed.days.length,
      warnings: parsed.issues.filter((i) => i.level === 'warning'),
    });
  }));

interface ImportBatchRow {
  id: string; fileName: string; storedFileName: string | null; rigId: string;
  uploadedBy: string; uploadedAt: string; status: string;
  recordCount: number; errorCount: number; errorDetail: string | null;
  rigNumber: string; rigName: string;
}

dprRouter.get('/import/history', requireAuth, requireModulePermission('DPR', 'view'), wrap((req, res) => {
  const scope = getDprRigScope(req);
  const rows = (scope.restricted
    ? db.prepare(`
        SELECT b.*, r.rigNumber, r.name AS rigName
        FROM dpr_import_batches b
        JOIN dpr_rigs r ON r.id = b.rigId
        WHERE b.rigId IN (${scope.rigIds.length ? scope.rigIds.map(() => '?').join(',') : `'${NO_RIG_ACCESS}'`})
        ORDER BY b.uploadedAt DESC
        LIMIT 200
      `).all(...scope.rigIds)
    : db.prepare(`
        SELECT b.*, r.rigNumber, r.name AS rigName
        FROM dpr_import_batches b
        JOIN dpr_rigs r ON r.id = b.rigId
        ORDER BY b.uploadedAt DESC
        LIMIT 200
      `).all()) as ImportBatchRow[];
  res.json({
    batches: rows.map((r) => ({
      ...r,
      errorDetail: r.errorDetail ? JSON.parse(r.errorDetail) as DprIssue[] : null,
    })),
  });
}));

/* ---------------------------- helpers ---------------------------- */

/**
 * Exported for tests: the rig the user selected must match the rig the
 * workbook itself declares, checked even when other issues are already
 * present so a mismatch is never masked by something else (spec 15). Never
 * mutates the input — returns a new issues array with the check merged in.
 */
export function withRigMatchCheck(
  parsed: Pick<ParsedDprWorkbook, 'rigKeyInFile' | 'rigTextInFile' | 'issues'>,
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

function recordFailedBatch(
  req: { user?: { username: string } },
  fileName: string, storedFileName: string, rigId: string, issues: DprIssue[],
): string {
  const id = newId('dprimp');
  db.prepare(`
    INSERT INTO dpr_import_batches (id, fileName, storedFileName, rigId, uploadedBy, uploadedAt, status, recordCount, errorCount, errorDetail)
    VALUES (@id, @fileName, NULL, @rigId, @uploadedBy, @uploadedAt, 'Failed', 0, @errorCount, @errorDetail)
  `).run({
    id, fileName, rigId, uploadedBy: req.user?.username ?? 'unknown', uploadedAt: nowIso(),
    errorCount: issues.filter((i) => i.level === 'fatal').length,
    errorDetail: JSON.stringify(issues),
  });
  return id;
}

/** Manual-entry lines arrive as plain objects from the client; coerce and recompute totals server-side. */
function normaliseManualLines(raw: unknown): ParsedDprLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any, i: number): ParsedDprLine => {
      const drillingFrom = numOrNull(r.drillingFrom);
      const drillingTo = numOrNull(r.drillingTo);
      const casingFrom = numOrNull(r.casingFrom);
      const casingTo = numOrNull(r.casingTo);
      const startTime = strOrNull(r.startTime);
      const endTime = strOrNull(r.endTime);
      return {
        lineNo: i + 1,
        wellName: strOrNull(r.wellName),
        operationCode: strOrNull(r.operationCode),
        workType: strOrNull(r.workType),
        startTime, endTime,
        totalHours: computeTotalHours(startTime, endTime),
        description: strOrNull(r.description),
        breakdownEquipment: strOrNull(r.breakdownEquipment),
        breakdownReason: strOrNull(r.breakdownReason),
        drillingSection: strOrNull(r.drillingSection),
        drillingFrom, drillingTo,
        drillingTotal: drillingFrom !== null && drillingTo !== null ? round2(drillingTo - drillingFrom) : null,
        casingSection: strOrNull(r.casingSection),
        casingFrom, casingTo,
        casingTotal: casingFrom !== null && casingTo !== null ? round2(casingTo - casingFrom) : null,
      };
    })
    .filter((l) => l.wellName || l.operationCode || l.startTime || l.endTime || l.description);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Exported for tests: the create/replace/recompute logic shared by manual entry and Excel import. */
export function saveDprReport(input: {
  existingReportId: string | null;
  rigId: string; dprDate: string; source: 'excel' | 'manual';
  importBatchId: string | null; lines: ParsedDprLine[];
  ctx: { user: string; ip: string | null };
  isUpdate?: boolean;
  skipTransaction?: boolean;
}): string {
  const run = () => {
    const stamp = nowIso();
    let reportId = input.existingReportId;
    if (reportId) {
      db.prepare('DELETE FROM dpr_line_items WHERE reportId = ?').run(reportId);
      db.prepare(`
        UPDATE dpr_reports SET dprDate = @dprDate, source = @source, importBatchId = @importBatchId,
          updatedBy = @updatedBy, updatedAt = @updatedAt
        WHERE id = @id
      `).run({
        id: reportId, dprDate: input.dprDate, source: input.source, importBatchId: input.importBatchId,
        updatedBy: input.ctx.user, updatedAt: stamp,
      });
    } else {
      reportId = newId('dpr');
      db.prepare(`
        INSERT INTO dpr_reports (id, rigId, dprDate, source, importBatchId, createdBy, createdAt, updatedBy, updatedAt)
        VALUES (@id, @rigId, @dprDate, @source, @importBatchId, @createdBy, @createdAt, @createdBy, @createdAt)
      `).run({
        id: reportId, rigId: input.rigId, dprDate: input.dprDate, source: input.source,
        importBatchId: input.importBatchId, createdBy: input.ctx.user, createdAt: stamp,
      });
    }

    const insertLine = db.prepare(`
      INSERT INTO dpr_line_items (id, reportId, lineNo, wellName, operationCode, workType, startTime, endTime,
        totalHours, description, breakdownEquipment, breakdownEquipmentId, breakdownReason, drillingSection, drillingFrom, drillingTo, drillingTotal,
        casingSection, casingFrom, casingTo, casingTotal, otherActivityDescription)
      VALUES (@id, @reportId, @lineNo, @wellName, @operationCode, @workType, @startTime, @endTime,
        @totalHours, @description, @breakdownEquipment, @breakdownEquipmentId, @breakdownReason, @drillingSection, @drillingFrom, @drillingTo, @drillingTotal,
        @casingSection, @casingFrom, @casingTo, @casingTotal, @otherActivityDescription)
    `);
    for (const line of input.lines) {
      insertLine.run({
        id: newId('dprl'), reportId, ...line,
        breakdownEquipmentId: line.breakdownEquipmentId ?? null,
        otherActivityDescription: line.otherActivityDescription ?? null,
      });
    }

    audit({
      user: input.ctx.user, ip: input.ctx.ip,
      action: input.isUpdate ? 'dpr.update' : 'dpr.create',
      entity: 'dpr_reports', entityId: reportId,
      detail: `${input.lines.length} line(s), source ${input.source}`,
    });

    return reportId;
  };

  return input.skipTransaction ? run() : transact(run);
}
