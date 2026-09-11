import { db } from '../db/index.js';

/**
 * "Today's Uploads" on the PMS Dashboard — every real submission event for a
 * given date, from BOTH sources this portal actually has: Excel workbook
 * uploads (mechanical_log_uploads) and DRR daily-entry submissions
 * (drr_reports). The dashboard KPI and the click-through detail list both
 * call these same two functions, so the count and the list can never drift
 * apart, and both stay correct automatically as new data is entered — there
 * is no separate cache or snapshot to go stale.
 */

export interface TodaysExcelUpload {
  id: string; fileName: string; rigId: string; rigNumber: string; rigName: string;
  logMonth: string; coverageEndDate: string | null; uploadDate: string; uploadedBy: string;
  recordsImported: number; storedFileName: string | null;
}

export interface TodaysDrrSubmission {
  id: string; rigId: string; rigNumber: string; rigName: string;
  reportDate: string; shift: string; status: string; submittedBy: string; updatedAt: string;
}

function scopeClause(scope: string[] | null, column: string): { clause: string; params: string[] } {
  if (scope === null) return { clause: '', params: [] };
  if (scope.length === 0) return { clause: 'AND 1 = 0', params: [] };
  return { clause: `AND ${column} IN (${scope.map(() => '?').join(',')})`, params: scope };
}

/** scope === [] (an account assigned to zero rigs) must return nothing, never everything — checked by the caller before this is even worth calling, but scopeClause() also fails safe on its own. */
export function getTodaysExcelUploads(scope: string[] | null, date: string): TodaysExcelUpload[] {
  const { clause, params } = scopeClause(scope, 'u.rigId');
  return db.prepare(`
    SELECT u.id, u.fileName, u.rigId, r.rigNumber AS rigNumber, r.name AS rigName, u.logMonth, u.coverageEndDate,
           u.uploadDate, u.uploadedBy, u.recordsImported, u.storedFileName
    FROM mechanical_log_uploads u
    JOIN rigs r ON r.id = u.rigId
    WHERE date(u.uploadDate) = date(?) ${clause}
    ORDER BY u.uploadDate DESC
  `).all(date, ...params) as TodaysExcelUpload[];
}

/**
 * A DRR "becomes Submitted" event — the direct-submit path and the
 * Approve-workflow path both call saveReport()/approve(), which always
 * stamps updatedAt to the moment of that save, so `status = 'Submitted' AND
 * date(updatedAt) = date` reliably captures "finalised today" for either
 * path without needing a second dedicated timestamp column.
 */
export function getTodaysDrrSubmissions(scope: string[] | null, date: string): TodaysDrrSubmission[] {
  const { clause, params } = scopeClause(scope, 'd.rigId');
  return db.prepare(`
    SELECT d.id, d.rigId, r.rigNumber AS rigNumber, r.name AS rigName, d.reportDate, d.shift, d.status,
           d.submittedBy, d.updatedAt
    FROM drr_reports d
    JOIN rigs r ON r.id = d.rigId
    WHERE d.status = 'Submitted' AND date(d.updatedAt) = date(?) ${clause}
    ORDER BY d.updatedAt DESC
  `).all(date, ...params) as TodaysDrrSubmission[];
}
