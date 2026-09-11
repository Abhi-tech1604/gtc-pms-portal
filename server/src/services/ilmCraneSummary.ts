import ExcelJS from 'exceljs';
import { db } from '../db/index.js';

/**
 * The "Crane Summary" report: every ilm_cranes row (one row per crane per
 * shift-day) for the filtered rig+date(s), grouped by craneNo into per-unit
 * "Crane Record" cards with their own day-by-day work-hours table — the
 * layout the uploaded mockup shows. Rig Type is bridged from PMS's
 * rigs.rigType by rigKey match, the same bridge dprOperationalData.ts and
 * equipmentForDprRig() already use.
 */

export interface CraneSummaryQuery {
  rigId?: string;
  rigType?: string;
  dateFrom?: string;
  dateTo?: string;
}

function pickStr(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

function normaliseQuery(query: Record<string, unknown>): CraneSummaryQuery {
  return {
    rigId: pickStr(query, 'rigId'),
    rigType: pickStr(query, 'rigType'),
    dateFrom: pickStr(query, 'dateFrom'),
    dateTo: pickStr(query, 'dateTo'),
  };
}

function buildWhere(q: CraneSummaryQuery): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = ["c.craneNo IS NOT NULL", "trim(c.craneNo) <> ''"];
  const params: Record<string, unknown> = {};
  if (q.rigId) { clauses.push('t.rigId = @rigId'); params.rigId = q.rigId; }
  if (q.rigType) { clauses.push('r.rigKey IN (SELECT rigKey FROM rigs WHERE rigType = @rigType)'); params.rigType = q.rigType; }
  if (q.dateFrom) { clauses.push('t.date >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { clauses.push('t.date <= @dateTo'); params.dateTo = q.dateTo; }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

interface CraneRow {
  craneNo: string; capacityTon: number | null; reportingDate: string | null; rigOrHired: string | null;
  registrationNo: string | null; arrivedDate: string | null; arrivedTime: string | null;
  releaseDate: string | null; releaseTime: string | null; transporterName: string | null;
  dayNo: number | null; shiftDate: string | null; dayShiftHrs: number | null; detailsJobDay: string | null;
  nightShiftHrs: number | null; detailsJobNight: string | null; breakdownHrs: number | null;
  cumulativeHrs: number | null; issuedHsdLtrs: number | null; totalWorkingHrs: number | null;
}

export interface CraneSummaryUnit {
  craneNo: string;
  capacityTon: number | null;
  reportingDate: string | null;
  rigOrHired: string | null;
  registrationNo: string | null;
  arrivedDate: string | null;
  arrivedTime: string | null;
  releaseDate: string | null;
  releaseTime: string | null;
  transporterName: string | null;
  rows: {
    dayNo: number | null; shiftDate: string | null; dayShiftHrs: number | null; detailsJobDay: string | null;
    nightShiftHrs: number | null; detailsJobNight: string | null; breakdownHrs: number | null;
    cumulativeHrs: number | null; issuedHsdLtrs: number | null; totalWorkingHrs: number | null;
  }[];
  totals: {
    dayShiftHrs: number; nightShiftHrs: number; breakdownHrs: number;
    cumulativeHrs: number | null; issuedHsdLtrs: number; totalWorkingHrs: number;
  };
}

export interface CraneSummaryResponse {
  kpis: { activeCranes: number; totalWorkingHours: number; totalHsdIssued: number; totalBreakdownHours: number };
  units: CraneSummaryUnit[];
}

const SELECT_SQL = `
  SELECT c.craneNo, c.capacityTon, c.reportingDate, c.rigOrHired, c.registrationNo,
         c.arrivedDate, c.arrivedTime, c.releaseDate, c.releaseTime, c.transporterName,
         c.dayNo, c.shiftDate, c.dayShiftHrs, c.detailsJobDay, c.nightShiftHrs, c.detailsJobNight,
         c.breakdownHrs, c.cumulativeHrs, c.issuedHsdLtrs, c.totalWorkingHrs
  FROM ilm_cranes c
  JOIN ilm_transactions t ON t.id = c.transactionId
  JOIN ilm_rigs r ON r.id = t.rigId
`;

function sum(n: number | null): number { return n ?? 0; }

export function getCraneSummary(rawQuery: Record<string, unknown>): CraneSummaryResponse {
  const q = normaliseQuery(rawQuery);
  const { where, params } = buildWhere(q);

  const rows = db.prepare(`
    ${SELECT_SQL} ${where}
    ORDER BY c.craneNo, t.date ASC, c.shiftDate ASC, c.dayNo ASC
  `).all(params) as CraneRow[];

  const byUnit = new Map<string, CraneRow[]>();
  for (const row of rows) {
    const list = byUnit.get(row.craneNo) ?? [];
    list.push(row);
    byUnit.set(row.craneNo, list);
  }

  const units: CraneSummaryUnit[] = [];
  for (const [craneNo, unitRows] of byUnit) {
    const head = unitRows[0];
    const totals = unitRows.reduce((acc, r) => ({
      dayShiftHrs: acc.dayShiftHrs + sum(r.dayShiftHrs),
      nightShiftHrs: acc.nightShiftHrs + sum(r.nightShiftHrs),
      breakdownHrs: acc.breakdownHrs + sum(r.breakdownHrs),
      issuedHsdLtrs: acc.issuedHsdLtrs + sum(r.issuedHsdLtrs),
      totalWorkingHrs: acc.totalWorkingHrs + sum(r.totalWorkingHrs),
    }), { dayShiftHrs: 0, nightShiftHrs: 0, breakdownHrs: 0, issuedHsdLtrs: 0, totalWorkingHrs: 0 });
    const lastCumulative = [...unitRows].reverse().find((r) => r.cumulativeHrs !== null)?.cumulativeHrs ?? null;

    units.push({
      craneNo,
      capacityTon: head.capacityTon,
      reportingDate: head.reportingDate,
      rigOrHired: head.rigOrHired,
      registrationNo: head.registrationNo,
      arrivedDate: head.arrivedDate,
      arrivedTime: head.arrivedTime,
      releaseDate: head.releaseDate,
      releaseTime: head.releaseTime,
      transporterName: head.transporterName,
      rows: unitRows.map((r) => ({
        dayNo: r.dayNo, shiftDate: r.shiftDate, dayShiftHrs: r.dayShiftHrs, detailsJobDay: r.detailsJobDay,
        nightShiftHrs: r.nightShiftHrs, detailsJobNight: r.detailsJobNight, breakdownHrs: r.breakdownHrs,
        cumulativeHrs: r.cumulativeHrs, issuedHsdLtrs: r.issuedHsdLtrs, totalWorkingHrs: r.totalWorkingHrs,
      })),
      totals: { ...totals, cumulativeHrs: lastCumulative },
    });
  }

  const kpis = {
    activeCranes: units.length,
    totalWorkingHours: Math.round(units.reduce((s, u) => s + u.totals.totalWorkingHrs, 0) * 100) / 100,
    totalHsdIssued: Math.round(units.reduce((s, u) => s + u.totals.issuedHsdLtrs, 0) * 100) / 100,
    totalBreakdownHours: Math.round(units.reduce((s, u) => s + u.totals.breakdownHrs, 0) * 100) / 100,
  };

  return { kpis, units };
}

export async function buildCraneSummaryExportWorkbook(rawQuery: Record<string, unknown>): Promise<Buffer> {
  const { kpis, units } = getCraneSummary(rawQuery);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Crane Summary');
  ws.addRow(['Active Cranes', kpis.activeCranes, 'Total Working Hours', kpis.totalWorkingHours,
    'Fuel Consumed (L)', kpis.totalHsdIssued, 'Breakdown Hours', kpis.totalBreakdownHours]).font = { bold: true };
  ws.addRow([]);

  for (const u of units) {
    ws.addRow([`Crane Record - ${u.craneNo} (${u.capacityTon ?? '-'} Ton)`]).font = { bold: true };
    ws.addRow(['Reporting Date', u.reportingDate ?? '-', 'Rig/Hired', u.rigOrHired ?? '-', 'Registration No', u.registrationNo ?? '-']);
    ws.addRow(['Arrived', `${u.arrivedDate ?? '-'} ${u.arrivedTime ?? ''}`.trim(), 'Release', `${u.releaseDate ?? '-'} ${u.releaseTime ?? ''}`.trim(), 'Transporter', u.transporterName ?? '-']);
    const header = ws.addRow(['Day', 'Date', 'Day Shift Hrs', 'Details of Job (Day)', 'Night Shift Hrs', 'Details of Job (Night)',
      'Breakdown Hrs', 'Cumulative Hrs', 'Issued HSD (Ltrs)', 'Total Working Hrs']);
    header.font = { bold: true };
    u.rows.forEach((r, i) => {
      ws.addRow([i + 1, r.shiftDate ?? '-', r.dayShiftHrs ?? '-', r.detailsJobDay ?? '-', r.nightShiftHrs ?? '-',
        r.detailsJobNight ?? '-', r.breakdownHrs ?? '-', r.cumulativeHrs ?? '-', r.issuedHsdLtrs ?? '-', r.totalWorkingHrs ?? '-']);
    });
    ws.addRow(['Totals', '-', u.totals.dayShiftHrs, '-', u.totals.nightShiftHrs, '-',
      u.totals.breakdownHrs, u.totals.cumulativeHrs ?? '-', u.totals.issuedHsdLtrs, u.totals.totalWorkingHrs]).font = { bold: true };
    ws.addRow([]);
  }
  ws.columns.forEach((c) => { c.width = 16; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
