import ExcelJS from 'exceljs';
import { displayDate } from '../util/date.js';
import { boxBorder, paintLocked, setFormula } from './template.js';

/**
 * Generates the rig-wise ILM (Inter Location Movement) workbook, built from
 * the structure of the real workbook this module was reverse-engineered
 * from: three sheets (Individual / Trailer Load Detail / Crane Detail), none
 * of which carried sheet protection, data validation or formulas in the
 * source file. This version adds real dropdowns and two live formulas (HSD
 * consumption balance, avg consumption/km) that the original never had —
 * the fix instructed in spec 13, not scope creep — plus a version-stamp cell
 * so a stale/modified template can be rejected on import (spec 15).
 */

export const ILM_TEMPLATE_VERSION = '1.0';

export interface IlmTemplateInput {
  rigNumber: string;
  date: string; // YYYY-MM-DD, prefilled but left editable
}

const YELLOW = 'FFFFFF00';
const HEADER_BLUE = 'FF2D7DD2';
const HEADER_GREY = 'FFD9D9D9';

const INDIVIDUAL_HEADERS = [
  'REASON FOR DELAY', 'TOTAL DELAY TIME\n(HRS)', 'HSD STOCK @ ACCESSION\n(L)',
  'RECEIVED QTY DURING ILM\n(L)', 'HSD STOCK @ SHIFT END\n(L)', 'TOTAL HSD CONSUMPTION\n(L)\n(Auto)',
  'ILM DISTANCE\n(KM)', 'TOTAL LOADS MOVED', 'CUMULATIVE TRAILER KMs', 'AVG CONSUMPTION PER KM\n(Auto)',
];
const INDIVIDUAL_WIDTHS = [22, 14, 16, 16, 16, 16, 12, 14, 16, 16];
const INDIVIDUAL_FIRST_ROW = 13;
const INDIVIDUAL_LAST_ROW = 32;

const TRAILER_TYPES = ['HB', 'LB', 'SEMI'];
const TRAILER_HEADERS = [
  'SR. NO.', 'MT. NO. / GATE PASS NO.', 'TRAILER NO.', 'TRAILER TYPE\n(HB/LB/SEMI)',
  'LOADING DATE\n(DD/MM/YYYY)', 'LOADING TIME\n(HH:MM)', 'LOAD DESCRIPTION', 'TOTAL NO. OF PACKAGES',
  'UNLOADING DATE\n(DD/MM/YYYY)', 'UNLOADING TIME\n(HH:MM)', 'DRIVER NAME', 'DRIVER CONTACT NO.',
];
const TRAILER_WIDTHS = [8, 18, 14, 14, 14, 12, 26, 14, 14, 12, 18, 16];
const TRAILER_FIRST_ROW = 11;
const TRAILER_LAST_ROW = 30;

const RIG_HIRED = ['Rig', 'Hired'];
const CRANE_HEADERS = [
  'CRANE NO.', 'CAPACITY\n(TON)', 'REPORTING DATE\n(DD/MM/YYYY)', 'RIG / HIRED', 'REGISTRATION NO.',
  'ARRIVED DATE\n(DD/MM/YYYY)', 'ARRIVED TIME\n(HH:MM)', 'TRANSPORTER NAME', 'DAY NO.',
  'SHIFT DATE\n(DD/MM/YYYY)', 'DAY SHIFT HRS\n(07:00–19:00)', 'DETAILS OF JOB (DAY)',
  'NIGHT SHIFT HRS\n(19:00–07:00)', 'DETAILS OF JOB (NIGHT)', 'BREAKDOWN HRS', 'CUMULATIVE HRS',
  'ISSUED HSD\n(LTRS)', 'TOTAL WORKING HRS',
];
const CRANE_WIDTHS = [12, 10, 14, 10, 16, 14, 12, 18, 8, 14, 12, 22, 12, 22, 12, 12, 12, 14];
const CRANE_FIRST_ROW = 4;
const CRANE_LAST_ROW = 23;

export async function buildIlmTemplateWorkbook(input: IlmTemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GTC Oilfield Portal';
  wb.created = new Date();

  buildMetaSheet(wb);
  buildListsSheet(wb);
  buildIndividualSheet(wb, input);
  buildTrailerSheet(wb, input);
  buildCraneSheet(wb);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function ilmTemplateFileName(rigNumber: string): string {
  const rigPart = rigNumber.replace(/^\s*(gtc|rig)\s*/i, '').replace(/[^A-Za-z0-9-]+/g, '_');
  return `Rig_${rigPart}_ILM_Template.xlsx`;
}

function buildMetaSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('ILM_Meta', { state: 'veryHidden' });
  ws.getCell('A1').value = 'ILM_TEMPLATE_VERSION';
  ws.getCell('B1').value = ILM_TEMPLATE_VERSION;
}

function buildListsSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('Lists', { state: 'hidden' });
  TRAILER_TYPES.forEach((v, i) => { ws.getCell(i + 1, 2).value = v; }); // col B
  RIG_HIRED.forEach((v, i) => { ws.getCell(i + 1, 3).value = v; });     // col C
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 10;
  ws.getColumn(3).width = 10;
}

function title(ws: ExcelJS.Worksheet, lastCol: string, text: string): void {
  ws.mergeCells(`A1:${lastCol}1`);
  const cell = ws.getCell('A1');
  cell.value = text;
  cell.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BLUE } };
  ws.getRow(1).height = 24;
}

function headerField(ws: ExcelJS.Worksheet, row: number, label: string): ExcelJS.Cell {
  const labelCell = ws.getCell(`A${row}`);
  labelCell.value = label;
  labelCell.font = { bold: true };
  labelCell.alignment = { vertical: 'middle', wrapText: true };
  const valueCell = ws.getCell(`B${row}`);
  valueCell.border = boxBorder();
  valueCell.protection = { locked: false };
  valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  return valueCell;
}

function headerRow(ws: ExcelJS.Worksheet, row: number, headers: string[]): void {
  headers.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 9 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_GREY } };
    cell.border = boxBorder();
    cell.protection = { locked: true };
  });
  ws.getRow(row).height = 32;
}

function entryCell(ws: ExcelJS.Worksheet, r: number, c: number, opts: { numFmt?: string; listRange?: string } = {}): void {
  const cell = ws.getCell(r, c);
  cell.value = null;
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', horizontal: opts.numFmt ? 'center' : 'left', wrapText: !opts.numFmt };
  cell.protection = { locked: false };
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  if (opts.listRange) {
    cell.dataValidation = { type: 'list', allowBlank: true, formulae: [opts.listRange], showErrorMessage: false };
  }
}

function protectSheet(ws: ExcelJS.Worksheet): void {
  ws.protect('', {
    selectLockedCells: true, selectUnlockedCells: true,
    formatCells: false, formatColumns: false, formatRows: false,
    insertRows: false, insertColumns: false, deleteRows: false, deleteColumns: false,
    sort: false, autoFilter: false,
  });
}

function buildIndividualSheet(wb: ExcelJS.Workbook, input: IlmTemplateInput): void {
  const ws = wb.addWorksheet('2_ILM_Individual');
  INDIVIDUAL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  title(ws, 'J', 'MODULE 2 – ILM INDIVIDUAL');

  const dateCell = headerField(ws, 2, 'DATE\n(DD/MM/YYYY)');
  dateCell.value = displayDate(input.date);
  dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };

  const rigCell = headerField(ws, 3, 'RIG NO.');
  rigCell.value = input.rigNumber;
  paintLocked(rigCell);

  headerField(ws, 4, 'AREA');
  headerField(ws, 5, 'MOVEMENT FROM Well');
  headerField(ws, 6, 'MOVEMENT TO Well');
  const relDate = headerField(ws, 7, 'RELEASE DATE\n(DD/MM/YYYY)');
  relDate.numFmt = 'dd/mm/yyyy';
  const relTime = headerField(ws, 8, 'RELEASE TIME\n(HH:MM)');
  relTime.numFmt = 'h:mm';
  const spudDate = headerField(ws, 9, 'SPUD DATE\n(DD/MM/YYYY)');
  spudDate.numFmt = 'dd/mm/yyyy';
  const spudTime = headerField(ws, 10, 'SPUD TIME\n(HH:MM)');
  spudTime.numFmt = 'h:mm';

  headerRow(ws, 12, INDIVIDUAL_HEADERS);

  for (let r = INDIVIDUAL_FIRST_ROW; r <= INDIVIDUAL_LAST_ROW; r++) {
    ws.getRow(r).height = 20;
    entryCell(ws, r, 1);                        // A reason for delay
    entryCell(ws, r, 2, { numFmt: '0.0' });      // B total delay hours
    entryCell(ws, r, 3, { numFmt: '0.0' });      // C HSD stock @ accession
    entryCell(ws, r, 4, { numFmt: '0.0' });      // D received qty during ILM
    entryCell(ws, r, 5, { numFmt: '0.0' });      // E HSD stock @ shift end
    setFormula(ws, r, 6, `IF(AND(C${r}<>"",D${r}<>"",E${r}<>""),C${r}+D${r}-E${r},"")`); // F total HSD consumption
    entryCell(ws, r, 7, { numFmt: '0.0' });      // G ILM distance (km)
    entryCell(ws, r, 8, { numFmt: '0' });        // H total loads moved
    entryCell(ws, r, 9, { numFmt: '0.0' });      // I cumulative trailer km
    setFormula(ws, r, 10, `IF(AND(F${r}<>"",G${r}<>"",G${r}<>0),F${r}/G${r},"")`); // J avg consumption/km
  }

  protectSheet(ws);
}

function buildTrailerSheet(wb: ExcelJS.Workbook, input: IlmTemplateInput): void {
  const ws = wb.addWorksheet('4_ILM_Trailer_Load_Detail');
  TRAILER_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  title(ws, 'L', 'MODULE 4 – ILM TRAILER LOAD DETAIL');

  const rigNameCell = headerField(ws, 2, 'RIG NAME');
  rigNameCell.value = input.rigNumber;
  paintLocked(rigNameCell);

  headerField(ws, 3, 'OLD LOCATION');
  headerField(ws, 4, 'NEW LOCATION');
  headerField(ws, 5, 'Lead Distance to new location').numFmt = '0.0';
  const releaseAt = headerField(ws, 6, 'Rig Release date & time');
  releaseAt.numFmt = 'dd/mm/yyyy hh:mm';
  const reportAt = headerField(ws, 7, 'Fleet report date & time');
  reportAt.numFmt = 'dd/mm/yyyy hh:mm';
  headerField(ws, 8, 'Allowed duration as per contract (Hrs)').numFmt = '0.0';

  headerRow(ws, 10, TRAILER_HEADERS);

  for (let r = TRAILER_FIRST_ROW; r <= TRAILER_LAST_ROW; r++) {
    ws.getRow(r).height = 20;
    entryCell(ws, r, 1, { numFmt: '0' });                              // A sr no
    entryCell(ws, r, 2);                                               // B MT/gate pass no
    entryCell(ws, r, 3);                                               // C trailer no
    entryCell(ws, r, 4, { listRange: `Lists!$B$1:$B$${TRAILER_TYPES.length}` }); // D trailer type
    entryCell(ws, r, 5, { numFmt: 'dd/mm/yyyy' });                     // E loading date
    entryCell(ws, r, 6, { numFmt: 'h:mm' });                           // F loading time
    entryCell(ws, r, 7);                                               // G load description
    entryCell(ws, r, 8, { numFmt: '0' });                              // H total packages
    entryCell(ws, r, 9, { numFmt: 'dd/mm/yyyy' });                     // I unloading date
    entryCell(ws, r, 10, { numFmt: 'h:mm' });                          // J unloading time
    entryCell(ws, r, 11);                                              // K driver name
    entryCell(ws, r, 12);                                              // L driver contact no
  }

  protectSheet(ws);
}

function buildCraneSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('5_ILM_Crane_Detail');
  CRANE_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  title(ws, 'R', 'MODULE 5 – ILM CRANE DETAIL');
  headerRow(ws, 3, CRANE_HEADERS);

  for (let r = CRANE_FIRST_ROW; r <= CRANE_LAST_ROW; r++) {
    ws.getRow(r).height = 20;
    entryCell(ws, r, 1);                                               // A crane no
    entryCell(ws, r, 2, { numFmt: '0.0' });                            // B capacity (ton)
    entryCell(ws, r, 3, { numFmt: 'dd/mm/yyyy' });                     // C reporting date
    entryCell(ws, r, 4, { listRange: `Lists!$C$1:$C$${RIG_HIRED.length}` }); // D rig/hired
    entryCell(ws, r, 5);                                               // E registration no
    entryCell(ws, r, 6, { numFmt: 'dd/mm/yyyy' });                     // F arrived date
    entryCell(ws, r, 7, { numFmt: 'h:mm' });                           // G arrived time
    entryCell(ws, r, 8);                                               // H transporter name
    entryCell(ws, r, 9, { numFmt: '0' });                              // I day no
    entryCell(ws, r, 10, { numFmt: 'dd/mm/yyyy' });                    // J shift date
    entryCell(ws, r, 11, { numFmt: '0.0' });                           // K day shift hrs
    entryCell(ws, r, 12);                                              // L details of job (day)
    entryCell(ws, r, 13, { numFmt: '0.0' });                           // M night shift hrs
    entryCell(ws, r, 14);                                              // N details of job (night)
    entryCell(ws, r, 15, { numFmt: '0.0' });                           // O breakdown hrs
    entryCell(ws, r, 16, { numFmt: '0.0' });                           // P cumulative hrs
    entryCell(ws, r, 17, { numFmt: '0.0' });                           // Q issued HSD (ltrs)
    entryCell(ws, r, 18, { numFmt: '0.0' });                           // R total working hrs
  }

  protectSheet(ws);
}
