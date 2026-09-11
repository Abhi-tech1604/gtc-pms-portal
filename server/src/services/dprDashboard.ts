import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { db } from '../db/index.js';
import { equipmentForDprRig } from '../routes/dpr.js';

/**
 * All DPR Dashboard aggregation lives here, separate from routes/dpr.ts (already
 * 500+ lines of CRUD/import) — mirrors the services/dprView.ts split. Every
 * query reads existing columns only; no schema changes.
 *
 * Diesel figures come from hsd_reports/hsd_equipment_lines, a structurally
 * separate table set from dpr_reports (both point at dpr_rigs, but there is
 * no FK between them) — correlated here by matching rigId + date range, never
 * by report id.
 *
 * Equipment-wise figures are best-effort: dpr_line_items.breakdownEquipment
 * and hsd_equipment_lines.equipment are free text, not FK'd to the `equipment`
 * table, so grouping is by trimmed/lowercased name only. Two records naming
 * the same machine slightly differently will not merge — surfaced in the UI,
 * not hidden.
 *
 * Downtime = R3 work-type hours, the same category the dashboard already
 * displayed (as "R3 Total Time") before this upgrade.
 */

export interface DashboardQuery {
  rigId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  workType?: string;
  operationCode?: string;
  equipment?: string;
}

function pickStr(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

export function normaliseDashboardQuery(query: Record<string, unknown>): DashboardQuery {
  return {
    rigId: pickStr(query, 'rigId'),
    dateFrom: pickStr(query, 'dateFrom'),
    dateTo: pickStr(query, 'dateTo'),
    search: pickStr(query, 'search'),
    workType: pickStr(query, 'workType'),
    operationCode: pickStr(query, 'operationCode'),
    equipment: pickStr(query, 'equipment'),
  };
}

interface FilterBuild {
  /** `SELECT rr.* FROM dpr_reports rr JOIN dpr_rigs r ...` — report-grained, for use as a CTE. */
  reportsCte: string;
  /** `SELECT h.* FROM hsd_reports h ...` — report-grained HSD equivalent, correlated by rigId/date only. */
  hsdCte: string;
  /** "" or "AND <cond> AND <cond>" — line-level predicate (workType/operationCode/equipment), append after an existing boolean. */
  linePredicate: string;
  /** "" or "AND lower(trim(e.equipment)) LIKE ..." — equipment-name predicate for hsd_equipment_lines. */
  hsdEquipmentPredicate: string;
  params: Record<string, unknown>;
}

function buildFilters(q: DashboardQuery): FilterBuild {
  const params: Record<string, unknown> = {};
  const reportWhere: string[] = [];

  if (q.rigId) { reportWhere.push('rr.rigId = @rigId'); params.rigId = q.rigId; }
  if (q.dateFrom) { reportWhere.push('rr.dprDate >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { reportWhere.push('rr.dprDate <= @dateTo'); params.dateTo = q.dateTo; }
  if (q.search) {
    const needle = `%${q.search.toLowerCase()}%`;
    params.needle = needle;
    reportWhere.push(`(
      lower(r.rigNumber) LIKE @needle OR lower(r.name) LIKE @needle OR
      EXISTS (SELECT 1 FROM dpr_line_items li WHERE li.reportId = rr.id AND (
        lower(li.wellName) LIKE @needle OR lower(li.operationCode) LIKE @needle OR lower(li.description) LIKE @needle
      ))
    )`);
  }

  const lineConds: string[] = [];
  if (q.workType) { lineConds.push('upper(trim(li.workType)) = upper(trim(@workType))'); params.workType = q.workType; }
  if (q.operationCode) { lineConds.push('li.operationCode = @operationCode'); params.operationCode = q.operationCode; }
  if (q.equipment) {
    lineConds.push("lower(trim(li.breakdownEquipment)) LIKE lower('%'||@equipment||'%')");
    params.equipment = q.equipment;
  }
  const linePredicate = lineConds.length ? `AND ${lineConds.join(' AND ')}` : '';

  if (lineConds.length) {
    reportWhere.push(`EXISTS (SELECT 1 FROM dpr_line_items li WHERE li.reportId = rr.id ${linePredicate})`);
  }

  const reportsCte = `
    SELECT rr.* FROM dpr_reports rr
    JOIN dpr_rigs r ON r.id = rr.rigId
    ${reportWhere.length ? `WHERE ${reportWhere.join(' AND ')}` : ''}
  `;

  const hsdWhere: string[] = [];
  if (q.rigId) hsdWhere.push('h.rigId = @rigId');
  if (q.dateFrom) hsdWhere.push('h.hsdDate >= @dateFrom');
  if (q.dateTo) hsdWhere.push('h.hsdDate <= @dateTo');
  const hsdCte = `SELECT h.* FROM hsd_reports h ${hsdWhere.length ? `WHERE ${hsdWhere.join(' AND ')}` : ''}`;

  const hsdEquipmentPredicate = q.equipment ? "AND lower(trim(e.equipment)) LIKE lower('%'||@equipment||'%')" : '';

  return { reportsCte, hsdCte, linePredicate, hsdEquipmentPredicate, params };
}

/* ---------------------------- KPIs ---------------------------- */

export interface DprDashboardKpis {
  r1Hours: number; r2Hours: number; r3Hours: number; ilmHours: number;
  totalDpr: number;
  totalProgress: number;
  totalRigHours: number;
  totalDiesel: number;
  avgDieselPerDay: number;
  dieselPerRigHour: number;
  downtimeHours: number;
  equipmentUtilizationPct: number;
}

export function getDashboardKpis(rawQuery: Record<string, unknown>): DprDashboardKpis {
  const q = normaliseDashboardQuery(rawQuery);
  const { reportsCte, hsdCte, linePredicate, hsdEquipmentPredicate, params } = buildFilters(q);

  const work = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R1' ${linePredicate} THEN li.totalHours END), 0) AS r1Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R2' ${linePredicate} THEN li.totalHours END), 0) AS r2Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R3' ${linePredicate} THEN li.totalHours END), 0) AS r3Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'ILM' ${linePredicate} THEN li.totalHours END), 0) AS ilmHours,
      COUNT(DISTINCT rr.id) AS totalDpr,
      COALESCE(SUM(CASE WHEN 1=1 ${linePredicate} THEN li.drillingTotal END), 0)
        + COALESCE(SUM(CASE WHEN 1=1 ${linePredicate} THEN li.casingTotal END), 0) AS totalProgress,
      COALESCE(SUM(CASE WHEN 1=1 ${linePredicate} THEN li.totalHours END), 0) AS totalRigHours
    FROM filtered_reports rr
    LEFT JOIN dpr_line_items li ON li.reportId = rr.id
  `).get(params) as {
    r1Hours: number; r2Hours: number; r3Hours: number; ilmHours: number;
    totalDpr: number; totalProgress: number; totalRigHours: number;
  };

  const diesel = db.prepare(`
    WITH filtered_hsd AS (${hsdCte})
    SELECT
      COUNT(DISTINCT h.id) AS dieselDays,
      (SELECT COALESCE(SUM(e.consumedHsd), 0) FROM hsd_equipment_lines e
        WHERE e.reportId IN (SELECT id FROM filtered_hsd) ${hsdEquipmentPredicate}) AS totalDiesel
    FROM filtered_hsd h
  `).get(params) as { dieselDays: number; totalDiesel: number };

  const utilization = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT
      COALESCE(SUM(li.totalHours), 0) AS taggedHours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) <> 'R3' THEN li.totalHours END), 0) AS productiveTaggedHours
    FROM filtered_reports rr
    JOIN dpr_line_items li ON li.reportId = rr.id
    WHERE li.breakdownEquipment IS NOT NULL AND trim(li.breakdownEquipment) <> '' ${linePredicate}
  `).get(params) as { taggedHours: number; productiveTaggedHours: number };

  const avgDieselPerDay = diesel.dieselDays > 0 ? diesel.totalDiesel / diesel.dieselDays : 0;
  const dieselPerRigHour = work.totalRigHours > 0 ? diesel.totalDiesel / work.totalRigHours : 0;
  const equipmentUtilizationPct = utilization.taggedHours > 0
    ? (100 * utilization.productiveTaggedHours) / utilization.taggedHours : 0;

  return {
    r1Hours: work.r1Hours, r2Hours: work.r2Hours, r3Hours: work.r3Hours, ilmHours: work.ilmHours,
    totalDpr: work.totalDpr,
    totalProgress: round2(work.totalProgress),
    totalRigHours: round2(work.totalRigHours),
    totalDiesel: round2(diesel.totalDiesel),
    avgDieselPerDay: round2(avgDieselPerDay),
    dieselPerRigHour: round2(dieselPerRigHour),
    downtimeHours: round2(work.r3Hours),
    equipmentUtilizationPct: round2(equipmentUtilizationPct),
  };
}

/* ---------------------------- rig comparison ---------------------------- */

export interface DprDashboardRigComparisonRow {
  rigId: string; rigNumber: string; rigName: string;
  lastReportDate: string | null; reportCount: number;
  totalHours: number; netDrillingMeters: number; totalProgress: number;
  downtimeHours: number; efficiencyPct: number; utilizationPct: number; totalDiesel: number;
  dprStatus: 'Pending' | 'Completed';
}

export function getRigComparison(rawQuery: Record<string, unknown>): DprDashboardRigComparisonRow[] {
  const q = normaliseDashboardQuery(rawQuery);
  const { reportsCte, linePredicate, hsdEquipmentPredicate, params } = buildFilters(q);

  const rigFilterClause = q.rigId ? 'AND r.id = @rigId' : '';
  const status = pickStr(rawQuery, 'status');
  let havingClause = '';
  if (status === 'Completed') havingClause = 'HAVING reportCount > 0';
  else if (status === 'Pending') havingClause = 'HAVING reportCount = 0';

  const dateWhere: string[] = [];
  if (q.dateFrom) dateWhere.push('h.hsdDate >= @dateFrom');
  if (q.dateTo) dateWhere.push('h.hsdDate <= @dateTo');
  const dieselDateClause = dateWhere.length ? `AND ${dateWhere.join(' AND ')}` : '';

  const rows = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT r.id AS rigId, r.rigNumber, r.name AS rigName,
           MAX(rr.dprDate) AS lastReportDate,
           COUNT(DISTINCT rr.id) AS reportCount,
           COALESCE(SUM(li.totalHours), 0) AS totalHours,
           COALESCE(SUM(li.drillingTotal), 0) AS netDrillingMeters,
           COALESCE(SUM(li.drillingTotal), 0) + COALESCE(SUM(li.casingTotal), 0) AS totalProgress,
           COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R3' THEN li.totalHours END), 0) AS downtimeHours,
           CASE WHEN COALESCE(SUM(li.totalHours), 0) = 0 THEN 0
                ELSE 100.0 * COALESCE(SUM(CASE WHEN upper(trim(li.workType)) <> 'R3' THEN li.totalHours END), 0) / SUM(li.totalHours)
           END AS efficiencyPct,
           CASE WHEN COALESCE(SUM(CASE WHEN li.breakdownEquipment IS NOT NULL AND trim(li.breakdownEquipment) <> '' THEN li.totalHours END), 0) = 0 THEN 0
                ELSE 100.0 * COALESCE(SUM(CASE WHEN li.breakdownEquipment IS NOT NULL AND trim(li.breakdownEquipment) <> '' AND upper(trim(li.workType)) <> 'R3' THEN li.totalHours END), 0)
                     / SUM(CASE WHEN li.breakdownEquipment IS NOT NULL AND trim(li.breakdownEquipment) <> '' THEN li.totalHours END)
           END AS utilizationPct,
           (SELECT COALESCE(SUM(e.consumedHsd), 0) FROM hsd_reports h
              JOIN hsd_equipment_lines e ON e.reportId = h.id
              WHERE h.rigId = r.id ${dieselDateClause} ${hsdEquipmentPredicate}) AS totalDiesel,
           CASE WHEN COUNT(DISTINCT rr.id) > 0 THEN 'Completed' ELSE 'Pending' END AS dprStatus
    FROM dpr_rigs r
    LEFT JOIN filtered_reports rr ON rr.rigId = r.id
    LEFT JOIN dpr_line_items li ON li.reportId = rr.id ${linePredicate ? `AND (1=1 ${linePredicate})` : ''}
    WHERE r.status = 'Active' ${rigFilterClause}
    GROUP BY r.id
    ${havingClause}
    ORDER BY r.rigNumber
  `).all(params) as DprDashboardRigComparisonRow[];

  return rows.map((r) => ({
    ...r,
    totalHours: round2(r.totalHours), netDrillingMeters: round2(r.netDrillingMeters),
    totalProgress: round2(r.totalProgress), downtimeHours: round2(r.downtimeHours),
    efficiencyPct: round2(r.efficiencyPct), utilizationPct: round2(r.utilizationPct),
    totalDiesel: round2(r.totalDiesel),
  }));
}

/* ---------------------------- trends ---------------------------- */

export interface DprTrendPoint {
  bucket: string; dprCount: number; totalHours: number; totalProgress: number;
  downtimeHours: number; totalDiesel: number;
}

export function getTrends(rawQuery: Record<string, unknown>, granularity: 'day' | 'week' | 'month'): DprTrendPoint[] {
  const q = normaliseDashboardQuery(rawQuery);
  const { reportsCte, hsdCte, linePredicate, hsdEquipmentPredicate, params } = buildFilters(q);

  const dprBucketExpr = bucketExpr(granularity, 'rr.dprDate');
  const hsdBucketExpr = bucketExpr(granularity, 'h.hsdDate');

  const dprRows = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT ${dprBucketExpr} AS bucket,
           COUNT(DISTINCT rr.id) AS dprCount,
           COALESCE(SUM(CASE WHEN 1=1 ${linePredicate} THEN li.totalHours END), 0) AS totalHours,
           COALESCE(SUM(CASE WHEN 1=1 ${linePredicate} THEN li.drillingTotal END), 0)
             + COALESCE(SUM(CASE WHEN 1=1 ${linePredicate} THEN li.casingTotal END), 0) AS totalProgress,
           COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R3' ${linePredicate} THEN li.totalHours END), 0) AS downtimeHours
    FROM filtered_reports rr
    LEFT JOIN dpr_line_items li ON li.reportId = rr.id
    GROUP BY bucket
    ORDER BY bucket
  `).all(params) as { bucket: string; dprCount: number; totalHours: number; totalProgress: number; downtimeHours: number }[];

  const dieselRows = db.prepare(`
    WITH filtered_hsd AS (${hsdCte})
    SELECT ${hsdBucketExpr} AS bucket, COALESCE(SUM(e.consumedHsd), 0) AS totalDiesel
    FROM filtered_hsd h
    LEFT JOIN hsd_equipment_lines e ON e.reportId = h.id ${hsdEquipmentPredicate}
    GROUP BY bucket
    ORDER BY bucket
  `).all(params) as { bucket: string; totalDiesel: number }[];

  const dieselByBucket = new Map(dieselRows.map((r) => [r.bucket, r.totalDiesel]));
  const buckets = new Set([...dprRows.map((r) => r.bucket), ...dieselRows.map((r) => r.bucket)]);
  const dprByBucket = new Map(dprRows.map((r) => [r.bucket, r]));

  return [...buckets].sort().map((bucket) => {
    const dpr = dprByBucket.get(bucket);
    return {
      bucket,
      dprCount: dpr?.dprCount ?? 0,
      totalHours: round2(dpr?.totalHours ?? 0),
      totalProgress: round2(dpr?.totalProgress ?? 0),
      downtimeHours: round2(dpr?.downtimeHours ?? 0),
      totalDiesel: round2(dieselByBucket.get(bucket) ?? 0),
    };
  });
}

function bucketExpr(granularity: 'day' | 'week' | 'month', column: string): string {
  if (granularity === 'week') return `strftime('%Y-W%W', ${column})`;
  if (granularity === 'month') return `strftime('%Y-%m', ${column})`;
  return column;
}

/* ---------------------------- equipment-wise performance ---------------------------- */

export interface DprEquipmentPerformanceRow {
  equipmentName: string; activityCount: number; totalHours: number;
  downtimeHours: number; utilizationPct: number;
}

export function getEquipmentPerformance(rawQuery: Record<string, unknown>): DprEquipmentPerformanceRow[] {
  const q = normaliseDashboardQuery(rawQuery);
  const { reportsCte, linePredicate, params } = buildFilters(q);

  const rows = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT
      trim(li.breakdownEquipment) AS equipmentName,
      COUNT(*) AS activityCount,
      COALESCE(SUM(li.totalHours), 0) AS totalHours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R3' THEN li.totalHours END), 0) AS downtimeHours
    FROM filtered_reports rr
    JOIN dpr_line_items li ON li.reportId = rr.id
    WHERE li.breakdownEquipment IS NOT NULL AND trim(li.breakdownEquipment) <> '' ${linePredicate}
    GROUP BY lower(trim(li.breakdownEquipment))
    ORDER BY totalHours DESC
    LIMIT 50
  `).all(params) as { equipmentName: string; activityCount: number; totalHours: number; downtimeHours: number }[];

  return rows.map((r) => ({
    ...r,
    totalHours: round2(r.totalHours), downtimeHours: round2(r.downtimeHours),
    utilizationPct: round2(r.totalHours > 0 ? (100 * (r.totalHours - r.downtimeHours)) / r.totalHours : 0),
  }));
}

/* ---------------------------- downtime analysis ---------------------------- */

export interface DprDowntimeAnalysis {
  byRig: { rigNumber: string; downtimeHours: number }[];
  byOperationCode: { operationCode: string; hours: number; occurrences: number }[];
}

export function getDowntimeAnalysis(rawQuery: Record<string, unknown>): DprDowntimeAnalysis {
  const q = normaliseDashboardQuery(rawQuery);
  const { reportsCte, linePredicate, params } = buildFilters(q);

  const byRig = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT r.rigNumber, COALESCE(SUM(li.totalHours), 0) AS downtimeHours
    FROM filtered_reports rr
    JOIN dpr_rigs r ON r.id = rr.rigId
    JOIN dpr_line_items li ON li.reportId = rr.id
    WHERE upper(trim(li.workType)) = 'R3' ${linePredicate}
    GROUP BY r.id
    ORDER BY downtimeHours DESC
  `).all(params) as { rigNumber: string; downtimeHours: number }[];

  const byOperationCode = db.prepare(`
    WITH filtered_reports AS (${reportsCte})
    SELECT COALESCE(li.operationCode, '(unspecified)') AS operationCode,
           COALESCE(SUM(li.totalHours), 0) AS hours, COUNT(*) AS occurrences
    FROM filtered_reports rr
    JOIN dpr_line_items li ON li.reportId = rr.id
    WHERE upper(trim(li.workType)) = 'R3' ${linePredicate}
    GROUP BY li.operationCode
    ORDER BY hours DESC
  `).all(params) as { operationCode: string; hours: number; occurrences: number }[];

  return {
    byRig: byRig.map((r) => ({ ...r, downtimeHours: round2(r.downtimeHours) })),
    byOperationCode: byOperationCode.map((r) => ({ ...r, hours: round2(r.hours) })),
  };
}

/* ---------------------------- equipment filter options ---------------------------- */

export interface DprEquipmentOption { id: string; name: string }

/**
 * Populates the dashboard's Equipment filter for a chosen rig. Prefers the
 * live PMS Equipment Master bridge (equipmentForDprRig, same as DprEntry's
 * dropdown); falls back to the distinct free-text names already recorded on
 * this rig's own DPR/HSD rows when there's no PMS-linked rig or it has no
 * active equipment, so the filter is never empty just because the two rig
 * masters have drifted apart.
 */
export function getEquipmentOptions(rigId: string): { equipment: DprEquipmentOption[]; linked: boolean } {
  const rig = db.prepare<[string], { rigNumber: string }>('SELECT rigNumber FROM dpr_rigs WHERE id = ?').get(rigId);
  if (!rig) return { equipment: [], linked: false };

  const live = equipmentForDprRig(rig.rigNumber);
  if (live.equipment.length > 0) return live;

  const names = db.prepare(`
    SELECT DISTINCT trim(breakdownEquipment) AS name FROM dpr_line_items li
      JOIN dpr_reports r ON r.id = li.reportId
      WHERE r.rigId = @rigId AND li.breakdownEquipment IS NOT NULL AND trim(li.breakdownEquipment) <> ''
    UNION
    SELECT DISTINCT trim(equipment) AS name FROM hsd_equipment_lines e
      JOIN hsd_reports h ON h.id = e.reportId
      WHERE h.rigId = @rigId AND e.equipment IS NOT NULL AND trim(e.equipment) <> ''
    ORDER BY name
  `).all({ rigId }) as { name: string }[];

  return {
    equipment: names.map((n, i) => ({ id: `name:${i}`, name: n.name })),
    linked: live.linked,
  };
}

/* ---------------------------- export: excel ---------------------------- */

export async function buildDashboardExportWorkbook(rawQuery: Record<string, unknown>): Promise<Buffer> {
  const kpis = getDashboardKpis(rawQuery);
  const rigWise = getRigComparison(rawQuery);

  const wb = new ExcelJS.Workbook();

  const kpiSheet = wb.addWorksheet('KPIs');
  kpiSheet.columns = [{ header: 'Metric', key: 'metric', width: 28 }, { header: 'Value', key: 'value', width: 18 }];
  kpiSheet.getRow(1).font = { bold: true };
  kpiSheet.addRows([
    { metric: 'Total DPR', value: kpis.totalDpr },
    { metric: 'Total Progress (m)', value: kpis.totalProgress },
    { metric: 'Total Rig Hours', value: kpis.totalRigHours },
    { metric: 'Total Diesel (L)', value: kpis.totalDiesel },
    { metric: 'Average Diesel/Day (L)', value: kpis.avgDieselPerDay },
    { metric: 'Diesel per Rig Hour (L)', value: kpis.dieselPerRigHour },
    { metric: 'Downtime (hrs)', value: kpis.downtimeHours },
    { metric: 'Equipment Utilization (%)', value: kpis.equipmentUtilizationPct },
    { metric: 'R1 Hours', value: kpis.r1Hours },
    { metric: 'R2 Hours', value: kpis.r2Hours },
    { metric: 'R3 Hours', value: kpis.r3Hours },
    { metric: 'ILM Hours', value: kpis.ilmHours },
  ]);

  const rigSheet = wb.addWorksheet('Rig Comparison');
  rigSheet.columns = [
    { header: 'Rig Number', key: 'rigNumber', width: 16 },
    { header: 'Rig Name', key: 'rigName', width: 20 },
    { header: 'Last DPR', key: 'lastReportDate', width: 14 },
    { header: 'Reports', key: 'reportCount', width: 10 },
    { header: 'Progress (m)', key: 'totalProgress', width: 14 },
    { header: 'Hours', key: 'totalHours', width: 12 },
    { header: 'Diesel (L)', key: 'totalDiesel', width: 12 },
    { header: 'Efficiency (%)', key: 'efficiencyPct', width: 14 },
    { header: 'Utilization (%)', key: 'utilizationPct', width: 14 },
    { header: 'Downtime (hrs)', key: 'downtimeHours', width: 14 },
    { header: 'Status', key: 'dprStatus', width: 12 },
  ];
  rigSheet.getRow(1).font = { bold: true };
  rigSheet.addRows(rigWise);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ---------------------------- export: pdf ---------------------------- */

export function buildDashboardExportPdf(rawQuery: Record<string, unknown>): Promise<Buffer> {
  const kpis = getDashboardKpis(rawQuery);
  const rigWise = getRigComparison(rawQuery);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('DPR Dashboard Export', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#666').text(`Generated ${new Date().toISOString()}`);
    doc.moveDown(1);

    doc.fillColor('#000').fontSize(12).text('KPI Summary', { underline: true });
    doc.moveDown(0.3);
    const kpiPairs: [string, string | number][] = [
      ['Total DPR', kpis.totalDpr], ['Total Progress (m)', kpis.totalProgress],
      ['Total Rig Hours', kpis.totalRigHours], ['Total Diesel (L)', kpis.totalDiesel],
      ['Average Diesel/Day (L)', kpis.avgDieselPerDay], ['Diesel per Rig Hour (L)', kpis.dieselPerRigHour],
      ['Downtime (hrs)', kpis.downtimeHours], ['Equipment Utilization (%)', kpis.equipmentUtilizationPct],
    ];
    doc.fontSize(9);
    for (const [label, value] of kpiPairs) {
      doc.text(`${label}: ${value}`);
    }

    doc.moveDown(1);
    doc.fontSize(12).text('Rig Comparison', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(8);
    const colWidths = [60, 70, 60, 50, 60, 50, 55, 60, 60, 60, 55];
    const headers = ['Rig No.', 'Name', 'Last DPR', 'Reports', 'Progress', 'Hours', 'Diesel', 'Efficiency %', 'Utilization %', 'Downtime', 'Status'];
    let y = doc.y;
    const startX = doc.x;
    headers.forEach((h, i) => {
      const x = startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
      doc.text(h, x, y, { width: colWidths[i], continued: false });
    });
    doc.moveDown(0.5);
    for (const r of rigWise) {
      y = doc.y;
      if (y > 520) { doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' }); y = doc.y; }
      const cells = [
        r.rigNumber, r.rigName, r.lastReportDate ?? '-', String(r.reportCount),
        String(r.totalProgress), String(r.totalHours), String(r.totalDiesel),
        String(r.efficiencyPct), String(r.utilizationPct), String(r.downtimeHours), r.dprStatus,
      ];
      cells.forEach((c, i) => {
        const x = startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
        doc.text(c, x, y, { width: colWidths[i] });
      });
      doc.moveDown(0.4);
    }

    doc.end();
  });
}

function round2(n: number | null | undefined): number {
  return Math.round((n ?? 0) * 100) / 100;
}
