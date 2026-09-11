import * as XLSX from 'xlsx';
import { rigKey as toRigKey } from './normalize.js';
import { parseCellDate } from '../util/date.js';
import { cleanText, presentNumber } from '../util/num.js';
import { ILM_TEMPLATE_VERSION } from './ilmTemplate.js';

/**
 * Reads the ILM (Inter Location Movement) workbook: one rig movement per
 * file, spread across the three sheets the real template was built from —
 * 2_ILM_Individual (header + repeating delay/fuel table), 4_ILM_Trailer_
 * Load_Detail (header + repeating trailer-row table), 5_ILM_Crane_Detail
 * (flat repeating table, no header). Positions, not header text, are
 * trusted for data rows, same convention as dprIngest.ts.
 */

export interface IlmIssue {
  level: 'fatal' | 'warning';
  sheet?: string;
  row?: number; // 1-based spreadsheet row, when the issue is row-specific
  message: string;
}

export interface ParsedIlmIndividualLine {
  lineNo: number;
  reasonForDelay: string | null;
  totalDelayHours: number | null;
  hsdStockAccession: number | null;
  receivedQtyDuringIlm: number | null;
  hsdStockShiftEnd: number | null;
  totalHsdConsumption: number | null; // always recomputed here, never trusted from the sheet's own cell
  ilmDistanceKm: number | null;
  totalLoadsMoved: number | null;
  cumulativeTrailerKm: number | null;
  avgConsumptionPerKm: number | null; // always recomputed here
}

export interface ParsedIlmTrailerLoad {
  lineNo: number;
  srNo: string | null;
  mtGatePassNo: string | null;
  trailerNo: string | null;
  trailerType: string | null;
  capacityTon: number | null; // not on the Excel template; always null for imported rows
  arrivalDate: string | null; // not on the Excel template; always null for imported rows
  arrivalTime: string | null; // not on the Excel template; always null for imported rows
  loadingDate: string | null;
  loadingTime: string | null;
  loadDescription: string | null;
  totalPackages: number | null;
  unloadingDate: string | null;
  unloadingTime: string | null;
  driverName: string | null;
  driverContact: string | null;
}

export interface ParsedIlmCrane {
  lineNo: number;
  craneNo: string | null;
  capacityTon: number | null;
  reportingDate: string | null;
  rigOrHired: string | null;
  registrationNo: string | null;
  arrivedDate: string | null;
  arrivedTime: string | null;
  releaseDate: string | null; // not on the Excel template; always null for imported rows
  releaseTime: string | null; // not on the Excel template; always null for imported rows
  transporterName: string | null;
  dayNo: number | null;
  shiftDate: string | null;
  dayShiftHrs: number | null;
  detailsJobDay: string | null;
  nightShiftHrs: number | null;
  detailsJobNight: string | null;
  breakdownHrs: number | null;
  cumulativeHrs: number | null;
  issuedHsdLtrs: number | null;
  totalWorkingHrs: number | null;
}

export interface ParsedIlmWorkbook {
  rigTextInFile: string | null; // from 2_ILM_Individual!B3
  rigKeyInFile: string;
  trailerRigTextInFile: string | null; // from 4_ILM_Trailer_Load_Detail!B2
  trailerRigKeyInFile: string;
  ilmDate: string | null;
  area: string | null;
  movementFromWell: string | null;
  movementToWell: string | null;
  releaseDate: string | null;
  releaseTime: string | null;
  spudDate: string | null;
  spudTime: string | null;
  individualLines: ParsedIlmIndividualLine[];
  trailerHeader: {
    rigName: string | null; oldLocation: string | null; newLocation: string | null;
    leadDistanceKm: number | null; rigReleaseAt: string | null; fleetReportAt: string | null;
    allowedDurationHrs: number | null;
  };
  trailerLoads: ParsedIlmTrailerLoad[];
  cranes: ParsedIlmCrane[];
  issues: IlmIssue[];
}

const SHEET_INDIVIDUAL = '2_ILM_Individual';
const SHEET_TRAILER = '4_ILM_Trailer_Load_Detail';
const SHEET_CRANE = '5_ILM_Crane_Detail';
const REQUIRED_SHEETS = [SHEET_INDIVIDUAL, SHEET_TRAILER, SHEET_CRANE];

const IND_FIRST_ROW = 13;
const IND_LAST_ROW = 32;
const TRAILER_FIRST_ROW = 11;
const TRAILER_LAST_ROW = 30;
const CRANE_FIRST_ROW = 4;
const CRANE_LAST_ROW = 23;

const emptyResult = (issues: IlmIssue[]): ParsedIlmWorkbook => ({
  rigTextInFile: null, rigKeyInFile: '', trailerRigTextInFile: null, trailerRigKeyInFile: '',
  ilmDate: null, area: null, movementFromWell: null, movementToWell: null,
  releaseDate: null, releaseTime: null, spudDate: null, spudTime: null,
  individualLines: [], trailerHeader: {
    rigName: null, oldLocation: null, newLocation: null, leadDistanceKm: null,
    rigReleaseAt: null, fleetReportAt: null, allowedDurationHrs: null,
  },
  trailerLoads: [], cranes: [], issues,
});

export function parseIlmWorkbook(buffer: Buffer): ParsedIlmWorkbook {
  let wb: XLSX.WorkBook;
  try {
    // cellDates off for the same reason as dprIngest.ts: exceljs (writer) and
    // xlsx (reader) disagree on the 1899-12-30 time-only anchor day, so times
    // are read as raw serials/day-fractions instead of converted JS Dates.
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, bookVBA: false });
  } catch (err) {
    return emptyResult([{ level: 'fatal', message: `The file could not be read as an Excel workbook: ${(err as Error).message}` }]);
  }

  const missing = REQUIRED_SHEETS.filter((name) => !wb.SheetNames.includes(name));
  if (missing.length > 0) {
    return emptyResult(missing.map((name) => ({
      level: 'fatal' as const,
      message: `Missing required sheet: ${name}. Please download the latest ILM template and try again.`,
    })));
  }

  const metaSheet = wb.Sheets['ILM_Meta'];
  const version = metaSheet ? cleanText(XLSX.utils.sheet_to_json<unknown[]>(metaSheet, { header: 1, raw: true })[0]?.[1]) : null;
  const issues: IlmIssue[] = [];
  if (version !== ILM_TEMPLATE_VERSION) {
    issues.push({
      level: 'fatal',
      message: version
        ? `This file was created with ILM Template Version ${version}, but Version ${ILM_TEMPLATE_VERSION} is required. Download the latest template and re-enter the data.`
        : 'This does not appear to be a valid ILM template (missing version information). Download a fresh template and try again.',
    });
    return emptyResult(issues);
  }

  const indGrid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_INDIVIDUAL], { header: 1, raw: true, defval: null });
  const trlGrid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_TRAILER], { header: 1, raw: true, defval: null });
  const crnGrid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_CRANE], { header: 1, raw: true, defval: null });

  const indTitle = cleanText(indGrid[0]?.[0]);
  if (!/module 2|ilm individual/i.test(indTitle ?? '')) {
    issues.push({ level: 'fatal', sheet: SHEET_INDIVIDUAL, message: 'This does not appear to be a valid ILM Individual sheet.' });
  }
  const crnTitle = cleanText(crnGrid[0]?.[0]);
  if (!/module 5|ilm crane/i.test(crnTitle ?? '')) {
    issues.push({ level: 'fatal', sheet: SHEET_CRANE, message: 'This does not appear to be a valid ILM Crane Detail sheet.' });
  }
  if (issues.some((i) => i.level === 'fatal')) return emptyResult(issues);

  const ilmDate = parseCellDate(indGrid[1]?.[1]);        // Individual B2
  const rigTextInFile = cleanText(indGrid[2]?.[1]);       // Individual B3
  const area = cleanText(indGrid[3]?.[1]);
  const movementFromWell = cleanText(indGrid[4]?.[1]);
  const movementToWell = cleanText(indGrid[5]?.[1]);
  const releaseDate = parseCellDate(indGrid[6]?.[1]);
  const releaseTime = extractTime(indGrid[7]?.[1]);
  const spudDate = parseCellDate(indGrid[8]?.[1]);
  const spudTime = extractTime(indGrid[9]?.[1]);

  if (!rigTextInFile) issues.push({ level: 'fatal', sheet: SHEET_INDIVIDUAL, row: 3, message: 'Rig No. is missing.' });
  if (!ilmDate) issues.push({ level: 'fatal', sheet: SHEET_INDIVIDUAL, row: 2, message: 'Date is missing or could not be read.' });

  const trailerRigTextInFile = cleanText(trlGrid[1]?.[1]); // Trailer B2
  const oldLocation = cleanText(trlGrid[2]?.[1]);
  const newLocation = cleanText(trlGrid[3]?.[1]);
  const leadDistanceKm = numericOrIssue(trlGrid[4]?.[1], SHEET_TRAILER, 5, 'Lead Distance to new location', issues);
  const rigReleaseAt = cleanText(trlGrid[5]?.[1]);
  const fleetReportAt = cleanText(trlGrid[6]?.[1]);
  const allowedDurationHrs = numericOrIssue(trlGrid[7]?.[1], SHEET_TRAILER, 8, 'Allowed duration as per contract (Hrs)', issues);

  const individualLines: ParsedIlmIndividualLine[] = [];
  for (let r = IND_FIRST_ROW; r <= IND_LAST_ROW; r++) {
    const row = indGrid[r - 1] ?? [];
    const reasonForDelay = cleanText(row[0]);
    const totalDelayHoursRaw = row[1];
    const accessionRaw = row[2];
    const receivedRaw = row[3];
    const shiftEndRaw = row[4];
    const distanceRaw = row[6];
    const loadsMovedRaw = row[7];
    const cumulativeKmRaw = row[8];

    const blank = !reasonForDelay && !isPresentValue(totalDelayHoursRaw) && !isPresentValue(accessionRaw)
      && !isPresentValue(receivedRaw) && !isPresentValue(shiftEndRaw) && !isPresentValue(distanceRaw)
      && !isPresentValue(loadsMovedRaw) && !isPresentValue(cumulativeKmRaw);
    if (blank) continue;

    const totalDelayHours = numericOrIssue(totalDelayHoursRaw, SHEET_INDIVIDUAL, r, 'Total Delay Time (HRS)', issues);
    const hsdStockAccession = numericOrIssue(accessionRaw, SHEET_INDIVIDUAL, r, 'HSD Stock @ Accession (L)', issues);
    const receivedQtyDuringIlm = numericOrIssue(receivedRaw, SHEET_INDIVIDUAL, r, 'Received Qty During ILM (L)', issues);
    const hsdStockShiftEnd = numericOrIssue(shiftEndRaw, SHEET_INDIVIDUAL, r, 'HSD Stock @ Shift End (L)', issues);
    const ilmDistanceKm = numericOrIssue(distanceRaw, SHEET_INDIVIDUAL, r, 'ILM Distance (KM)', issues);
    const totalLoadsMoved = numericOrIssue(loadsMovedRaw, SHEET_INDIVIDUAL, r, 'Total Loads Moved', issues);
    const cumulativeTrailerKm = numericOrIssue(cumulativeKmRaw, SHEET_INDIVIDUAL, r, 'Cumulative Trailer KMs', issues);

    individualLines.push({
      lineNo: individualLines.length + 1,
      reasonForDelay, totalDelayHours, hsdStockAccession, receivedQtyDuringIlm, hsdStockShiftEnd,
      totalHsdConsumption: hsdBalance(hsdStockAccession, receivedQtyDuringIlm, hsdStockShiftEnd),
      ilmDistanceKm, totalLoadsMoved, cumulativeTrailerKm,
      avgConsumptionPerKm: perKm(hsdBalance(hsdStockAccession, receivedQtyDuringIlm, hsdStockShiftEnd), ilmDistanceKm),
    });
  }

  const trailerLoads: ParsedIlmTrailerLoad[] = [];
  for (let r = TRAILER_FIRST_ROW; r <= TRAILER_LAST_ROW; r++) {
    const row = trlGrid[r - 1] ?? [];
    const trailerNo = cleanText(row[2]);
    const srNo = cleanText(row[0]);
    const mtGatePassNo = cleanText(row[1]);
    const trailerType = cleanText(row[3]);
    const loadingDate = parseCellDate(row[4]);
    const loadingTime = extractTime(row[5]);
    const loadDescription = cleanText(row[6]);
    const totalPackagesRaw = row[7];
    const unloadingDate = parseCellDate(row[8]);
    const unloadingTime = extractTime(row[9]);
    const driverName = cleanText(row[10]);
    const driverContact = cleanText(row[11]);

    const blank = !srNo && !trailerNo && !mtGatePassNo && !loadingDate && !unloadingDate && !driverName;
    if (blank) continue;

    if (!trailerNo) issues.push({ level: 'fatal', sheet: SHEET_TRAILER, row: r, message: 'Trailer No. is required.' });

    trailerLoads.push({
      lineNo: trailerLoads.length + 1,
      srNo, mtGatePassNo, trailerNo, trailerType, capacityTon: null, arrivalDate: null, arrivalTime: null,
      loadingDate, loadingTime, loadDescription,
      totalPackages: numericOrIssue(totalPackagesRaw, SHEET_TRAILER, r, 'Total No. of Packages', issues),
      unloadingDate, unloadingTime, driverName, driverContact,
    });
  }

  const cranes: ParsedIlmCrane[] = [];
  for (let r = CRANE_FIRST_ROW; r <= CRANE_LAST_ROW; r++) {
    const row = crnGrid[r - 1] ?? [];
    const craneNo = cleanText(row[0]);
    const registrationNo = cleanText(row[4]);
    const blank = !craneNo && !registrationNo && !isPresentValue(row[10]) && !isPresentValue(row[12]);
    if (blank) continue;

    if (!craneNo) issues.push({ level: 'fatal', sheet: SHEET_CRANE, row: r, message: 'Crane No. is required.' });

    cranes.push({
      lineNo: cranes.length + 1,
      craneNo,
      capacityTon: numericOrIssue(row[1], SHEET_CRANE, r, 'Capacity (Ton)', issues),
      reportingDate: parseCellDate(row[2]),
      rigOrHired: cleanText(row[3]),
      registrationNo,
      arrivedDate: parseCellDate(row[5]),
      arrivedTime: extractTime(row[6]),
      releaseDate: null,
      releaseTime: null,
      transporterName: cleanText(row[7]),
      dayNo: numericOrIssue(row[8], SHEET_CRANE, r, 'Day No.', issues) as number | null,
      shiftDate: parseCellDate(row[9]),
      dayShiftHrs: numericOrIssue(row[10], SHEET_CRANE, r, 'Day Shift Hrs', issues),
      detailsJobDay: cleanText(row[11]),
      nightShiftHrs: numericOrIssue(row[12], SHEET_CRANE, r, 'Night Shift Hrs', issues),
      detailsJobNight: cleanText(row[13]),
      breakdownHrs: numericOrIssue(row[14], SHEET_CRANE, r, 'Breakdown Hrs', issues),
      cumulativeHrs: numericOrIssue(row[15], SHEET_CRANE, r, 'Cumulative Hrs', issues),
      issuedHsdLtrs: numericOrIssue(row[16], SHEET_CRANE, r, 'Issued HSD (Ltrs)', issues),
      totalWorkingHrs: numericOrIssue(row[17], SHEET_CRANE, r, 'Total Working Hrs', issues),
    });
  }

  if (individualLines.length === 0 && trailerLoads.length === 0 && cranes.length === 0) {
    issues.push({ level: 'fatal', message: 'No ILM data rows were found in any sheet. Fill in at least one row before uploading.' });
  }

  return {
    rigTextInFile, rigKeyInFile: toRigKey(rigTextInFile),
    trailerRigTextInFile, trailerRigKeyInFile: toRigKey(trailerRigTextInFile),
    ilmDate, area, movementFromWell, movementToWell, releaseDate, releaseTime, spudDate, spudTime,
    individualLines,
    trailerHeader: { rigName: trailerRigTextInFile, oldLocation, newLocation, leadDistanceKm, rigReleaseAt, fleetReportAt, allowedDurationHrs },
    trailerLoads, cranes, issues,
  };
}

function isPresentValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  return String(v).trim() !== '';
}

function numericOrIssue(raw: unknown, sheet: string, row: number, label: string, issues: IlmIssue[]): number | null {
  if (!isPresentValue(raw)) return null;
  const n = presentNumber(raw);
  if (n === null) {
    issues.push({ level: 'fatal', sheet, row, message: `${label} has an invalid numeric value.` });
    return null;
  }
  return n;
}

/** HSD fuel balance: what was on hand, plus what came in, minus what's left. */
function hsdBalance(accession: number | null, received: number | null, shiftEnd: number | null): number | null {
  if (accession === null || received === null || shiftEnd === null) return null;
  return round2(accession + received - shiftEnd);
}

function perKm(consumption: number | null, distanceKm: number | null): number | null {
  if (consumption === null || distanceKm === null || distanceKm === 0) return null;
  return round2(consumption / distanceKm);
}

/** Same raw-serial/day-fraction handling as dprIngest.ts's extractTime. */
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
