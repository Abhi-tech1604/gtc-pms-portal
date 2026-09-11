import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso, today } from '../util/date.js';
import {
  parseIlmWorkbook,
  type IlmIssue, type ParsedIlmWorkbook,
} from '../excel/ilmIngest.js';
import { buildIlmTemplateWorkbook, ilmTemplateFileName } from '../excel/ilmTemplate.js';
import { requireAdmin, requireAuth, requireModulePermission, requirePage } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { getIlmTransaction, listIlmTransactions } from '../services/ilmView.js';
import { buildCraneSummaryExportWorkbook, getCraneSummary } from '../services/ilmCraneSummary.js';
import { getCraneDashboard, getCraneFilterOptions } from '../services/ilmCraneDashboard.js';
import { buildTrailerSummaryExportWorkbook, getTrailerSummary } from '../services/ilmTrailerSummary.js';
import { buildIlmSummaryReportExportWorkbook, getIlmSummaryReport } from '../services/ilmSummaryReport.js';
import { assertModuleRigAllowed, getIlmRigScope, NO_RIG_ACCESS, resolveModuleRigIds, scopedQuery } from '../services/rigScope.js';
import {
  addCraneRecord, addCraneRound, addDelayRecord, addTrailerLoad, addTrailerMovement, appendDelayLines,
  createIlm, deleteCraneRecord, deleteTrailerLoad, endIlm, findActiveIlm,
  reopenIlm, setDelayLines, updateCraneRecord, updateIlmHeader, updateTrailerLoad,
  type CraneRecordInput, type DelayLineInput, type DelayRecordInput, type IlmHeaderInput, type TrailerLoadInput,
} from '../services/ilmLifecycle.js';

export const ilmRouter = Router();

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

ilmRouter.get('/dashboard', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const scope = getIlmRigScope(req);
  // Admin Dashboard's Rig filter sends a PMS rig id (its own master rig
  // list) — bridge it to this ILM rig's own id by rigKey, the same bridge
  // getIlmRigScope() already uses for account-based scoping. No match means
  // this rig has no ILM counterpart: force zero results, never fleet-wide.
  const pmsRigId = req.query.pmsRigId as string | undefined;
  let scopedRigId: string | null;
  if (pmsRigId) {
    const [bridgedRigId] = resolveModuleRigIds([pmsRigId], 'ilm_rigs');
    scopedRigId = bridgedRigId ?? NO_RIG_ACCESS;
    assertModuleRigAllowed(scope, scopedRigId);
  } else {
    // Fail-safe for a genuinely multi-rig scope: these filters are all
    // single-value equality (t.rigId = @rigId), so a scope of several rigs has
    // no one value to force — NO_RIG_ACCESS rather than silently under/over-scope.
    scopedRigId = scope.restricted ? (scope.rigIds.length === 1 ? scope.rigIds[0] : NO_RIG_ACCESS) : null;
  }
  const txnRigFilter = scopedRigId ? 'AND t.rigId = @rigId' : '';
  const rigRowFilter = scopedRigId ? 'AND r.id = @rigId' : '';
  const loadRigFilter = scopedRigId ? 'AND tl.transactionId IN (SELECT id FROM ilm_transactions WHERE rigId = @rigId)' : '';
  const craneRigFilter = scopedRigId ? 'AND c.transactionId IN (SELECT id FROM ilm_transactions WHERE rigId = @rigId)' : '';
  const lineRigFilter = scopedRigId ? 'AND il.transactionId IN (SELECT id FROM ilm_transactions WHERE rigId = @rigId)' : '';
  const params = { rigId: scopedRigId };

  const kpis = db.prepare(`
    SELECT
      COUNT(DISTINCT t.id) AS totalMovements,
      COUNT(DISTINCT CASE WHEN t.status = 'Active' THEN t.id END) AS activeMovements,
      COUNT(DISTINCT CASE WHEN t.status = 'Completed' THEN t.id END) AS completedMovements,
      COALESCE((SELECT SUM(il.ilmDistanceKm) FROM ilm_individual_lines il WHERE 1=1 ${lineRigFilter}), 0) AS totalDistanceKm,
      COALESCE((SELECT COUNT(*) FROM ilm_trailer_loads tl WHERE 1=1 ${loadRigFilter}), 0) AS totalTrailerLoads,
      COALESCE((SELECT COUNT(*) FROM ilm_cranes c WHERE 1=1 ${craneRigFilter}), 0) AS totalCraneRecords,
      COALESCE((SELECT SUM(il.totalHsdConsumption) FROM ilm_individual_lines il WHERE 1=1 ${lineRigFilter}), 0) AS totalHsdConsumption
    FROM ilm_transactions t
    JOIN ilm_rigs r ON r.id = t.rigId
    WHERE 1=1 ${txnRigFilter}
  `).get(params) as Record<string, number>;

  const avgConsumptionPerKm = kpis.totalDistanceKm > 0
    ? Math.round((kpis.totalHsdConsumption / kpis.totalDistanceKm) * 100) / 100
    : 0;

  const rigWise = db.prepare(`
    SELECT r.id AS rigId, r.rigNumber, r.name AS rigName,
           MAX(t.date) AS lastMovementDate,
           (SELECT COUNT(*) FROM ilm_transactions t2 WHERE t2.rigId = r.id) AS movementCount
    FROM ilm_rigs r
    LEFT JOIN ilm_transactions t ON t.rigId = r.id
    WHERE r.status = 'Active' ${rigRowFilter}
    GROUP BY r.id
    ORDER BY r.rigNumber
  `).all(params);

  const recent = db.prepare(`
    SELECT t.id, t.ilmNumber, t.date, t.source, t.status, r.rigNumber, r.name AS rigName,
           t.createdBy, t.createdAt,
           (SELECT movementFromWell FROM ilm_individual WHERE transactionId = t.id) AS movementFromWell,
           (SELECT movementToWell FROM ilm_individual WHERE transactionId = t.id) AS movementToWell,
           (SELECT COALESCE(SUM(ilmDistanceKm),0) FROM ilm_individual_lines WHERE transactionId = t.id) AS totalDistanceKm
    FROM ilm_transactions t
    JOIN ilm_rigs r ON r.id = t.rigId
    WHERE 1=1 ${txnRigFilter}
    ORDER BY t.createdAt DESC
    LIMIT 15
  `).all(params);

  /**
   * Trailer Summary and Crane Summary: real, already-entered fleet totals
   * only (no cost/rate/operator/well-no/delay-category fields — none of
   * that exists anywhere in ILM's data today). Crane capacity is summed
   * per distinct craneNo (not per row) so the same physical crane logged
   * across several movements isn't counted into fleet capacity twice.
   */
  const trailerTotals = db.prepare(`
    SELECT
      COUNT(DISTINCT NULLIF(trim(trailerNo), '')) AS totalTrailersDeployed,
      COUNT(*) AS totalLoads,
      COALESCE(SUM(totalPackages), 0) AS totalPackages
    FROM ilm_trailer_loads tl
    WHERE 1=1 ${loadRigFilter}
  `).get(params) as { totalTrailersDeployed: number; totalLoads: number; totalPackages: number };
  const trailerDistance = db.prepare(`
    SELECT COALESCE(SUM(leadDistanceKm), 0) AS totalDistanceKm FROM ilm_trailer_movements tm
    WHERE 1=1 ${scopedRigId ? 'AND tm.transactionId IN (SELECT id FROM ilm_transactions WHERE rigId = @rigId)' : ''}
  `).get(params) as { totalDistanceKm: number };
  const trailerByType = db.prepare(`
    SELECT trailerType, COUNT(*) AS count FROM ilm_trailer_loads tl
    WHERE trailerType IS NOT NULL AND trim(trailerType) <> '' ${loadRigFilter}
    GROUP BY trailerType ORDER BY count DESC
  `).all(params) as { trailerType: string; count: number }[];

  const craneTotals = db.prepare(`
    SELECT
      COUNT(DISTINCT NULLIF(trim(craneNo), '')) AS totalCranesDeployed,
      COALESCE(SUM(totalWorkingHrs), 0) AS totalWorkingHours,
      COALESCE(SUM(breakdownHrs), 0) AS totalBreakdownHours,
      COALESCE(SUM(issuedHsdLtrs), 0) AS totalHsdIssued
    FROM ilm_cranes c
    WHERE 1=1 ${craneRigFilter}
  `).get(params) as { totalCranesDeployed: number; totalWorkingHours: number; totalBreakdownHours: number; totalHsdIssued: number };
  const craneCapacity = db.prepare(`
    SELECT COALESCE(SUM(capacityTon), 0) AS totalCapacityTon FROM (
      SELECT c.craneNo, MAX(c.capacityTon) AS capacityTon FROM ilm_cranes c
      WHERE c.craneNo IS NOT NULL AND trim(c.craneNo) <> '' ${craneRigFilter}
      GROUP BY c.craneNo
    )
  `).get(params) as { totalCapacityTon: number };
  const craneByOwnership = db.prepare(`
    SELECT rigOrHired, COUNT(*) AS count FROM ilm_cranes c
    WHERE rigOrHired IS NOT NULL AND trim(rigOrHired) <> '' ${craneRigFilter}
    GROUP BY rigOrHired ORDER BY count DESC
  `).all(params) as { rigOrHired: string; count: number }[];

  res.json({
    kpis: { ...kpis, avgConsumptionPerKm },
    rigWise, recent,
    trailerSummary: { ...trailerTotals, ...trailerDistance, byType: trailerByType },
    craneSummary: { ...craneTotals, ...craneCapacity, byOwnership: craneByOwnership },
  });
}));

/** Real PMS rig types only (bridged from rigs.rigType via ilm_rigs.rigKey) — never a fabricated static list. */
ilmRouter.get('/rig-types', requireAuth, requireModulePermission('ILM', 'view'), wrap((_req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT rigType FROM rigs WHERE rigType IS NOT NULL AND trim(rigType) <> '' ORDER BY rigType",
  ).all() as { rigType: string }[];
  res.json({ rigTypes: rows.map((r) => r.rigType) });
}));

/**
 * Bridges an ILM rig to the central Equipment Master, exactly the way
 * routes/dpr.ts's equipmentForDprRig() bridges DPR's independent rig master:
 * ILM keeps its own Rig Master (ilm_rigs) by design, so a live rigKey match
 * against the real rigs table is how this ever-so-slightly indirect link is
 * made — never a fabricated or duplicated equipment list.
 */
export function equipmentForIlmRig(ilmRigId: string, category: 'Crane' | 'Trailer'): { equipment: { id: string; name: string }[]; linked: boolean } {
  const ilmRig = db.prepare<[string], { rigKey: string }>('SELECT rigKey FROM ilm_rigs WHERE id = ?').get(ilmRigId);
  if (!ilmRig) return { equipment: [], linked: false };
  const pmsRig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigKey = ?').get(ilmRig.rigKey);
  if (!pmsRig) return { equipment: [], linked: false };

  const equipment = db.prepare<[string, string], { id: string; name: string }>(
    'SELECT id, name FROM equipment WHERE rigId = ? AND category = ? AND isActive = 1 ORDER BY name',
  ).all(pmsRig.id, category);
  return { equipment, linked: true };
}

ilmRouter.get('/equipment', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const ilmRigId = String(req.query.ilmRigId ?? '');
  const category = req.query.category === 'Trailer' ? 'Trailer' : 'Crane';
  if (!ilmRigId) throw badRequest('Select a rig first.');
  res.json(equipmentForIlmRig(ilmRigId, category));
}));

/** Looks up an Equipment Master row for the crane/trailer link, validating it's Active and the right category; returns its name to use as the historical craneNo/trailerNo snapshot. */
function resolveLinkedIlmEquipment(equipmentId: string | null, category: 'Crane' | 'Trailer'): string | null {
  if (!equipmentId) return null;
  const row = db.prepare<[string], { name: string; category: string; isActive: number }>(
    'SELECT name, category, isActive FROM equipment WHERE id = ?',
  ).get(equipmentId);
  if (!row || !row.isActive || row.category !== category) throw badRequest(`That linked ${category} record does not exist.`);
  return row.name;
}

/* ---------------------------- crane summary report ---------------------------- */

ilmRouter.get('/crane-summary', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const q = scopedQuery(getIlmRigScope(req), req.query as Record<string, unknown>);
  res.json(getCraneSummary(q));
}));

ilmRouter.get('/crane-summary/export.xlsx', requireAuth, requireModulePermission('ILM', 'view'), wrap(async (req, res) => {
  const q = scopedQuery(getIlmRigScope(req), req.query as Record<string, unknown>);
  const buf = await buildCraneSummaryExportWorkbook(q);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ilm-crane-summary.xlsx"');
  res.send(buf);
}));

/** The Crane Management dashboard: KPIs, rig/crane/transporter comparisons, trend, and the detailed table — all live aggregates over the same ilm_cranes/ilm_crane_rounds rows the ILM form writes. */
ilmRouter.get('/crane-summary/dashboard', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const q = scopedQuery(getIlmRigScope(req), req.query as Record<string, unknown>);
  res.json(getCraneDashboard(q));
}));

/** Filter dropdown option lists (crane names, transporter names) — rig-scoped only, independent of the dashboard's own date/crane/transporter/status filters. */
ilmRouter.get('/crane-summary/filter-options', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const scope = getIlmRigScope(req);
  const rigId = scope.restricted ? (scope.rigIds.length === 1 ? scope.rigIds[0] : NO_RIG_ACCESS) : (req.query.rigId as string | undefined);
  res.json(getCraneFilterOptions(rigId ? { rigId } : {}));
}));

/* ---------------------------- trailer summary report ---------------------------- */

ilmRouter.get('/trailer-summary', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const q = scopedQuery(getIlmRigScope(req), req.query as Record<string, unknown>);
  res.json(getTrailerSummary(q));
}));

ilmRouter.get('/trailer-summary/export.xlsx', requireAuth, requireModulePermission('ILM', 'view'), wrap(async (req, res) => {
  const q = scopedQuery(getIlmRigScope(req), req.query as Record<string, unknown>);
  const buf = await buildTrailerSummaryExportWorkbook(q);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ilm-trailer-summary.xlsx"');
  res.send(buf);
}));

/* ---------------------------- individual summary dashboard ---------------------------- */

ilmRouter.get('/summary', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const rigId = String(req.query.rigId ?? '');
  const dateFrom = String(req.query.dateFrom ?? '');
  const dateTo = String(req.query.dateTo ?? '');
  if (!rigId || !dateFrom || !dateTo) throw badRequest('Select a rig and a date range.');
  assertModuleRigAllowed(getIlmRigScope(req), rigId);
  res.json(getIlmSummaryReport(rigId, dateFrom, dateTo));
}));

ilmRouter.get('/summary/export.xlsx', requireAuth, requireModulePermission('ILM', 'view'), wrap(async (req, res) => {
  const rigId = String(req.query.rigId ?? '');
  const dateFrom = String(req.query.dateFrom ?? '');
  const dateTo = String(req.query.dateTo ?? '');
  if (!rigId || !dateFrom || !dateTo) throw badRequest('Select a rig and a date range.');
  assertModuleRigAllowed(getIlmRigScope(req), rigId);
  const buf = await buildIlmSummaryReportExportWorkbook(rigId, dateFrom, dateTo);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ilm-summary.xlsx"');
  res.send(buf);
}));

/* ---------------------------- transactions (progress report) ---------------------------- */

ilmRouter.get('/transactions', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const scope = getIlmRigScope(req);
  const rigId = scope.restricted ? (scope.rigIds.length === 1 ? scope.rigIds[0] : NO_RIG_ACCESS) : (req.query.rigId as string | undefined);
  res.json({
    transactions: listIlmTransactions({
      rigId,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      ilmNumber: req.query.ilmNumber as string | undefined,
      movementFrom: req.query.movementFrom as string | undefined,
      movementTo: req.query.movementTo as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
    }),
  });
}));

ilmRouter.get('/transactions/:id', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const txn = getIlmTransaction(req.params.id);
  if (!txn) throw notFound('That ILM transaction does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), txn.rigId);
  res.json({ transaction: txn });
}));

/** Requirement 9: the "does this rig already have an Active ILM" check the New ILM form runs before offering Save & Start. */
ilmRouter.get('/active-for-rig/:rigId', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  assertModuleRigAllowed(getIlmRigScope(req), req.params.rigId);
  res.json({ active: findActiveIlm(req.params.rigId) });
}));

ilmRouter.post('/transactions', requireAuth, requirePage('ILM','ilm_add','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const rigId = String(body.rigId ?? '');
  const date = String(body.date ?? '');
  if (!rigId) throw badRequest('Select a rig.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Select a valid ILM start date.');
  assertModuleRigAllowed(getIlmRigScope(req), rigId);

  const rig = db.prepare<[string], { id: string }>('SELECT id FROM ilm_rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  const transactionId = createIlm({
    rigId, date, source: 'manual', importBatchId: null,
    individual: normaliseHeader(body.individual ?? {}),
    ctx: { user: req.user!.username, ip: req.clientIp ?? null },
  });
  res.status(201).json({ transaction: getIlmTransaction(transactionId) });
}));

ilmRouter.put('/transactions/:id', requireAuth, requirePage('ILM','ilm_add','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; rigId: string }>(
    'SELECT id, rigId FROM ilm_transactions WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That ILM does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), existing.rigId);

  const body = req.body ?? {};
  const ctx = { user: req.user!.username, ip: req.clientIp ?? null };
  updateIlmHeader(existing.id, normaliseHeader(body.individual ?? {}), ctx);
  if (Array.isArray(body.individualLines)) {
    setDelayLines(existing.id, body.individualLines.map(normaliseDelayLine), ctx);
  }
  res.json({ transaction: getIlmTransaction(existing.id) });
}));

ilmRouter.delete('/transactions/:id', requireAuth, requirePage('ILM','ilm_add','delete'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; rigId: string; ilmNumber: string }>(
    'SELECT id, rigId, ilmNumber FROM ilm_transactions WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That ILM transaction does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), existing.rigId);

  transact(() => {
    db.prepare('DELETE FROM ilm_transactions WHERE id = ?').run(existing.id); // children cascade
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'ilm.delete',
      entity: 'ilm_transactions', entityId: existing.id, oldValue: existing,
    });
  });
  res.json({ ok: true });
}));

/* ---------------------------- lifecycle: end / reopen ---------------------------- */

ilmRouter.post('/transactions/:id/end', requireAuth, requirePage('ILM','ilm_add','edit'), wrap((req, res) => {
  const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(req.params.id);
  if (!txn) throw notFound('That ILM does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), txn.rigId);
  endIlm(req.params.id, { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ transaction: getIlmTransaction(req.params.id) });
}));

ilmRouter.post('/transactions/:id/reopen', requireAuth, requireAdmin, wrap((req, res) => {
  const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(req.params.id);
  if (!txn) throw notFound('That ILM does not exist.');
  reopenIlm(req.params.id, { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ transaction: getIlmTransaction(req.params.id) });
}));

/* ---------------------------- lifecycle: trailer movements & loads ---------------------------- */

ilmRouter.post('/transactions/:id/trailer-movements', requireAuth, requirePage('ILM','ilm_add','create'), wrap((req, res) => {
  const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(req.params.id);
  if (!txn) throw notFound('That ILM does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), txn.rigId);
  const body = req.body ?? {};
  const { id: movementId, contractWarning } = addTrailerMovement(req.params.id, {
    fleetReportAt: strOrNull(body.fleetReportAt), leadDistanceKm: numOrNull(body.leadDistanceKm),
    allowedDurationHrs: numOrNull(body.allowedDurationHrs),
  }, { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ transaction: getIlmTransaction(req.params.id), movementId, contractWarning });
}));

ilmRouter.post('/trailer-movements/:movementId/loads', requireAuth, requirePage('ILM','ilm_add','create'), wrap((req, res) => {
  const owner = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_trailer_movements WHERE id = ?',
  ).get(req.params.movementId);
  if (!owner) throw notFound('That Trailer Movement does not exist.');
  const rig = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(owner.transactionId)!;
  assertModuleRigAllowed(getIlmRigScope(req), rig.rigId);
  const loadId = addTrailerLoad(req.params.movementId, normaliseTrailerLoad(req.body ?? {}), { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ transaction: getIlmTransaction(owner.transactionId), loadId });
}));

ilmRouter.put('/trailer-loads/:loadId', requireAuth, requirePage('ILM','ilm_add','edit'), wrap((req, res) => {
  const load = db.prepare<[string], { transactionId: string }>('SELECT transactionId FROM ilm_trailer_loads WHERE id = ?').get(req.params.loadId);
  if (!load) throw notFound('That trailer load does not exist.');
  const rig = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(load.transactionId)!;
  assertModuleRigAllowed(getIlmRigScope(req), rig.rigId);
  updateTrailerLoad(req.params.loadId, normaliseTrailerLoad(req.body ?? {}), { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ transaction: getIlmTransaction(load.transactionId) });
}));

ilmRouter.delete('/trailer-loads/:loadId', requireAuth, requirePage('ILM','ilm_add','delete'), wrap((req, res) => {
  const load = db.prepare<[string], { transactionId: string }>('SELECT transactionId FROM ilm_trailer_loads WHERE id = ?').get(req.params.loadId);
  if (!load) throw notFound('That trailer load does not exist.');
  const rig = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(load.transactionId)!;
  assertModuleRigAllowed(getIlmRigScope(req), rig.rigId);
  deleteTrailerLoad(req.params.loadId, { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ transaction: getIlmTransaction(load.transactionId) });
}));

/* ---------------------------- lifecycle: crane rounds & records ---------------------------- */

ilmRouter.post('/transactions/:id/crane-rounds', requireAuth, requirePage('ILM','ilm_add','create'), wrap((req, res) => {
  const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(req.params.id);
  if (!txn) throw notFound('That ILM does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), txn.rigId);
  const body = req.body ?? {};
  const roundId = addCraneRound(req.params.id, {
    oldLocation: strOrNull(body.oldLocation), newLocation: strOrNull(body.newLocation),
    locationType: strOrNull(body.locationType),
  }, { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ transaction: getIlmTransaction(req.params.id), roundId });
}));

ilmRouter.post('/crane-rounds/:roundId/records', requireAuth, requirePage('ILM','ilm_add','create'), wrap((req, res) => {
  const owner = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_crane_rounds WHERE id = ?',
  ).get(req.params.roundId);
  if (!owner) throw notFound('That Crane Round does not exist.');
  const rig = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(owner.transactionId)!;
  assertModuleRigAllowed(getIlmRigScope(req), rig.rigId);
  const craneId = addCraneRecord(req.params.roundId, normaliseCrane(req.body ?? {}), { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ transaction: getIlmTransaction(owner.transactionId), craneId });
}));

ilmRouter.put('/crane-records/:craneId', requireAuth, requirePage('ILM','ilm_add','edit'), wrap((req, res) => {
  const crane = db.prepare<[string], { transactionId: string }>('SELECT transactionId FROM ilm_cranes WHERE id = ?').get(req.params.craneId);
  if (!crane) throw notFound('That crane record does not exist.');
  const rig = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(crane.transactionId)!;
  assertModuleRigAllowed(getIlmRigScope(req), rig.rigId);
  updateCraneRecord(req.params.craneId, normaliseCrane(req.body ?? {}), { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ transaction: getIlmTransaction(crane.transactionId) });
}));

ilmRouter.delete('/crane-records/:craneId', requireAuth, requirePage('ILM','ilm_add','delete'), wrap((req, res) => {
  const crane = db.prepare<[string], { transactionId: string }>('SELECT transactionId FROM ilm_cranes WHERE id = ?').get(req.params.craneId);
  if (!crane) throw notFound('That crane record does not exist.');
  const rig = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(crane.transactionId)!;
  assertModuleRigAllowed(getIlmRigScope(req), rig.rigId);
  deleteCraneRecord(req.params.craneId, { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ transaction: getIlmTransaction(crane.transactionId) });
}));

/* ---------------------------- delay records ---------------------------- */

/** The automatic Delay popup's submission — appended, never overwrites a previous one. */
ilmRouter.post('/transactions/:id/delay-records', requireAuth, requirePage('ILM','ilm_add','edit'), wrap((req, res) => {
  const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(req.params.id);
  if (!txn) throw notFound('That ILM does not exist.');
  assertModuleRigAllowed(getIlmRigScope(req), txn.rigId);
  addDelayRecord(req.params.id, normaliseDelayRecord(req.body ?? {}), { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ transaction: getIlmTransaction(req.params.id) });
}));

/* ---------------------------- template ---------------------------- */

ilmRouter.get('/template/:rigId', requireAuth, requirePage('ILM','import','create'), wrap(async (req, res) => {
  assertModuleRigAllowed(getIlmRigScope(req), req.params.rigId);
  const rig = db.prepare<[string], { id: string; rigNumber: string; name: string }>(
    'SELECT id, rigNumber, name FROM ilm_rigs WHERE id = ?',
  ).get(req.params.rigId);
  if (!rig) throw notFound('That rig does not exist.');

  const buffer = await buildIlmTemplateWorkbook({ rigNumber: rig.rigNumber, date: today() });
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'ilm.template.download',
    entity: 'ilm_rigs', entityId: rig.id,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${ilmTemplateFileName(rig.rigNumber)}"`);
  res.send(buffer);
}));

/* ---------------------------- import ---------------------------- */

ilmRouter.post('/import', requireAuth, requirePage('ILM','import','create'),
  upload.single('file'), wrap((req, res) => {
    if (!req.file) throw badRequest('Attach an ILM Excel workbook to upload.');
    const rigId = String(req.body?.rigId ?? '');
    if (!rigId) throw badRequest('Select which rig this file belongs to before uploading.');

    assertModuleRigAllowed(getIlmRigScope(req), rigId);
    const rig = db.prepare<[string], { id: string; rigNumber: string; rigKey: string }>(
      'SELECT id, rigNumber, rigKey FROM ilm_rigs WHERE id = ?',
    ).get(rigId);
    if (!rig) throw badRequest('That rig does not exist.');

    const storedFileName = `${Date.now()}_${newId('f')}${path.extname(req.file.originalname).toLowerCase()}`;

    let parsed: ParsedIlmWorkbook;
    try {
      parsed = parseIlmWorkbook(req.file.buffer);
    } catch (err) {
      recordFailedBatch(req, req.file.originalname, storedFileName, rigId,
        [{ level: 'fatal', message: (err as Error).message }]);
      throw badRequest((err as Error).message);
    }

    const issues = withRigMatchCheck(parsed, rig);
    const fatal = issues.filter((i) => i.level === 'fatal');
    if (fatal.length > 0) {
      const batchId = recordFailedBatch(req, req.file.originalname, storedFileName, rigId, issues);
      throw new HttpError(400, 'Import failed. Correct the file and upload again.', {
        issues, batchId,
      });
    }

    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    // One file still represents one movement's worth of data (one rig, one
    // date). It no longer "replaces" anything — it appends a new Trailer
    // Movement + Crane Round + delay lines to whichever ILM is Active for
    // this rig, starting a new ILM first if the rig has none Active yet.
    const recordCount = parsed.individualLines.length + parsed.trailerLoads.length + parsed.cranes.length;
    const batchId = newId('ilmimp');
    const ctx = { user: req.user!.username, ip: req.clientIp ?? null };
    const transactionId = transact(() => {
      db.prepare(`
        INSERT INTO ilm_import_batches (id, fileName, storedFileName, rigId, uploadedBy, uploadedAt, status, templateVersion, recordCount, errorCount, errorDetail)
        VALUES (@id, @fileName, @storedFileName, @rigId, @uploadedBy, @uploadedAt, 'Successful', @templateVersion, @recordCount, 0, NULL)
      `).run({
        id: batchId, fileName: req.file!.originalname, storedFileName, rigId: rig.id,
        uploadedBy: req.user!.username, uploadedAt: nowIso(), templateVersion: '1.0', recordCount,
      });

      const active = findActiveIlm(rig.id);
      const id = active?.id ?? createIlm({
        rigId: rig.id, date: parsed.ilmDate!, source: 'excel', importBatchId: batchId,
        individual: {
          area: parsed.area, operatorName: null, wellNo: null,
          movementFromWell: parsed.movementFromWell, movementToWell: parsed.movementToWell,
          releaseDate: parsed.releaseDate, releaseTime: parsed.releaseTime, spudDate: parsed.spudDate, spudTime: parsed.spudTime,
          ilmRatePerDay: null, ilmExpenses: null,
        },
        ctx,
      });

      if (parsed.individualLines.length) {
        appendDelayLines(id, parsed.individualLines.map((l) => ({
          reasonForDelay: l.reasonForDelay, totalDelayHours: l.totalDelayHours,
          hsdStockAccession: l.hsdStockAccession, receivedQtyDuringIlm: l.receivedQtyDuringIlm, hsdStockShiftEnd: l.hsdStockShiftEnd,
          ilmDistanceKm: l.ilmDistanceKm, totalLoadsMoved: l.totalLoadsMoved, cumulativeTrailerKm: l.cumulativeTrailerKm,
        })), ctx);
      }

      if (parsed.trailerLoads.length || parsed.trailerHeader.oldLocation || parsed.trailerHeader.newLocation) {
        const { id: movementId } = addTrailerMovement(id, {
          fleetReportAt: parsed.trailerHeader.fleetReportAt, leadDistanceKm: parsed.trailerHeader.leadDistanceKm,
          allowedDurationHrs: parsed.trailerHeader.allowedDurationHrs,
          explicitHeader: {
            rigName: parsed.trailerHeader.rigName, oldLocation: parsed.trailerHeader.oldLocation,
            newLocation: parsed.trailerHeader.newLocation, rigReleaseAt: parsed.trailerHeader.rigReleaseAt,
          },
        }, ctx);
        for (const t of parsed.trailerLoads) {
          addTrailerLoad(movementId, {
            mtGatePassNo: t.mtGatePassNo, trailerNo: t.trailerNo, equipmentId: null, trailerType: t.trailerType, capacityTon: t.capacityTon,
            arrivalDate: t.arrivalDate, arrivalTime: t.arrivalTime, loadingDate: t.loadingDate, loadingTime: t.loadingTime,
            loadDescription: t.loadDescription, totalPackages: t.totalPackages, unloadingDate: t.unloadingDate,
            unloadingTime: t.unloadingTime, driverName: t.driverName, driverContact: t.driverContact,
          }, ctx);
        }
      }

      if (parsed.cranes.length) {
        const roundId = addCraneRound(id, { oldLocation: null, newLocation: null }, ctx);
        for (const c of parsed.cranes) addCraneRecord(roundId, { ...c, equipmentId: null }, ctx);
      }

      db.prepare('UPDATE ilm_import_batches SET transactionId = ? WHERE id = ?').run(id, batchId);
      return id;
    });

    audit({
      user: req.user!.username, ip: req.clientIp, action: 'ilm.import',
      entity: 'ilm_transactions', entityId: transactionId,
      detail: `${req.file.originalname} -> ${rig.rigNumber} ${parsed.ilmDate}: ${recordCount} record(s)`,
    });

    res.status(201).json({
      transaction: getIlmTransaction(transactionId), batchId,
      warnings: parsed.issues.filter((i) => i.level === 'warning'),
    });
  }));

interface ImportBatchRow {
  id: string; fileName: string; storedFileName: string | null; rigId: string;
  uploadedBy: string; uploadedAt: string; status: string; templateVersion: string | null;
  recordCount: number; errorCount: number; errorDetail: string | null; transactionId: string | null;
  rigNumber: string; rigName: string;
}

ilmRouter.get('/import/history', requireAuth, requireModulePermission('ILM', 'view'), wrap((req, res) => {
  const scope = getIlmRigScope(req);
  const rows = (scope.restricted
    ? db.prepare(`
        SELECT b.*, r.rigNumber, r.name AS rigName
        FROM ilm_import_batches b
        JOIN ilm_rigs r ON r.id = b.rigId
        WHERE b.rigId IN (${scope.rigIds.length ? scope.rigIds.map(() => '?').join(',') : `'${NO_RIG_ACCESS}'`})
        ORDER BY b.uploadedAt DESC
        LIMIT 200
      `).all(...scope.rigIds)
    : db.prepare(`
        SELECT b.*, r.rigNumber, r.name AS rigName
        FROM ilm_import_batches b
        JOIN ilm_rigs r ON r.id = b.rigId
        ORDER BY b.uploadedAt DESC
        LIMIT 200
      `).all()) as ImportBatchRow[];
  res.json({
    batches: rows.map((r) => ({
      ...r,
      errorDetail: r.errorDetail ? JSON.parse(r.errorDetail) as IlmIssue[] : null,
    })),
  });
}));

/* ---------------------------- helpers ---------------------------- */

/**
 * Exported for tests: the rig the user selected must match BOTH the rig
 * named on the Individual sheet and the rig named on the Trailer sheet —
 * checked even when other issues are already present so a mismatch is never
 * masked by something else. Never mutates the input.
 */
export function withRigMatchCheck(
  parsed: Pick<ParsedIlmWorkbook, 'rigKeyInFile' | 'rigTextInFile' | 'trailerRigKeyInFile' | 'trailerRigTextInFile' | 'issues'>,
  rig: { rigNumber: string; rigKey: string },
): IlmIssue[] {
  const hasFatal = parsed.issues.some((i) => i.level === 'fatal');
  if (hasFatal) return parsed.issues;

  const mismatchText = [parsed.rigKeyInFile, parsed.trailerRigKeyInFile].find(
    (key) => key && key !== rig.rigKey,
  );
  if (!mismatchText) return parsed.issues;

  const fileRigText = parsed.rigKeyInFile && parsed.rigKeyInFile !== rig.rigKey
    ? parsed.rigTextInFile : parsed.trailerRigTextInFile;
  return [
    {
      level: 'fatal',
      message: `Incorrect Rig Template.\nSelected Rig: ${rig.rigNumber}\nUploaded Template Rig: ${fileRigText}\nPlease upload the correct Rig template.`,
    },
    ...parsed.issues,
  ];
}

function recordFailedBatch(
  req: { user?: { username: string } },
  fileName: string, storedFileName: string, rigId: string, issues: IlmIssue[],
): string {
  const id = newId('ilmimp');
  db.prepare(`
    INSERT INTO ilm_import_batches (id, fileName, storedFileName, rigId, uploadedBy, uploadedAt, status, templateVersion, recordCount, errorCount, errorDetail)
    VALUES (@id, @fileName, NULL, @rigId, @uploadedBy, @uploadedAt, 'Failed', NULL, 0, @errorCount, @errorDetail)
  `).run({
    id, fileName, rigId, uploadedBy: req.user?.username ?? 'unknown', uploadedAt: nowIso(),
    errorCount: issues.filter((i) => i.level === 'fatal').length,
    errorDetail: JSON.stringify(issues),
  });
  return id;
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

/** Manual-entry payloads arrive as plain objects from the client; coerce types server-side, one per resource. */
function normaliseHeader(ind: any): IlmHeaderInput {
  return {
    area: strOrNull(ind.area), operatorName: strOrNull(ind.operatorName), wellNo: strOrNull(ind.wellNo),
    movementFromWell: strOrNull(ind.movementFromWell), movementToWell: strOrNull(ind.movementToWell),
    releaseDate: strOrNull(ind.releaseDate), releaseTime: strOrNull(ind.releaseTime),
    spudDate: strOrNull(ind.spudDate), spudTime: strOrNull(ind.spudTime),
    ilmRatePerDay: numOrNull(ind.ilmRatePerDay), ilmExpenses: numOrNull(ind.ilmExpenses),
    contractDateFrom: strOrNull(ind.contractDateFrom), contractDateTo: strOrNull(ind.contractDateTo),
    movementDistanceKm: numOrNull(ind.movementDistanceKm),
  };
}

function normaliseDelayRecord(r: any): DelayRecordInput {
  return {
    reasonForDelay: String(r.reasonForDelay ?? '').trim(),
    otherReason: strOrNull(r.otherReason), delayHours: numOrNull(r.delayHours), remarks: strOrNull(r.remarks),
  };
}

function normaliseDelayLine(r: any): DelayLineInput {
  return {
    reasonForDelay: strOrNull(r.reasonForDelay), totalDelayHours: numOrNull(r.totalDelayHours),
    hsdStockAccession: numOrNull(r.hsdStockAccession), receivedQtyDuringIlm: numOrNull(r.receivedQtyDuringIlm),
    hsdStockShiftEnd: numOrNull(r.hsdStockShiftEnd), ilmDistanceKm: numOrNull(r.ilmDistanceKm),
    totalLoadsMoved: numOrNull(r.totalLoadsMoved), cumulativeTrailerKm: numOrNull(r.cumulativeTrailerKm),
  };
}

/** srNo/lineNo are deliberately absent — the service always assigns them (spec: never user-entered). */
function normaliseTrailerLoad(r: any): TrailerLoadInput {
  const equipmentId = strOrNull(r.equipmentId);
  const linkedName = resolveLinkedIlmEquipment(equipmentId, 'Trailer');
  return {
    mtGatePassNo: strOrNull(r.mtGatePassNo), trailerNo: linkedName ?? strOrNull(r.trailerNo), equipmentId,
    trailerType: strOrNull(r.trailerType), capacityTon: numOrNull(r.capacityTon),
    arrivalDate: strOrNull(r.arrivalDate), arrivalTime: strOrNull(r.arrivalTime),
    loadingDate: strOrNull(r.loadingDate), loadingTime: strOrNull(r.loadingTime),
    loadDescription: strOrNull(r.loadDescription), totalPackages: numOrNull(r.totalPackages),
    unloadingDate: strOrNull(r.unloadingDate), unloadingTime: strOrNull(r.unloadingTime),
    driverName: strOrNull(r.driverName), driverContact: strOrNull(r.driverContact),
  };
}

function normaliseCrane(r: any): CraneRecordInput {
  const equipmentId = strOrNull(r.equipmentId);
  const linkedName = resolveLinkedIlmEquipment(equipmentId, 'Crane');
  return {
    craneNo: linkedName ?? strOrNull(r.craneNo), equipmentId, capacityTon: numOrNull(r.capacityTon), reportingDate: strOrNull(r.reportingDate),
    rigOrHired: strOrNull(r.rigOrHired), registrationNo: strOrNull(r.registrationNo),
    arrivedDate: strOrNull(r.arrivedDate), arrivedTime: strOrNull(r.arrivedTime),
    releaseDate: strOrNull(r.releaseDate), releaseTime: strOrNull(r.releaseTime),
    transporterName: strOrNull(r.transporterName),
    dayNo: numOrNull(r.dayNo), shiftDate: strOrNull(r.shiftDate),
    dayShiftHrs: numOrNull(r.dayShiftHrs), detailsJobDay: strOrNull(r.detailsJobDay),
    nightShiftHrs: numOrNull(r.nightShiftHrs), detailsJobNight: strOrNull(r.detailsJobNight),
    breakdownHrs: numOrNull(r.breakdownHrs), cumulativeHrs: numOrNull(r.cumulativeHrs),
    issuedHsdLtrs: numOrNull(r.issuedHsdLtrs), totalWorkingHrs: numOrNull(r.totalWorkingHrs),
  };
}
