import * as XLSX from 'xlsx';
import { rigKey as toRigKey } from './normalize.js';
import { parseCellDate } from '../util/date.js';
import { cleanText, presentNumber } from '../util/num.js';
import { DRR_TEMPLATE_VERSION, SECTION_MARKERS } from './drrTemplate.js';

/**
 * Reads the admin-only DRR Excel Import workbook back into the exact shape
 * `saveReport()` (routes/dailyRigReport.ts) already accepts — this module
 * does no validation or DB work of its own, only extraction, so import and
 * the manual form share one business-logic path (see drrImport.ts).
 *
 * Sections are located by scanning column A for the marker text
 * drrTemplate.ts wrote, not by fixed row numbers — equipment/oil row counts
 * are dynamic per rig and can drift between a template's download and its
 * upload (a machine deactivated in between, say), so nothing here assumes a
 * row offset computed from today's master data.
 */

export interface DrrIssue {
  level: 'fatal' | 'warning';
  row?: number;
  message: string;
}

export interface ParsedDrrEquipmentLine {
  equipmentId: string; dayHours: number; nightHours: number; hsdConsumption: number;
  status: string | null; remarks: string | null;
  serviceDoneToday: boolean; serviceHours: number | null;
}
export interface ParsedDrrOilLine { oilLubricantId: string; oilAdded: number; oilConsumed: number; remark: string | null; }
export interface ParsedDrrHydraulicLine { tankName: string; topUp: number; loss: number; remark: string | null; }
export interface ParsedDrrActivityLine {
  wellName: string | null; operationCode: string | null; workType: string | null;
  startTime: string | null; endTime: string | null; description: string | null;
  breakdownEquipment: string | null; breakdownReason: string | null;
  drillingSection: string | null; drillingFrom: number | null; drillingTo: number | null;
  casingSection: string | null; casingFrom: number | null; casingTo: number | null;
}

export interface ParsedDrr {
  rigTextInFile: string | null;
  rigKeyInFile: string;
  reportDate: string | null;
  wellNo: string | null;
  shift: string | null;
  fieldLocation: string | null;
  submittedBy: string | null;
  hsdReceived: number | null;
  hsdRemarks: string | null;
  dprLines: ParsedDrrActivityLine[];
  equipmentLines: ParsedDrrEquipmentLine[];
  oilLines: ParsedDrrOilLine[];
  hydraulicLines: ParsedDrrHydraulicLine[];
  issues: DrrIssue[];
}

const emptyResult = (issues: DrrIssue[]): ParsedDrr => ({
  rigTextInFile: null, rigKeyInFile: '', reportDate: null, wellNo: null, shift: null,
  fieldLocation: null, submittedBy: null, hsdReceived: null, hsdRemarks: null,
  dprLines: [], equipmentLines: [], oilLines: [], hydraulicLines: [], issues,
});

export function parseDrrWorkbook(buffer: Buffer): ParsedDrr {
  let wb: XLSX.WorkBook;
  try {
    // cellDates off: exceljs (writer) and xlsx (reader) disagree on the
    // 1899-12-30 time-only anchor day, same reason dprIngest/ilmIngest avoid it.
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, bookVBA: false });
  } catch (err) {
    return emptyResult([{ level: 'fatal', message: `The file could not be read as an Excel workbook: ${(err as Error).message}` }]);
  }

  if (!wb.SheetNames.includes('DRR')) {
    return emptyResult([{ level: 'fatal', message: 'Missing required sheet: DRR. Download the latest DRR template and try again.' }]);
  }

  const metaSheet = wb.Sheets['DRR_Meta'];
  const version = metaSheet ? cleanText(XLSX.utils.sheet_to_json<unknown[]>(metaSheet, { header: 1, raw: true })[0]?.[1]) : null;
  if (version !== DRR_TEMPLATE_VERSION) {
    return emptyResult([{
      level: 'fatal',
      message: version
        ? `This file was created with DRR Template Version ${version}, but Version ${DRR_TEMPLATE_VERSION} is required. Download the latest template and re-enter the data.`
        : 'This does not appear to be a valid DRR template (missing version information). Download a fresh template and try again.',
    }]);
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['DRR'], { header: 1, raw: true, defval: null });
  const issues: DrrIssue[] = [];

  // ---- Fixed header block (rows 2-7, written by drrTemplate.ts's headerField calls) ----
  const rigTextInFile = cleanText(grid[1]?.[1]);   // row 2
  const reportDate = parseCellDate(grid[2]?.[1]);  // row 3
  const wellNo = cleanText(grid[3]?.[1]);           // row 4
  const shift = cleanText(grid[4]?.[1]);            // row 5
  const fieldLocation = cleanText(grid[5]?.[1]);    // row 6
  const submittedBy = cleanText(grid[6]?.[1]);      // row 7

  if (!rigTextInFile) issues.push({ level: 'fatal', row: 2, message: 'Rig No. is missing.' });
  if (!reportDate) issues.push({ level: 'fatal', row: 3, message: 'Date is missing or could not be read.' });
  if (!shift) issues.push({ level: 'fatal', row: 5, message: 'Shift is required.' });

  // ---- Locate every section marker by scanning column A ----
  const allMarkerTexts: string[] = Object.values(SECTION_MARKERS);
  const markerRows = new Map<string, number>();
  for (let i = 0; i < grid.length; i++) {
    const text = cleanText(grid[i]?.[0]);
    if (text && allMarkerTexts.includes(text)) markerRows.set(text, i + 1);
  }
  const missingMarkers = allMarkerTexts.filter((m) => !markerRows.has(m));
  if (missingMarkers.length > 0) {
    issues.push({ level: 'fatal', message: `This file is missing expected section(s): ${missingMarkers.join(', ')}. Download a fresh template.` });
    return { ...emptyResult(issues), rigTextInFile, rigKeyInFile: toRigKey(rigTextInFile), reportDate };
  }

  const sortedMarkers = [...markerRows.entries()].sort((a, b) => a[1] - b[1]);
  const nextMarkerAfter = (row: number): number => {
    const next = sortedMarkers.find(([, r]) => r > row);
    return next ? next[1] : grid.length + 1;
  };

  // ---- DPR Activity ----
  const dprLines: ParsedDrrActivityLine[] = [];
  const dprMarkerRow = markerRows.get(SECTION_MARKERS.dprActivity)!;
  const dprDataStart = dprMarkerRow + 2; // marker row, then header row, then data
  const dprDataEnd = nextMarkerAfter(dprMarkerRow) - 1;
  for (let r = dprDataStart; r <= dprDataEnd; r++) {
    const row = grid[r - 1] ?? [];
    const wellName = cleanText(row[0]);
    const operationCode = cleanText(row[1]);
    const workType = cleanText(row[2]);
    const startTime = extractTime(row[3]);
    const endTime = extractTime(row[4]);
    const description = cleanText(row[6]);
    const breakdownEquipment = cleanText(row[7]);
    const breakdownReason = cleanText(row[8]);
    const drillingSection = cleanText(row[9]);
    const drillingFrom = numericOrIssue(row[10], r, 'Drill From', issues);
    const drillingTo = numericOrIssue(row[11], r, 'Drill To', issues);
    const casingSection = cleanText(row[13]);
    const casingFrom = numericOrIssue(row[14], r, 'Casing From', issues);
    const casingTo = numericOrIssue(row[15], r, 'Casing To', issues);

    const blank = !wellName && !operationCode && !startTime && !endTime && !description && !drillingFrom && !casingFrom;
    if (blank) continue;

    dprLines.push({
      wellName, operationCode, workType, startTime, endTime, description,
      breakdownEquipment, breakdownReason, drillingSection, drillingFrom, drillingTo,
      casingSection, casingFrom, casingTo,
    });
  }

  // ---- Equipment Running Hours ----
  const equipmentLines: ParsedDrrEquipmentLine[] = [];
  const equipMarkerRow = markerRows.get(SECTION_MARKERS.equipment)!;
  const equipDataStart = equipMarkerRow + 2;
  const equipDataEnd = nextMarkerAfter(equipMarkerRow) - 1;
  for (let r = equipDataStart; r <= equipDataEnd; r++) {
    const row = grid[r - 1] ?? [];
    const equipmentId = cleanText(row[14]); // column O, hidden-styled but still read
    if (!equipmentId) continue; // blank/placeholder row (e.g. "no equipment" message row)

    const serviceDoneTodayRaw = cleanText(row[12]);
    const serviceDoneToday = (serviceDoneTodayRaw ?? '').toLowerCase() === 'yes';
    equipmentLines.push({
      equipmentId,
      dayHours: numericOrIssue(row[4], r, 'Day Hrs', issues) ?? 0,
      nightHours: numericOrIssue(row[5], r, 'Night Hrs', issues) ?? 0,
      hsdConsumption: numericOrIssue(row[9], r, 'HSD Consumption', issues) ?? 0,
      status: cleanText(row[10]),
      remarks: cleanText(row[11]),
      serviceDoneToday,
      serviceHours: serviceDoneToday ? numericOrIssue(row[13], r, 'Service Hours', issues) : null,
    });
  }

  // ---- Lubricating Oil ----
  const oilLines: ParsedDrrOilLine[] = [];
  const oilMarkerRow = markerRows.get(SECTION_MARKERS.oil)!;
  const oilDataStart = oilMarkerRow + 2;
  const oilDataEnd = nextMarkerAfter(oilMarkerRow) - 1;
  for (let r = oilDataStart; r <= oilDataEnd; r++) {
    const row = grid[r - 1] ?? [];
    const oilLubricantId = cleanText(row[6]); // column G
    if (!oilLubricantId) continue;

    oilLines.push({
      oilLubricantId,
      oilAdded: numericOrIssue(row[2], r, 'Oil Added', issues) ?? 0,
      oilConsumed: numericOrIssue(row[3], r, 'Oil Consumed', issues) ?? 0,
      remark: cleanText(row[5]),
    });
  }

  // ---- Hydraulic Oil ----
  const hydraulicLines: ParsedDrrHydraulicLine[] = [];
  const hydMarkerRow = markerRows.get(SECTION_MARKERS.hydraulic)!;
  const hydDataStart = hydMarkerRow + 2;
  const hydDataEnd = nextMarkerAfter(hydMarkerRow) - 1;
  for (let r = hydDataStart; r <= hydDataEnd; r++) {
    const row = grid[r - 1] ?? [];
    const tankName = cleanText(row[0]);
    if (!tankName) continue;

    hydraulicLines.push({
      tankName,
      topUp: numericOrIssue(row[2], r, 'Top-up', issues) ?? 0,
      loss: numericOrIssue(row[3], r, 'Loss', issues) ?? 0,
      remark: cleanText(row[5]),
    });
  }

  // ---- HSD Summary (fixed offsets from its own marker — always 7 field rows) ----
  const hsdMarkerRow = markerRows.get(SECTION_MARKERS.hsdSummary)!;
  const hsdReceived = numericOrIssue(grid[hsdMarkerRow + 1]?.[1], hsdMarkerRow + 2, 'HSD Received / Top-up', issues);
  const hsdRemarks = cleanText(grid[hsdMarkerRow + 6]?.[1]);

  return {
    rigTextInFile, rigKeyInFile: toRigKey(rigTextInFile), reportDate, wellNo, shift, fieldLocation, submittedBy,
    hsdReceived, hsdRemarks, dprLines, equipmentLines, oilLines, hydraulicLines, issues,
  };
}

function numericOrIssue(raw: unknown, row: number, label: string, issues: DrrIssue[]): number | null {
  if (!isPresentValue(raw)) return null;
  const n = presentNumber(raw);
  if (n === null) {
    issues.push({ level: 'fatal', row, message: `${label} has an invalid numeric value.` });
    return null;
  }
  return n;
}

function isPresentValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  return String(v).trim() !== '';
}

/** Same raw-serial/day-fraction handling as ilmIngest.ts's extractTime. */
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

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
