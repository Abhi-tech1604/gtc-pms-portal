import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { buildDprTemplateWorkbook, dprTemplateFileName } from '../src/excel/dprTemplate.js';
import { parseDprWorkbook } from '../src/excel/dprIngest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, 'fixtures', name);

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

const DROPDOWN_COLUMNS = ['B', 'C', 'H', 'I', 'M'];

test('the workbook has exactly 31 sheets named "1".."31" — the same convention the Mechanical Log module uses — plus a hidden Lists sheet backing the dropdowns', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 200-01', logMonth: '2026-08' });
  const wb = await open(buf);
  assert.equal(wb.worksheets.length, 32, '31 day-sheets + 1 hidden Lists sheet');
  for (let day = 1; day <= 31; day++) assert.ok(wb.getWorksheet(String(day)), `sheet "${day}" exists`);
  const lists = wb.getWorksheet('Lists');
  assert.ok(lists, 'the Lists sheet is present');
  assert.equal(lists!.state, 'hidden');
});

/**
 * Regression: this module's Excel format was rewritten mid-session for the
 * 31-sheet-per-month convention, and that rewrite accidentally dropped the
 * Lists sheet and every dropdown along with the old single-sheet layout —
 * a real user-visible regression, not a hypothetical one (the sample this
 * asserts against, tests/fixtures/dpr-sample-with-dropdowns.xlsx, is this
 * module's own earlier generated output, back when dropdowns still worked).
 * Every dropdown cell and its exact list source is asserted against that
 * real sample, not an invented expectation.
 */
test('every dropdown cell in the sample workbook has an identical dropdown in the generated workbook', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 100-03', logMonth: '2026-08' });
  const generated = await open(buf);
  const sampleWb = new ExcelJS.Workbook();
  await sampleWb.xlsx.readFile(fixture('dpr-sample-with-dropdowns.xlsx'));

  const sample = sampleWb.getWorksheet('DPR')!;
  const gen = generated.getWorksheet('1')!; // day-sheet "1" plays the sample's single "DPR" sheet's role

  let checked = 0;
  for (let r = 4; r <= 19; r++) {
    for (const col of DROPDOWN_COLUMNS) {
      const sampleFormula = (sample.getCell(`${col}${r}`).dataValidation as { formulae?: string[] } | undefined)?.formulae?.[0];
      const genFormula = (gen.getCell(`${col}${r}`).dataValidation as { formulae?: string[] } | undefined)?.formulae?.[0];
      assert.ok(sampleFormula, `sanity check: sample really has a dropdown at ${col}${r}`);
      assert.equal(genFormula, sampleFormula, `${col}${r} dropdown source matches the sample exactly`);
      checked++;
    }
  }
  assert.equal(checked, 16 * 5, 'all 80 dropdown cells (16 rows x 5 columns) were checked');
});

test('a dropdown\'s list values in the generated Lists sheet match the sample\'s exactly', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 100-03', logMonth: '2026-08' });
  const generated = await open(buf);
  const sampleWb = new ExcelJS.Workbook();
  await sampleWb.xlsx.readFile(fixture('dpr-sample-with-dropdowns.xlsx'));

  const sampleLists = sampleWb.getWorksheet('Lists')!;
  const genLists = generated.getWorksheet('Lists')!;
  for (const col of [2, 3, 4, 5, 6]) { // B..F
    const sampleValues: unknown[] = [];
    const genValues: unknown[] = [];
    for (let r = 1; r <= 22; r++) {
      const sv = sampleLists.getCell(r, col).value;
      const gv = genLists.getCell(r, col).value;
      if (sv !== null && sv !== undefined) sampleValues.push(sv);
      if (gv !== null && gv !== undefined) genValues.push(gv);
    }
    assert.deepEqual(genValues, sampleValues, `Lists column ${String.fromCharCode(64 + col)} values match`);
  }
});

test('every one of the 31 day-sheets carries the same dropdowns, not just the first', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 200-01', logMonth: '2026-08' });
  const wb = await open(buf);
  for (const day of [1, 15, 31]) {
    const ws = wb.getWorksheet(String(day))!;
    const dv = ws.getCell('B10').dataValidation as { formulae?: string[]; type?: string } | undefined;
    assert.equal(dv?.type, 'list', `sheet "${day}" B10 is a real list dropdown`);
    assert.equal(dv?.formulae?.[0], 'Lists!$C$1:$C$22', `sheet "${day}" B10 points at the same shared Lists range`);
  }
});

test('a value picked from the dropdown round-trips through the parser exactly as typed', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 50-01', logMonth: '2026-08' });
  const wb = await open(buf);
  const day1 = wb.getWorksheet('1')!;
  day1.getCell('A4').value = 'WELL-DROPDOWN';
  day1.getCell('B4').value = '18 - Cementing'; // a value that only exists in the Lists!$C range
  day1.getCell('C4').value = 'ILM';            // a value that only exists in the Lists!$B range
  day1.getCell('D4').value = '06:00';
  day1.getCell('E4').value = '12:00';

  const refilled = Buffer.from(await wb.xlsx.writeBuffer());
  const parsed = parseDprWorkbook(refilled);
  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.days[0].lines[0].operationCode, '18 - Cementing');
  assert.equal(parsed.days[0].lines[0].workType, 'ILM');
});

test('the rig and the date are both pre-filled and locked on every sheet — spec 9 fixes both, matching the Mechanical Log convention', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 200-01', logMonth: '2026-08' });
  const wb = await open(buf);
  const day1 = wb.getWorksheet('1')!;
  const day15 = wb.getWorksheet('15')!;
  assert.equal(day1.getCell('B2').value, 'GTC 200-01', 'the user never has to type the rig');
  assert.equal(day15.getCell('B2').value, 'GTC 200-01', 'the rig is fixed for every sheet, not just the first');
  assert.equal(day1.getCell('E2').value, '01-08-2026');
  assert.equal(day15.getCell('E2').value, '15-08-2026', 'the date advances one day per sheet');
  // Locked is the Excel default once sheet protection is on, so a locked cell
  // carries no explicit flag once the file is written — what matters is it is
  // never explicitly unlocked.
  assert.notEqual(day1.getCell('B2').protection?.locked, false, 'the rig cell is locked');
  assert.notEqual(day1.getCell('E2').protection?.locked, false, 'the date cell is locked — fixed, not typed in');
});

test('a day beyond the real month length is left blank, not given a fictitious date', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 200-01', logMonth: '2026-04' }); // April has 30 days
  const wb = await open(buf);
  const day31 = wb.getWorksheet('31')!;
  assert.equal(day31.getCell('E2').value, '');
});

test('the three "(Auto)" columns carry the same formulas as the original single-sheet template', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 200-01', logMonth: '2026-08' });
  const wb = await open(buf);
  const ws = wb.getWorksheet('1')!;
  const f = ws.getCell('F4').value as ExcelJS.CellFormulaValue;
  const l = ws.getCell('L4').value as ExcelJS.CellFormulaValue;
  const p = ws.getCell('P4').value as ExcelJS.CellFormulaValue;
  assert.equal(f.formula, 'IF(AND(D4<>"",E4<>""),IF(E4>=D4,(E4-D4)*24,(1+E4-D4)*24),"")');
  assert.equal(l.formula, 'IF(AND(J4<>"",K4<>""),K4-J4,"")');
  assert.equal(p.formula, 'IF(AND(N4<>"",O4<>""),O4-N4,"")');
  // Locked is the Excel default once sheet protection is on, so a locked cell
  // carries no explicit flag once the file is written (same convention as the
  // existing Mechanical Log template test) — what matters is it is never
  // explicitly unlocked.
  assert.notEqual(ws.getCell('F4').protection?.locked, false, 'formula cells stay locked');
  assert.equal(ws.getCell('A4').protection?.locked, false, 'crew-entry cells stay editable');
});

test('every sheet is protected, matching the original template\'s convention', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 200-01', logMonth: '2026-08' });
  const wb = await open(buf);
  for (const name of ['1', '15', '31']) {
    const ws = wb.getWorksheet(name)!;
    assert.ok((ws as unknown as { sheetProtection?: unknown }).sheetProtection, `sheet "${name}" is protected`);
  }
});

test('a template filled in across a few days round-trips through the monthly parser unchanged', async () => {
  const buf = await buildDprTemplateWorkbook({ rigNumber: 'GTC 50-01', logMonth: '2026-08' });
  const wb = await open(buf);

  const day1 = wb.getWorksheet('1')!;
  day1.getCell('A4').value = 'WELL-X';
  day1.getCell('B4').value = '02 - Drilling';
  day1.getCell('C4').value = 'R1';
  day1.getCell('D4').value = new Date(Date.UTC(1899, 11, 30, 6, 0));
  day1.getCell('E4').value = new Date(Date.UTC(1899, 11, 30, 12, 0));
  day1.getCell('I4').value = '8-1/2"';
  day1.getCell('J4').value = 100;
  day1.getCell('K4').value = 150;

  const day2 = wb.getWorksheet('2')!;
  day2.getCell('A4').value = 'WELL-Y';
  day2.getCell('B4').value = '05 - C&C';
  day2.getCell('C4').value = 'R1';
  day2.getCell('D4').value = new Date(Date.UTC(1899, 11, 30, 8, 0));
  day2.getCell('E4').value = new Date(Date.UTC(1899, 11, 30, 14, 0));

  const refilled = Buffer.from(await wb.xlsx.writeBuffer());
  const parsed = parseDprWorkbook(refilled);

  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.rigTextInFile, 'GTC 50-01');
  assert.equal(parsed.logMonth, '2026-08');
  assert.equal(parsed.days.length, 2);
  assert.equal(parsed.days[0].date, '2026-08-01');
  assert.equal(parsed.days[0].lines[0].wellName, 'WELL-X');
  assert.equal(parsed.days[0].lines[0].startTime, '06:00');
  assert.equal(parsed.days[0].lines[0].totalHours, 6);
  assert.equal(parsed.days[0].lines[0].drillingTotal, 50);
  assert.equal(parsed.days[1].date, '2026-08-02');
  assert.equal(parsed.days[1].lines[0].wellName, 'WELL-Y');
});

test('the filename identifies the rig and month', () => {
  assert.equal(dprTemplateFileName('GTC 200-01', '2026-08'), 'Rig_200-01_DPR_August_2026.xlsx');
});
