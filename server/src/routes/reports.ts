import { Router } from 'express';
import ExcelJS from 'exceljs';
import { db } from '../db/index.js';
import { isIsoDate, today } from '../util/date.js';
import { requireAnyPage, requireAuth, rigScope } from '../middleware/auth.js';
import { badRequest, wrap } from '../middleware/http.js';
import { listEquipment } from '../services/equipmentView.js';
import { UPCOMING_SERVICE_WINDOW } from '../services/calc.js';

export const reportsRouter = Router();

type ReportKey = 'equipment-status' | 'service-due' | 'running-hours';

interface ReportTable {
  title: string;
  columns: { key: string; label: string; width?: number }[];
  rows: Record<string, unknown>[];
  meta?: Record<string, unknown>;
}

/** Spec 6.7. Every report is built from stored records and is exportable to Excel. */
function buildReport(key: ReportKey, query: Record<string, unknown>, scope: string[] | null): ReportTable {
  // The single rig to additionally narrow to, if any: an explicit filter the
  // user picked, or — only when the account's whole scope is exactly one rig
  // — that rig. A genuinely multi-rig scope has no single implied rig; those
  // reports rely on `scope` itself (passed through to listEquipment, or
  // IN-filtered directly below) to stay within bounds.
  const rigId = (typeof query.rigId === 'string' && query.rigId) ? query.rigId
    : (scope && scope.length === 1 ? scope[0] : null);

  switch (key) {
    case 'equipment-status': {
      let items = listEquipment(scope);
      if (rigId) items = items.filter((e) => e.rigId === rigId);
      if (query.category) items = items.filter((e) => e.category === query.category);
      return {
        title: 'Equipment Status Report',
        columns: [
          { key: 'rigNumber', label: 'Rig', width: 14 },
          { key: 'name', label: 'Machine', width: 30 },
          { key: 'category', label: 'Category', width: 20 },
          { key: 'serialNumber', label: 'Serial No', width: 22 },
          { key: 'currentRunningHours', label: 'Current Hrs', width: 13 },
          { key: 'lastServiceHours', label: 'Last Service Hrs', width: 16 },
          { key: 'runningSinceLastService', label: 'Hrs Since Service', width: 17 },
          { key: 'serviceInterval', label: 'Interval', width: 11 },
          { key: 'remainingServiceHours', label: 'Hrs Remaining', width: 14 },
          { key: 'status', label: 'Status', width: 12 },
          { key: 'lastHealthCheckDate', label: 'Last Health Check', width: 17 },
          { key: 'healthStatus', label: 'Health', width: 11 },
          { key: 'lastReportedDate', label: 'Last Reported', width: 14 },
        ],
        rows: items as unknown as Record<string, unknown>[],
      };
    }

    case 'service-due': {
      let items = listEquipment(scope).filter(
        (e) => e.remainingServiceHours <= UPCOMING_SERVICE_WINDOW,
      );
      if (rigId) items = items.filter((e) => e.rigId === rigId);
      items.sort((a, b) => a.remainingServiceHours - b.remainingServiceHours);
      return {
        title: 'Service Due Report',
        columns: [
          { key: 'rigNumber', label: 'Rig', width: 14 },
          { key: 'name', label: 'Machine', width: 30 },
          { key: 'category', label: 'Category', width: 20 },
          { key: 'currentRunningHours', label: 'Current Hrs', width: 13 },
          { key: 'runningSinceLastService', label: 'Hrs Since Service', width: 17 },
          { key: 'serviceInterval', label: 'Interval', width: 11 },
          { key: 'remainingServiceHours', label: 'Hrs Remaining', width: 14 },
          { key: 'status', label: 'Status', width: 12 },
        ],
        rows: items as unknown as Record<string, unknown>[],
        meta: { overdue: items.filter((i) => i.remainingServiceHours <= 0).length },
      };
    }

    case 'running-hours': {
      const filters: string[] = [];
      const params: unknown[] = [];
      if (rigId) { filters.push('l.rigId = ?'); params.push(rigId); }
      else if (scope) {
        if (scope.length === 0) filters.push('1 = 0');
        else { filters.push(`l.rigId IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
      }
      if (isIsoDate(query.from)) { filters.push('l.logDate >= ?'); params.push(query.from); }
      if (isIsoDate(query.to)) { filters.push('l.logDate <= ?'); params.push(query.to); }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT r.rigNumber AS rigNumber, r.name AS rigName,
               strftime('%Y-%m', l.logDate) AS month,
               COUNT(DISTINCT l.logDate) AS daysReported,
               COUNT(DISTINCT l.equipmentId) AS machines,
               CAST(ROUND(SUM(COALESCE(l.totalRunHours, 0))) AS INTEGER) AS totalHours
        FROM mechanical_log_rows l
        JOIN rigs r ON r.id = l.rigId
        ${where}
        GROUP BY r.id, month
        ORDER BY r.rigNumber, month DESC
      `).all(...params) as Record<string, unknown>[];
      return {
        title: 'Running Hours Summary',
        columns: [
          { key: 'rigNumber', label: 'Rig', width: 14 },
          { key: 'rigName', label: 'Name', width: 18 },
          { key: 'month', label: 'Month', width: 10 },
          { key: 'daysReported', label: 'Days Reported', width: 14 },
          { key: 'machines', label: 'Machines', width: 11 },
          { key: 'totalHours', label: 'Total Run Hours', width: 16 },
        ],
        rows,
      };
    }

    default:
      throw badRequest(`"${key}" is not a known report.`);
  }
}

const KEYS: ReportKey[] = ['equipment-status', 'service-due', 'running-hours'];

reportsRouter.get('/:key', requireAuth, requireAnyPage(['PMS','reports','view'],['ADMIN','reports','view']), wrap((req, res) => {
  const key = req.params.key as ReportKey;
  if (!KEYS.includes(key)) throw badRequest(`"${key}" is not a known report.`);
  res.json({ report: buildReport(key, req.query as Record<string, unknown>, rigScope(req)) });
}));

reportsRouter.get('/:key/export', requireAuth, requireAnyPage(['PMS','reports','view'],['ADMIN','reports','view']), wrap(async (req, res) => {
  const key = req.params.key as ReportKey;
  if (!KEYS.includes(key)) throw badRequest(`"${key}" is not a known report.`);
  const report = buildReport(key, req.query as Record<string, unknown>, rigScope(req));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'PMS Portal';
  const ws = wb.addWorksheet(report.title.slice(0, 30));

  ws.addRow([report.title]);
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.addRow([`Generated ${new Date().toISOString()} by ${req.user!.username}`]);
  if (report.meta?.legend) ws.addRow([String(report.meta.legend)]);
  ws.addRow([]);

  const headerRow = ws.addRow(report.columns.map((c) => c.label));
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  report.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 16; });

  for (const row of report.rows) {
    ws.addRow(report.columns.map((c) => row[c.key] ?? ''));
  }
  ws.views = [{ state: 'frozen', ySplit: headerRow.number }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${key}_${today()}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));
