import { db } from '../db/index.js';
import { yesterday } from '../util/date.js';

/**
 * Upload compliance answers exactly one question per rig: what date does this
 * rig have data for?
 *
 * The answer comes from the logDate carried by the ingested rows, never from
 * when a file happened to be uploaded, and never filtered on an upload status
 * value that mechanical log imports do not write. That conflation is defect D8.
 */

export interface RigCompliance {
  rigId: string;
  rigName: string;
  rigNumber: string;
  /** Most recent calendar date this rig has data for. */
  lastDataDate: string | null;
  /** Wall-clock time of the most recent upload, shown alongside but never used to judge. */
  lastUploadAt: string | null;
  status: 'Uploaded' | 'Pending' | 'Exempt';
  holidayDescription: string | null;
}

const SQL = `
  SELECT r.id AS rigId, r.name AS rigName, r.rigNumber AS rigNumber,
         (SELECT MAX(l.logDate) FROM mechanical_log_rows l WHERE l.rigId = r.id) AS lastDataDate,
         (SELECT MAX(u.uploadDate) FROM mechanical_log_uploads u WHERE u.rigId = r.id) AS lastUploadAt
  FROM rigs r
`;

export function complianceFor(targetDate: string = yesterday(), rigScope: string | string[] | null = null): RigCompliance[] {
  const ids = rigScope === null ? null : Array.isArray(rigScope) ? rigScope : [rigScope];
  let rows: Omit<RigCompliance, 'status' | 'holidayDescription'>[];
  if (ids === null) {
    rows = db.prepare(`${SQL} ORDER BY r.rigNumber`).all() as typeof rows;
  } else if (ids.length === 0) {
    rows = [];
  } else {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`${SQL} WHERE r.id IN (${placeholders}) ORDER BY r.rigNumber`).all(...ids) as typeof rows;
  }

  const holidays = db.prepare<[string], { rigId: string; description: string | null }>(
    'SELECT rigId, description FROM rig_holidays WHERE date = ?',
  ).all(targetDate);
  const holidayFor = new Map(holidays.map((h) => [h.rigId, h.description]));
  const fleetHoliday = holidayFor.has('all');

  return rows.map((row) => {
    const isHoliday = fleetHoliday || holidayFor.has(row.rigId);
    let status: RigCompliance['status'];
    if (row.lastDataDate && row.lastDataDate >= targetDate) status = 'Uploaded';
    else if (isHoliday) status = 'Exempt';
    else status = 'Pending';
    return {
      ...row,
      status,
      holidayDescription: isHoliday
        ? holidayFor.get(row.rigId) ?? holidayFor.get('all') ?? 'Non-reporting day'
        : null,
    };
  });
}
