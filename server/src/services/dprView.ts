import { db } from '../db/index.js';

/**
 * The single place a DPR report (and its activity lines) becomes the shape
 * the API returns — mirrors services/equipmentView.ts. Used identically
 * whether the report came from an Excel import or manual entry; nothing
 * downstream can tell the difference except the `source` field.
 */

export interface DprLineView {
  id: string;
  lineNo: number;
  wellName: string | null;
  operationCode: string | null;
  workType: string | null;
  startTime: string | null;
  endTime: string | null;
  totalHours: number | null;
  description: string | null;
  breakdownEquipment: string | null;
  breakdownReason: string | null;
  drillingSection: string | null;
  drillingFrom: number | null;
  drillingTo: number | null;
  drillingTotal: number | null;
  casingSection: string | null;
  casingFrom: number | null;
  casingTo: number | null;
  casingTotal: number | null;
}

export interface DprReportSummary {
  id: string;
  rigId: string;
  rigNumber: string;
  rigName: string;
  dprDate: string;
  source: string;
  importBatchId: string | null;
  /** Original name of the Excel file this DPR was imported from; null for manual entries. */
  fileName: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  totalHours: number;
  lineCount: number;
}

export interface DprReportView extends DprReportSummary {
  lines: DprLineView[];
}

interface ReportRow {
  id: string; rigId: string; rigNumber: string; rigName: string; dprDate: string;
  source: string; importBatchId: string | null; fileName: string | null;
  createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string;
}

const SELECT_REPORT = `
  SELECT rr.*, r.rigNumber, r.name AS rigName, b.fileName AS fileName
  FROM dpr_reports rr
  JOIN dpr_rigs r ON r.id = rr.rigId
  LEFT JOIN dpr_import_batches b ON b.id = rr.importBatchId
`;

const selectLines = db.prepare<[string], DprLineView>(
  'SELECT * FROM dpr_line_items WHERE reportId = ? ORDER BY lineNo',
);

export function getDprReport(id: string): DprReportView | null {
  const row = db.prepare<[string], ReportRow>(`${SELECT_REPORT} WHERE rr.id = ?`).get(id);
  if (!row) return null;
  const lines = selectLines.all(id);
  return { ...row, lines, ...totals(lines) };
}

export interface DprReportFilters {
  rigId?: string;
  dateFrom?: string;
  dateTo?: string;
  well?: string;
  search?: string;
}

export function listDprReports(filters: DprReportFilters): DprReportSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.rigId) { where.push('rr.rigId = ?'); params.push(filters.rigId); }
  if (filters.dateFrom) { where.push('rr.dprDate >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('rr.dprDate <= ?'); params.push(filters.dateTo); }
  if (filters.well) {
    where.push('EXISTS (SELECT 1 FROM dpr_line_items li WHERE li.reportId = rr.id AND li.wellName = ?)');
    params.push(filters.well);
  }
  if (filters.search) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    where.push(`(
      r.rigNumber LIKE ? OR
      EXISTS (SELECT 1 FROM dpr_line_items li WHERE li.reportId = rr.id AND (
        lower(li.wellName) LIKE ? OR lower(li.operationCode) LIKE ? OR lower(li.description) LIKE ?
      ))
    )`);
    params.push(needle, needle, needle, needle);
  }

  const sql = `${SELECT_REPORT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rr.dprDate DESC, rr.createdAt DESC LIMIT 500`;
  const rows = db.prepare(sql).all(...params) as ReportRow[];

  return rows.map((row) => {
    const lines = selectLines.all(row.id);
    return { ...row, ...totals(lines) };
  });
}

function totals(lines: DprLineView[]): { totalHours: number; lineCount: number } {
  const totalHours = Math.round(lines.reduce((n, l) => n + (l.totalHours ?? 0), 0) * 100) / 100;
  return { totalHours, lineCount: lines.length };
}
