import * as XLSX from 'xlsx';
import { headerKey, nameKey, rigKey, serialKey } from './normalize.js';
import { cleanText, isPresent, presentNumber, roundHours } from '../util/num.js';
import { parseCellDate } from '../util/date.js';

/**
 * Steps 1 to 4 of the ingestion engine (spec 8.1 - 8.4): read the workbook,
 * identify the rig, locate the data, decide which rows are real, and group
 * rows into machines. Nothing here touches the database.
 */

export type Grid = (unknown[])[];

export interface RawDayRow {
  sheetDay: number;
  sheetName: string;
  excelRow: number;
  section: 'diesel' | 'generator';
  name: string;
  makeModel: string | null;
  serial: string | null;
  serialKey: string;
  isInUse: string | null;
  hoursRunDay: number | null;
  hoursRunNight: number | null;
  lubeOilPressure: string | null;
  lubeOilAdded: number | null;
  opening: number | null;
  totalRun: number | null;
  closing: number | null;
  lastServiceHours: number | null;
  runningAfterService: number | null;
  defineHours: number | null;
  hoursRemaining: number | null;
  pmDetails: string | null;
  remarks: string | null;
  lastServiceDate: string | null;
  isReal: boolean;
}

export interface MachineGroup {
  key: string;
  name: string;
  nameKey: string;
  serial: string | null;
  serialKey: string;
  makeModel: string | null;
  section: 'diesel' | 'generator';
  /** Only days that passed the real-data test, ordered by sheetDay ascending. */
  days: RawDayRow[];
}

export interface ParseIssue {
  level: 'fatal' | 'warning';
  sheet?: string;
  machine?: string;
  message: string;
}

export interface ParsedWorkbook {
  rigNumberInFile: string | null;
  rigKeyInFile: string;
  sheetDateSamples: { day: number; date: string }[];
  /** Log month derived from the workbook's own date cells, YYYY-MM. */
  logMonth: string | null;
  groups: MachineGroup[];
  issues: ParseIssue[];
  /** Highest sheet day that carried at least one real row. */
  lastFilledDay: number | null;
  sheetsScanned: number;
}

/** Column slots the engine understands, in workbook order. */
const COLUMN_SPECS: { field: ColumnField; fallback: number; match: string[] }[] = [
  { field: 'srNo', fallback: 0, match: ['srno', 'sno', 'serialno1'] },
  { field: 'name', fallback: 1, match: ['equipment', 'description', 'equipmentdescription', 'machine'] },
  { field: 'makeModel', fallback: 2, match: ['makemodel', 'make', 'model', 'makeandmodel'] },
  { field: 'serial', fallback: 3, match: ['mcserialno', 'machineserialno', 'serialno', 'serialnumber', 'mcsrno'] },
  { field: 'isInUse', fallback: 4, match: ['isinuse', 'inuse', 'used'] },
  { field: 'hoursRunDay', fallback: 5, match: ['hoursrun', 'hoursrunday', 'day'] },
  { field: 'hoursRunNight', fallback: 6, match: ['night', 'hoursrunnight'] },
  { field: 'lubeOilPressure', fallback: 7, match: ['lubeoilpressure', 'oilpressure'] },
  { field: 'lubeOilAdded', fallback: 8, match: ['lubeoiladded', 'oiladded'] },
  { field: 'opening', fallback: 9, match: ['opningrunninghrs', 'openingrunninghrs', 'openingrunninghours', 'openinghrs', 'opninghrs'] },
  { field: 'totalRun', fallback: 10, match: ['totalrunhours', 'totalrunhrs', 'totalhours'] },
  { field: 'closing', fallback: 11, match: ['closinghrs', 'closinghours', 'closingrunninghrs'] },
  { field: 'lastServiceHours', fallback: 12, match: ['lastservicehours', 'lastservicehrs'] },
  { field: 'runningAfterService', fallback: 13, match: ['runninghrsafterlastservice', 'runninghoursafterlastservice', 'hrsafterlastservice'] },
  { field: 'defineHours', fallback: 14, match: ['definehours', 'definehrs', 'serviceinterval'] },
  { field: 'hoursRemaining', fallback: 15, match: ['hoursremainingfornextservice', 'hoursremaining', 'hrsremaining', 'remaininghours'] },
  { field: 'pmDetails', fallback: 16, match: ['preventivepredictivemaintenancedetails', 'preventivemaintenancedetails', 'maintenancedetails'] },
  { field: 'remarks', fallback: 17, match: ['remarks', 'remark'] },
  { field: 'lastServiceDate', fallback: 18, match: ['lastservicedate', 'lastservicedone', 'servicedate'] },
];

type ColumnField =
  | 'srNo' | 'name' | 'makeModel' | 'serial' | 'isInUse' | 'hoursRunDay' | 'hoursRunNight'
  | 'lubeOilPressure' | 'lubeOilAdded' | 'opening' | 'totalRun' | 'closing' | 'lastServiceHours'
  | 'runningAfterService' | 'defineHours' | 'hoursRemaining' | 'pmDetails' | 'remarks' | 'lastServiceDate';

type ColumnMap = Record<ColumnField, number>;

/**
 * Structural labels. Any row whose name cell matches one of these is part of the
 * form, not data, and is skipped (spec 8.2).
 */
const STRUCTURAL_LABELS = new Set(
  [
    'srno', 'sno', 'equipment', 'description', 'makemodel', 'make', 'model',
    'mcserialno', 'serialno', 'isinuse', 'hoursrun', 'day', 'night',
    'lubeoilpressure', 'lubeoiladded', 'opningrunninghrs', 'openingrunninghrs',
    'totalrunhours', 'closinghrs', 'lastservicehours', 'runninghrsafterlastservice',
    'definehours', 'hoursremainingfornextservice', 'preventivepredictivemaintenancedetails',
    'remarks', 'lastservicedate', 'lastservicedone', 'dieselengines', 'generator',
    'generators', 'rigno', 'rignumber', 'wellno', 'date', 'dailymechanicalreport',
    'yesno', 'psibar', 'liters', 'litres', 'total', 'grandtotal', 'signature',
    'preparedby', 'checkedby', 'toolpusher', 'mechanic',
  ],
);

const RIG_LABEL_KEYS = ['rigno', 'rignumber', 'rigname', 'rig', 'rignumbe'];
const DATE_LABEL_KEYS = ['date', 'reportdate', 'logdate'];
const TITLE_KEY = 'dailymechanicalreport';

export function readWorkbookGrid(buffer: Buffer): { sheets: Map<string, Grid>; names: string[] } {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellText: false });
  const sheets = new Map<string, Grid>();
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    sheets.set(name, grid);
  }
  return { sheets, names: wb.SheetNames };
}

/**
 * Step 1 (spec 8.1). Scans the first eight rows for a "Rig No" style label and
 * takes the next non-empty cell to its right, skipping the merged report title.
 * The label is not always in the same cell, which is exactly defect D1.
 */
export function findRigNumber(grid: Grid): string | null {
  const limit = Math.min(8, grid.length);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const key = headerKey(row[c]);
      if (!key || !RIG_LABEL_KEYS.includes(key)) continue;
      for (let k = c + 1; k < row.length; k++) {
        if (!isPresent(row[k])) continue;
        const value = cleanText(row[k]);
        if (!value) continue;
        if (headerKey(value) === TITLE_KEY) continue; // merged title sits adjacent
        return value;
      }
    }
  }
  return null;
}

/** Reads the sheet's own date cell, used to derive the log month (spec 7.1). */
export function findSheetDate(grid: Grid): string | null {
  const limit = Math.min(8, grid.length);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const key = headerKey(row[c]);
      if (!key || !DATE_LABEL_KEYS.includes(key)) continue;
      for (let k = c + 1; k < row.length; k++) {
        if (!isPresent(row[k])) continue;
        const parsed = parseCellDate(row[k]);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

/**
 * Step 2 (spec 8.2). Finds every header row and derives the column index of each
 * field from the header text rather than assuming fixed positions, because column
 * layouts drift between rig crews. Falls back to the standard positions of 7.3.
 */
function findHeaderRows(grid: Grid): number[] {
  const found: number[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const hasAnchor = row.some((cell) => {
      const k = headerKey(cell);
      return k === 'equipment' || k === 'description' || k === 'equipmentdescription';
    });
    if (hasAnchor) found.push(r);
  }
  return found;
}

function buildColumnMap(grid: Grid, headerRow: number): ColumnMap {
  const map = {} as ColumnMap;
  for (const spec of COLUMN_SPECS) map[spec.field] = spec.fallback;
  if (headerRow < 0) return map;

  // Merge the two-row header block (rows 4-5 of the standard layout): the main
  // header carries "Hours Run", the sub-header carries DAY / NIGHT.
  const main = grid[headerRow] || [];
  const sub = grid[headerRow + 1] || [];
  const width = Math.max(main.length, sub.length);

  const taken = new Set<number>();
  const assign = (field: ColumnField, index: number) => {
    if (index < 0 || taken.has(index)) return;
    map[field] = index;
    taken.add(index);
  };

  // Exact matches first so that "day" does not steal the "hours run" column.
  for (const spec of COLUMN_SPECS) {
    let best = -1;
    for (let c = 0; c < width; c++) {
      if (taken.has(c)) continue;
      const mk = headerKey(main[c]);
      const sk = headerKey(sub[c]);
      const combined = headerKey(`${cleanText(main[c]) ?? ''} ${cleanText(sub[c]) ?? ''}`);
      if (spec.match.includes(mk) || spec.match.includes(sk) || spec.match.includes(combined)) {
        best = c;
        break;
      }
    }
    if (best >= 0) assign(spec.field, best);
  }

  // "Hours Run" spans two columns; the second is NIGHT even when unlabelled.
  if (map.hoursRunNight === map.hoursRunDay) map.hoursRunNight = map.hoursRunDay + 1;
  return map;
}

function looksStructural(name: string): boolean {
  const key = nameKey(name);
  if (!key) return true;
  if (STRUCTURAL_LABELS.has(key)) return true;
  if (!/[a-z]/.test(key)) return true; // purely numeric or symbols
  return false;
}

/**
 * Step 3 (spec 8.3). A row counts as genuinely filled in by the crew only when
 * Total Run Hours (column K) itself carries a value. Every other column —
 * hours run, meter readings, the service baseline — can be formula residue or
 * a carried-forward figure on a day nobody actually reported; only a typed
 * total (including a typed zero) is treated as a real observation.
 */
export function isRealRow(r: { totalRunRaw: unknown }): boolean {
  return isPresent(r.totalRunRaw);
}

function extractRow(
  row: unknown[],
  map: ColumnMap,
  ctx: { sheetDay: number; sheetName: string; excelRow: number; section: 'diesel' | 'generator' },
): RawDayRow | null {
  const nameRaw = cleanText(row[map.name]);
  if (!nameRaw || looksStructural(nameRaw)) return null;

  const hoursRunDayRaw = row[map.hoursRunDay];
  const hoursRunNightRaw = row[map.hoursRunNight];
  const openingRaw = row[map.opening];
  const closingRaw = row[map.closing];
  const lastServiceRaw = row[map.lastServiceHours];
  const totalRunRaw = row[map.totalRun];

  const serial = cleanText(row[map.serial]);
  return {
    sheetDay: ctx.sheetDay,
    sheetName: ctx.sheetName,
    excelRow: ctx.excelRow,
    section: ctx.section,
    name: nameRaw,
    makeModel: cleanText(row[map.makeModel]),
    serial,
    serialKey: serialKey(serial),
    isInUse: normaliseUse(row[map.isInUse]),
    hoursRunDay: roundHours(presentNumber(hoursRunDayRaw)),
    hoursRunNight: roundHours(presentNumber(hoursRunNightRaw)),
    lubeOilPressure: cleanText(row[map.lubeOilPressure]),
    lubeOilAdded: roundHours(presentNumber(row[map.lubeOilAdded])),
    opening: roundHours(presentNumber(openingRaw)),
    totalRun: roundHours(presentNumber(totalRunRaw)),
    closing: roundHours(presentNumber(closingRaw)),
    lastServiceHours: roundHours(presentNumber(lastServiceRaw)),
    runningAfterService: roundHours(presentNumber(row[map.runningAfterService])),
    defineHours: roundHours(presentNumber(row[map.defineHours])),
    hoursRemaining: roundHours(presentNumber(row[map.hoursRemaining])),
    pmDetails: cleanText(row[map.pmDetails]),
    remarks: cleanText(row[map.remarks]),
    // Column S contributes only a date, never a service-hours figure (D6).
    lastServiceDate: parseCellDate(extractDateText(row[map.lastServiceDate])),
    isReal: isRealRow({ totalRunRaw }),
  };
}

/** Column S in the field is free text like "LAST SERVICE DONE @ 25366 HRS. DT- 2026-07-01". */
function extractDateText(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'number') return v;
  const s = String(v);
  const m =
    s.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/) ||
    s.match(/(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/);
  return m ? m[1] : null;
}

function normaliseUse(v: unknown): string | null {
  const s = cleanText(v);
  if (!s) return null;
  const k = nameKey(s);
  if (k === 'yes' || k === 'y') return 'Yes';
  if (k === 'no' || k === 'n') return 'No';
  return s;
}

/** Section banners split the sheet into diesel engines and generators (spec 7.2). */
function sectionForRow(grid: Grid, rowIndex: number): 'diesel' | 'generator' {
  for (let r = rowIndex; r >= 0; r--) {
    const first = nameKey((grid[r] || [])[0]);
    if (first === 'generator' || first === 'generators') return 'generator';
    if (first === 'dieselengines') return 'diesel';
  }
  return 'diesel';
}

/** Extracts every data row from one day sheet. */
export function extractSheetRows(grid: Grid, sheetDay: number, sheetName: string): RawDayRow[] {
  const headerRows = findHeaderRows(grid);
  const out: RawDayRow[] = [];

  if (headerRows.length === 0) {
    // Fall back to the standard positions of section 7.3 and read the whole sheet.
    const map = buildColumnMap(grid, -1);
    for (let r = 0; r < grid.length; r++) {
      const parsed = extractRow(grid[r] || [], map, {
        sheetDay, sheetName, excelRow: r + 1, section: sectionForRow(grid, r),
      });
      if (parsed) out.push(parsed);
    }
    return out;
  }

  for (let h = 0; h < headerRows.length; h++) {
    const headerRow = headerRows[h];
    const map = buildColumnMap(grid, headerRow);
    const end = h + 1 < headerRows.length ? headerRows[h + 1] : grid.length;
    // Skip the header row and its sub-header row.
    for (let r = headerRow + 1; r < end; r++) {
      const parsed = extractRow(grid[r] || [], map, {
        sheetDay, sheetName, excelRow: r + 1, section: sectionForRow(grid, headerRow),
      });
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/**
 * Step 4 (spec 8.4). Groups rows by normalised machine name; when a name carries
 * more than one distinct serial across the month, each serial becomes its own
 * machine. Groups with no real day at all are discarded entirely, which is what
 * keeps phantom machines out of the register.
 */
export function groupRows(rows: RawDayRow[]): { groups: MachineGroup[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const byName = new Map<string, RawDayRow[]>();
  for (const row of rows) {
    const key = nameKey(row.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(row);
  }

  const groups: MachineGroup[] = [];

  for (const [nk, nameRows] of byName) {
    const serials = new Set(nameRows.map((r) => r.serialKey).filter(Boolean));

    if (serials.size <= 1) {
      const serialRow = nameRows.find((r) => r.serialKey);
      groups.push(buildGroup(nk, nameRows, serialRow?.serial ?? null, serialRow?.serialKey ?? ''));
      continue;
    }

    // Two different machines can legitimately share a name (spec 8.4).
    const bySerial = new Map<string, RawDayRow[]>();
    for (const s of serials) bySerial.set(s, []);
    const blanks: RawDayRow[] = [];
    for (const row of nameRows) {
      if (row.serialKey) bySerial.get(row.serialKey)!.push(row);
      else blanks.push(row);
    }
    // A row that left the serial blank goes to the serial whose run of total
    // hours it continues most closely (spec 8.4).
    for (const row of blanks) {
      const target = bestSerialFor(row, bySerial);
      bySerial.get(target)!.push(row);
    }
    for (const [sk, serialRows] of bySerial) {
      serialRows.sort((a, b) => a.sheetDay - b.sheetDay);
      const display = serialRows.find((r) => r.serial)?.serial ?? null;
      groups.push(buildGroup(`${nk}::${sk}`, serialRows, display, sk));
    }
  }

  const kept: MachineGroup[] = [];
  for (const g of groups) {
    if (g.days.length === 0) {
      issues.push({
        level: 'warning',
        machine: g.name,
        message: `"${g.name}" has no day with real crew data and was skipped. No equipment record was created.`,
      });
      continue;
    }
    kept.push(g);
  }
  return { groups: kept, issues };
}

function buildGroup(key: string, rows: RawDayRow[], serial: string | null, sk: string): MachineGroup {
  const sorted = [...rows].sort((a, b) => a.sheetDay - b.sheetDay);
  const real = sorted.filter((r) => r.isReal);
  const display = sorted.find((r) => r.name)?.name ?? '';
  return {
    key,
    name: display,
    nameKey: nameKey(display),
    serial,
    serialKey: sk,
    makeModel: sorted.find((r) => r.makeModel)?.makeModel ?? null,
    section: majoritySection(sorted),
    days: real,
  };
}

/** Picks the serial whose meter readings the blank-serial row lines up with. */
function bestSerialFor(row: RawDayRow, bySerial: Map<string, RawDayRow[]>): string {
  const target = row.closing ?? row.opening;
  let bestKey = [...bySerial.keys()][0];
  if (target === null || target === undefined) return bestKey;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [sk, rows] of bySerial) {
    for (const other of rows) {
      const value = other.closing ?? other.opening;
      if (value === null || value === undefined) continue;
      const distance = Math.abs(value - target) + Math.abs(other.sheetDay - row.sheetDay);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = sk;
      }
    }
  }
  return bestKey;
}

export interface ParseOptions {
  /** Overrides the month when the workbook carries no usable date cell. */
  fallbackLogMonth?: string;
}

export function parseWorkbook(buffer: Buffer, options: ParseOptions = {}): ParsedWorkbook {
  const issues: ParseIssue[] = [];
  let sheets: Map<string, Grid>;
  let names: string[];
  try {
    ({ sheets, names } = readWorkbookGrid(buffer));
  } catch (err) {
    throw new Error(
      `The file could not be read as an Excel workbook: ${(err as Error).message}`,
    );
  }

  const daySheets = names
    .map((name) => ({ name, day: Number(String(name).trim()) }))
    .filter((s) => Number.isInteger(s.day) && s.day >= 1 && s.day <= 31);

  if (daySheets.length === 0) {
    throw new Error(
      'No day worksheets were found. A Daily Mechanical Report must have worksheets named 1 to 31.',
    );
  }

  // Step 1: the rig declaration, taken from whichever sheet carries it.
  let rigNumberInFile: string | null = null;
  for (const s of [...daySheets].reverse()) {
    rigNumberInFile = findRigNumber(sheets.get(s.name)!);
    if (rigNumberInFile) break;
  }

  // Log month: from the workbook's own date cells (spec 7.1).
  const sheetDateSamples: { day: number; date: string }[] = [];
  const monthVotes = new Map<string, number>();
  for (const s of daySheets) {
    const d = findSheetDate(sheets.get(s.name)!);
    if (!d) continue;
    sheetDateSamples.push({ day: s.day, date: d });
    const month = d.slice(0, 7);
    monthVotes.set(month, (monthVotes.get(month) ?? 0) + 1);
  }
  let logMonth: string | null = null;
  let bestVotes = 0;
  for (const [month, votes] of monthVotes) {
    if (votes > bestVotes) {
      bestVotes = votes;
      logMonth = month;
    }
  }
  if (!logMonth && options.fallbackLogMonth) logMonth = options.fallbackLogMonth;

  // Steps 2 and 3: walk the day sheets from the back so the last filled day is
  // found first, then extract every row.
  const allRows: RawDayRow[] = [];
  for (const s of [...daySheets].sort((a, b) => b.day - a.day)) {
    const grid = sheets.get(s.name)!;
    try {
      allRows.push(...extractSheetRows(grid, s.day, s.name));
    } catch (err) {
      issues.push({
        level: 'warning',
        sheet: s.name,
        message: `Sheet "${s.name}" could not be read and was skipped: ${(err as Error).message}`,
      });
    }
  }

  const { groups, issues: groupIssues } = groupRows(allRows);
  issues.push(...groupIssues);

  let lastFilledDay: number | null = null;
  for (const g of groups) {
    for (const d of g.days) {
      if (lastFilledDay === null || d.sheetDay > lastFilledDay) lastFilledDay = d.sheetDay;
    }
  }

  if (groups.length === 0) {
    issues.push({
      level: 'fatal',
      message:
        'No machine in this workbook has a day with real crew data. Nothing would be imported. ' +
        'Check that hours run, or a meter reading together with a last-service figure, have been entered.',
    });
  }

  return {
    rigNumberInFile,
    rigKeyInFile: rigKey(rigNumberInFile),
    sheetDateSamples,
    logMonth,
    groups,
    issues,
    lastFilledDay,
    sheetsScanned: daySheets.length,
  };
}

/** Which half of the form the machine lives in, by weight of its rows. */
function majoritySection(rows: RawDayRow[]): 'diesel' | 'generator' {
  let generator = 0;
  for (const r of rows) if (r.section === 'generator') generator++;
  return generator * 2 > rows.length ? 'generator' : 'diesel';
}
