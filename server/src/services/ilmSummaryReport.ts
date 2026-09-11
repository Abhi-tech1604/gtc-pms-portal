import ExcelJS from 'exceljs';
import { db } from '../db/index.js';
import { getIlmTransaction, type IlmTransactionView } from './ilmView.js';

/**
 * The "Individual Summary Dashboard" (ILM → Dashboard's default view): a
 * report for one rig across a date range, reusing getIlmTransaction() per
 * matching movement and layering on the derived figures the mockup shows —
 * days/hours span, delay-reason breakdown, equipment capacity totals, and
 * day-rate effectiveness. When the range covers more than one movement,
 * every figure is a real aggregate (union of equipment, sums of HSD/delay
 * counts, earliest release → latest spud span) — never averaged-then-guessed.
 * A single-movement range (dateFrom === dateTo, one match) is just the N=1
 * case of the same aggregation, so the math is identical to before.
 *
 * Not built: a per-equipment HSD breakdown (Rig Generator/Mud Pump/Camp DG/
 * etc.) — ILM has no per-equipment fuel-issue tracking anywhere in its data
 * model (that granularity exists only in DRR's mechanical logs, a different
 * module), so that table is intentionally omitted rather than invented.
 */

export const DELAY_REASON_CATEGORIES = [
  'Site Not Ready',
  'Site Barricaded',
  'Non-Availability of Trailers',
  'Non-Availability of Cranes',
  'Weather Conditions',
  'For Spares/Equipment',
] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(fromDate: string | null, toDate: string | null): number | null {
  if (!fromDate || !toDate) return null;
  const from = new Date(fromDate).getTime();
  const to = new Date(toDate).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86400000);
}

function firstNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (const v of values) if (v !== null && v !== undefined) return v;
  return null;
}

export interface IlmSummaryReport {
  found: true;
  rigId: string;
  rigNumber: string;
  dateFrom: string;
  dateTo: string;
  movementCount: number;
  summary: {
    rigNumber: string;
    area: string | null;
    operatorName: string | null;
    wellNo: string | null;
    movementFromWell: string | null;
    movementToWell: string | null;
    releaseDate: string | null;
    releaseTime: string | null;
    spudDate: string | null;
    spudTime: string | null;
    totalDaysReleaseToSpud: number | null;
  };
  equipment: {
    craneCapacityTon: number | null;
    trailerCapacityTon: number | null;
    totalCranes: number;
    totalTrailers: number;
    delayReasonCounts: { reason: string; count: number }[];
    totalTimeForDelayHrs: number | null;
  };
  hsd: {
    hsdStockAccession: number | null;
    receivedQtyDuringIlm: number | null;
    hsdStockShiftEnd: number | null;
    totalHsdConsumption: number | null;
    ilmDistanceKm: number | null;
    totalLoadsMoved: number | null;
    cumulativeTrailerKm: number | null;
    avgConsumptionPerKm: number | null;
    cumulativeCraneHrs: number | null;
    avgConsumptionPerHr: number | null;
  };
  timeAndCosts: {
    totalHrsForIlm: number | null;
    totalDaysForIlm: number | null;
    ilmRatePerDay: number | null;
    ilmExpenses: number | null;
    averageDayRate: number | null;
    operatingDayRate: number | null;
    effectiveDayRatePct: number | null;
  };
  kpis: {
    totalHsdConsumption: number | null;
    ilmFleetCost: number | null;
    distanceCoveredKm: number | null;
    effectiveDayRatePct: number | null;
  };
  trailerAnalysis: {
    byType: { trailerType: string; tripCount: number; totalLoads: number }[];
  };
  craneAnalysis: {
    byUnit: {
      craneNo: string; transporterName: string | null; rigOrHired: string | null;
      totalWorkingHrs: number; totalBreakdownHrs: number; breakdownRatioPct: number;
    }[];
  };
}

export type IlmSummaryReportResult = IlmSummaryReport | { found: false };

export function getIlmSummaryReport(rigId: string, dateFrom: string, dateTo: string): IlmSummaryReportResult {
  const rig = db.prepare<[string], { rigNumber: string }>('SELECT rigNumber FROM ilm_rigs WHERE id = ?').get(rigId);
  if (!rig) return { found: false };

  const rows = db.prepare<[string, string, string], { id: string }>(
    'SELECT id FROM ilm_transactions WHERE rigId = ? AND date >= ? AND date <= ? ORDER BY date ASC',
  ).all(rigId, dateFrom, dateTo);
  if (rows.length === 0) return { found: false };

  const txns = rows.map((r) => getIlmTransaction(r.id)).filter((t): t is IlmTransactionView => t !== null);
  return buildReport(rigId, rig.rigNumber, dateFrom, dateTo, txns);
}

function buildReport(
  rigId: string, rigNumber: string, dateFrom: string, dateTo: string, txns: IlmTransactionView[],
): IlmSummaryReport {
  const individuals = txns.map((t) => t.individual);
  const individualLines = txns.flatMap((t) => t.individualLines);
  const cranes = txns.flatMap((t) => t.cranes);
  const trailerLoads = txns.flatMap((t) => t.trailerLoads);

  const releaseDate = firstNonNull(individuals.map((i) => i?.releaseDate ?? null));
  const releaseTime = firstNonNull(individuals.map((i) => i?.releaseDate === releaseDate ? (i?.releaseTime ?? null) : null));
  const spudDate = firstNonNull([...individuals].reverse().map((i) => i?.spudDate ?? null));
  const spudTime = firstNonNull([...individuals].reverse().map((i) => i?.spudDate === spudDate ? (i?.spudTime ?? null) : null));
  const totalDaysReleaseToSpud = daysBetween(releaseDate, spudDate);

  const craneNos = new Set(cranes.map((c) => c.craneNo).filter((v): v is string => !!v));
  const trailerNos = new Set(trailerLoads.map((t) => t.trailerNo).filter((v): v is string => !!v));
  const craneCapacityByNo = new Map<string, number>();
  for (const c of cranes) {
    if (c.craneNo && c.capacityTon !== null) {
      craneCapacityByNo.set(c.craneNo, Math.max(craneCapacityByNo.get(c.craneNo) ?? 0, c.capacityTon));
    }
  }
  const trailerCapacityByNo = new Map<string, number>();
  for (const t of trailerLoads) {
    if (t.trailerNo && t.capacityTon !== null) {
      trailerCapacityByNo.set(t.trailerNo, Math.max(trailerCapacityByNo.get(t.trailerNo) ?? 0, t.capacityTon));
    }
  }
  const craneCapacityTon = craneCapacityByNo.size > 0 ? round2([...craneCapacityByNo.values()].reduce((s, v) => s + v, 0)) : null;
  const trailerCapacityTon = trailerCapacityByNo.size > 0 ? round2([...trailerCapacityByNo.values()].reduce((s, v) => s + v, 0)) : null;

  const delayReasonCounts = DELAY_REASON_CATEGORIES.map((reason) => ({
    reason,
    count: individualLines.filter((l) => (l.reasonForDelay ?? '').trim().toLowerCase() === reason.toLowerCase()).length,
  }));
  const totalTimeForDelayHrs = individualLines.length > 0
    ? round2(individualLines.reduce((s, l) => s + (l.totalDelayHours ?? 0), 0))
    : null;

  const sumOrNull = (values: (number | null)[]): number | null => {
    const present = values.filter((v): v is number => v !== null);
    return present.length > 0 ? round2(present.reduce((s, v) => s + v, 0)) : null;
  };
  // hsdStockAccession/hsdStockShiftEnd are point-in-time tank balances, not
  // flows — summing them across several movements produced a meaningless
  // total (e.g. three movements' opening stock added together). Take the
  // earliest movement's accession and the latest movement's shift-end
  // instead, the same first/last pattern already used for release/spud dates
  // above. receivedQtyDuringIlm is a genuine flow (fuel delivered during each
  // movement), so summing it across movements stays correct.
  const hsdStockAccession = firstNonNull(individualLines.map((l) => l.hsdStockAccession));
  const receivedQtyDuringIlm = sumOrNull(individualLines.map((l) => l.receivedQtyDuringIlm));
  const hsdStockShiftEnd = firstNonNull([...individualLines].reverse().map((l) => l.hsdStockShiftEnd));
  const trailerHsdConsumption = sumOrNull(individualLines.map((l) => l.totalHsdConsumption));
  const craneHsdIssued = sumOrNull(cranes.map((c) => c.issuedHsdLtrs));
  const totalHsdConsumption = trailerHsdConsumption !== null || craneHsdIssued !== null
    ? round2((trailerHsdConsumption ?? 0) + (craneHsdIssued ?? 0)) : null;
  const ilmDistanceKm = sumOrNull(individualLines.map((l) => l.ilmDistanceKm));
  const totalLoadsMoved = sumOrNull(individualLines.map((l) => l.totalLoadsMoved));
  const cumulativeTrailerKm = sumOrNull(individualLines.map((l) => l.cumulativeTrailerKm));
  const avgConsumptionPerKm = totalHsdConsumption !== null && ilmDistanceKm !== null && ilmDistanceKm !== 0
    ? round2(totalHsdConsumption / ilmDistanceKm) : null;
  const cumulativeCraneHrs = sumOrNull(cranes.map((c) => c.totalWorkingHrs));
  const avgConsumptionPerHr = craneHsdIssued !== null && cumulativeCraneHrs !== null && cumulativeCraneHrs !== 0
    ? round2(craneHsdIssued / cumulativeCraneHrs) : null;

  const totalHrsForIlm = totalDaysReleaseToSpud !== null ? totalDaysReleaseToSpud * 24 : null;
  const rates = individuals.map((i) => i?.ilmRatePerDay ?? null).filter((v): v is number => v !== null);
  const ilmRatePerDay = rates.length > 0 ? round2(rates.reduce((s, v) => s + v, 0) / rates.length) : null;
  const ilmExpenses = sumOrNull(individuals.map((i) => i?.ilmExpenses ?? null));
  const averageDayRate = ilmRatePerDay;
  const operatingDayRate = ilmExpenses !== null && totalDaysReleaseToSpud !== null && totalDaysReleaseToSpud !== 0
    ? round2(ilmExpenses / totalDaysReleaseToSpud) : null;
  const effectiveDayRatePct = averageDayRate !== null && operatingDayRate !== null && operatingDayRate !== 0
    ? round2((averageDayRate / operatingDayRate) * 100) : null;

  // Trailer-type-wise breakdown: every trailer load in range, grouped by its
  // own trailerType (blank/unrecorded types bucket together rather than
  // being dropped, so the totals below still reconcile with equipment.totalTrailers).
  const trailerTypeMap = new Map<string, { tripCount: number; totalLoads: number }>();
  for (const load of trailerLoads) {
    const key = load.trailerType?.trim() || 'Unspecified';
    const bucket = trailerTypeMap.get(key) ?? { tripCount: 0, totalLoads: 0 };
    bucket.tripCount += 1;
    bucket.totalLoads += load.totalPackages ?? 0;
    trailerTypeMap.set(key, bucket);
  }
  const trailerAnalysis = {
    byType: [...trailerTypeMap.entries()]
      .map(([trailerType, v]) => ({ trailerType, tripCount: v.tripCount, totalLoads: round2(v.totalLoads) }))
      .sort((a, b) => b.tripCount - a.tripCount),
  };

  // Crane/transporter-wise breakdown: every crane record in range, grouped by
  // craneNo (falling back to the transporter name for a record with no crane
  // number recorded, so it still shows up rather than vanishing).
  const craneUnitMap = new Map<string, { transporterName: string | null; rigOrHired: string | null; workingHrs: number; breakdownHrs: number }>();
  for (const c of cranes) {
    const key = c.craneNo?.trim() || c.transporterName?.trim() || 'Unspecified';
    const bucket = craneUnitMap.get(key) ?? { transporterName: c.transporterName, rigOrHired: c.rigOrHired, workingHrs: 0, breakdownHrs: 0 };
    bucket.workingHrs += c.totalWorkingHrs ?? 0;
    bucket.breakdownHrs += c.breakdownHrs ?? 0;
    craneUnitMap.set(key, bucket);
  }
  const craneAnalysis = {
    byUnit: [...craneUnitMap.entries()]
      .map(([craneNo, v]) => ({
        craneNo, transporterName: v.transporterName, rigOrHired: v.rigOrHired,
        totalWorkingHrs: round2(v.workingHrs), totalBreakdownHrs: round2(v.breakdownHrs),
        breakdownRatioPct: v.workingHrs > 0 ? round2((v.breakdownHrs / v.workingHrs) * 100) : 0,
      }))
      .sort((a, b) => b.totalWorkingHrs - a.totalWorkingHrs),
  };

  return {
    found: true,
    rigId, rigNumber, dateFrom, dateTo, movementCount: txns.length,
    summary: {
      rigNumber,
      area: firstNonNull(individuals.map((i) => i?.area ?? null)),
      operatorName: firstNonNull(individuals.map((i) => i?.operatorName ?? null)),
      wellNo: firstNonNull(individuals.map((i) => i?.wellNo ?? null)),
      movementFromWell: firstNonNull(individuals.map((i) => i?.movementFromWell ?? null)),
      movementToWell: firstNonNull([...individuals].reverse().map((i) => i?.movementToWell ?? null)),
      releaseDate, releaseTime, spudDate, spudTime,
      totalDaysReleaseToSpud,
    },
    equipment: {
      craneCapacityTon, trailerCapacityTon,
      totalCranes: craneNos.size, totalTrailers: trailerNos.size,
      delayReasonCounts, totalTimeForDelayHrs,
    },
    hsd: {
      hsdStockAccession, receivedQtyDuringIlm, hsdStockShiftEnd, totalHsdConsumption,
      ilmDistanceKm, totalLoadsMoved, cumulativeTrailerKm, avgConsumptionPerKm,
      cumulativeCraneHrs, avgConsumptionPerHr,
    },
    timeAndCosts: {
      totalHrsForIlm, totalDaysForIlm: totalDaysReleaseToSpud, ilmRatePerDay, ilmExpenses,
      averageDayRate, operatingDayRate, effectiveDayRatePct,
    },
    kpis: {
      totalHsdConsumption, ilmFleetCost: ilmExpenses, distanceCoveredKm: ilmDistanceKm, effectiveDayRatePct,
    },
    trailerAnalysis, craneAnalysis,
  };
}

export async function buildIlmSummaryReportExportWorkbook(rigId: string, dateFrom: string, dateTo: string): Promise<Buffer> {
  const report = getIlmSummaryReport(rigId, dateFrom, dateTo);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary');
  if (!report.found) {
    ws.addRow(['No ILM movement found for this rig and date range.']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const section = (title: string) => { const r = ws.addRow([title]); r.font = { bold: true, size: 12 }; };
  const kv = (rows: [string, unknown][]) => rows.forEach(([k, v]) => ws.addRow([k, v ?? '-']));

  section('Summary Information');
  kv([
    ['Rig No.', report.summary.rigNumber], ['Area', report.summary.area],
    ['Operator Name', report.summary.operatorName], ['Well No.', report.summary.wellNo],
    ['Movement', `${report.summary.movementFromWell ?? '-'} -> ${report.summary.movementToWell ?? '-'}`],
    ['Release Date & Time', `${report.summary.releaseDate ?? '-'} ${report.summary.releaseTime ?? ''}`.trim()],
    ['Spud Date & Time', `${report.summary.spudDate ?? '-'} ${report.summary.spudTime ?? ''}`.trim()],
    ['Total Days from Release to Spud', report.summary.totalDaysReleaseToSpud],
    ['Movements in Range', report.movementCount],
  ]);
  ws.addRow([]);

  section('Equipment & Capacity');
  kv([
    ['Crane Capacity (Ton)', report.equipment.craneCapacityTon], ['Trailer Capacity (Ton)', report.equipment.trailerCapacityTon],
    ['Total No. of Cranes', report.equipment.totalCranes], ['Total No. of Trailers', report.equipment.totalTrailers],
    ...report.equipment.delayReasonCounts.map((d): [string, unknown] => [d.reason, d.count]),
    ['Total Time for Delay (Hrs)', report.equipment.totalTimeForDelayHrs],
  ]);
  ws.addRow([]);

  section('HSD Consumption Summary');
  kv([
    ['HSD Stock @ Rig Accession', report.hsd.hsdStockAccession], ['Received Qty During ILM', report.hsd.receivedQtyDuringIlm],
    ['HSD Stock @ Shift End', report.hsd.hsdStockShiftEnd], ['Total HSD Consumption', report.hsd.totalHsdConsumption],
    ['ILM Distance (KM)', report.hsd.ilmDistanceKm], ['Total Loads Moved', report.hsd.totalLoadsMoved],
    ['Cumulative Trailer KMs', report.hsd.cumulativeTrailerKm], ['Avg Consumption per KM', report.hsd.avgConsumptionPerKm],
    ['Cumulative Crane Hrs', report.hsd.cumulativeCraneHrs], ['Avg Consumption per Hr', report.hsd.avgConsumptionPerHr],
  ]);
  ws.addRow([]);

  section('ILM Time & Costs');
  kv([
    ['Total Hrs for ILM', report.timeAndCosts.totalHrsForIlm], ['Total No. of Days for ILM', report.timeAndCosts.totalDaysForIlm],
    ['ILM Rate', report.timeAndCosts.ilmRatePerDay], ['ILM Expenses', report.timeAndCosts.ilmExpenses],
    ['Average Day Rate', report.timeAndCosts.averageDayRate], ['Operating Day Rate', report.timeAndCosts.operatingDayRate],
    ['% Effective Day Rate', report.timeAndCosts.effectiveDayRatePct],
  ]);
  ws.addRow([]);

  section('Key Performance Indicators');
  kv([
    ['Total HSD Consumption', report.kpis.totalHsdConsumption], ['ILM Fleet Cost', report.kpis.ilmFleetCost],
    ['Distance Covered (KM)', report.kpis.distanceCoveredKm], ['Effective Day Rate (%)', report.kpis.effectiveDayRatePct],
  ]);
  ws.addRow([]);

  section('Trailer Analysis (by Type)');
  ws.addRow(['Trailer Type', 'Trip Count', 'Total Loads']).font = { bold: true };
  for (const t of report.trailerAnalysis.byType) ws.addRow([t.trailerType, t.tripCount, t.totalLoads]);
  ws.addRow([]);

  section('Crane Analysis (by Unit)');
  ws.addRow(['Crane No.', 'Transporter', 'Rig/Hired', 'Working Hrs', 'Breakdown Hrs', 'Breakdown Ratio %']).font = { bold: true };
  for (const c of report.craneAnalysis.byUnit) {
    ws.addRow([c.craneNo, c.transporterName ?? '-', c.rigOrHired ?? '-', c.totalWorkingHrs, c.totalBreakdownHrs, c.breakdownRatioPct]);
  }

  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 24;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
