import * as XLSX from 'xlsx';
import { rigKey as toRigKey } from './normalize.js';
import { parseCellDate } from '../util/date.js';
import { cleanText, presentNumber } from '../util/num.js';

/**
 * Reads the DPR (Daily Progress Report) workbook: one rig, one month, up to
 * 31 day-sheets named "1".."31" — the same 31-sheet-per-month convention the
 * Mechanical Log module's importer already expects (excel/parseWorkbook.ts),
 * not a new pattern. There is no Lists sheet to check for; the old two-sheet
 * (List + DPR) shape is gone. Each present sheet keeps the original per-day
 * layout, validated exactly as the old single-sheet parser did, just once
 * per day-sheet instead of once per file.
 */

export interface DprIssue {
  level: 'fatal' | 'warning';
  day?: number;   // 1-based sheet/day number, when the issue is day-specific
  row?: number;   // 1-based spreadsheet row within that day's sheet
  message: string;
}

export interface ParsedDprLine {
  lineNo: number;
  wellName: string | null;
  operationCode: string | null;
  workType: string | null;
  startTime: string | null; // "HH:MM", 24h
  endTime: string | null;
  totalHours: number | null; // always recomputed here, never trusted from the sheet's own formula
  description: string | null;
  breakdownEquipment: string | null;
  /** Traceability-only link into the central Equipment Master; DRR sets this when the picked equipment came from Equipment Master, Excel-imported lines always leave this null (the workbook only ever names a machine, never its id). breakdownEquipment stays the authoritative historical label either way. */
  breakdownEquipmentId?: string | null;
  /** Manual entry only — not a column in the fixed-layout Excel template, so Excel-imported lines always leave this null. */
  breakdownReason: string | null;
  drillingSection: string | null;
  drillingFrom: number | null;
  drillingTo: number | null;
  drillingTotal: number | null;
  casingSection: string | null;
  casingFrom: number | null;
  casingTo: number | null;
  casingTotal: number | null;
  /** Manual entry only, meaningful when operationCode = '23 - Other' — not a column in the fixed-layout Excel template, so Excel-imported lines always leave this null. */
  otherActivityDescription?: string | null;
}

export interface ParsedDprDay {
  day: number;
  date: string;
  lines: ParsedDprLine[];
}

export interface ParsedDprWorkbook {
  rigTextInFile: string | null;
  rigKeyInFile: string;
  logMonth: string | null; // YYYY-MM, inferred from the used day-sheets
  days: ParsedDprDay[];
  issues: DprIssue[];
}

const FIRST_DATA_ROW = 4; // spreadsheet row (1-based); rows 4-19 are the sixteen activity slots
const LAST_DATA_ROW = 19;
const LAST_SHEET_DAY = 31;

export function parseDprWorkbook(buffer: Buffer): ParsedDprWorkbook {
  let wb: XLSX.WorkBook;
  try {
    // cellDates is deliberately off: a JS Date round-tripped through two
    // different libraries' Excel epoch handling (exceljs writes, xlsx reads)
    // drifts for the 1899-12-30 time-only anchor day the D/E columns use, so
    // times and the date cell are read as raw serials and converted by hand.
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (err) {
    throw new Error(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }

  const issues: DprIssue[] = [];
  const missing: number[] = [];
  for (let day = 1; day <= LAST_SHEET_DAY; day++) {
    if (!wb.SheetNames.includes(String(day))) missing.push(day);
  }
  if (missing.length > 0) {
    return {
      rigTextInFile: null, rigKeyInFile: '', logMonth: null, days: [],
      issues: missing.map((day) => ({
        level: 'fatal' as const, day,
        message: `Invalid DPR template: DPR ${day} sheet is missing.`,
      })),
    };
  }

  // Structural check on sheet "1" — is this really a DPR template, not some
  // unrelated file renamed to .xlsx.
  const firstGrid = sheetGrid(wb, '1');
  const title = cleanText(firstGrid[0]?.[0]);
  const looksLikeDpr = /daily progress report|\bdpr\b/i.test(title ?? '');
  const headerRow = cleanText(firstGrid[2]?.[0]);
  const looksLikeHeaderRow = /well/i.test(headerRow ?? '');
  if (!looksLikeDpr || !looksLikeHeaderRow) {
    return {
      rigTextInFile: null, rigKeyInFile: '', logMonth: null, days: [],
      issues: [{
        level: 'fatal',
        message: 'This does not appear to be a valid DPR template. Download a fresh template for the rig and re-enter the data.',
      }],
    };
  }

  let rigTextInFile: string | null = null;
  let logMonth: string | null = null;
  const days: ParsedDprDay[] = [];

  for (let day = 1; day <= LAST_SHEET_DAY; day++) {
    const grid = day === 1 ? firstGrid : sheetGrid(wb, String(day));
    const rigText = cleanText(grid[1]?.[1]); // B2
    const dateIso = parseCellDate(grid[1]?.[4]); // E2

    // Rig must be identical on every sheet — the whole workbook is one rig.
    if (rigText) {
      if (rigTextInFile === null) rigTextInFile = rigText;
      else if (toRigKey(rigText) !== toRigKey(rigTextInFile)) {
        issues.push({
          level: 'fatal', day,
          message: `Invalid DPR sheet structure: DPR ${day} names a different rig than the rest of the workbook.`,
        });
      }
    }

    const lines = readDayLines(grid, day, issues);
    const isUsed = !!dateIso || lines.length > 0;
    if (!isUsed) continue; // a day past the real month length, left blank — not an error

    if (!dateIso) {
      issues.push({ level: 'fatal', day, message: `DPR ${day}: Date is missing or could not be read.` });
    } else {
      const expectedDayOfMonth = Number(dateIso.slice(8, 10));
      if (expectedDayOfMonth !== day) {
        issues.push({ level: 'fatal', day, message: 'Date mismatch detected.' });
      } else {
        const sheetMonth = dateIso.slice(0, 7);
        if (logMonth === null) logMonth = sheetMonth;
        else if (sheetMonth !== logMonth) {
          issues.push({ level: 'fatal', day, message: 'Date mismatch detected.' });
        }
      }
    }

    // A dated day with no activity rows simply hasn't been reported yet — the
    // template pre-fills every real day's date whether or not the crew has
    // filled it in, so this can't be treated as an error (a partial-month,
    // mid-month upload is the normal case, not a corrupted file).
    if (lines.length === 0) continue;

    if (dateIso) days.push({ day, date: dateIso, lines });
  }

  if (!rigTextInFile) issues.push({ level: 'fatal', message: 'Rig No. is missing.' });
  if (days.length === 0 && issues.every((i) => i.level !== 'fatal')) {
    issues.push({ level: 'fatal', message: 'No DPR data was found in this workbook. Fill in at least one day before uploading.' });
  }

  return {
    rigTextInFile, rigKeyInFile: toRigKey(rigTextInFile), logMonth, days, issues,
  };
}

function sheetGrid(wb: XLSX.WorkBook, sheetName: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
}

function readDayLines(grid: unknown[][], day: number, issues: DprIssue[]): ParsedDprLine[] {
  const lines: ParsedDprLine[] = [];
  for (let r = FIRST_DATA_ROW; r <= LAST_DATA_ROW; r++) {
    const row = grid[r - 1] ?? [];
    const wellName = cleanText(row[0]);
    const operationCode = cleanText(row[1]);
    const workType = cleanText(row[2]);
    const startTime = extractTime(row[3]);
    const endTime = extractTime(row[4]);
    const description = cleanText(row[6]);
    const breakdownEquipment = cleanText(row[7]);
    const drillingSection = cleanText(row[8]);
    const drillingFromRaw = row[9];
    const drillingToRaw = row[10];
    const casingSection = cleanText(row[12]);
    const casingFromRaw = row[13];
    const casingToRaw = row[14];

    const blank = !wellName && !operationCode && !startTime && !endTime && !description
      && !isPresentValue(drillingFromRaw) && !isPresentValue(drillingToRaw)
      && !isPresentValue(casingFromRaw) && !isPresentValue(casingToRaw);
    if (blank) continue;

    if (!wellName) issues.push({ level: 'fatal', day, row: r, message: 'Well name is required.' });
    if (!operationCode) issues.push({ level: 'fatal', day, row: r, message: 'Operation/Task code is required.' });
    if (!startTime || !endTime) issues.push({ level: 'fatal', day, row: r, message: 'Start time and end time are required.' });

    const drillingFrom = numericOrIssue(drillingFromRaw, day, r, 'Drilling From (M)', issues);
    const drillingTo = numericOrIssue(drillingToRaw, day, r, 'Drilling To (M)', issues);
    const casingFrom = numericOrIssue(casingFromRaw, day, r, 'Casing From (M)', issues);
    const casingTo = numericOrIssue(casingToRaw, day, r, 'Casing To (M)', issues);

    lines.push({
      lineNo: lines.length + 1,
      wellName, operationCode, workType, startTime, endTime,
      totalHours: computeTotalHours(startTime, endTime),
      description, breakdownEquipment, breakdownReason: null,
      drillingSection, drillingFrom, drillingTo,
      drillingTotal: delta(drillingFrom, drillingTo),
      casingSection, casingFrom, casingTo,
      casingTotal: delta(casingFrom, casingTo),
    });
  }
  return lines;
}

function isPresentValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  return String(v).trim() !== '';
}

function numericOrIssue(raw: unknown, day: number, row: number, label: string, issues: DprIssue[]): number | null {
  if (!isPresentValue(raw)) return null;
  const n = presentNumber(raw);
  if (n === null) {
    issues.push({ level: 'fatal', day, row, message: `${label} has an invalid numeric value.` });
    return null;
  }
  return n;
}

function delta(from: number | null, to: number | null): number | null {
  return from !== null && to !== null ? round2(to - from) : null;
}

/** D/E hold a time-of-day; exceljs/xlsx read it as a Date on 1899-12-30, or as a day-fraction. */
function extractTime(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const frac = v - Math.floor(v);
    const totalMinutes = Math.round(frac * 1440);
    return `${pad(Math.floor(totalMinutes / 60) % 24)}:${pad(totalMinutes % 60)}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${pad(Number(m[1]))}:${m[2]}`;
  return null;
}

/** Same arithmetic as the sheet's own TOTAL TIME formula, including the overnight wrap. */
export function computeTotalHours(startTime: string | null, endTime: string | null): number | null {
  if (!startTime || !endTime) return null;
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  const diffMinutes = e >= s ? e - s : 1440 + e - s;
  return round2(diffMinutes / 60);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
