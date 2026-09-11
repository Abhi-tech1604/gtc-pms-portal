import ExcelJS from 'exceljs';
import { displayDate } from '../util/date.js';
import { boxBorder, paintLocked, setFormula } from './template.js';
import { listEquipment } from '../services/equipmentView.js';
import {
  getScopedOilRows, HYDRAULIC_TANKS, SHIFT_OPTIONS, EQUIPMENT_STATUS_OPTIONS,
} from '../routes/dailyRigReport.js';
import {
  getPreviousEquipmentHours, getPreviousHsdOpening, getPreviousHydraulicLevel, getPreviousOilBalance,
} from '../services/drrCarryForward.js';

/**
 * Admin-only DRR Excel Import template: one rig, one day, built live from the
 * exact same master-data functions the manual DRR form's prefill uses
 * (listEquipment, getScopedOilRows, the drrCarryForward getPrevious* helpers)
 * so equipment/oil rows and every opening balance always match what typing
 * the same rig+date into the web form would show — and so a newly added
 * machine or oil is automatically on the very next download.
 *
 * Sections are marked with a plain-text banner in column A rather than
 * fixed row numbers (contrast dprTemplate.ts/ilmTemplate.ts, whose section
 * sizes are fixed) — equipment/oil row *counts* are genuinely dynamic per
 * rig, so drrIngest.ts locates each section by scanning for its marker
 * instead of assuming an offset computed from current master data, which
 * could have drifted between download and upload.
 */

export const DRR_TEMPLATE_VERSION = '1.0';

export const SECTION_MARKERS = {
  dprActivity: '### DPR ACTIVITY ###',
  hsdSummary: '### HSD SUMMARY ###',
  equipment: '### EQUIPMENT RUNNING HOURS ###',
  oil: '### LUBRICATING OIL ###',
  hydraulic: '### HYDRAULIC OIL ###',
} as const;

// Copied from client/src/lib/dprLists.ts (which documents copying this same
// list from dprTemplate.ts) — the one place all three copies must stay equal.
const DPR_WORK_TYPES = ['R0', 'R1', 'R2', 'R2/2', 'R3', 'ILM'];
const DPR_ACTIVITY_CODES = [
  '02 - Drilling', '03 - Reaming', '04 - Coring', '05 - C&C', '06 - Tripping', '07 - Lubrication',
  '08 - Breakdown', '09 - Slip & Cut', '10 - Deviation Survey', '11 - Logging', '12 - Casing R/in',
  '13 - Wait on Cement', '14 - Nipple Up/Down BOP', '15 - Test BOP', '16 - Drill Stem BOP',
  '17 - Plug Back', '18 - Cementing', '19 - Fishing', '20 - Directional Work', '21 - Tubing Job',
  '22 - Testing LOT CIT', '23 - Other',
];

const DPR_ACTIVITY_ROWS = 15;
const HEADER_GREY = 'FFD9D9D9';
const BANNER_BLUE = 'FF2D7DD2';

export interface DrrTemplateInput {
  rigId: string;
  rigNumber: string;
  reportDate: string; // YYYY-MM-DD
}

export async function buildDrrTemplateWorkbook(input: DrrTemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GTC Oilfield Portal';
  wb.created = new Date();

  const equipment = listEquipment(input.rigId).filter((e) => e.isActive);
  const oils = getScopedOilRows(input.rigId);
  const hsdOpening = getPreviousHsdOpening(input.rigId, input.reportDate).siteDieselClosing ?? 0;

  buildMetaSheet(wb);
  buildListsSheet(wb, equipment.map((e) => e.name));
  buildDrrSheet(wb, input, equipment, oils, hsdOpening);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function drrTemplateFileName(rigNumber: string, reportDate: string): string {
  const rigPart = rigNumber.replace(/^\s*(gtc|rig)\s*/i, '').replace(/[^A-Za-z0-9-]+/g, '_');
  return `Rig_${rigPart}_DRR_${reportDate}_Template.xlsx`;
}

function buildMetaSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('DRR_Meta', { state: 'veryHidden' });
  ws.getCell('A1').value = 'DRR_TEMPLATE_VERSION';
  ws.getCell('B1').value = DRR_TEMPLATE_VERSION;
}

function buildListsSheet(wb: ExcelJS.Workbook, equipmentNames: string[]): void {
  const ws = wb.addWorksheet('Lists', { state: 'hidden' });
  DPR_WORK_TYPES.forEach((v, i) => { ws.getCell(i + 1, 1).value = v; });      // col A
  DPR_ACTIVITY_CODES.forEach((v, i) => { ws.getCell(i + 1, 2).value = v; });  // col B
  SHIFT_OPTIONS.forEach((v, i) => { ws.getCell(i + 1, 3).value = v; });       // col C
  EQUIPMENT_STATUS_OPTIONS.forEach((v, i) => { ws.getCell(i + 1, 4).value = v; }); // col D
  ['Yes', 'No'].forEach((v, i) => { ws.getCell(i + 1, 5).value = v; });       // col E
  equipmentNames.forEach((v, i) => { ws.getCell(i + 1, 6).value = v; });     // col F
  ws.getColumn(1).width = 6; ws.getColumn(2).width = 22; ws.getColumn(3).width = 8;
  ws.getColumn(4).width = 14; ws.getColumn(5).width = 6; ws.getColumn(6).width = 28;
}

function headerField(ws: ExcelJS.Worksheet, row: number, label: string): ExcelJS.Cell {
  const labelCell = ws.getCell(`A${row}`);
  labelCell.value = label;
  labelCell.font = { bold: true };
  labelCell.alignment = { vertical: 'middle' };
  const valueCell = ws.getCell(`B${row}`);
  valueCell.border = boxBorder();
  valueCell.protection = { locked: false };
  return valueCell;
}

function marker(ws: ExcelJS.Worksheet, row: number, lastCol: string, text: string): void {
  ws.mergeCells(`A${row}:${lastCol}${row}`);
  const cell = ws.getCell(`A${row}`);
  cell.value = text;
  cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BANNER_BLUE } };
  ws.getRow(row).height = 22;
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
  ws.getRow(row).height = 30;
}

function entryCell(ws: ExcelJS.Worksheet, r: number, c: number, opts: { numFmt?: string; listRange?: string; hidden?: boolean } = {}): ExcelJS.Cell {
  const cell = ws.getCell(r, c);
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', horizontal: opts.numFmt ? 'center' : 'left', wrapText: !opts.numFmt };
  cell.protection = { locked: !!opts.hidden };
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  if (opts.listRange) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [opts.listRange], showErrorMessage: false };
  return cell;
}

function lockedCell(ws: ExcelJS.Worksheet, r: number, c: number, value: unknown, opts: { hidden?: boolean } = {}): ExcelJS.Cell {
  const cell = ws.getCell(r, c);
  cell.value = value as ExcelJS.CellValue;
  cell.border = boxBorder();
  cell.alignment = { vertical: 'middle', wrapText: true };
  cell.protection = { locked: true };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  if (opts.hidden) { cell.font = { color: { argb: 'FFF2F2F2' } }; }
  return cell;
}

function buildDrrSheet(
  wb: ExcelJS.Workbook,
  input: DrrTemplateInput,
  equipment: ReturnType<typeof listEquipment>,
  oils: { id: string; name: string }[],
  hsdOpening: number,
): void {
  const ws = wb.addWorksheet('DRR');
  ws.getColumn(1).width = 24;
  for (let c = 2; c <= 17; c++) ws.getColumn(c).width = 14;

  ws.mergeCells('A1:F1');
  const title = ws.getCell('A1');
  title.value = 'DAILY RIG REPORT';
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BANNER_BLUE } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 26;

  const rigCell = headerField(ws, 2, 'Rig No.');
  rigCell.value = input.rigNumber;
  paintLocked(rigCell);
  const dateCell = headerField(ws, 3, 'Date (DD/MM/YYYY)');
  dateCell.value = displayDate(input.reportDate);
  paintLocked(dateCell);
  headerField(ws, 4, 'Well No.');
  const shiftCell = headerField(ws, 5, 'Shift');
  shiftCell.dataValidation = { type: 'list', allowBlank: false, formulae: [`Lists!$C$1:$C$${SHIFT_OPTIONS.length}`], showErrorMessage: false };
  headerField(ws, 6, 'Field / Location');
  headerField(ws, 7, 'Submitted By (optional)');

  // ---- DPR Activity ----
  const dprMarkerRow = 9;
  marker(ws, dprMarkerRow, 'Q', SECTION_MARKERS.dprActivity);
  const dprHeaderRow = dprMarkerRow + 1;
  headerRow(ws, dprHeaderRow, [
    'Well', 'Operation', 'Work Type', 'Start (HH:MM)', 'End (HH:MM)', 'Total (H)', 'Description / Remarks',
    'Breakdown Equip.', 'Breakdown Reason', 'Drill Sec.', 'Drill From', 'Drill To', 'Drill Total',
    'Casing Sec.', 'Casing From', 'Casing To', 'Casing Total',
  ]);
  const dprFirstDataRow = dprHeaderRow + 1;
  const dprLastDataRow = dprFirstDataRow + DPR_ACTIVITY_ROWS - 1;
  for (let r = dprFirstDataRow; r <= dprLastDataRow; r++) {
    entryCell(ws, r, 1);
    entryCell(ws, r, 2, { listRange: `Lists!$B$1:$B$${DPR_ACTIVITY_CODES.length}` });
    entryCell(ws, r, 3, { listRange: `Lists!$A$1:$A$${DPR_WORK_TYPES.length}` });
    entryCell(ws, r, 4, { numFmt: 'h:mm' });
    entryCell(ws, r, 5, { numFmt: 'h:mm' });
    setFormula(ws, r, 6, `IF(AND(D${r}<>"",E${r}<>""),MOD(E${r}-D${r},1)*24,"")`);
    entryCell(ws, r, 7);
    entryCell(ws, r, 8, { listRange: `Lists!$F$1:$F$${Math.max(equipment.length, 1)}` });
    entryCell(ws, r, 9);
    entryCell(ws, r, 10);
    entryCell(ws, r, 11, { numFmt: '0.00' });
    entryCell(ws, r, 12, { numFmt: '0.00' });
    setFormula(ws, r, 13, `IF(AND(K${r}<>"",L${r}<>""),L${r}-K${r},"")`);
    entryCell(ws, r, 14);
    entryCell(ws, r, 15, { numFmt: '0.00' });
    entryCell(ws, r, 16, { numFmt: '0.00' });
    setFormula(ws, r, 17, `IF(AND(O${r}<>"",P${r}<>""),P${r}-O${r},"")`);
  }

  // ---- HSD Summary (row numbers reserved here; formulas need the equipment
  // range, which is computed next, so its cells are written after that) ----
  const hsdMarker = dprLastDataRow + 2;
  const HSD_SUMMARY_ROWS = 7; // opening/received/total-avail/total-consumption/closing/average/remarks
  const hsdLastRow = hsdMarker + HSD_SUMMARY_ROWS;

  // ---- Equipment Running Hours ----
  const equipMarkerRow = hsdLastRow + 2;
  const equipHeaderRow = equipMarkerRow + 1;
  const equipFirstDataRow = equipHeaderRow + 1;
  const equipLastDataRow = equipFirstDataRow + Math.max(equipment.length, 1) - 1;

  marker(ws, equipMarkerRow, 'O', SECTION_MARKERS.equipment);
  headerRow(ws, equipHeaderRow, [
    'Equipment', 'Make/Model', 'Serial No.', 'Opening Hrs', 'Day Hrs', 'Night Hrs', 'Total Hrs',
    'Closing Hrs', 'Last Service Hrs', 'HSD Consumption', 'Status', 'Remarks',
    'Service Done Today (Yes/No)', 'Service Hours', 'Equipment ID',
  ]);
  equipment.forEach((e, i) => {
    const r = equipFirstDataRow + i;
    const opening = getPreviousEquipmentHours(e.id, input.reportDate);
    lockedCell(ws, r, 1, e.name);
    lockedCell(ws, r, 2, [e.manufacturer, e.model].filter(Boolean).join(' '));
    lockedCell(ws, r, 3, e.serialNumber ?? '');
    lockedCell(ws, r, 4, opening.openingRunningHours);
    entryCell(ws, r, 5, { numFmt: '0.00' });
    entryCell(ws, r, 6, { numFmt: '0.00' });
    setFormula(ws, r, 7, `E${r}+F${r}`);
    setFormula(ws, r, 8, `D${r}+G${r}`);
    lockedCell(ws, r, 9, e.lastServiceHours);
    entryCell(ws, r, 10, { numFmt: '0.00' });
    entryCell(ws, r, 11, { listRange: `Lists!$D$1:$D$${EQUIPMENT_STATUS_OPTIONS.length}` });
    entryCell(ws, r, 12);
    entryCell(ws, r, 13, { listRange: `Lists!$E$1:$E$2` });
    entryCell(ws, r, 14, { numFmt: '0.00' });
    lockedCell(ws, r, 15, e.id, { hidden: true });
  });
  if (equipment.length === 0) {
    ws.mergeCells(`A${equipFirstDataRow}:O${equipFirstDataRow}`);
    ws.getCell(`A${equipFirstDataRow}`).value = 'No active equipment registered for this rig.';
  }

  // ---- Lubricating Oil ----
  const oilMarkerRow = equipLastDataRow + 2;
  const oilHeaderRow = oilMarkerRow + 1;
  const oilFirstDataRow = oilHeaderRow + 1;
  const oilLastDataRow = oilFirstDataRow + Math.max(oils.length, 1) - 1;

  marker(ws, oilMarkerRow, 'G', SECTION_MARKERS.oil);
  headerRow(ws, oilHeaderRow, ['Oil Type', 'Opening Bal.', 'Added', 'Consumed', 'Closing Bal.', 'Remark', 'Oil ID']);
  oils.forEach((o, i) => {
    const r = oilFirstDataRow + i;
    const openingBalance = getPreviousOilBalance(null, o.name, input.rigId, input.reportDate) ?? 0;
    lockedCell(ws, r, 1, o.name);
    lockedCell(ws, r, 2, openingBalance);
    entryCell(ws, r, 3, { numFmt: '0.00' });
    entryCell(ws, r, 4, { numFmt: '0.00' });
    setFormula(ws, r, 5, `B${r}+C${r}-D${r}`);
    entryCell(ws, r, 6);
    lockedCell(ws, r, 7, o.id, { hidden: true });
  });
  if (oils.length === 0) {
    ws.mergeCells(`A${oilFirstDataRow}:G${oilFirstDataRow}`);
    ws.getCell(`A${oilFirstDataRow}`).value = 'No oil/lubricant assigned to this rig\'s equipment yet.';
  }

  // ---- Hydraulic Oil ----
  const hydMarkerRow = oilLastDataRow + 2;
  const hydHeaderRow = hydMarkerRow + 1;
  const hydFirstDataRow = hydHeaderRow + 1;
  const hydLastDataRow = hydFirstDataRow + HYDRAULIC_TANKS.length - 1;

  marker(ws, hydMarkerRow, 'F', SECTION_MARKERS.hydraulic);
  headerRow(ws, hydHeaderRow, ['Tank', 'Opening Level', 'Top-up', 'Loss', 'Closing Level', 'Remark']);
  HYDRAULIC_TANKS.forEach((tankName, i) => {
    const r = hydFirstDataRow + i;
    const openingLevel = getPreviousHydraulicLevel(input.rigId, tankName, input.reportDate) ?? 0;
    lockedCell(ws, r, 1, tankName);
    lockedCell(ws, r, 2, openingLevel);
    entryCell(ws, r, 3, { numFmt: '0.00' });
    entryCell(ws, r, 4, { numFmt: '0.00' });
    setFormula(ws, r, 5, `B${r}+C${r}-D${r}`);
    entryCell(ws, r, 6);
  });

  // ---- HSD Summary cells (rows reserved above; written now that the
  // equipment range is known, so SUM()/average formulas can reference it) ----
  marker(ws, hsdMarker, 'B', SECTION_MARKERS.hsdSummary);
  headerField(ws, hsdMarker + 1, 'Opening Stock (L)').value = hsdOpening;
  paintLocked(ws.getCell(`B${hsdMarker + 1}`));
  headerField(ws, hsdMarker + 2, 'HSD Received / Top-up (L)');
  const totalAvailCell = headerField(ws, hsdMarker + 3, 'Total Available HSD (L)');
  setFormula(ws, hsdMarker + 3, 2, `B${hsdMarker + 1}+B${hsdMarker + 2}`);
  void totalAvailCell;
  setFormula(ws, hsdMarker + 4, 2, `SUM(J${equipFirstDataRow}:J${equipLastDataRow})`);
  ws.getCell(`A${hsdMarker + 4}`).value = 'Total Consumption (L)';
  ws.getCell(`A${hsdMarker + 4}`).font = { bold: true };
  setFormula(ws, hsdMarker + 5, 2, `B${hsdMarker + 3}-B${hsdMarker + 4}`);
  ws.getCell(`A${hsdMarker + 5}`).value = 'Closing HSD (L)';
  ws.getCell(`A${hsdMarker + 5}`).font = { bold: true };
  setFormula(ws, hsdMarker + 6, 2, `IF(SUM(G${equipFirstDataRow}:G${equipLastDataRow})>0,B${hsdMarker + 4}/SUM(G${equipFirstDataRow}:G${equipLastDataRow}),"")`);
  ws.getCell(`A${hsdMarker + 6}`).value = 'Average Consumption (L/hr)';
  ws.getCell(`A${hsdMarker + 6}`).font = { bold: true };
  headerField(ws, hsdMarker + 7, 'HSD Remarks');

  ws.protect('', {
    selectLockedCells: true, selectUnlockedCells: true,
    formatCells: false, formatColumns: false, formatRows: false,
    insertRows: false, insertColumns: false, deleteRows: false, deleteColumns: false,
    sort: false, autoFilter: false,
  });
  // The Equipment ID / Oil ID columns stay visible (not column-hidden) —
  // column-level hide would apply sheet-wide and these column letters are
  // reused by other sections (e.g. column O is also DPR Activity's "Casing
  // From"). Being locked + sheet-protected is enough to keep an admin from
  // editing them; the grey fill from lockedCell() marks them as read-only.
}
