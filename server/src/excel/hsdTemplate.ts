import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daysInMonth, dateFromMonthDay, monthName } from '../util/date.js';

/**
 * Produces the HSD (diesel consumption) template for one rig and month.
 *
 * Unlike the DPR template (excel/dprTemplate.ts), which is drawn cell by cell,
 * this one starts from the customer's own master workbook — checked in at
 * assets/hsd-master-template.xlsx — and only blanks the crew-entry cells and
 * stamps the rig and dates. Re-drawing 35 sheets by hand would inevitably
 * drift from the original's columns, formulas and formatting; copying it
 * cannot. Everything the crew does not type (headers, the D=B+C / I=D-E /
 * H=G+F / J=IFERROR(E/F) formulas, the four rollup sheets, column widths,
 * fills and borders) survives untouched.
 */

export interface HsdTemplateInput {
  rigNumber: string;
  logMonth: string; // YYYY-MM
}

const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'assets', 'hsd-master-template.xlsx',
);

/** Cell map of one day sheet — the same one hsdIngest.ts reads back. */
const RIG_CELL = 'B2';
const DATE_CELL = 'H2';
const WELL_CELL = 'B3';
const HOURS_CELLS = ['C4', 'D4', 'E4', 'F4'];       // R1 R2 R3 ILM
const EQUIP_FIRST_ROW = 6, EQUIP_LAST_ROW = 26;
/** Columns the crew fills on an equipment row; the rest are formulas or the pre-printed name. */
const EQUIP_INPUT_COLUMNS = [2, 3, 5, 6, 7, 11];    // B C E F G K
const SITE_ROWS = [30, 31];
// B C E F H — D and G are formulas and are skipped by clearValue(); on the
// diesel row E and F are formulas too (=C27/=E27) and likewise survive.
const SITE_INPUT_COLUMNS = [2, 3, 5, 6, 8];
const LAST_SHEET_DAY = 31;

/** The month/rig header on the rollup sheet, stamped so the file identifies itself. */
const MASTER_SHEET = 'HSD Consumption Master Seet';
const MASTER_MONTH_CELL = 'C2';
const MASTER_RIG_CELL = 'G2';

let cachedTemplate: Buffer | null = null;

function templateBytes(): Buffer {
  if (!cachedTemplate) cachedTemplate = fs.readFileSync(TEMPLATE_PATH);
  return cachedTemplate;
}

export async function buildHsdTemplateWorkbook(input: HsdTemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // exceljs types `load` against the older Buffer<ArrayBuffer>; the bytes are
  // the same either way.
  await wb.xlsx.load(templateBytes() as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const total = daysInMonth(input.logMonth);

  // The source workbook is a filled-in month, so every formula cell also
  // carries last month's cached result. Excel recalculates on open, but a
  // viewer that does not would show those stale numbers in a blank template —
  // drop the cached results everywhere and keep only the formulas.
  wb.eachSheet((sheet) => stripFormulaResults(sheet));

  for (let day = 1; day <= LAST_SHEET_DAY; day++) {
    const ws = wb.getWorksheet(String(day));
    if (!ws) continue;
    blankDaySheet(ws);

    ws.getCell(RIG_CELL).value = input.rigNumber;
    // Days past the end of a short month keep their sheet but carry no date,
    // so the importer treats them as unused rather than mis-dated.
    const iso = day <= total ? dateFromMonthDay(input.logMonth, day) : null;
    ws.getCell(DATE_CELL).value = iso ? new Date(`${iso}T00:00:00Z`) : null;
  }

  const master = wb.getWorksheet(MASTER_SHEET);
  if (master) {
    master.getCell(MASTER_MONTH_CELL).value = new Date(`${dateFromMonthDay(input.logMonth, 1)}T00:00:00Z`);
    master.getCell(MASTER_RIG_CELL).value = input.rigNumber;
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Clears what the crew types, and only that: the header well/hours block, the
 * input columns of each equipment row, and the site diesel block. Formula
 * cells are left alone — overwriting one would replace the formula with a
 * literal and quietly break the sheet's arithmetic for the user.
 */
function blankDaySheet(ws: ExcelJS.Worksheet): void {
  ws.getCell(WELL_CELL).value = null;
  for (const ref of HOURS_CELLS) ws.getCell(ref).value = null;

  for (let r = EQUIP_FIRST_ROW; r <= EQUIP_LAST_ROW; r++) {
    for (const c of EQUIP_INPUT_COLUMNS) clearValue(ws.getCell(r, c));
  }
  for (const r of SITE_ROWS) {
    for (const c of SITE_INPUT_COLUMNS) clearValue(ws.getCell(r, c));
  }
}

/** Rewrites every formula cell as formula-only, discarding the cached result Excel stored alongside it. */
function stripFormulaResults(ws: ExcelJS.Worksheet): void {
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value as Record<string, unknown> | null;
      if (!v || typeof v !== 'object') return;
      if (typeof v.formula !== 'string' && typeof v.sharedFormula !== 'string') return;
      // Keep every other key (ref/shareType carry Excel's shared-formula
      // grouping); dropping them would unshare the formula and lose it.
      const { result: _drop, ...rest } = v;
      cell.value = rest as unknown as ExcelJS.CellValue;
    });
  });
}

function clearValue(cell: ExcelJS.Cell): void {
  if (cell.formula || (cell.value && typeof cell.value === 'object' && 'formula' in cell.value)) return;
  cell.value = null;
}

export function hsdTemplateFileName(rigNumber: string, logMonth: string): string {
  const rigPart = rigNumber.replace(/^\s*(gtc|rig)\s*/i, '').replace(/[^A-Za-z0-9-]+/g, '_');
  return `Rig_${rigPart}_HSD_${monthName(logMonth)}.xlsx`;
}
