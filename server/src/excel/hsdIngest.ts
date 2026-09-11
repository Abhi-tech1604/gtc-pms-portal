import * as XLSX from 'xlsx';
import { rigKey as toRigKey } from './normalize.js';
import { parseCellDate } from '../util/date.js';
import { cleanText, presentNumber } from '../util/num.js';
import type { DprIssue } from './dprIngest.js';

/**
 * Reads the HSD (diesel consumption) workbook: one rig, one month, day-sheets
 * named "1".."31" — the same 31-sheet-per-month convention dprIngest.ts and
 * the Mechanical Log importer already expect. The workbook also carries four
 * summary sheets ("HSD Consumption Master Seet", "Oil Tracking Sheet", "HSD
 * TOP UP Sheet", "Hydraulic Oil Level Sheet"); those are pure cross-sheet
 * rollups of the day sheets in the customer's own file, so they are left
 * untouched here and never used as an input.
 *
 * Every derived column is recomputed from its inputs rather than read back
 * from the sheet's formula result, exactly as dprIngest.ts does — a workbook
 * edited in a viewer that does not evaluate formulas would otherwise import
 * stale or empty totals.
 */

export interface ParsedHsdEquipmentLine {
  lineNo: number;
  equipment: string | null;
  /** Traceability-only link into the central Equipment Master; DRR sets this from the equipment the line was built for, Excel-imported lines always leave this null. `equipment` stays the authoritative historical label either way. */
  equipmentId?: string | null;
  openingStock: number | null;
  topUp: number | null;
  totalHsd: number | null;
  consumedHsd: number | null;
  consumedHours: number | null;
  openingRunningHours: number | null;
  closingHours: number | null;
  closingStock: number | null;
  average: number | null;
  remark: string | null;
}

export interface ParsedHsdSiteLine {
  lineNo: number;
  label: string | null;
  openingBalance: number | null;
  received: number | null;
  totalBalance: number | null;
  topUp: number | null;
  totalConsumption: number | null;
  closingBalance: number | null;
  remark: string | null;
}

export interface ParsedHsdDay {
  day: number;
  date: string;
  wellName: string | null;
  r1Hours: number | null;
  r2Hours: number | null;
  r3Hours: number | null;
  ilmHours: number | null;
  totalHours: number | null;
  equipment: ParsedHsdEquipmentLine[];
  site: ParsedHsdSiteLine[];
}

export interface ParsedHsdWorkbook {
  rigTextInFile: string | null;
  rigKeyInFile: string;
  logMonth: string | null; // YYYY-MM, inferred from the used day-sheets
  days: ParsedHsdDay[];
  issues: DprIssue[];
}

/* Cell map of one day sheet, taken from the customer's own workbook. */
const RIG_ROW = 2, RIG_COL = 1;          // B2  rig name
const DATE_ROW = 2, DATE_COL = 7;        // H2  date
const WELL_ROW = 3, WELL_COL = 1;        // B3  well no
const HOURS_ROW = 4;                     // C4:F4  R1 R2 R3 ILM
const EQUIP_FIRST_ROW = 6, EQUIP_LAST_ROW = 26;
const SITE_FIRST_ROW = 30, SITE_LAST_ROW = 31;
const LAST_SHEET_DAY = 31;

export function parseHsdWorkbook(buffer: Buffer): ParsedHsdWorkbook {
  let wb: XLSX.WorkBook;
  try {
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
        message: `Invalid HSD template: day ${day} sheet is missing.`,
      })),
    };
  }

  // Structural check on sheet "1" — is this really an HSD workbook and not
  // some other 31-sheet file (a DPR template, say) renamed.
  const firstGrid = sheetGrid(wb, '1');
  const title = cleanText(firstGrid[0]?.[0]) ?? '';
  const equipHeader = cleanText(firstGrid[EQUIP_FIRST_ROW - 2]?.[0]) ?? '';
  const stockHeader = cleanText(firstGrid[EQUIP_FIRST_ROW - 2]?.[1]) ?? '';
  const looksLikeHsd = /short dpr|hsd/i.test(title)
    && /equipment/i.test(equipHeader) && /opening stock/i.test(stockHeader);
  if (!looksLikeHsd) {
    return {
      rigTextInFile: null, rigKeyInFile: '', logMonth: null, days: [],
      issues: [{
        level: 'fatal',
        message: 'This does not appear to be a valid HSD template. Download a fresh HSD template for the rig and re-enter the data.',
      }],
    };
  }

  let rigTextInFile: string | null = null;
  let logMonth: string | null = null;
  const days: ParsedHsdDay[] = [];

  for (let day = 1; day <= LAST_SHEET_DAY; day++) {
    const grid = day === 1 ? firstGrid : sheetGrid(wb, String(day));
    const rigText = cleanText(cell(grid, RIG_ROW, RIG_COL));
    const dateIso = parseCellDate(cell(grid, DATE_ROW, DATE_COL));

    // The whole workbook is one rig — every sheet must agree.
    if (rigText) {
      if (rigTextInFile === null) rigTextInFile = rigText;
      else if (toRigKey(rigText) !== toRigKey(rigTextInFile)) {
        issues.push({
          level: 'fatal', day,
          message: `Invalid HSD sheet structure: day ${day} names a different rig than the rest of the workbook.`,
        });
      }
    }

    const equipment = readEquipmentLines(grid, day, issues);
    const site = readSiteLines(grid, day, equipment, issues);
    const isUsed = equipment.length > 0 || site.length > 0;
    if (!isUsed) continue; // a day past the month's length, left blank — not an error

    if (!dateIso) {
      issues.push({ level: 'fatal', day, message: `Day ${day}: Date is missing or could not be read.` });
      continue;
    }

    if (Number(dateIso.slice(8, 10)) !== day) {
      issues.push({ level: 'fatal', day, message: `Day ${day}: the date on this sheet is not day ${day} of its month.` });
      continue;
    }
    const sheetMonth = dateIso.slice(0, 7);
    if (logMonth === null) logMonth = sheetMonth;
    else if (sheetMonth !== logMonth) {
      issues.push({ level: 'fatal', day, message: `Day ${day}: the date belongs to a different month than the rest of the workbook.` });
      continue;
    }

    const r1Hours = numericOrIssue(cell(grid, HOURS_ROW, 2), day, HOURS_ROW, 'R1 hours', issues);
    const r2Hours = numericOrIssue(cell(grid, HOURS_ROW, 3), day, HOURS_ROW, 'R2 hours', issues);
    const r3Hours = numericOrIssue(cell(grid, HOURS_ROW, 4), day, HOURS_ROW, 'R3 hours', issues);
    const ilmHours = numericOrIssue(cell(grid, HOURS_ROW, 5), day, HOURS_ROW, 'ILM hours', issues);

    days.push({
      day,
      date: dateIso,
      wellName: cleanText(cell(grid, WELL_ROW, WELL_COL)),
      r1Hours, r2Hours, r3Hours, ilmHours,
      totalHours: sum([r1Hours, r2Hours, r3Hours, ilmHours]),
      equipment, site,
    });
  }

  if (!rigTextInFile) issues.push({ level: 'fatal', message: 'Rig Name is missing.' });
  if (days.length === 0 && issues.every((i) => i.level !== 'fatal')) {
    issues.push({ level: 'fatal', message: 'No HSD data was found in this workbook. Fill in at least one day before uploading.' });
  }

  return { rigTextInFile, rigKeyInFile: toRigKey(rigTextInFile), logMonth, days, issues };
}

function sheetGrid(wb: XLSX.WorkBook, sheetName: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
}

/** 1-based spreadsheet row, 0-based column — the mix the cell map above uses. */
function cell(grid: unknown[][], row: number, col: number): unknown {
  return (grid[row - 1] ?? [])[col];
}

function readEquipmentLines(grid: unknown[][], day: number, issues: DprIssue[]): ParsedHsdEquipmentLine[] {
  const lines: ParsedHsdEquipmentLine[] = [];
  for (let r = EQUIP_FIRST_ROW; r <= EQUIP_LAST_ROW; r++) {
    const row = grid[r - 1] ?? [];
    const equipment = cleanText(row[0]);
    const openingStock = row[1];
    const topUp = row[2];
    const consumedHsd = row[4];
    const consumedHours = row[5];
    const openingRunningHours = row[6];
    const remark = cleanText(row[10]);

    // The equipment names are pre-printed on the template for every rig,
    // whether or not that unit ran, so a name on its own is not data — only a
    // non-zero figure (or a remark) marks the row as actually filled in.
    // Keying off the name instead would make every blank day look used.
    const figures = [openingStock, topUp, consumedHsd, consumedHours, openingRunningHours];
    const hasFigure = figures.some((v) => isPresentValue(v) && presentNumber(v) !== 0);
    if (!hasFigure && !remark) continue;
    if (!equipment) {
      issues.push({ level: 'fatal', day, row: r, message: 'Equipment name is required when the row has figures.' });
      continue;
    }

    const opening = numericOrIssue(openingStock, day, r, 'Opening Stock HSD', issues);
    const top = numericOrIssue(topUp, day, r, 'Top-up HSD', issues);
    const consumed = numericOrIssue(consumedHsd, day, r, 'Total Consu. HSD', issues);
    const hours = numericOrIssue(consumedHours, day, r, 'Total Consu. HRS', issues);
    const openingHours = numericOrIssue(openingRunningHours, day, r, 'Opening Running HRS', issues);

    const totalHsd = add(opening, top);
    if (totalHsd !== null && consumed !== null && consumed > totalHsd) {
      issues.push({
        level: 'fatal', day, row: r,
        message: `${equipment}: consumed HSD (${consumed}) is more than the total available (${totalHsd}).`,
      });
    }

    lines.push({
      lineNo: lines.length + 1,
      equipment,
      openingStock: opening,
      topUp: top,
      totalHsd,
      consumedHsd: consumed,
      consumedHours: hours,
      openingRunningHours: openingHours,
      closingHours: add(openingHours, hours),
      closingStock: subtract(totalHsd, consumed),
      average: divide(consumed, hours),
      remark,
    });
  }
  return lines;
}

/**
 * The two site rows are not symmetric in the customer's sheet, so they are not
 * read symmetrically here:
 *
 *   row 30 "Rig Site Diesel"   E30 = C27, F30 = E27, G30 = D30 - E30
 *   row 31 "Rig Site -D.Water" E31/F31 are typed,    G31 = D31 - F31
 *
 * So the diesel row's top-up and consumption are the equipment table's own
 * column totals (never typed, and blank in a workbook whose formulas were not
 * evaluated), while the water row's are plain inputs — and the two closing
 * balances subtract different columns.
 */
function readSiteLines(
  grid: unknown[][], day: number, equipment: ParsedHsdEquipmentLine[], issues: DprIssue[],
): ParsedHsdSiteLine[] {
  const lines: ParsedHsdSiteLine[] = [];
  for (let r = SITE_FIRST_ROW; r <= SITE_LAST_ROW; r++) {
    const row = grid[r - 1] ?? [];
    const label = cleanText(row[0]);
    if (!label) continue;

    const isDieselRow = r === SITE_FIRST_ROW;
    const openingBalance = numericOrIssue(row[1], day, r, `${label}: Opening bal`, issues);
    const received = numericOrIssue(row[2], day, r, `${label}: Received`, issues);
    const totalBalance = add(openingBalance, received);

    const topUp = isDieselRow
      ? sum(equipment.map((e) => e.topUp))
      : numericOrIssue(row[4], day, r, `${label}: TOP UP`, issues);
    const totalConsumption = isDieselRow
      ? sum(equipment.map((e) => e.consumedHsd))
      : numericOrIssue(row[5], day, r, `${label}: Total Consumption`, issues);

    const hasFigure = [openingBalance, received, topUp, totalConsumption]
      .some((v) => v !== null && v !== 0);
    if (!hasFigure) continue;

    if (totalBalance !== null && topUp !== null && topUp > totalBalance) {
      issues.push({
        level: 'fatal', day, row: r,
        message: `${label}: top-up (${topUp}) is more than the total balance available (${totalBalance}).`,
      });
    }

    lines.push({
      lineNo: lines.length + 1,
      label,
      openingBalance, received, totalBalance, topUp, totalConsumption,
      closingBalance: subtract(totalBalance, isDieselRow ? topUp : totalConsumption),
      remark: cleanText(row[7]),
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

function add(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return round2((a ?? 0) + (b ?? 0));
}

function subtract(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return round2((a ?? 0) - (b ?? 0));
}

/** Mirrors the sheet's own IFERROR(E/F,"") — a zero or missing divisor yields no average, not an error. */
function divide(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return round2(a / b);
}

function sum(values: (number | null)[]): number | null {
  if (values.every((v) => v === null)) return null;
  return round2(values.reduce((n: number, v) => n + (v ?? 0), 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
