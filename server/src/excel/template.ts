import ExcelJS from 'exceljs';
import { daysInMonth, displayDate, monthName } from '../util/date.js';

/**
 * Generates the Daily Mechanical Report workbook of section 7.
 *
 * exceljs is used rather than SheetJS because the template must ship with live
 * formulas and real cell protection, and the cross-sheet carry-forward chain in
 * column J is the entire point of the workbook.
 */

export interface TemplateMachine {
  name: string;
  makeModel: string | null;
  serialNumber: string | null;
  currentRunningHours: number;
  lastServiceHours: number;
  serviceInterval: number;
  section: 'diesel' | 'generator';
}

export interface TemplateInput {
  rigNumber: string;
  rigName: string;
  logMonth: string; // YYYY-MM
  wellNumber?: string;
  machines: TemplateMachine[];
}

/** Fixed layout from spec 7.2. Ten data rows per section, always (defect D13). */
const ROWS_PER_SECTION = 10;
const DIESEL_BANNER_ROW = 3;
const DIESEL_HEADER_ROW = 4;
const DIESEL_FIRST_DATA_ROW = 6;   // rows 6-15
const GENERATOR_BANNER_ROW = 25;
const GENERATOR_HEADER_ROW = 26;
const GENERATOR_FIRST_DATA_ROW = 28; // rows 28-37
const LAST_COLUMN = 'S';

const HEADERS: [string, string][] = [
  ['Sr No', ''],
  ['Equipment', ''],
  ['Make/Model', ''],
  ['M/C Serial No', ''],
  ['Is in Use', 'Yes/No'],
  ['Hours Run', 'DAY'],
  ['Hours Run', 'NIGHT'],
  ['Lube Oil Pressure', 'psi/bar'],
  ['Lube Oil Added', 'Liters'],
  ['Opening Running HRS', ''],
  ['Total Run Hours', ''],
  ['Closing HRS', ''],
  ['Last Service Hours', ''],
  ['Running HRS after last service', ''],
  ['Define hours', ''],
  ['Hours Remaining For Next Service.', ''],
  ['Preventive /Predictive Maintenance Details', ''],
  ['Remarks', ''],
  ['Last Service Date', ''],
];

const COLUMN_WIDTHS = [6, 28, 20, 20, 9, 8, 8, 12, 12, 13, 12, 12, 13, 15, 11, 15, 28, 22, 26];

const YELLOW = 'FFFFFF00';
const ORANGE = 'FFF4B183';
const HEADER_GREY = 'FFD9D9D9';

export async function buildTemplateWorkbook(input: TemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PMS Portal';
  wb.created = new Date();

  const total = daysInMonth(input.logMonth);
  const diesel = input.machines.filter((m) => m.section !== 'generator');
  const generators = input.machines.filter((m) => m.section === 'generator');

  // 31 worksheets named "1" through "31" (spec 7.1). Days beyond the month's
  // length still exist so the workbook layout never changes shape.
  for (let day = 1; day <= 31; day++) {
    const ws = wb.addWorksheet(String(day), {
      views: [{ showGridLines: true }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    await buildSheet(ws, input, day, total, diesel, generators);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function templateFileName(rigNumber: string, logMonth: string): string {
  const rigPart = rigNumber.replace(/^\s*(gtc|rig)\s*/i, '').replace(/[^A-Za-z0-9-]+/g, '_');
  return `Mechanical_Log_Sheet_Rig_${rigPart}_${monthName(logMonth)}.xlsx`;
}

async function buildSheet(
  ws: ExcelJS.Worksheet,
  input: TemplateInput,
  day: number,
  daysInThisMonth: number,
  diesel: TemplateMachine[],
  generators: TemplateMachine[],
): Promise<void> {
  COLUMN_WIDTHS.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  // Row 1: rig number (locked), merged title, date (locked).
  ws.getCell('A1').value = 'Rig No:';
  ws.getCell('A1').font = { bold: true };
  ws.getCell('B1').value = input.rigNumber;
  paintLocked(ws.getCell('B1'));
  ws.mergeCells('C1:O1');
  ws.getCell('C1').value = 'Daily Mechanical Report';
  ws.getCell('C1').font = { bold: true, size: 14 };
  ws.getCell('C1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('P1').value = 'Date:';
  ws.getCell('P1').font = { bold: true };
  ws.mergeCells('Q1:S1');
  const dateCell = ws.getCell('Q1');
  dateCell.value =
    day <= daysInThisMonth
      ? displayDate(`${input.logMonth}-${String(day).padStart(2, '0')}`)
      : '';
  paintLocked(dateCell);
  dateCell.alignment = { horizontal: 'center' };

  // Row 2: well number, editable because it changes job to job.
  ws.getCell('A2').value = 'Well No:';
  ws.getCell('A2').font = { bold: true };
  const well = ws.getCell('B2');
  well.value = input.wellNumber ?? '';
  well.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  well.protection = { locked: false };
  well.border = boxBorder();

  writeSection(ws, DIESEL_BANNER_ROW, DIESEL_HEADER_ROW, DIESEL_FIRST_DATA_ROW, 'Diesel Engines', diesel, day);
  writeSection(ws, GENERATOR_BANNER_ROW, GENERATOR_HEADER_ROW, GENERATOR_FIRST_DATA_ROW, 'Generator', generators, day);

  // Structure locked, insertion disabled, empty password (spec 7.5).
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertRows: false,
    insertColumns: false,
    deleteRows: false,
    deleteColumns: false,
    sort: false,
    autoFilter: false,
  });
}

function writeSection(
  ws: ExcelJS.Worksheet,
  bannerRow: number,
  headerRow: number,
  firstDataRow: number,
  bannerText: string,
  machines: TemplateMachine[],
  day: number,
): void {
  ws.mergeCells(`A${bannerRow}:${LAST_COLUMN}${bannerRow}`);
  const banner = ws.getCell(`A${bannerRow}`);
  banner.value = bannerText;
  banner.font = { bold: true, size: 12 };
  banner.alignment = { horizontal: 'center', vertical: 'middle' };
  banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE } };
  banner.border = boxBorder();

  // Two-row header block (spec 7.3).
  HEADERS.forEach(([main, sub], i) => {
    const col = i + 1;
    const top = ws.getCell(headerRow, col);
    const bottom = ws.getCell(headerRow + 1, col);
    top.value = main;
    bottom.value = sub;
    for (const cell of [top, bottom]) {
      cell.font = { bold: true, size: 9 };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_GREY } };
      cell.border = boxBorder();
      cell.protection = { locked: true };
    }
  });
  ws.getRow(headerRow).height = 34;

  // Always ten rows, even when the rig has fewer machines or none at all, so a
  // new rig still gets a fully formula-wired grid (spec 7.6, defect D13).
  for (let i = 0; i < ROWS_PER_SECTION; i++) {
    const r = firstDataRow + i;
    const machine = machines[i];
    writeDataRow(ws, r, i + 1, machine, day);
  }
}

function writeDataRow(
  ws: ExcelJS.Worksheet,
  r: number,
  srNo: number,
  machine: TemplateMachine | undefined,
  day: number,
): void {
  const row = ws.getRow(r);
  row.height = 22;

  set(ws, r, 1, srNo, true);
  set(ws, r, 2, machine?.name ?? '', false);
  set(ws, r, 3, machine?.makeModel ?? '', false);
  set(ws, r, 4, machine?.serialNumber ?? '', false);
  set(ws, r, 5, '', false); // Is in Use
  set(ws, r, 6, '', false); // Hours Run DAY
  set(ws, r, 7, '', false); // Hours Run NIGHT
  set(ws, r, 8, '', false); // Lube oil pressure
  set(ws, r, 9, '', false); // Lube oil added

  // Column J: day 1 is a static seeded value and stays editable so the opening
  // baseline can be corrected; days 2-31 carry forward from the previous sheet
  // and are locked. This chain is the whole point of the workbook (spec 7.4).
  if (day === 1) {
    set(ws, r, 10, machine ? machine.currentRunningHours : '', false);
  } else {
    setFormula(ws, r, 10, `'${day - 1}'!L${r}`);
  }

  setFormula(ws, r, 11, `F${r}+G${r}`);            // K: total run = day + night
  setFormula(ws, r, 12, `J${r}+K${r}`);            // L: closing = opening + run
  set(ws, r, 13, machine ? machine.lastServiceHours : '', false); // M: crew entry
  setFormula(ws, r, 14, `L${r}-M${r}`);            // N: hours since service
  set(ws, r, 15, machine ? machine.serviceInterval : '', false);  // O: interval
  setFormula(ws, r, 16, `O${r}-N${r}`);            // P: hours remaining
  set(ws, r, 17, '', false); // Q
  set(ws, r, 18, '', false); // R
  set(ws, r, 19, '', false); // S
}

function set(ws: ExcelJS.Worksheet, r: number, c: number, value: unknown, locked: boolean): void {
  const cell = ws.getCell(r, c);
  cell.value = value as ExcelJS.CellValue;
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', wrapText: c === 2 || c >= 17 };
  cell.protection = { locked };
  if (c >= 6 && c <= 16) cell.alignment = { ...cell.alignment, horizontal: 'center' };
}

/**
 * Formula cells are locked; overwriting them breaks the calculation chain.
 * Exported: dprTemplate.ts reuses this and boxBorder/paintLocked as-is —
 * they carry no column-position assumptions, unlike set() above.
 */
export function setFormula(ws: ExcelJS.Worksheet, r: number, c: number, formula: string): void {
  const cell = ws.getCell(r, c);
  cell.value = { formula, result: undefined } as ExcelJS.CellFormulaValue;
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.protection = { locked: true };
  cell.font = { color: { argb: 'FF1F4E79' } };
}

export function paintLocked(cell: ExcelJS.Cell): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  cell.font = { bold: true };
  cell.protection = { locked: true };
  cell.border = boxBorder();
}

export function boxBorder(): Partial<ExcelJS.Borders> {
  const thin = { style: 'thin' as const, color: { argb: 'FF808080' } };
  return { top: thin, left: thin, bottom: thin, right: thin };
}

/* ------------------------------------------------------------------ */
/* Health checkup template (spec 6.6)                                  */
/* ------------------------------------------------------------------ */

export interface HealthTemplateInput {
  rigNumber: string;
  checkDate: string;
  machines: { name: string; serialNumber: string | null; makeModel: string | null }[];
}

const HEALTH_HEADERS = [
  'Sr No', 'Equipment', 'M/C Serial No', 'Make/Model', 'Check Date',
  'Condition (Normal/Breakdown)', 'Inspector', 'Findings / Remarks',
];

export async function buildHealthTemplateWorkbook(input: HealthTemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PMS Portal';
  const ws = wb.addWorksheet('Health Checkup');
  ws.columns = [
    { width: 6 }, { width: 30 }, { width: 22 }, { width: 22 },
    { width: 14 }, { width: 26 }, { width: 20 }, { width: 40 },
  ];

  ws.getCell('A1').value = 'Rig No:';
  ws.getCell('A1').font = { bold: true };
  ws.getCell('B1').value = input.rigNumber;
  paintLocked(ws.getCell('B1'));
  ws.getCell('D1').value = 'Date:';
  ws.getCell('D1').font = { bold: true };
  ws.getCell('E1').value = displayDate(input.checkDate);
  paintLocked(ws.getCell('E1'));

  HEALTH_HEADERS.forEach((h, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_GREY } };
    cell.border = boxBorder();
    cell.protection = { locked: true };
  });

  const rowCount = Math.max(input.machines.length, 15);
  for (let i = 0; i < rowCount; i++) {
    const r = 4 + i;
    const m = input.machines[i];
    set(ws, r, 1, i + 1, true);
    set(ws, r, 2, m?.name ?? '', false);
    set(ws, r, 3, m?.serialNumber ?? '', false);
    set(ws, r, 4, m?.makeModel ?? '', false);
    set(ws, r, 5, displayDate(input.checkDate), false);
    set(ws, r, 6, '', false);
    set(ws, r, 7, '', false);
    set(ws, r, 8, '', false);
  }

  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, insertRows: false });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
