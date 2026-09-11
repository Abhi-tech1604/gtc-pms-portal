import { Router } from 'express';
import { db } from '../db/index.js';
import { today, yesterday } from '../util/date.js';
import { assertRigAllowed, requireAuth, requireRight, rigScope } from '../middleware/auth.js';
import { wrap } from '../middleware/http.js';
import { listEquipment } from '../services/equipmentView.js';
import { complianceFor } from '../services/compliance.js';
import { UPCOMING_HEALTH_WINDOW, UPCOMING_SERVICE_WINDOW } from '../services/calc.js';
import { getTodaysDrrSubmissions, getTodaysExcelUploads } from '../services/todaysActivity.js';

export const dashboardRouter = Router();

/**
 * Spec 6.2. Every figure below is derived from stored records; nothing on this
 * screen is a hard-coded array (defect D15).
 */
dashboardRouter.get('/', requireAuth, requireRight('canViewDashboard'), wrap((req, res) => {
  // An explicit ?rigId= (Admin Dashboard's Rig filter) narrows to exactly
  // that one rig, still checked against this account's own scope first —
  // a restricted account can only ever narrow further, never widen.
  const requestedRigId = req.query.rigId as string | undefined;
  let scope = rigScope(req);
  if (requestedRigId) {
    assertRigAllowed(req, requestedRigId);
    scope = [requestedRigId];
  }
  const equipment = listEquipment(scope);
  const target = yesterday();
  const compliance = complianceFor(target, scope);

  const rigCount = scope
    ? scope.length
    : (db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM rigs').get()!.n);

  const overdueServices = equipment.filter((e) => e.remainingServiceHours <= 0);
  const upcomingServices = equipment.filter(
    (e) => e.remainingServiceHours >= 1 && e.remainingServiceHours <= UPCOMING_SERVICE_WINDOW,
  );
  const overdueHealth = equipment.filter((e) => e.healthStatus === 'Overdue');
  const upcomingHealth = equipment.filter(
    (e) => e.remainingHealthCheckDays !== null
      && e.remainingHealthCheckDays >= 1
      && e.remainingHealthCheckDays <= UPCOMING_HEALTH_WINDOW,
  );

  // scope === [] (assigned to zero rigs) must count zero, not run unrestricted —
  // an empty `IN ()` is invalid SQL, so that case is handled before ever building one.
  // "Today's Uploads" now covers every real submission event for today, not
  // only Excel workbook uploads — DRR's own daily-entry submissions land
  // directly in drr_reports/mechanical_log_rows without ever creating a
  // mechanical_log_uploads row, so the old Excel-only count silently missed
  // every DRR-submitted rig. Both counts come from services/todaysActivity.ts,
  // the exact same functions the click-through detail list uses, so the
  // number on this card and the rows behind it can never disagree.
  const canSeeToday = scope === null || scope.length > 0;
  const todaysExcelUploads = canSeeToday ? getTodaysExcelUploads(scope, today()) : [];
  const todaysDrrSubmissions = canSeeToday ? getTodaysDrrSubmissions(scope, today()) : [];
  const uploadsToday = todaysExcelUploads.length + todaysDrrSubmissions.length;

  const pendingYesterday = compliance.filter((c) => c.status === 'Pending').length;

  // Material Master is a global catalog (not rig-scoped), so these totals are
  // fleet-wide regardless of the viewing user's own rig scope.
  const totalEngines = (db.prepare("SELECT COUNT(*) AS n FROM material_master WHERE materialType = 'Engine'").get() as { n: number }).n;
  const totalTransmissions = (db.prepare("SELECT COUNT(*) AS n FROM material_master WHERE materialType = 'Transmission'").get() as { n: number }).n;

  const byStatus = {
    Normal: equipment.filter((e) => e.status === 'Normal').length,
    Upcoming: upcomingServices.length,
    Overdue: overdueServices.length,
    Breakdown: equipment.filter((e) => e.status === 'Breakdown').length,
  };

  const byCategory = Object.entries(
    equipment.reduce<Record<string, number>>((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([category, count]) => ({ category, count }));

  // Running hours actually logged per day over the last 14 days, from real rows.
  const trendFrom = addDays(today(), -13);
  let trend: { date: string; hours: number; rowCount: number }[] = [];
  if (scope === null || scope.length > 0) {
    const trendSql = `
      SELECT logDate AS date, SUM(COALESCE(totalRunHours, 0)) AS hours, COUNT(*) AS rowCount
      FROM mechanical_log_rows
      WHERE logDate >= ?${scope ? ` AND rigId IN (${scope.map(() => '?').join(',')})` : ''}
      GROUP BY logDate ORDER BY logDate
    `;
    const args = scope ? [trendFrom, ...scope] : [trendFrom];
    trend = db.prepare(trendSql).all(...args) as typeof trend;
  }

  res.json({
    asOf: today(),
    complianceDate: target,
    kpis: {
      totalRigs: rigCount,
      totalEquipment: equipment.length,
      overdueServices: overdueServices.length,
      upcomingServices: upcomingServices.length,
      overdueHealthChecks: overdueHealth.length,
      upcomingHealthChecks: upcomingHealth.length,
      pendingYesterdayUploads: pendingYesterday,
      uploadsToday,
      totalEngines,
      totalTransmissions,
    },
    compliance,
    byStatus,
    byCategory,
    trend: trend.map((t) => ({ ...t, hours: Math.round(t.hours) })),
    attention: [...overdueServices, ...upcomingServices]
      .sort((a, b) => a.remainingServiceHours - b.remainingServiceHours)
      .slice(0, 25),
    // Sorted soonest-due first; a machine never checked (remainingHealthCheckDays
    // null) counts as most overdue of all, ahead of one merely overdue by days.
    healthAttention: [...overdueHealth, ...upcomingHealth]
      .sort((a, b) => (a.remainingHealthCheckDays ?? -Infinity) - (b.remainingHealthCheckDays ?? -Infinity))
      .slice(0, 25),
  });
}));

/**
 * The "Uploads Today" card's click-through — every Excel workbook upload AND
 * DRR submission for today, scoped to this account's own rigs (or the
 * Admin Dashboard's ?rigId= narrowing, same as GET / above). Reuses the exact
 * same two query functions the card's count is built from.
 */
dashboardRouter.get('/uploads-today', requireAuth, requireRight('canViewDashboard'), wrap((req, res) => {
  const requestedRigId = req.query.rigId as string | undefined;
  let scope = rigScope(req);
  if (requestedRigId) {
    assertRigAllowed(req, requestedRigId);
    scope = [requestedRigId];
  }
  const canSeeToday = scope === null || scope.length > 0;
  const asOf = today();
  res.json({
    date: asOf,
    excelUploads: canSeeToday ? getTodaysExcelUploads(scope, asOf) : [],
    drrSubmissions: canSeeToday ? getTodaysDrrSubmissions(scope, asOf) : [],
  });
}));

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
