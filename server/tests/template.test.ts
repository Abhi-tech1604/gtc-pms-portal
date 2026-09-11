import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildTemplateWorkbook, templateFileName } from '../src/excel/template.js';
import { parseWorkbook } from '../src/excel/parseWorkbook.js';

/** Section 12.1. The generated workbook is re-opened and inspected cell by cell. */

const machines = [
  {
    name: 'Rig Engine 1', makeModel: 'CAT-15', serialNumber: 'JDK00371',
    currentRunningHours: 25403, lastServiceHours: 25118, serviceInterval: 500,
    section: 'diesel' as const,
  },
  {
    name: 'DG set-1 125 kVA', makeModel: 'SVE-125', serialNumber: 'SWE9171801',
    currentRunningHours: 1465, lastServiceHours: 1245, serviceInterval: 500,
    section: 'generator' as const,
  },
];

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs types its loader against its own Buffer alias; the bytes are the same.
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

test('T1 - a rig with equipment gets 31 sheets with its machines pre-filled', async () => {
  const wb = await open(await buildTemplateWorkbook({
    rigNumber: 'GTC 50-01', rigName: 'Rig 50-01', logMonth: '2026-08', machines,
  }));

  assert.equal(wb.worksheets.length, 31);
  assert.deepEqual(wb.worksheets.map((w) => w.name).slice(0, 3), ['1', '2', '3']);

  const day1 = wb.getWorksheet('1')!;
  assert.equal(day1.getCell('B1').value, 'GTC 50-01');
  assert.equal(day1.getCell('B6').value, 'Rig Engine 1');
  assert.equal(day1.getCell('C6').value, 'CAT-15');
  assert.equal(day1.getCell('D6').value, 'JDK00371');
  assert.equal(day1.getCell('J6').value, 25403, 'day 1 opening is seeded from the register');
  assert.equal(day1.getCell('M6').value, 25118, 'the last service baseline is seeded');
  assert.equal(day1.getCell('O6').value, 500, 'the interval is seeded');
  // Generators go into the second section.
  assert.equal(day1.getCell('B28').value, 'DG set-1 125 kVA');
});

test('T2 - a rig with no equipment still gets ten fully wired rows per section (D13)', async () => {
  const wb = await open(await buildTemplateWorkbook({
    rigNumber: 'GTC 300-01', rigName: 'Rig 300-01', logMonth: '2026-08', machines: [],
  }));
  const day5 = wb.getWorksheet('5')!;

  for (const r of [6, 10, 15, 28, 32, 37]) {
    assert.equal(day5.getCell(`B${r}`).value, '', `row ${r} is a blank crew row`);
    assert.equal((day5.getCell(`K${r}`).value as ExcelJS.CellFormulaValue).formula, `F${r}+G${r}`);
    assert.equal((day5.getCell(`L${r}`).value as ExcelJS.CellFormulaValue).formula, `J${r}+K${r}`);
    assert.equal((day5.getCell(`N${r}`).value as ExcelJS.CellFormulaValue).formula, `L${r}-M${r}`);
    assert.equal((day5.getCell(`P${r}`).value as ExcelJS.CellFormulaValue).formula, `O${r}-N${r}`);
  }
});

test('T3 - the rig number and the date are locked, crew fields are not', async () => {
  const wb = await open(await buildTemplateWorkbook({
    rigNumber: 'GTC 50-01', rigName: 'Rig 50-01', logMonth: '2026-08', machines,
  }));
  const sheet = wb.getWorksheet('12')!;

  assert.ok(sheet.protect, 'the sheet is protected');
  // Locked is the Excel default, so a locked cell carries no explicit flag once
  // the file is written; what matters is that it is never unlocked.
  assert.notEqual(sheet.getCell('B1').protection?.locked, false, 'rig number locked');
  assert.notEqual(sheet.getCell('Q1').protection?.locked, false, 'date locked');
  assert.equal(sheet.getCell('B2').protection?.locked, false, 'well number stays editable');

  for (const col of ['K', 'L', 'N', 'P']) {
    assert.notEqual(sheet.getCell(`${col}6`).protection?.locked, false, `${col} is a formula cell`);
  }
  for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'M', 'O', 'Q', 'R', 'S']) {
    assert.equal(sheet.getCell(`${col}6`).protection?.locked, false, `${col} is a crew field`);
  }
  // J is locked on carry-forward days and unlocked on day one.
  assert.notEqual(sheet.getCell('J6').protection?.locked, false);
  assert.equal(wb.getWorksheet('1')!.getCell('J6').protection?.locked, false);
});

test('T4 - day 2 opening pulls day 1 closing, all the way to day 31', async () => {
  const wb = await open(await buildTemplateWorkbook({
    rigNumber: 'GTC 50-01', rigName: 'Rig 50-01', logMonth: '2026-08', machines,
  }));
  for (let day = 2; day <= 31; day++) {
    const cell = wb.getWorksheet(String(day))!.getCell('J6').value as ExcelJS.CellFormulaValue;
    assert.equal(cell.formula, `'${day - 1}'!L6`, `day ${day} must carry forward from day ${day - 1}`);
  }
});

test('T5 - the arithmetic chain is present on every data row of every sheet', async () => {
  const wb = await open(await buildTemplateWorkbook({
    rigNumber: 'GTC 50-01', rigName: 'Rig 50-01', logMonth: '2026-08', machines,
  }));
  const rows = [...range(6, 15), ...range(28, 37)];
  for (const sheet of wb.worksheets) {
    for (const r of rows) {
      const k = sheet.getCell(`K${r}`).value as ExcelJS.CellFormulaValue;
      const p = sheet.getCell(`P${r}`).value as ExcelJS.CellFormulaValue;
      assert.equal(k.formula, `F${r}+G${r}`, `sheet ${sheet.name} row ${r}`);
      assert.equal(p.formula, `O${r}-N${r}`, `sheet ${sheet.name} row ${r}`);
    }
  }
});

test('the generated template round-trips through the ingestion parser', async () => {
  const buffer = await buildTemplateWorkbook({
    rigNumber: 'GTC 50-01', rigName: 'Rig 50-01', logMonth: '2026-08', machines,
  });
  const parsed = parseWorkbook(buffer);
  assert.equal(parsed.rigNumberInFile, 'GTC 50-01');
  assert.equal(parsed.logMonth, '2026-08');

  // Total Run Hours (column K) is a live formula the crew's own entries drive;
  // a fresh template has nothing typed into it anywhere, seeded baseline
  // included, so nothing yet passes the real-data test of 8.3.
  assert.equal(parsed.groups.length, 0, 'an untouched template has nothing real to import yet');
});

test('the filename identifies the rig and month', () => {
  assert.equal(
    templateFileName('GTC 50-01', '2026-08'),
    'Mechanical_Log_Sheet_Rig_50-01_August_2026.xlsx',
  );
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
