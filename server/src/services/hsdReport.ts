import ExcelJS from 'exceljs';
import { db } from '../db/index.js';

/**
 * DPR → HSD Report: a rig-tank-level view of the diesel account, built
 * entirely from hsd_site_lines rows labelled 'Rig Site Diesel' (already
 * populated by every HSD import/entry — see excel/hsdIngest.ts) joined to
 * hsd_reports for the date and dpr_rigs for the rig identity. No new table,
 * no synthetic figures.
 *
 * openingBalance/closingBalance are point-in-time tank balances, not flows —
 * summing them across many days for one rig would be as meaningless as the
 * ILM Dashboard bug this app also had (see services/ilmSummaryReport.ts).
 * So "Opening Stock" is always the earliest day in range per rig, and
 * "Closing Balance" is always the latest day in range per rig; only
 * received/topUp(transferred out)/totalConsumption are summed, because
 * those are genuine flows (amounts moved during the period).
 */

export interface HsdReportQuery {
  rigId?: string;
  dateFrom?: string;
  dateTo?: string;
}

function pickStr(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

/** A "month" filter (YYYY-MM) is a convenience for dateFrom/dateTo — it wins over an explicit range when both are sent. */
export function normaliseHsdReportQuery(rawQuery: Record<string, unknown>): HsdReportQuery {
  const month = pickStr(rawQuery, 'month');
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      rigId: pickStr(rawQuery, 'rigId'),
      dateFrom: `${month}-01`,
      dateTo: `${month}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  return {
    rigId: pickStr(rawQuery, 'rigId'),
    dateFrom: pickStr(rawQuery, 'dateFrom'),
    dateTo: pickStr(rawQuery, 'dateTo'),
  };
}

interface SiteRow {
  rigId: string; rigNumber: string; rigName: string; hsdDate: string;
  openingBalance: number | null; received: number | null; transferredOut: number | null;
  used: number | null; closingBalance: number | null;
}

function fetchRows(q: HsdReportQuery): SiteRow[] {
  const where: string[] = ["s.label = 'Rig Site Diesel'"];
  const params: Record<string, unknown> = {};
  if (q.rigId) { where.push('h.rigId = @rigId'); params.rigId = q.rigId; }
  if (q.dateFrom) { where.push('h.hsdDate >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { where.push('h.hsdDate <= @dateTo'); params.dateTo = q.dateTo; }

  return db.prepare(`
    SELECT h.rigId, r.rigNumber, r.name AS rigName, h.hsdDate,
           s.openingBalance, s.received, s.topUp AS transferredOut,
           s.totalConsumption AS used, s.closingBalance
    FROM hsd_site_lines s
    JOIN hsd_reports h ON h.id = s.reportId
    JOIN dpr_rigs r ON r.id = h.rigId
    WHERE ${where.join(' AND ')}
    ORDER BY r.rigNumber, h.hsdDate
  `).all(params) as SiteRow[];
}

function round2(n: number | null | undefined): number {
  return Math.round((n ?? 0) * 100) / 100;
}
function sum(rows: SiteRow[], key: 'received' | 'transferredOut' | 'used'): number {
  return round2(rows.reduce((s, r) => s + (r[key] ?? 0), 0));
}

export interface HsdReportKpis {
  totalOpeningStock: number;
  totalReceived: number;
  totalTransferredOut: number;
  totalUsed: number;
  totalClosingBalance: number;
}

export interface HsdRigWiseBalance {
  rigId: string; rigNumber: string; rigName: string;
  opening: number; received: number; transferredOut: number; used: number; closing: number;
}

export interface HsdMonthlyTrendPoint {
  month: string; received: number; used: number; transferredOut: number;
}

export interface HsdTransferHistoryRow {
  rigId: string; rigNumber: string; rigName: string; date: string;
  opening: number; received: number; transferredOut: number; used: number; closing: number;
}

export interface HsdReportResult {
  kpis: HsdReportKpis;
  rigWise: HsdRigWiseBalance[];
  monthlyTrend: HsdMonthlyTrendPoint[];
  transferHistory: HsdTransferHistoryRow[];
}

export function getHsdReport(rawQuery: Record<string, unknown>): HsdReportResult {
  const q = normaliseHsdReportQuery(rawQuery);
  const rows = fetchRows(q);

  const byRig = new Map<string, SiteRow[]>();
  for (const row of rows) {
    if (!byRig.has(row.rigId)) byRig.set(row.rigId, []);
    byRig.get(row.rigId)!.push(row);
  }

  const rigWise: HsdRigWiseBalance[] = [...byRig.values()].map((rigRows) => {
    const first = rigRows[0];
    const last = rigRows[rigRows.length - 1];
    return {
      rigId: first.rigId, rigNumber: first.rigNumber, rigName: first.rigName,
      opening: round2(first.openingBalance),
      closing: round2(last.closingBalance),
      received: sum(rigRows, 'received'),
      transferredOut: sum(rigRows, 'transferredOut'),
      used: sum(rigRows, 'used'),
    };
  }).sort((a, b) => a.rigNumber.localeCompare(b.rigNumber));

  const kpis: HsdReportKpis = {
    totalOpeningStock: round2(rigWise.reduce((s, r) => s + r.opening, 0)),
    totalClosingBalance: round2(rigWise.reduce((s, r) => s + r.closing, 0)),
    totalReceived: round2(rigWise.reduce((s, r) => s + r.received, 0)),
    totalTransferredOut: round2(rigWise.reduce((s, r) => s + r.transferredOut, 0)),
    totalUsed: round2(rigWise.reduce((s, r) => s + r.used, 0)),
  };

  const monthlyMap = new Map<string, { received: number; used: number; transferredOut: number }>();
  for (const row of rows) {
    const month = row.hsdDate.slice(0, 7);
    const bucket = monthlyMap.get(month) ?? { received: 0, used: 0, transferredOut: 0 };
    bucket.received += row.received ?? 0;
    bucket.used += row.used ?? 0;
    bucket.transferredOut += row.transferredOut ?? 0;
    monthlyMap.set(month, bucket);
  }
  const monthlyTrend: HsdMonthlyTrendPoint[] = [...monthlyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month, received: round2(v.received), used: round2(v.used), transferredOut: round2(v.transferredOut),
    }));

  const transferHistory: HsdTransferHistoryRow[] = rows
    .slice()
    .sort((a, b) => (a.hsdDate < b.hsdDate ? 1 : a.hsdDate > b.hsdDate ? -1 : 0))
    .map((r) => ({
      rigId: r.rigId, rigNumber: r.rigNumber, rigName: r.rigName, date: r.hsdDate,
      opening: round2(r.openingBalance), received: round2(r.received),
      transferredOut: round2(r.transferredOut), used: round2(r.used), closing: round2(r.closingBalance),
    }))
    .slice(0, 500);

  return { kpis, rigWise, monthlyTrend, transferHistory };
}

export async function buildHsdReportExportWorkbook(rawQuery: Record<string, unknown>): Promise<Buffer> {
  const report = getHsdReport(rawQuery);
  const wb = new ExcelJS.Workbook();

  const kpiSheet = wb.addWorksheet('Summary');
  kpiSheet.columns = [{ header: 'Metric', key: 'metric', width: 28 }, { header: 'Value (L)', key: 'value', width: 18 }];
  kpiSheet.getRow(1).font = { bold: true };
  kpiSheet.addRows([
    { metric: 'Total Opening Stock', value: report.kpis.totalOpeningStock },
    { metric: 'Total Received', value: report.kpis.totalReceived },
    { metric: 'Total Transferred Out', value: report.kpis.totalTransferredOut },
    { metric: 'Total Used/Consumed', value: report.kpis.totalUsed },
    { metric: 'Total Closing Balance', value: report.kpis.totalClosingBalance },
  ]);

  const rigSheet = wb.addWorksheet('Rig-wise');
  rigSheet.columns = [
    { header: 'Rig Number', key: 'rigNumber', width: 16 },
    { header: 'Rig Name', key: 'rigName', width: 20 },
    { header: 'Opening (L)', key: 'opening', width: 14 },
    { header: 'Received (L)', key: 'received', width: 14 },
    { header: 'Transferred Out (L)', key: 'transferredOut', width: 16 },
    { header: 'Used (L)', key: 'used', width: 14 },
    { header: 'Closing (L)', key: 'closing', width: 14 },
  ];
  rigSheet.getRow(1).font = { bold: true };
  rigSheet.addRows(report.rigWise);

  const historySheet = wb.addWorksheet('Transfer History');
  historySheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Rig Number', key: 'rigNumber', width: 16 },
    { header: 'Rig Name', key: 'rigName', width: 20 },
    { header: 'Opening (L)', key: 'opening', width: 14 },
    { header: 'Received (L)', key: 'received', width: 14 },
    { header: 'Transferred Out (L)', key: 'transferredOut', width: 16 },
    { header: 'Used (L)', key: 'used', width: 14 },
    { header: 'Closing (L)', key: 'closing', width: 14 },
  ];
  historySheet.getRow(1).font = { bold: true };
  historySheet.addRows(report.transferHistory);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
