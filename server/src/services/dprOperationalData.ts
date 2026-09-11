import ExcelJS from 'exceljs';
import { db } from '../db/index.js';

/**
 * The "Operational DPR" report: every dpr_line_items row (not aggregated by
 * rig, unlike dprDashboard.ts's rig-wise comparison), flattened with its
 * report date and rig context — one row per real activity entry. Rig Type
 * is bridged from PMS's rigs.rigType by rigKey match, the same bridge
 * equipmentForDprRig() already uses for Equipment Master.
 */

export interface OperationalDataQuery {
  rigId?: string;
  rigType?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

function pickStr(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

function normaliseQuery(query: Record<string, unknown>): OperationalDataQuery {
  return {
    rigId: pickStr(query, 'rigId'),
    rigType: pickStr(query, 'rigType'),
    dateFrom: pickStr(query, 'dateFrom'),
    dateTo: pickStr(query, 'dateTo'),
    search: pickStr(query, 'search'),
  };
}

function buildWhere(q: OperationalDataQuery): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.rigId) { clauses.push('rr.rigId = @rigId'); params.rigId = q.rigId; }
  if (q.rigType) { clauses.push('r.rigKey IN (SELECT rigKey FROM rigs WHERE rigType = @rigType)'); params.rigType = q.rigType; }
  if (q.dateFrom) { clauses.push('rr.dprDate >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { clauses.push('rr.dprDate <= @dateTo'); params.dateTo = q.dateTo; }
  if (q.search) {
    const needle = `%${q.search.toLowerCase()}%`;
    params.needle = needle;
    clauses.push(`(
      lower(r.rigNumber) LIKE @needle OR lower(li.wellName) LIKE @needle OR
      lower(li.operationCode) LIKE @needle OR lower(li.description) LIKE @needle
    )`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export interface OperationalLineRow {
  id: string; lineNo: number; dprDate: string; rigNumber: string; rigName: string;
  wellName: string | null; operationCode: string | null; workType: string | null;
  startTime: string | null; endTime: string | null; totalHours: number | null;
  breakdownEquipment: string | null; breakdownReason: string | null;
  drillingSection: string | null; drillingFrom: number | null; drillingTo: number | null; drillingTotal: number | null;
  casingSection: string | null; casingFrom: number | null; casingTo: number | null; casingTotal: number | null;
}

const SELECT_SQL = `
  SELECT li.id, li.lineNo, rr.dprDate, r.rigNumber, r.name AS rigName,
         li.wellName, li.operationCode, li.workType, li.startTime, li.endTime, li.totalHours,
         li.breakdownEquipment, li.breakdownReason,
         li.drillingSection, li.drillingFrom, li.drillingTo, li.drillingTotal,
         li.casingSection, li.casingFrom, li.casingTo, li.casingTotal
  FROM dpr_line_items li
  JOIN dpr_reports rr ON rr.id = li.reportId
  JOIN dpr_rigs r ON r.id = rr.rigId
`;

export function getOperationalLineItems(rawQuery: Record<string, unknown>): {
  rows: OperationalLineRow[];
  kpis: { r0Hours: number; r1Hours: number; r2Hours: number; r22Hours: number; r3Hours: number; ilmHours: number };
} {
  const q = normaliseQuery(rawQuery);
  const { where, params } = buildWhere(q);

  const rows = db.prepare(`
    ${SELECT_SQL} ${where}
    ORDER BY rr.dprDate DESC, li.lineNo ASC
    LIMIT 2000
  `).all(params) as OperationalLineRow[];

  const kpis = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R0' THEN li.totalHours END), 0) AS r0Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R1' THEN li.totalHours END), 0) AS r1Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R2' THEN li.totalHours END), 0) AS r2Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R2/2' THEN li.totalHours END), 0) AS r22Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R3' THEN li.totalHours END), 0) AS r3Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'ILM' THEN li.totalHours END), 0) AS ilmHours
    FROM dpr_line_items li
    JOIN dpr_reports rr ON rr.id = li.reportId
    JOIN dpr_rigs r ON r.id = rr.rigId
    ${where}
  `).get(params) as { r0Hours: number; r1Hours: number; r2Hours: number; r22Hours: number; r3Hours: number; ilmHours: number };

  return { rows, kpis };
}

export interface RigHsdComparisonRow {
  rigId: string;
  rigNumber: string;
  rigName: string;
  totalConsumption: number;
}

/**
 * Rig-wise HSD consumption for the comparison chart on the DPR Dashboard —
 * real hsd_equipment_lines.consumedHsd totals per rig, over the same
 * rigType/rigId/date-range filters as the rest of this page. Labelled with
 * each rig's actual name/number from the DPR Rig Master, never a hardcoded
 * "R1"/"R2"/"R3" placeholder.
 */
export function getRigHsdComparison(rawQuery: Record<string, unknown>): RigHsdComparisonRow[] {
  const q = normaliseQuery(rawQuery);
  const rigWhere: string[] = ["r.status = 'Active'"];
  const dateWhere: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.rigId) { rigWhere.push('r.id = @rigId'); params.rigId = q.rigId; }
  if (q.rigType) { rigWhere.push('r.rigKey IN (SELECT rigKey FROM rigs WHERE rigType = @rigType)'); params.rigType = q.rigType; }
  if (q.dateFrom) { dateWhere.push('h.hsdDate >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { dateWhere.push('h.hsdDate <= @dateTo'); params.dateTo = q.dateTo; }

  // The date range filters which hsd_reports join in (LEFT JOIN's ON clause,
  // not WHERE) so a rig with no data in range still lists at 0 rather than
  // disappearing from the comparison entirely.
  const rows = db.prepare(`
    SELECT r.id AS rigId, r.rigNumber, r.name AS rigName,
           COALESCE(SUM(e.consumedHsd), 0) AS totalConsumption
    FROM dpr_rigs r
    LEFT JOIN hsd_reports h ON h.rigId = r.id ${dateWhere.length ? `AND ${dateWhere.join(' AND ')}` : ''}
    LEFT JOIN hsd_equipment_lines e ON e.reportId = h.id
    WHERE ${rigWhere.join(' AND ')}
    GROUP BY r.id
    ORDER BY r.rigNumber
  `).all(params) as RigHsdComparisonRow[];

  return rows.map((r) => ({ ...r, totalConsumption: Math.round(r.totalConsumption * 100) / 100 }));
}

/** Real PMS rig types only (bridged from rigs.rigType) — never a fabricated static list. */
export function getRigTypes(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT rigType FROM rigs WHERE rigType IS NOT NULL AND trim(rigType) <> '' ORDER BY rigType",
  ).all() as { rigType: string }[];
  return rows.map((r) => r.rigType);
}

export async function buildOperationalDataExportWorkbook(rawQuery: Record<string, unknown>): Promise<Buffer> {
  const { rows } = getOperationalLineItems(rawQuery);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Operational Data');
  ws.columns = [
    { header: 'Date', key: 'dprDate', width: 12 },
    { header: 'Rig No.', key: 'rigNumber', width: 14 },
    { header: 'Well Name', key: 'wellName', width: 14 },
    { header: 'Work Type', key: 'workType', width: 10 },
    { header: 'Operation Code', key: 'operationCode', width: 18 },
    { header: 'Start', key: 'startTime', width: 8 },
    { header: 'End', key: 'endTime', width: 8 },
    { header: 'Total Time (h)', key: 'totalHours', width: 12 },
    { header: 'Breakdown Equipment', key: 'breakdownEquipment', width: 18 },
    { header: 'Breakdown Reason', key: 'breakdownReason', width: 18 },
    { header: 'Drill Section', key: 'drillingSection', width: 12 },
    { header: 'Drill From (m)', key: 'drillingFrom', width: 12 },
    { header: 'Drill To (m)', key: 'drillingTo', width: 12 },
    { header: 'Drill Total (m)', key: 'drillingTotal', width: 12 },
    { header: 'Casing Section', key: 'casingSection', width: 12 },
    { header: 'Casing From (m)', key: 'casingFrom', width: 12 },
    { header: 'Casing To (m)', key: 'casingTo', width: 12 },
    { header: 'Casing Total (m)', key: 'casingTotal', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
