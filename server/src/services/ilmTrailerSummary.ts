import ExcelJS from 'exceljs';
import { db } from '../db/index.js';

/**
 * The "Trailer Summary" report: every ilm_trailer_loads row (one row per
 * gate-pass load) for the filtered rig+date(s), grouped by trailerNo into
 * one summary row per physical trailer — merging the flat per-load detail
 * (loading point/date/time, load description, packages, driver) with the
 * per-trailer trip-sequence view (No. of Trips, 1st/2nd trip dates) the
 * uploaded mockups show. "Loading Point" is bridged from the load's own
 * Trailer Movement round (ilm_trailer_movements.oldLocation), never
 * fabricated — one ILM can have several rounds, so this is a per-load join,
 * not a per-transaction one.
 */

export interface TrailerSummaryQuery {
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

function normaliseQuery(query: Record<string, unknown>): TrailerSummaryQuery {
  return {
    rigId: pickStr(query, 'rigId'),
    rigType: pickStr(query, 'rigType'),
    dateFrom: pickStr(query, 'dateFrom'),
    dateTo: pickStr(query, 'dateTo'),
  };
}

function buildWhere(q: TrailerSummaryQuery): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = ["tl.trailerNo IS NOT NULL", "trim(tl.trailerNo) <> ''"];
  const params: Record<string, unknown> = {};
  if (q.rigId) { clauses.push('t.rigId = @rigId'); params.rigId = q.rigId; }
  if (q.rigType) { clauses.push('r.rigKey IN (SELECT rigKey FROM rigs WHERE rigType = @rigType)'); params.rigType = q.rigType; }
  if (q.dateFrom) { clauses.push('t.date >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { clauses.push('t.date <= @dateTo'); params.dateTo = q.dateTo; }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

interface TrailerLoadRow {
  trailerNo: string; srNo: string | null; mtGatePassNo: string | null; trailerType: string | null;
  arrivalDate: string | null; arrivalTime: string | null; loadingDate: string | null; loadingTime: string | null;
  loadDescription: string | null; totalPackages: number | null; unloadingDate: string | null; unloadingTime: string | null;
  driverName: string | null; driverContact: string | null; loadingPoint: string | null;
}

/** One trip = one ilm_trailer_loads row. Unlimited — a trailer can make as many trips as were actually logged. */
export interface TrailerTripDetail {
  tripNo: number;
  mtGatePassNo: string | null;
  loadingDate: string | null;
  loadingTime: string | null;
  unloadingDate: string | null;
  unloadingTime: string | null;
  totalPackages: number | null;
  loadDescription: string | null;
}

export interface TrailerSummaryRow {
  trailerNo: string;
  tripCount: number;
  trailerType: string | null;
  loadingPoint: string | null;
  arrivalDate: string | null;
  arrivalTime: string | null;
  loadingDate: string | null;
  loadingTime: string | null;
  loadDescription: string | null;
  totalPackages: number;
  driverName: string | null;
  driverContact: string | null;
  /** Every trip this trailer made, oldest first — not just the first two. */
  trips: TrailerTripDetail[];
  loadDetails: string | null;
}

export interface TrailerSummaryResponse {
  kpis: {
    totalTrailers: number; totalTrips: number; completionRatePct: number;
    avgTripsPerTrailer: number; totalDays: number; totalPackages: number;
  };
  rows: TrailerSummaryRow[];
}

const SELECT_SQL = `
  SELECT tl.trailerNo, tl.srNo, tl.mtGatePassNo, tl.trailerType, tl.arrivalDate, tl.arrivalTime,
         tl.loadingDate, tl.loadingTime, tl.loadDescription, tl.totalPackages, tl.unloadingDate, tl.unloadingTime,
         tl.driverName, tl.driverContact, tm.oldLocation AS loadingPoint
  FROM ilm_trailer_loads tl
  JOIN ilm_transactions t ON t.id = tl.transactionId
  JOIN ilm_rigs r ON r.id = t.rigId
  LEFT JOIN ilm_trailer_movements tm ON tm.id = tl.movementId
`;

export function getTrailerSummary(rawQuery: Record<string, unknown>): TrailerSummaryResponse {
  const q = normaliseQuery(rawQuery);
  const { where, params } = buildWhere(q);

  const rows = db.prepare(`
    ${SELECT_SQL} ${where}
    ORDER BY tl.trailerNo, t.date ASC, tl.loadingDate ASC, tl.lineNo ASC
  `).all(params) as TrailerLoadRow[];

  const byTrailer = new Map<string, TrailerLoadRow[]>();
  for (const row of rows) {
    const list = byTrailer.get(row.trailerNo) ?? [];
    list.push(row);
    byTrailer.set(row.trailerNo, list);
  }

  const summaryRows: TrailerSummaryRow[] = [];
  for (const [trailerNo, loads] of byTrailer) {
    const first = loads[0];
    summaryRows.push({
      trailerNo,
      tripCount: loads.length,
      trailerType: first.trailerType,
      loadingPoint: first.loadingPoint,
      arrivalDate: first.arrivalDate,
      arrivalTime: first.arrivalTime,
      loadingDate: first.loadingDate,
      loadingTime: first.loadingTime,
      loadDescription: first.loadDescription,
      totalPackages: loads.reduce((s, l) => s + (l.totalPackages ?? 0), 0),
      driverName: first.driverName,
      driverContact: first.driverContact,
      trips: loads.map((l, i) => ({
        tripNo: i + 1,
        mtGatePassNo: l.mtGatePassNo,
        loadingDate: l.loadingDate,
        loadingTime: l.loadingTime,
        unloadingDate: l.unloadingDate,
        unloadingTime: l.unloadingTime,
        totalPackages: l.totalPackages,
        loadDescription: l.loadDescription,
      })),
      loadDetails: first.loadDescription,
    });
  }

  const totalTrailers = summaryRows.length;
  const totalTrips = rows.length;
  const completedTrips = rows.filter((r) => r.loadingDate && r.unloadingDate).length;
  const allDates = rows.flatMap((r) => [r.loadingDate, r.unloadingDate]).filter((d): d is string => !!d).sort();
  const totalDays = allDates.length > 0
    ? Math.round((new Date(allDates[allDates.length - 1]).getTime() - new Date(allDates[0]).getTime()) / 86400000) + 1
    : 0;

  return {
    kpis: {
      totalTrailers, totalTrips,
      completionRatePct: totalTrips > 0 ? Math.round((completedTrips / totalTrips) * 1000) / 10 : 0,
      avgTripsPerTrailer: totalTrailers > 0 ? Math.round((totalTrips / totalTrailers) * 10) / 10 : 0,
      totalDays,
      totalPackages: rows.reduce((s, r) => s + (r.totalPackages ?? 0), 0),
    },
    rows: summaryRows,
  };
}

export async function buildTrailerSummaryExportWorkbook(rawQuery: Record<string, unknown>): Promise<Buffer> {
  const { rows } = getTrailerSummary(rawQuery);
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('Trailer Summary');
  ws.columns = [
    { header: 'Trailer No.', key: 'trailerNo', width: 14 },
    { header: 'No. of Trips', key: 'tripCount', width: 12 },
    { header: 'Trailer Type', key: 'trailerType', width: 12 },
    { header: 'Loading Point', key: 'loadingPoint', width: 16 },
    { header: 'Arrival Date', key: 'arrivalDate', width: 14 },
    { header: 'Arrival Time', key: 'arrivalTime', width: 12 },
    { header: 'Loading Date', key: 'loadingDate', width: 14 },
    { header: 'Loading Time', key: 'loadingTime', width: 12 },
    { header: 'Load Description', key: 'loadDescription', width: 22 },
    { header: 'Total Packages', key: 'totalPackages', width: 14 },
    { header: 'Driver Name', key: 'driverName', width: 16 },
    { header: 'Driver Contact', key: 'driverContact', width: 14 },
    { header: 'Load Details', key: 'loadDetails', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);

  // A trailer can make any number of trips, so every trip gets its own flat
  // row here instead of trying to fit a variable count into fixed columns.
  const tripWs = wb.addWorksheet('Trip Detail');
  tripWs.columns = [
    { header: 'Trailer No.', key: 'trailerNo', width: 14 },
    { header: 'Trip No.', key: 'tripNo', width: 10 },
    { header: 'MT/Gate Pass', key: 'mtGatePassNo', width: 16 },
    { header: 'Loading Date', key: 'loadingDate', width: 14 },
    { header: 'Loading Time', key: 'loadingTime', width: 12 },
    { header: 'Unloading Date', key: 'unloadingDate', width: 14 },
    { header: 'Unloading Time', key: 'unloadingTime', width: 12 },
    { header: 'Packages', key: 'totalPackages', width: 12 },
    { header: 'Load Description', key: 'loadDescription', width: 22 },
  ];
  tripWs.getRow(1).font = { bold: true };
  for (const row of rows) {
    for (const trip of row.trips) tripWs.addRow({ trailerNo: row.trailerNo, ...trip });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
