import ExcelJS from 'exceljs';
import { daysInMonth, dateFromMonthDay, displayDate, monthName } from '../util/date.js';
import { boxBorder, paintLocked, setFormula } from './template.js';

/**
 * Generates the rig-wise DPR (Daily Progress Report) workbook: one sheet per
 * day of the month, named "1".."31" — the same 31-sheet-per-month convention
 * the Mechanical Log module already uses (excel/template.ts), not a new
 * pattern. Each sheet keeps the original per-day layout (rig/date header,
 * sixteen activity rows, three "(Auto)" formula columns), but the rig is
 * fixed for the whole workbook and the date is fixed per sheet — the user
 * never types either.
 *
 * A single hidden "Lists" sheet (shared across all 31 day-sheets, matching
 * the sample workbook this was reverse-engineered from) backs real Excel
 * dropdown/data-validation on Operation Task Code, Work Type, Breakdown
 * Equipment, Drilling Section and Casing Section — the exact five columns
 * and the exact list values/ranges the sample's own Lists sheet uses.
 */

export interface DprTemplateInput {
  rigNumber: string;
  logMonth: string; // YYYY-MM
}

const LAST_COLUMN = 'P';
const FIRST_DATA_ROW = 4;
const LAST_DATA_ROW = 19;
const TOTAL_ROW = 20;

const HEADERS = [
  'WELL NAME', 'OPERATION\nTASK CODE', 'WORK\nTYPE', 'START\nTIME', 'END\nTIME', 'TOTAL TIME\n(Auto)',
  'DESCRIPTION / REMARKS', 'BREAKDOWN\nEQUIPMENT', 'DRILLING\nSECTION', 'FROM\n(M)', 'TO\n(M)', 'TOTAL\n(Auto)',
  'CASING\nSECTION', 'FROM\n(M)', 'TO\n(M)', 'TOTAL\n(Auto)',
];
const COLUMN_WIDTHS = [16, 24, 12, 10, 10, 11, 40, 20, 13, 10, 10, 10, 13, 10, 10, 10];

const YELLOW = 'FFFFFF00';
const HEADER_GREY = 'FFD9D9D9';
const SECTION_BLUE = 'FFBDD7EE';

// Exactly the values found in the sample workbook's own hidden "Lists"
// sheet (columns B-F) — inspected programmatically, not invented.
const WORK_TYPES = ['R0', 'R1', 'R2', 'R2/2', 'R3', 'ILM'];
const ACTIVITY_CODES = [
  '02 - Drilling', '03 - Reaming', '04 - Coring', '05 - C&C', '06 - Tripping', '07 - Lubrication',
  '08 - Breakdown', '09 - Slip & Cut', '10 - Deviation Survey', '11 - Logging', '12 - Casing R/in',
  '13 - Wait on Cement', '14 - Nipple Up/Down BOP', '15 - Test BOP', '16 - Drill Stem BOP',
  '17 - Plug Back', '18 - Cementing', '19 - Fishing', '20 - Directional Work', '21 - Tubing Job',
  '22 - Testing LOT CIT', '23 - Other',
];
const EQUIPMENT = ['Draw Works', 'Mud Pump', 'Kelly', 'Rotary/PTO', 'Carrier Engine', 'Compressor', 'Drillograph', 'Others'];
const BIT_SIZES = ['5 1/2"', '6"', '8 1/2"', '12 1/4"', '17 1/2"', '26"'];
const CASING_SIZES = ['2 7/8"', '4 1/2"', '5"', '5 1/2"', '7"', '9 5/8"', '13 3/8"', '20"'];

export async function buildDprTemplateWorkbook(input: DprTemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GTC Oilfield Portal';
  wb.created = new Date();

  buildListsSheet(wb);

  const total = daysInMonth(input.logMonth);
  for (let day = 1; day <= 31; day++) {
    const ws = wb.addWorksheet(String(day), { views: [{ showGridLines: true }] });
    buildDaySheet(ws, input, day, total);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** Column layout (B=work types, C=activity codes, D=equipment, E=bit sizes, F=casing sizes) matches the sample's own Lists sheet exactly. */
function buildListsSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('Lists', { state: 'hidden' });
  const columns = [WORK_TYPES, ACTIVITY_CODES, EQUIPMENT, BIT_SIZES, CASING_SIZES];
  columns.forEach((values, colIdx) => {
    const col = colIdx + 2; // B, C, D, E, F
    values.forEach((v, i) => { ws.getCell(i + 1, col).value = v; });
  });
  ws.getColumn(1).width = 4;
  for (let c = 2; c <= 6; c++) ws.getColumn(c).width = 22;
}

export function dprTemplateFileName(rigNumber: string, logMonth: string): string {
  const rigPart = rigNumber.replace(/^\s*(gtc|rig)\s*/i, '').replace(/[^A-Za-z0-9-]+/g, '_');
  return `Rig_${rigPart}_DPR_${monthName(logMonth)}.xlsx`;
}

function buildDaySheet(ws: ExcelJS.Worksheet, input: DprTemplateInput, day: number, daysInThisMonth: number): void {
  COLUMN_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  ws.mergeCells(`A1:${LAST_COLUMN}1`);
  const title = ws.getCell('A1');
  title.value = 'GTC — Daily Progress Report (DPR)';
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };

  ws.getCell('A2').value = 'RIG NO.';
  ws.getCell('A2').font = { bold: true };
  ws.mergeCells('B2:C2');
  ws.getCell('B2').value = input.rigNumber;
  paintLocked(ws.getCell('B2'));

  ws.getCell('D2').value = 'DATE';
  ws.getCell('D2').font = { bold: true };
  ws.mergeCells('E2:F2');
  const dateCell = ws.getCell('E2');
  const iso = day <= daysInThisMonth ? dateFromMonthDay(input.logMonth, day) : null;
  dateCell.value = iso ? displayDate(iso) : '';
  paintLocked(dateCell);

  ws.mergeCells('I2:L2');
  sectionBanner(ws.getCell('I2'), 'DRILLING SECTION');
  ws.mergeCells('M2:P2');
  sectionBanner(ws.getCell('M2'), 'CASING SECTION');

  HEADERS.forEach((h, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 9 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_GREY } };
    cell.border = boxBorder();
    cell.protection = { locked: true };
  });
  ws.getRow(3).height = 32;

  for (let r = FIRST_DATA_ROW; r <= LAST_DATA_ROW; r++) writeDataRow(ws, r);

  ws.getCell(`A${TOTAL_ROW}`).value = 'TOTAL';
  ws.getCell(`A${TOTAL_ROW}`).font = { bold: true };
  setFormula(ws, TOTAL_ROW, 6, `SUM(F${FIRST_DATA_ROW}:F${LAST_DATA_ROW})`);
  setFormula(ws, TOTAL_ROW, 12, `SUM(L${FIRST_DATA_ROW}:L${LAST_DATA_ROW})`);
  setFormula(ws, TOTAL_ROW, 16, `SUM(P${FIRST_DATA_ROW}:P${LAST_DATA_ROW})`);

  ws.protect('', {
    selectLockedCells: true, selectUnlockedCells: true,
    formatCells: false, formatColumns: false, formatRows: false,
    insertRows: false, insertColumns: false, deleteRows: false, deleteColumns: false,
    sort: false, autoFilter: false,
  });
}

function sectionBanner(cell: ExcelJS.Cell, text: string): void {
  cell.value = text;
  cell.font = { bold: true };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_BLUE } };
  cell.border = boxBorder();
  cell.protection = { locked: true };
}

function writeDataRow(ws: ExcelJS.Worksheet, r: number): void {
  ws.getRow(r).height = 20;

  crew(ws, r, 1);                        // A well name
  crew(ws, r, 2, `Lists!$C$1:$C$${ACTIVITY_CODES.length}`); // B operation code -> Lists col C
  crew(ws, r, 3, `Lists!$B$1:$B$${WORK_TYPES.length}`);     // C work type -> Lists col B
  crewTime(ws, r, 4);                    // D start time
  crewTime(ws, r, 5);                    // E end time
  setFormula(ws, r, 6, `IF(AND(D${r}<>"",E${r}<>""),IF(E${r}>=D${r},(E${r}-D${r})*24,(1+E${r}-D${r})*24),"")`);
  crew(ws, r, 7, undefined, true);       // G description/remarks — wraps
  crew(ws, r, 8, `Lists!$D$1:$D$${EQUIPMENT.length}`);      // H breakdown equipment
  crew(ws, r, 9, `Lists!$E$1:$E$${BIT_SIZES.length}`);      // I drilling section
  crewNumber(ws, r, 10);                 // J drilling from
  crewNumber(ws, r, 11);                 // K drilling to
  setFormula(ws, r, 12, `IF(AND(J${r}<>"",K${r}<>""),K${r}-J${r},"")`);
  crew(ws, r, 13, `Lists!$F$1:$F$${CASING_SIZES.length}`);  // M casing section
  crewNumber(ws, r, 14);                 // N casing from
  crewNumber(ws, r, 15);                 // O casing to
  setFormula(ws, r, 16, `IF(AND(N${r}<>"",O${r}<>""),O${r}-N${r},"")`);
}

function crew(ws: ExcelJS.Worksheet, r: number, c: number, listRange?: string, wrap = false): void {
  const cell = ws.getCell(r, c);
  cell.value = null;
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', wrapText: wrap };
  cell.protection = { locked: false };
  if (listRange) {
    cell.dataValidation = { type: 'list', allowBlank: true, formulae: [listRange], showErrorMessage: false };
  }
}

function crewTime(ws: ExcelJS.Worksheet, r: number, c: number): void {
  const cell = ws.getCell(r, c);
  cell.value = null;
  cell.numFmt = 'h:mm';
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.protection = { locked: false };
}

function crewNumber(ws: ExcelJS.Worksheet, r: number, c: number): void {
  const cell = ws.getCell(r, c);
  cell.value = null;
  cell.numFmt = '0';
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.protection = { locked: false };
}
