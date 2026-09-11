import { config } from '../config.js';

/**
 * All date arithmetic runs in the configured timezone (default Asia/Kolkata),
 * never in server-local time (spec 9.6). Dates are stored as ISO YYYY-MM-DD.
 */

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in the configured timezone, as YYYY-MM-DD. */
export function today(): string {
  return fmt.format(new Date());
}

export function yesterday(): string {
  return addDays(today(), -1);
}

/** Current wall-clock instant as an ISO timestamp (UTC), for audit rows. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Date-only arithmetic that never touches local time. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function daysInMonth(logMonth: string): number {
  const [y, m] = logMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Combines a YYYY-MM log month with a sheet day number (spec 8.5). */
export function dateFromMonthDay(logMonth: string, day: number): string | null {
  if (!/^\d{4}-\d{2}$/.test(logMonth)) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (day > daysInMonth(logMonth)) return null;
  return `${logMonth}-${String(day).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(logMonth: string): string {
  const [y, m] = logMonth.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]}_${y}`;
}

/**
 * Parses whatever the crew (or Excel) put in the date cell. Handles real Date
 * objects, Excel serial numbers, and the dd-mm-yyyy / dd/mm/yy text the rigs use.
 * Day-first is assumed because that is the convention in the field workbooks.
 */
export function parseCellDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return fromExcelSerial(v);
  const s = String(v).trim();
  if (s === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return `${year}-${pad(+m[2])}-${pad(+m[1])}`;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 1000 && n < 100000) return fromExcelSerial(n);
  return null;
}

function fromExcelSerial(serial: number): string | null {
  // Excel's 1900 date system, including its deliberate 1900 leap-year bug.
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Display helper used by generated Excel exports: 01-08-2026. */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}
