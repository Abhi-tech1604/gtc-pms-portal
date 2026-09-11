import { Router } from 'express';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso, today } from '../util/date.js';
import { rigKey } from '../excel/normalize.js';
import { assertRigAllowed, requireAuth, requireModulePermission, requirePage, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { listEquipment, type EquipmentView } from '../services/equipmentView.js';
import {
  getPreviousEquipmentHours, getPreviousHsdOpening, getPreviousHydraulicLevel, getPreviousOilBalance,
} from '../services/drrCarryForward.js';
import { saveDprReport } from './dpr.js';
import { saveHsdReport } from './hsd.js';
import { recordService } from '../services/equipmentService.js';
import { getScheduledEmployees } from '../services/manpowerRoster.js';
import { listActiveEmployees } from './employees.js';
import { assertCanDecide, assertDrrRigVisible, drrRigIds } from '../services/drrResponsibility.js';
import {
  NOTIFICATION_TYPES, notifyDrrApproved, notifyDrrPendingApproval, notifyDrrRejected, settingsFor,
} from '../services/notifications.js';
import type { ParsedDprLine } from '../excel/dprIngest.js';
import type { ParsedHsdDay, ParsedHsdEquipmentLine, ParsedHsdSiteLine } from '../excel/hsdIngest.js';

export const drrRouter = Router();

/**
 * A Daily Rig Report is one form that writes into three modules' own tables
 * in a single save (spec: DPR + Mechanical Log + HSD share one entry point).
 * Nothing here replaces those modules' Excel import — this is a second
 * writer into the same tables, exactly the way DPR's manual entry already
 * writes the same dpr_reports/dpr_line_items its own Excel import does.
 */

/**
 * Lubricating Oil types offered in DRR are scoped to what's actually been
 * assigned (Admin > Oil & Lubricant Master's Rig -> Equipment -> Oil mapping)
 * to this rig's active equipment — never a fixed catalogue in code.
 */
/**
 * The oils offered for a rig's Lubricating Oil section, and what the Excel
 * Import template's dropdown/hidden-id column is built from — one shared
 * query so the manual form and the template can never drift apart.
 *
 * Two kinds of Active oil reach a rig, and both are read live from Oil &
 * Lubricant Master on every request:
 *
 * 1. Assigned — mapped to one of THIS rig's active machines. Rig-specific.
 * 2. Unassigned anywhere — in the master but not yet mapped to any equipment
 *    on any rig. These are general-purpose (grease, coolant, dope), and they
 *    are what a newly added master entry looks like the moment it is created.
 *
 * Including (2) is what makes the master and the DRR form stay in step: a
 * fresh entry in Oil & Lubricant Master shows up on every rig's form
 * immediately, and narrows to the rigs that actually use it as soon as it is
 * assigned to equipment. Without it, once every rig had assignments (which is
 * now the case fleet-wide) a newly added oil could never appear in DRR at all.
 */
export function getScopedOilRows(rigId: string): { id: string; name: string }[] {
  return db.prepare(`
    SELECT DISTINCT o.id, o.name
      FROM oil_lubricants o
     WHERE o.status = 'Active'
       AND (
         EXISTS (
           SELECT 1 FROM equipment_oil_lubricants m
             JOIN equipment e ON e.id = m.equipmentId
            WHERE m.oilLubricantId = o.id AND m.status = 'Active'
              AND e.rigId = ? AND e.isActive = 1
         )
         OR NOT EXISTS (
           SELECT 1 FROM equipment_oil_lubricants m
             JOIN equipment e ON e.id = m.equipmentId
            WHERE m.oilLubricantId = o.id AND m.status = 'Active' AND e.isActive = 1
         )
       )
     ORDER BY o.name
  `).all(rigId) as { id: string; name: string }[];
}

function getActiveLubricantTypes(rigId: string): string[] {
  return getScopedOilRows(rigId).map((r) => r.name);
}

// The HSD workbook's own two hydraulic tanks (Hydraulic Oil Level Sheet).
export const HYDRAULIC_TANKS = ['Rig Carrier Hydraulic Tank', 'Accumulator Tank'];

export const SHIFT_OPTIONS = ['Day', 'Night', '24 Hour'];
export const EQUIPMENT_STATUS_OPTIONS = ['Running', 'Standby', 'Breakdown', 'Maintenance', 'Not Available'];

interface RigRow { id: string; rigNumber: string; name: string; }
interface DprRigRow { id: string; rigNumber: string; rigKey: string; }

/** Bridges PMS's rig (rigs, equipment's own master) to DPR/HSD's rig (dpr_rigs) by rigNumber — see plan decision 2. */
export function resolveDprRig(rigNumber: string): DprRigRow {
  const key = rigKey(rigNumber);
  const row = db.prepare<[string], DprRigRow>('SELECT id, rigNumber, rigKey FROM dpr_rigs WHERE rigKey = ?').get(key);
  if (!row) {
    throw badRequest(
      `No matching DPR rig for "${rigNumber}". The PMS and DPR rig masters have drifted apart — ask an admin to add "${rigNumber}" in DPR Rig Master before filing a Daily Rig Report for it.`,
    );
  }
  return row;
}

/* ---------------------------- prefill ---------------------------- */

/**
 * The PMS rig list, read straight from `rigs` rather than proxied through
 * /api/rigs — a user can have DRR access without PMS access (they are
 * separate modules), and the rig picker here needs the list regardless.
 */
drrRouter.get('/rigs', requireAuth, requireModulePermission('DRR', 'view'), wrap((req, res) => {
  const ids = drrRigIds(req);
  if (ids === null) {
    res.json({ rigs: db.prepare("SELECT id, rigNumber, name, status FROM rigs WHERE status = 'Active' ORDER BY rigNumber").all() });
    return;
  }
  if (ids.length === 0) { res.json({ rigs: [] }); return; }
  const placeholders = ids.map(() => '?').join(',');
  const rigs = db.prepare(
    `SELECT id, rigNumber, name, status FROM rigs WHERE status = 'Active' AND id IN (${placeholders}) ORDER BY rigNumber`,
  ).all(...ids);
  res.json({ rigs });
}));

drrRouter.get('/prefill', requireAuth, requireModulePermission('DRR', 'view'), wrap((req, res) => {
  const rigId = String(req.query.rigId ?? '');
  const reportDate = String(req.query.reportDate ?? '');
  if (!rigId || !reportDate) throw badRequest('Choose a rig and a date first.');

  const rig = db.prepare<[string], RigRow>('SELECT id, rigNumber, name FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw notFound('That rig does not exist.');
  assertDrrRigVisible(req, rig.id);
  const dprRig = resolveDprRig(rig.rigNumber);

  const equipment = listEquipment(rigId).filter((e) => e.isActive);
  const equipmentLines = equipment.map((e) => {
    const opening = getPreviousEquipmentHours(e.id, reportDate);
    return {
      equipmentId: e.id, name: e.name, category: e.category,
      manufacturer: e.manufacturer, model: e.model, serialNumber: e.serialNumber,
      openingRunningHours: opening.openingRunningHours, openingSource: opening.source,
      lastServiceHours: e.lastServiceHours,
    };
  });

  const hsdOpening = getPreviousHsdOpening(dprRig.id, reportDate);

  const oilTypes = getActiveLubricantTypes(rigId).map((oilType) => ({
    oilType,
    openingBalance: getPreviousOilBalance(null, oilType, rigId, reportDate),
  }));

  const hydraulicTanks = HYDRAULIC_TANKS.map((tankName) => ({
    tankName,
    openingLevel: getPreviousHydraulicLevel(rigId, tankName, reportDate),
  }));

  // Whether any of the opening values above were actually carried forward
  // from a real prior submission for THIS rig, or are starting cold (no
  // previous Daily Rig Report at all) — the client uses this to warn rather
  // than silently show zeroes/master defaults as if they were carried data.
  const previousReport = db.prepare<[string, string], { reportDate: string }>(
    "SELECT reportDate FROM drr_reports WHERE rigId = ? AND reportDate < ? AND status = 'Submitted' ORDER BY reportDate DESC LIMIT 1",
  ).get(rigId, reportDate);

  const wellSuggestions = db.prepare<[string, string], { wellName: string }>(`
    SELECT DISTINCT wellName FROM (
      SELECT wellName FROM hsd_reports WHERE rigId = ? AND wellName IS NOT NULL
      UNION
      SELECT wellName FROM dpr_line_items li JOIN dpr_reports r ON r.id = li.reportId
        WHERE r.rigId = ? AND wellName IS NOT NULL
    ) LIMIT 20
  `).all(dprRig.id, dprRig.id);

  res.json({
    rig, dprRig,
    equipment: equipmentLines,
    hsdOpeningStock: hsdOpening.siteDieselClosing ?? 0,
    oilTypes, hydraulicTanks,
    previousReportDate: previousReport?.reportDate ?? null,
    employees: listActiveEmployees(),
    // Reference only — a small "Scheduled: ON/OFF" indicator next to a
    // manually-added employee. Never used to auto-populate attendance rows.
    manpower: getScheduledEmployees(rigId, reportDate),
    wellSuggestions: wellSuggestions.map((w) => w.wellName),
    shiftOptions: SHIFT_OPTIONS, equipmentStatusOptions: EQUIPMENT_STATUS_OPTIONS,
  });
}));

/* ---------------------------- list / detail ---------------------------- */

/**
 * The rig restriction every DRR list/count endpoint applies: `null` from
 * drrRigIds() means unrestricted (Admin, or an account with no rig
 * responsibility assignment — same "see everything" default as before this
 * feature); otherwise the WHERE clause is hard-limited to exactly those
 * rigs, which is what stops a Storekeeper or Operational Manager from
 * reaching another rig's DRR data via a crafted request (spec section 6).
 */
function drrVisibilityWhere(req: import('express').Request, params: Record<string, unknown>): string | null {
  if (req.query.rigId) {
    assertDrrRigVisible(req, String(req.query.rigId));
    params.rigId = req.query.rigId;
    return 'd.rigId = @rigId';
  }
  const ids = drrRigIds(req);
  if (ids === null) return null;
  if (ids.length === 0) return '0'; // no assignment at all resolves to "sees nothing", not "sees everything"
  ids.forEach((rid, i) => { params[`rig${i}`] = rid; });
  return `d.rigId IN (${ids.map((_, i) => `@rig${i}`).join(',')})`;
}

drrRouter.get('/reports', requireAuth, requireModulePermission('DRR', 'view'), wrap((req, res) => {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const visibility = drrVisibilityWhere(req, params);
  if (visibility) where.push(visibility);
  if (req.query.status) { where.push('d.status = @status'); params.status = req.query.status; }
  if (req.query.dateFrom) { where.push('d.reportDate >= @dateFrom'); params.dateFrom = req.query.dateFrom; }
  if (req.query.dateTo) { where.push('d.reportDate <= @dateTo'); params.dateTo = req.query.dateTo; }

  const reports = db.prepare(`
    SELECT d.id, d.rigId, d.reportDate, d.wellNo, d.shift, d.fieldLocation, d.status,
           d.submittedBy, d.submittedAt, d.approvedBy, d.approvedAt, d.rejectedBy, d.rejectedAt, d.rejectionReason,
           d.createdBy, d.createdAt, d.updatedAt, r.rigNumber, r.name AS rigName
    FROM drr_reports d
    JOIN rigs r ON r.id = d.rigId
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.reportDate DESC, r.rigNumber
    LIMIT 500
  `).all(params);
  res.json({ reports });
}));

/**
 * Powers the DRR Dashboard's status boxes — one query, scoped exactly like
 * GET /reports above, so the counts on a box and what its click-through list
 * shows can never disagree.
 */
drrRouter.get('/reports/status-counts', requireAuth, requireModulePermission('DRR', 'view'), wrap((req, res) => {
  const params: Record<string, unknown> = {};
  const visibility = drrVisibilityWhere(req, params);
  const rows = db.prepare<Record<string, unknown>, { status: string; n: number }>(`
    SELECT d.status, COUNT(*) AS n FROM drr_reports d
    ${visibility ? `WHERE ${visibility}` : ''}
    GROUP BY d.status
  `).all(params);
  const counts = { Draft: 0, PendingApproval: 0, Submitted: 0, Rejected: 0 };
  for (const r of rows) if (r.status in counts) (counts as Record<string, number>)[r.status] = r.n;

  // "Operational Manager: Approval Overdue" (notification brief section 8) —
  // same visibility scope, same escalation threshold the DRR_APPROVAL_ESCALATION
  // generator uses, so this box's count can never disagree with what actually
  // escalates to Admin.
  const escalationHours = settingsFor(NOTIFICATION_TYPES.DRR_APPROVAL_ESCALATION).escalationHours ?? 24;
  const cutoff = new Date(Date.now() - escalationHours * 3600000).toISOString();
  const overdueParams: Record<string, unknown> = { cutoff };
  const overdueVisibility = drrVisibilityWhere(req, overdueParams);
  const overdue = db.prepare<Record<string, unknown>, { n: number }>(`
    SELECT COUNT(*) AS n FROM drr_reports d
    WHERE d.status = 'PendingApproval' AND d.submittedAt IS NOT NULL AND d.submittedAt <= @cutoff
    ${overdueVisibility ? `AND ${overdueVisibility}` : ''}
  `).get(overdueParams)!.n;

  res.json({ counts, overdueApprovals: overdue });
}));

drrRouter.get('/reports/:id', requireAuth, requireModulePermission('DRR', 'view'), wrap((req, res) => {
  const report = loadReportDetail(req.params.id);
  if (!report) throw notFound('That Daily Rig Report does not exist.');
  assertDrrRigVisible(req, report.rigId);
  res.json({ report });
}));

export interface DrrApprovalHistoryEntry {
  id: string; action: 'Submitted' | 'Approved' | 'Rejected'; byUser: string; atTime: string; reason: string | null;
}

export function loadReportDetail(id: string) {
  const row = db.prepare<[string], {
    id: string; rigId: string; reportDate: string; wellNo: string | null; shift: string;
    fieldLocation: string | null; status: string; dprReportId: string | null; hsdReportId: string | null;
    draftPayload: string | null; submittedBy: string; submittedAt: string | null;
    approvedBy: string | null; approvedAt: string | null;
    rejectedBy: string | null; rejectedAt: string | null; rejectionReason: string | null;
    createdBy: string; createdAt: string;
    updatedBy: string | null; updatedAt: string; rigNumber: string; rigName: string;
  }>(`
    SELECT d.*, r.rigNumber, r.name AS rigName FROM drr_reports d JOIN rigs r ON r.id = d.rigId WHERE d.id = ?
  `).get(id);
  if (!row) return null;

  // The last saved form payload is always kept (see schema.sql's comment on
  // drr_reports.draftPayload) — reopening the form for edit is always "read
  // back exactly what was last typed", whether or not it was ever submitted.
  const payload = row.draftPayload ? JSON.parse(row.draftPayload) : null;

  const approvalHistory = db.prepare<[string], DrrApprovalHistoryEntry>(
    'SELECT id, action, byUser, atTime, reason FROM drr_approval_history WHERE reportId = ? ORDER BY atTime',
  ).all(id);

  return {
    id: row.id, rigId: row.rigId, rigNumber: row.rigNumber, rigName: row.rigName,
    reportDate: row.reportDate, wellNo: row.wellNo, shift: row.shift, fieldLocation: row.fieldLocation,
    status: row.status, submittedBy: row.submittedBy, submittedAt: row.submittedAt,
    approvedBy: row.approvedBy, approvedAt: row.approvedAt,
    rejectedBy: row.rejectedBy, rejectedAt: row.rejectedAt, rejectionReason: row.rejectionReason,
    createdBy: row.createdBy, createdAt: row.createdAt, updatedAt: row.updatedAt,
    approvalHistory,
    ...payload,
  };
}

/* ---------------------------- validation ---------------------------- */

export interface EquipmentLineInput {
  equipmentId: string; openingRunningHours: number; dayHours: number; nightHours: number;
  hsdConsumption: number; status: string; remarks: string | null;
  breakdownAt?: string | null; breakdownDescription?: string | null; actionTaken?: string | null;
  partsRequired?: string | null; expectedRestoration?: string | null; breakdownRemark?: string | null;
  /** "Service Done Today" — locked by default; when true, serviceHours must be within [opening, closing] for the day. */
  serviceDoneToday?: boolean; serviceHours?: number | null;
}
export interface OilLineInput { equipmentId: string | null; oilType: string; openingBalance: number; oilAdded: number; oilConsumed: number; remark: string | null; }
export interface HydraulicLineInput { tankName: string; openingLevel: number; topUp: number; loss: number; remark: string | null; }

const ATTENDANCE_STATUS_OPTIONS = ['Present', 'Absent', 'Leave'];

/**
 * One row of Site Attendance — the ACTUAL manpower the Rig User recorded for
 * this rig on this date, entered directly, never inferred from the roster.
 * `employeeId` is null for a temporary/ad-hoc "+ Add Employee" entry;
 * `employeeName`/`employeeCode`/`designation` are always a frozen snapshot
 * taken at save time, never re-derived from Employee Master or the roster
 * later, so editing either afterward can never change a report already on
 * file. `rosterStatus` (if present) is likewise a frozen reference snapshot
 * of what the roster said for that day — display-only, it never constrains
 * `attendanceStatus`.
 */
export interface AttendanceLineInput {
  employeeId: string | null; employeeName: string; employeeCode: string | null; designation: string | null;
  rosterStatus: 'ON' | 'OFF' | null; attendanceStatus: string;
  shift: string | null; inTime: string | null; outTime: string | null;
  isTemporary: boolean; remarks: string | null;
}

export interface DrrPayload {
  /** No longer collected from the DRR form (Shift/Report Type was removed) — saveReport() always defaults it to 'Day'. Optional so pre-existing callers (tests, demo data, Excel import) that still pass an explicit shift keep compiling and behaving unchanged. */
  rigId: string; reportDate: string; wellNo: string; shift?: string; fieldLocation: string | null;
  hsdReceived: number;
  hsdRemarks: string | null;
  equipmentLines: EquipmentLineInput[];
  oilLines: OilLineInput[];
  hydraulicLines: HydraulicLineInput[];
  /** Optional so every pre-existing caller (tests, demo data, Excel import) that predates Site Attendance keeps compiling unchanged; saveReport()/validate() both treat a missing array the same as an empty one. */
  attendanceLines?: AttendanceLineInput[];
  dprLines: unknown[];
}

export interface Issue { field: string; message: string; }

export function validate(body: DrrPayload, isSubmit: boolean): Issue[] {
  const issues: Issue[] = [];
  if (!body.rigId) issues.push({ field: 'rigId', message: 'Select a rig.' });
  if (!body.reportDate) issues.push({ field: 'reportDate', message: 'Select a date.' });
  if (body.shift && !SHIFT_OPTIONS.includes(body.shift)) issues.push({ field: 'shift', message: 'Invalid shift value.' });
  if (isSubmit && !body.wellNo?.trim()) issues.push({ field: 'wellNo', message: 'Well No. is required.' });

  if (body.hsdReceived < 0) issues.push({ field: 'hsdReceived', message: 'HSD received cannot be negative.' });

  for (const [i, line] of (body.equipmentLines ?? []).entries()) {
    const p = `equipmentLines[${i}]`;
    if (line.dayHours < 0) issues.push({ field: p, message: `${p}: Day hours cannot be negative.` });
    if (line.nightHours < 0) issues.push({ field: p, message: `${p}: Night hours cannot be negative.` });
    if (line.hsdConsumption < 0) issues.push({ field: p, message: `${p}: HSD consumption cannot be negative.` });
    if (!EQUIPMENT_STATUS_OPTIONS.includes(line.status)) issues.push({ field: p, message: `${p}: invalid status.` });
    if (line.status === 'Breakdown' && isSubmit && !line.breakdownDescription?.trim()) {
      issues.push({ field: p, message: `${p}: breakdown description is required when status is Breakdown.` });
    }
    if (line.serviceDoneToday) {
      const closing = round2(line.openingRunningHours + line.dayHours + line.nightHours);
      if (line.serviceHours === null || line.serviceHours === undefined || !Number.isFinite(line.serviceHours)) {
        issues.push({ field: p, message: `${p}: enter the service hour reading.` });
      } else if (line.serviceHours < line.openingRunningHours || line.serviceHours > closing) {
        issues.push({
          field: p,
          message: `${p}: service hours must be between today's Opening Hours (${line.openingRunningHours}) and Closing Hours (${closing}).`,
        });
      }
    }
  }

  for (const [i, line] of (body.oilLines ?? []).entries()) {
    const p = `oilLines[${i}]`;
    if (line.oilAdded < 0) issues.push({ field: p, message: `${p}: oil added cannot be negative.` });
    if (line.oilConsumed < 0) issues.push({ field: p, message: `${p}: oil consumed cannot be negative.` });
    const closing = line.openingBalance + line.oilAdded - line.oilConsumed;
    if (closing < 0) issues.push({ field: p, message: `${p}: closing balance would go negative — check oil added/consumed.` });
  }

  for (const [i, line] of (body.hydraulicLines ?? []).entries()) {
    const p = `hydraulicLines[${i}]`;
    if (line.topUp < 0) issues.push({ field: p, message: `${p}: top-up cannot be negative.` });
    if (line.loss < 0) issues.push({ field: p, message: `${p}: loss cannot be negative.` });
    const closing = line.openingLevel + line.topUp - line.loss;
    if (closing < 0) issues.push({ field: p, message: `${p}: closing level cannot be negative.` });
  }

  const seenEmployeeIds = new Set<string>();
  for (const [i, line] of (body.attendanceLines ?? []).entries()) {
    const p = `attendanceLines[${i}]`;
    if (!line.employeeName?.trim()) issues.push({ field: p, message: `${p}: employee name is required.` });
    if (!ATTENDANCE_STATUS_OPTIONS.includes(line.attendanceStatus)) {
      issues.push({ field: p, message: `${p}: attendance status must be Present, Absent or Leave.` });
    }
    if (line.employeeId) {
      if (seenEmployeeIds.has(line.employeeId)) {
        issues.push({ field: p, message: `${p}: ${line.employeeName} already has an attendance entry in this report.` });
      }
      seenEmployeeIds.add(line.employeeId);
      if (!line.isTemporary) {
        const exists = db.prepare<[string], { id: string }>('SELECT id FROM employees WHERE id = ?').get(line.employeeId);
        if (!exists) issues.push({ field: p, message: `${p}: ${line.employeeName} was not found in the Employee Master.` });
      }
    } else if (!line.isTemporary) {
      issues.push({ field: p, message: `${p}: select an employee from the Employee Master, or add them as a temporary onsite worker.` });
    }
  }

  return issues;
}

/* ---------------------------- save (create / update) ---------------------------- */

/**
 * `Submitted` and `Rejected` are reached only through the approval endpoints
 * below (/reports/:id/approve, /reject) or through a trusted internal caller
 * (Excel import, demo seed data — both call saveReport() directly, never
 * through this route). The interactive form may only ever ask for `Draft` or
 * `PendingApproval` here — "Submit for Approval" is the storekeeper's whole
 * authority over a report's status; deciding it belongs to the manager.
 *
 * The one exception is Admin directly re-saving an already-Submitted report
 * as `Submitted` again — the same "edit an approved report" capability that
 * existed before this workflow, kept for Admin only (this app's usual
 * "Admin can fix anything" override), everyone else must go through Reject
 * -> correct -> resubmit -> Approve.
 */
function assertClientRequestableStatus(status: unknown, isAdmin: boolean): void {
  if (status === 'Submitted' && isAdmin) return;
  if (status !== undefined && status !== 'Draft' && status !== 'PendingApproval') {
    throw badRequest('A Daily Rig Report can only be saved as a Draft or submitted for approval here.');
  }
}

drrRouter.post('/reports', requireAuth, requirePage('DRR','new_report','create'), wrap((req, res) => {
  assertDrrRigVisible(req, req.body?.rigId ?? null);
  assertClientRequestableStatus(req.body?.status, req.user!.role === 'Admin');
  res.status(201).json(saveReport(null, req.body, req.user!.username, req.clientIp ?? null));
}));

drrRouter.put('/reports/:id', requireAuth, requirePage('DRR','new_report','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; status: string; rigId: string }>('SELECT id, status, rigId FROM drr_reports WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That Daily Rig Report does not exist.');
  assertDrrRigVisible(req, existing.rigId);
  assertDrrRigVisible(req, req.body?.rigId ?? null);
  assertClientRequestableStatus(req.body?.status, req.user!.role === 'Admin');
  if (existing.status !== 'Draft' && req.body?.status === 'Draft') {
    throw badRequest('This report has already been submitted — edit the values and use Save Daily Report, not Save Draft.');
  }
  // A report awaiting a decision, or already final, is not the storekeeper's
  // to resubmit — only Draft (first submission) or Rejected (correct and
  // resubmit) may move to PendingApproval. Admin is exempt, matching this
  // app's usual "Admin can fix anything" convention.
  if (req.body?.status === 'PendingApproval' && !['Draft', 'Rejected'].includes(existing.status) && req.user!.role !== 'Admin') {
    throw badRequest(`This report is ${existing.status === 'PendingApproval' ? 'already pending approval' : 'already finalized'} — it cannot be submitted for approval again.`);
  }
  res.json(saveReport(req.params.id, req.body, req.user!.username, req.clientIp ?? null));
}));

/* ---------------------------- approve / reject ---------------------------- */

/**
 * Approve: PendingApproval -> Submitted. Reuses saveReport() with the
 * report's own last-saved content (loadReportDetail() already returns
 * exactly the DrrPayload shape saveReport() expects — top-level fields plus
 * the draftPayload spread in) and status 'Submitted' — so approval runs
 * through the SAME validation and DPR/Mechanical Log/HSD distribution code
 * every other Submitted report has always used, unchanged. Only the
 * rig's Active Operational Manager (Primary or Backup), or Admin, may do this
 * (spec section 6 — enforced here, not just by hiding the button).
 */
drrRouter.post('/reports/:id/approve', requireAuth, requirePage('DRR','reports','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; status: string; rigId: string; submittedBy: string }>(
    'SELECT id, status, rigId, submittedBy FROM drr_reports WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That Daily Rig Report does not exist.');
  assertCanDecide(req, existing.rigId);
  if (existing.status !== 'PendingApproval') {
    throw badRequest('Only a report that is Pending Approval can be approved.');
  }

  const payload = loadReportDetail(existing.id) as unknown as DrrPayload;
  const user = req.user!.username;
  const ip = req.clientIp ?? null;
  const stamp = nowIso();

  const result = transact(() => {
    const saved = saveReport(existing.id, { ...payload, status: 'Submitted' }, user, ip);
    db.prepare('UPDATE drr_reports SET approvedBy = @user, approvedAt = @stamp WHERE id = @id')
      .run({ id: existing.id, user, stamp });
    db.prepare(`
      INSERT INTO drr_approval_history (id, reportId, action, byUser, atTime)
      VALUES (@id, @reportId, 'Approved', @byUser, @atTime)
    `).run({ id: newId('drrhist'), reportId: existing.id, byUser: user, atTime: stamp });
    audit({ user, ip, action: 'drr.approve', entity: 'drr_reports', entityId: existing.id });
    notifyDrrApproved({
      id: existing.id, rigId: existing.rigId, submittedBy: existing.submittedBy, approvedBy: user, approvedAt: stamp,
    });
    return saved;
  });
  res.json(loadReportDetail(result.id) ?? result);
}));

/**
 * Reject: PendingApproval -> Rejected, with a required reason. Nothing was
 * ever distributed for a PendingApproval report (see saveReport()'s isSubmit
 * gate), so there is nothing to roll back — the draftPayload the storekeeper
 * submitted is simply left in place for them to open, correct and resubmit.
 */
drrRouter.post('/reports/:id/reject', requireAuth, requirePage('DRR','reports','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; status: string; rigId: string; submittedBy: string }>(
    'SELECT id, status, rigId, submittedBy FROM drr_reports WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That Daily Rig Report does not exist.');
  assertCanDecide(req, existing.rigId);
  if (existing.status !== 'PendingApproval') {
    throw badRequest('Only a report that is Pending Approval can be rejected.');
  }
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) throw badRequest('A rejection reason is required.');

  const user = req.user!.username;
  const ip = req.clientIp ?? null;
  const stamp = nowIso();
  transact(() => {
    db.prepare(`
      UPDATE drr_reports SET status = 'Rejected', rejectedBy = @user, rejectedAt = @stamp,
        rejectionReason = @reason, updatedBy = @user, updatedAt = @stamp
      WHERE id = @id
    `).run({ id: existing.id, user, stamp, reason });
    db.prepare(`
      INSERT INTO drr_approval_history (id, reportId, action, byUser, atTime, reason)
      VALUES (@id, @reportId, 'Rejected', @byUser, @atTime, @reason)
    `).run({ id: newId('drrhist'), reportId: existing.id, byUser: user, atTime: stamp, reason });
    audit({ user, ip, action: 'drr.reject', entity: 'drr_reports', entityId: existing.id, detail: reason });
    notifyDrrRejected({
      id: existing.id, rigId: existing.rigId, submittedBy: existing.submittedBy,
      rejectedBy: user, rejectedAt: stamp, rejectionReason: reason,
    });
  });
  res.json(loadReportDetail(existing.id));
}));

export function saveReport(existingId: string | null, body: DrrPayload & { status?: string }, user: string, ip: string | null) {
  const status = body.status === 'Submitted' ? 'Submitted'
    : body.status === 'PendingApproval' ? 'PendingApproval'
    : body.status === 'Rejected' ? 'Rejected'
    : 'Draft';
  const isSubmit = status === 'Submitted';
  // PendingApproval is a real submission for review, held to the same
  // completeness rules as the final Submitted state — just not distributed
  // into DPR/Mechanical Log/HSD until a manager actually approves it.
  const isFinalizing = isSubmit || status === 'PendingApproval';

  const issues = validate(body, isFinalizing);
  if (issues.length > 0) throw new HttpError(400, 'Fix the highlighted fields before saving.', { issues });

  const rig = db.prepare<[string], RigRow>('SELECT id, rigNumber, name FROM rigs WHERE id = ?').get(body.rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  // Shift/Report Type is no longer collected from the form — default it in
  // place on body so the NOT NULL column and every existing rig+date+shift
  // uniqueness/duplicate-message/audit code path below keeps reading
  // body.shift exactly as before, unchanged for callers that still supply
  // one (tests, demo data, Excel import).
  body.shift = body.shift && SHIFT_OPTIONS.includes(body.shift) ? body.shift : 'Day';

  return transact(() => {
    const stamp = nowIso();
    let id = existingId;
    let dprReportId: string | null = null;
    let hsdReportId: string | null = null;
    let mechLogUploadId: string | null = null;

    if (id) {
      const existing = db.prepare<[string], { dprReportId: string | null; hsdReportId: string | null; mechLogUploadId: string | null }>(
        'SELECT dprReportId, hsdReportId, mechLogUploadId FROM drr_reports WHERE id = ?',
      ).get(id)!;
      dprReportId = existing.dprReportId;
      hsdReportId = existing.hsdReportId;
      mechLogUploadId = existing.mechLogUploadId;
    } else {
      id = newId('drr');
    }

    // The drr_reports row must exist before anything below, since
    // drr_oil_lines/drr_hydraulic_lines FK straight to it (reportId) — a
    // brand-new report has no row yet at this point. Written once now with
    // placeholder linkage, then updated in place once distribution (below)
    // resolves the real dprReportId/hsdReportId/mechLogUploadId.
    upsertDrrReportRow({
      id, existed: !!existingId, rig, body, status, dprReportId, hsdReportId, mechLogUploadId,
      draftPayload: null, user, stamp,
    });

    // A report is only distributed into DPR/Mechanical Log/HSD once
    // Submitted (spec 15: a draft must not affect closing balances/carry
    // forward). While Draft, the whole payload lives only in draftPayload.
    if (isSubmit) {
      // Cross-report duplicate-attendance guard: the same employee cannot be
      // recorded on two different reports for the same rig+date (a second
      // shift's report, say) — checked before anything is written so a
      // genuine duplicate submission never partially saves.
      const employeeIds = [...new Set((body.attendanceLines ?? []).map((l) => l.employeeId).filter((v): v is string => !!v))];
      if (employeeIds.length > 0) {
        const placeholders = employeeIds.map(() => '?').join(',');
        const clash = db.prepare<unknown[], { employeeName: string; reportDate: string; shift: string }>(`
          SELECT al.employeeName, r.reportDate, r.shift FROM drr_attendance_lines al
          JOIN drr_reports r ON r.id = al.reportId
          WHERE r.rigId = ? AND r.reportDate = ? AND r.id != ? AND al.employeeId IN (${placeholders})
          LIMIT 1
        `).get(rig.id, body.reportDate, id, ...employeeIds);
        if (clash) {
          throw new HttpError(400, `${clash.employeeName} already has attendance recorded for ${rig.rigNumber} on ${clash.reportDate} (${clash.shift} report).`);
        }
      }

      const dprLines = normaliseDprLines(body.dprLines);
      dprReportId = saveDprReport({
        existingReportId: dprReportId, rigId: resolveDprRig(rig.rigNumber).id, dprDate: body.reportDate,
        source: 'manual', importBatchId: null, lines: dprLines, ctx: { user, ip }, skipTransaction: true,
      });

      const dprRigForHsd = resolveDprRig(rig.rigNumber);
      const openingStock = getPreviousHsdOpening(dprRigForHsd.id, body.reportDate).siteDieselClosing ?? 0;
      const workTypeHours = sumHoursByWorkType(dprLines);
      const hsdDay = buildHsdDay(body, openingStock, workTypeHours);
      hsdReportId = saveHsdReport({
        existingReportId: hsdReportId, rigId: dprRigForHsd.id, day: hsdDay, importBatchId: null, user,
      });

      mechLogUploadId = upsertMechanicalLog(mechLogUploadId, rig.id, body, user, stamp);

      db.prepare('DELETE FROM drr_oil_lines WHERE reportId = ?').run(id);
      const insertOil = db.prepare(`
        INSERT INTO drr_oil_lines (id, reportId, equipmentId, oilType, openingBalance, oilAdded, oilConsumed, closingBalance, remark)
        VALUES (@id, @reportId, @equipmentId, @oilType, @openingBalance, @oilAdded, @oilConsumed, @closingBalance, @remark)
      `);
      for (const line of body.oilLines ?? []) {
        insertOil.run({
          id: newId('drroil'), reportId: id, equipmentId: line.equipmentId, oilType: line.oilType,
          openingBalance: line.openingBalance, oilAdded: line.oilAdded, oilConsumed: line.oilConsumed,
          closingBalance: round2(line.openingBalance + line.oilAdded - line.oilConsumed),
          remark: line.remark ?? null,
        });
      }

      db.prepare('DELETE FROM drr_hydraulic_lines WHERE reportId = ?').run(id);
      const insertHyd = db.prepare(`
        INSERT INTO drr_hydraulic_lines (id, reportId, tankName, openingLevel, topUp, loss, closingLevel, remark)
        VALUES (@id, @reportId, @tankName, @openingLevel, @topUp, @loss, @closingLevel, @remark)
      `);
      for (const line of body.hydraulicLines ?? []) {
        insertHyd.run({
          id: newId('drrhyd'), reportId: id, tankName: line.tankName,
          openingLevel: line.openingLevel, topUp: line.topUp, loss: line.loss,
          closingLevel: round2(line.openingLevel + line.topUp - line.loss),
          remark: line.remark ?? null,
        });
      }

      db.prepare('DELETE FROM drr_attendance_lines WHERE reportId = ?').run(id);
      const insertAttendance = db.prepare(`
        INSERT INTO drr_attendance_lines (id, reportId, employeeId, employeeName, employeeCode, designation, rosterStatus, attendanceStatus, shift, inTime, outTime, isTemporary, remarks)
        VALUES (@id, @reportId, @employeeId, @employeeName, @employeeCode, @designation, @rosterStatus, @attendanceStatus, @shift, @inTime, @outTime, @isTemporary, @remarks)
      `);
      for (const line of body.attendanceLines ?? []) {
        insertAttendance.run({
          id: newId('drratt'), reportId: id, employeeId: line.employeeId ?? null,
          employeeName: line.employeeName, employeeCode: line.employeeCode ?? null, designation: line.designation ?? null,
          rosterStatus: line.rosterStatus ?? null, attendanceStatus: line.attendanceStatus,
          shift: line.shift ?? null, inTime: line.inTime ?? null, outTime: line.outTime ?? null,
          isTemporary: line.isTemporary ? 1 : 0, remarks: line.remarks ?? null,
        });
      }
    }

    const draftPayload = JSON.stringify({
      hsdReceived: body.hsdReceived, hsdRemarks: body.hsdRemarks,
      equipmentLines: body.equipmentLines, oilLines: body.oilLines,
      hydraulicLines: body.hydraulicLines, attendanceLines: body.attendanceLines, dprLines: body.dprLines,
    });

    upsertDrrReportRow({
      id, existed: true, rig, body, status, dprReportId, hsdReportId, mechLogUploadId,
      draftPayload, user, stamp,
    });

    if (status === 'PendingApproval') {
      db.prepare(`
        INSERT INTO drr_approval_history (id, reportId, action, byUser, atTime)
        VALUES (@id, @reportId, 'Submitted', @byUser, @atTime)
      `).run({ id: newId('drrhist'), reportId: id, byUser: user, atTime: stamp });
      // "System reads the DRR Rig ID -> finds the Operational Manager
      // assigned to that Rig" — notified the moment this happens, not on the
      // next scheduled check; the hourly escalation generator is the safety
      // net if this manager never acts.
      notifyDrrPendingApproval({ id, rigId: rig.id, submittedBy: user, submittedAt: stamp });
    }

    audit({
      user, ip, action: existingId ? 'drr.update' : 'drr.create', entity: 'drr_reports', entityId: id,
      detail: `${rig.rigNumber} ${body.reportDate} ${body.shift} (${status})`,
    });

    return loadReportDetail(id);
  });
}

function upsertDrrReportRow(args: {
  id: string; existed: boolean; rig: RigRow; body: DrrPayload; status: string;
  dprReportId: string | null; hsdReportId: string | null; mechLogUploadId: string | null;
  draftPayload: string | null; user: string; stamp: string;
}): void {
  const { id, rig, body, status, dprReportId, hsdReportId, mechLogUploadId, draftPayload, user, stamp } = args;
  // `submittedBy`/`submittedAt` record the real "sent for approval" event —
  // who/when a Storekeeper actually submitted it — and Approve deliberately
  // does NOT re-stamp them: it calls saveReport() with the APPROVER's
  // username to reuse this same write path, and that must never overwrite
  // who originally submitted the report (approvedBy/approvedAt already
  // record the approval itself, separately, in the dedicated /approve route).
  // The only case a transition to 'Submitted' DOES stamp these is a report
  // that never went through PendingApproval at all — Excel import, demo
  // data, or Admin's direct-edit override — recognisable as "submittedAt is
  // still NULL", read from the row as it stood before this UPDATE.
  const clearsRejection = status === 'PendingApproval';

  if (args.existed) {
    db.prepare(`
      UPDATE drr_reports SET reportDate = @reportDate, wellNo = @wellNo, shift = @shift,
        fieldLocation = @fieldLocation, status = @status, dprReportId = @dprReportId,
        hsdReportId = @hsdReportId, mechLogUploadId = @mechLogUploadId,
        draftPayload = COALESCE(@draftPayload, draftPayload),
        submittedBy = CASE
          WHEN @status = 'PendingApproval' THEN @user
          WHEN @status = 'Submitted' AND submittedAt IS NULL THEN @user
          ELSE submittedBy END,
        submittedAt = CASE
          WHEN @status = 'PendingApproval' THEN @stamp
          WHEN @status = 'Submitted' AND submittedAt IS NULL THEN @stamp
          ELSE submittedAt END,
        rejectedBy = CASE WHEN @clearsRejection THEN NULL ELSE rejectedBy END,
        rejectedAt = CASE WHEN @clearsRejection THEN NULL ELSE rejectedAt END,
        rejectionReason = CASE WHEN @clearsRejection THEN NULL ELSE rejectionReason END,
        updatedBy = @user, updatedAt = @stamp
      WHERE id = @id
    `).run({
      id, reportDate: body.reportDate, wellNo: body.wellNo, shift: body.shift,
      fieldLocation: body.fieldLocation ?? null, status, dprReportId, hsdReportId, mechLogUploadId,
      draftPayload, user, stamp, clearsRejection: clearsRejection ? 1 : 0,
    });
    return;
  }
  // A brand-new report has no prior submittedAt to protect, so both a first
  // PendingApproval submission and a direct-to-Submitted create (Excel
  // import/demo data) stamp it here — that's the only case this matters for.
  const isNewSubmission = status === 'PendingApproval' || status === 'Submitted';
  try {
    db.prepare(`
      INSERT INTO drr_reports (id, rigId, reportDate, wellNo, shift, fieldLocation, status,
        dprReportId, hsdReportId, mechLogUploadId, draftPayload, submittedBy, submittedAt,
        createdBy, createdAt, updatedBy, updatedAt)
      VALUES (@id, @rigId, @reportDate, @wellNo, @shift, @fieldLocation, @status,
        @dprReportId, @hsdReportId, @mechLogUploadId, @draftPayload, @user, @submittedAt,
        @user, @stamp, @user, @stamp)
    `).run({
      id, rigId: rig.id, reportDate: body.reportDate, wellNo: body.wellNo, shift: body.shift,
      fieldLocation: body.fieldLocation ?? null, status, dprReportId, hsdReportId, mechLogUploadId,
      draftPayload, user, stamp, submittedAt: isNewSubmission ? stamp : null,
    });
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new HttpError(409, `A Daily Rig Report for ${rig.rigNumber} on ${body.reportDate} (${body.shift}) already exists. Open it for edit instead of creating a new one.`);
    }
    throw err;
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

function normaliseDprLines(raw: unknown): ParsedDprLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any, i: number): ParsedDprLine => {
    const startTime = r.startTime || null;
    const endTime = r.endTime || null;
    const drillingFrom = numOrNull(r.drillingFrom);
    const drillingTo = numOrNull(r.drillingTo);
    const casingFrom = numOrNull(r.casingFrom);
    const casingTo = numOrNull(r.casingTo);
    return {
      lineNo: i + 1,
      wellName: r.wellName || null, operationCode: r.operationCode || null, workType: r.workType || null,
      startTime, endTime, totalHours: computeTotalHours(startTime, endTime),
      description: r.description || null, breakdownEquipment: r.breakdownEquipment || null,
      breakdownEquipmentId: r.breakdownEquipmentId || null,
      breakdownReason: r.breakdownReason || null,
      drillingSection: r.drillingSection || null, drillingFrom, drillingTo,
      drillingTotal: drillingFrom !== null && drillingTo !== null ? round2(drillingTo - drillingFrom) : null,
      casingSection: r.casingSection || null, casingFrom, casingTo,
      casingTotal: casingFrom !== null && casingTo !== null ? round2(casingTo - casingFrom) : null,
      otherActivityDescription: r.otherActivityDescription || null,
    };
  });
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeTotalHours(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const s = sh * 60 + sm; const e = eh * 60 + em;
  const diff = e >= s ? e - s : 1440 + e - s;
  return round2(diff / 60);
}

/**
 * Builds the HSD "day" shape saveHsdReport() expects, from the DRR form's
 * equipment lines + rig-level diesel input. R1/R2/R3/ILM hours are left at 0
 * here — the DPR Activity section (dpr_line_items.workType) is the one place
 * those are actually entered (see plan decision 4); duplicating them onto
 * the HSD row too would let the two disagree.
 */
function sumHoursByWorkType(lines: ParsedDprLine[]): { r1: number; r2: number; r3: number; ilm: number } {
  const out = { r1: 0, r2: 0, r3: 0, ilm: 0 };
  for (const l of lines) {
    const t = (l.workType ?? '').trim().toUpperCase();
    const h = l.totalHours ?? 0;
    if (t === 'R1') out.r1 = round2(out.r1 + h);
    else if (t === 'R2') out.r2 = round2(out.r2 + h);
    else if (t === 'R3') out.r3 = round2(out.r3 + h);
    else if (t === 'ILM') out.ilm = round2(out.ilm + h);
  }
  return out;
}

function buildHsdDay(body: DrrPayload, openingStock: number, workTypeHours: { r1: number; r2: number; r3: number; ilm: number }): ParsedHsdDay {
  const equipment: ParsedHsdEquipmentLine[] = (body.equipmentLines ?? []).map((line, i) => ({
    lineNo: i + 1,
    equipment: equipmentLabel(line.equipmentId),
    equipmentId: line.equipmentId,
    openingStock: null, topUp: null, totalHsd: null,
    consumedHsd: line.hsdConsumption, consumedHours: round2(line.dayHours + line.nightHours),
    openingRunningHours: line.openingRunningHours,
    closingHours: round2(line.openingRunningHours + line.dayHours + line.nightHours),
    closingStock: null,
    average: line.dayHours + line.nightHours > 0 ? round2(line.hsdConsumption / (line.dayHours + line.nightHours)) : null,
    remark: line.remarks ?? null,
  }));

  const totalConsumed = round2((body.equipmentLines ?? []).reduce((n, l) => n + l.hsdConsumption, 0));
  const totalBalance = round2(openingStock + body.hsdReceived);

  const site: ParsedHsdSiteLine[] = [{
    lineNo: 1, label: 'Rig Site Diesel',
    openingBalance: openingStock, received: body.hsdReceived, totalBalance,
    topUp: null, totalConsumption: totalConsumed,
    closingBalance: round2(totalBalance - totalConsumed),
    remark: body.hsdRemarks ?? null,
  }];

  const totalHours = round2(workTypeHours.r1 + workTypeHours.r2 + workTypeHours.r3 + workTypeHours.ilm);
  return {
    day: 1, date: body.reportDate, wellName: body.wellNo || null,
    r1Hours: workTypeHours.r1, r2Hours: workTypeHours.r2, r3Hours: workTypeHours.r3, ilmHours: workTypeHours.ilm,
    totalHours, equipment, site,
  };
}

/**
 * The equipment's CURRENT name, read fresh every time.
 *
 * This label is written into the saved HSD rows, so it must reflect Equipment
 * Master as it stands at save time. It used to be memoised in a module-level
 * Map that nothing ever invalidated: rename a machine in Equipment Master (or
 * change the Engine/Transmission it is linked to) and every DRR saved for the
 * rest of the server's life kept recording the old name.
 *
 * A machine linked to a Material Master record takes its name from there, the
 * same precedence services/equipmentView.ts applies everywhere else, so the
 * whole app agrees on what a machine is called.
 */
function equipmentLabel(equipmentId: string): string {
  const row = db.prepare<[string], { name: string }>(`
    SELECT COALESCE(me.name, mt.name, e.name) AS name
      FROM equipment e
      LEFT JOIN material_master me ON me.id = e.linkedEngineId
      LEFT JOIN material_master mt ON mt.id = e.linkedTransmissionId
     WHERE e.id = ?
  `).get(equipmentId);
  return row?.name ?? equipmentId;
}

/** Upserts one mechanical_log_uploads marker + one mechanical_log_rows row per equipment line, and writes equipment back (currentRunningHours/isBreakdown) — mirrors what an Excel commit already does, without going through the plan/preview machinery that's specific to file uploads. */
function upsertMechanicalLog(
  existingUploadId: string | null, rigId: string, body: DrrPayload, user: string, stamp: string,
): string {
  const uploadId = existingUploadId ?? newId('mlu');
  if (existingUploadId) {
    db.prepare('DELETE FROM mechanical_log_rows WHERE uploadId = ?').run(existingUploadId);
    db.prepare(`
      UPDATE mechanical_log_uploads SET uploadDate = @stamp, logMonth = @logMonth,
        coverageStartDate = @reportDate, coverageEndDate = @reportDate, recordsImported = @count
      WHERE id = @id
    `).run({ id: existingUploadId, stamp, logMonth: body.reportDate.slice(0, 7), reportDate: body.reportDate, count: (body.equipmentLines ?? []).length });
  } else {
    db.prepare(`
      INSERT INTO mechanical_log_uploads (id, rigId, fileName, storedFileName, uploadDate, logMonth,
        coverageStartDate, coverageEndDate, uploadedBy, status, recordsImported, validationErrorsCount, notes)
      VALUES (@id, @rigId, @fileName, NULL, @stamp, @logMonth, @reportDate, @reportDate, @user, 'Uploaded', @count, 0, 'Daily Rig Report')
    `).run({
      id: uploadId, rigId, fileName: 'Daily Rig Report (manual entry)', stamp,
      logMonth: body.reportDate.slice(0, 7), reportDate: body.reportDate, user, count: (body.equipmentLines ?? []).length,
    });
  }

  const insertRow = db.prepare(`
    INSERT INTO mechanical_log_rows (id, uploadId, equipmentId, rigId, sheetDay, logDate, isInUse,
      hoursRunDay, hoursRunNight, lubeOilPressure, lubeOilAdded, openingRunningHours, totalRunHours,
      closingHours, lastServiceHours, runningHoursAfterLastService, defineHours, hoursRemainingForNextService,
      preventiveMaintenanceDetails, remarks, lastServiceDate, makeModel, serialNumber,
      source, status, hsdConsumptionLiters, breakdownAt, breakdownDescription, actionTaken,
      partsRequired, expectedRestoration, breakdownRemark)
    VALUES (@id, @uploadId, @equipmentId, @rigId, 1, @logDate, @isInUse,
      @hoursRunDay, @hoursRunNight, NULL, NULL, @openingRunningHours, @totalRunHours,
      @closingHours, @lastServiceHours, NULL, NULL, NULL,
      NULL, @remarks, NULL, NULL, NULL,
      'drr', @status, @hsdConsumptionLiters, @breakdownAt, @breakdownDescription, @actionTaken,
      @partsRequired, @expectedRestoration, @breakdownRemark)
  `);
  const updateEquipment = db.prepare('UPDATE equipment SET currentRunningHours = ?, isBreakdown = ? WHERE id = ?');

  for (const line of body.equipmentLines ?? []) {
    const totalRunHours = round2(line.dayHours + line.nightHours);
    const closingHours = round2(line.openingRunningHours + totalRunHours);
    insertRow.run({
      id: newId('mlr'), uploadId, equipmentId: line.equipmentId, rigId, logDate: body.reportDate,
      isInUse: line.status === 'Running' ? 'Yes' : 'No',
      hoursRunDay: line.dayHours, hoursRunNight: line.nightHours,
      openingRunningHours: line.openingRunningHours, totalRunHours, closingHours,
      lastServiceHours: line.serviceDoneToday ? line.serviceHours : null,
      remarks: line.remarks ?? null, status: line.status, hsdConsumptionLiters: line.hsdConsumption,
      breakdownAt: line.breakdownAt ?? null, breakdownDescription: line.breakdownDescription ?? null,
      actionTaken: line.actionTaken ?? null, partsRequired: line.partsRequired ?? null,
      expectedRestoration: line.expectedRestoration ?? null, breakdownRemark: line.breakdownRemark ?? null,
    });
    updateEquipment.run(closingHours, line.status === 'Breakdown' ? 1 : 0, line.equipmentId);

    // "Service Done Today" — logged permanently (equipment_service_records)
    // and moves the equipment's live lastServiceHours pointer forward, inside
    // this same transaction so the report and its service record are atomic.
    if (line.serviceDoneToday && line.serviceHours !== null && line.serviceHours !== undefined) {
      recordService({
        equipmentId: line.equipmentId, rigId, date: body.reportDate,
        serviceHours: line.serviceHours, remarks: line.remarks ?? null, method: 'DRR', user,
      });
    }
  }

  return uploadId;
}
