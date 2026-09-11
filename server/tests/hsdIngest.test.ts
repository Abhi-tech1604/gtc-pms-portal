import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildHsdTemplateWorkbook, hsdTemplateFileName } from '../src/excel/hsdTemplate.js';
import { parseHsdWorkbook } from '../src/excel/hsdIngest.js';
import { buildDprTemplateWorkbook } from '../src/excel/dprTemplate.js';
import { withRigMatchCheck } from '../src/routes/hsd.js';

/**
 * The HSD template is a copy of the customer's own master workbook with the
 * crew-entry cells blanked, so these tests assert against that real structure
 * (35 sheets, the exact column headers, the D=B+C / I=D-E / H=G+F formulas)
 * rather than an invented layout — and then round-trip a filled copy back
 * through the importer, which is the flow a user actually performs.
 */

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Fills day `day` of a template with a known equipment row and site diesel row. */
function fillDay(wb: ExcelJS.Workbook, day: number): void {
  const ws = wb.getWorksheet(String(day))!;
  ws.getCell('B3').value = 'DND#592';
  ws.getCell('C4').value = 7.5;   // R1
  ws.getCell('D4').value = 9.5;   // R2
  ws.getCell('E4').value = 0;     // R3
  ws.getCell('F4').value = 0;     // ILM

  ws.getCell('B6').value = 243;   // opening stock
  ws.getCell('C6').value = 170;   // top-up
  ws.getCell('E6').value = 22;    // consumed HSD
  ws.getCell('F6').value = 3.5;   // consumed hours
  ws.getCell('G6').value = 25125; // opening running hours

  // Only opening/received are typed on the diesel row — its TOP UP and Total
  // Consumption are the equipment table's own column totals (E30=C27, F30=E27).
  ws.getCell('B30').value = 100;
  ws.getCell('C30').value = 800;
}

test('the HSD template keeps the customer workbook whole: 35 sheets, the four rollups, and 31 day sheets', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  assert.equal(wb.worksheets.length, 35);
  for (const name of ['HSD Consumption Master Seet', 'Oil Tracking Sheet', 'HSD TOP UP Sheet', 'Hydraulic Oil Level Sheet']) {
    assert.ok(wb.getWorksheet(name), `${name} survives`);
  }
  for (let day = 1; day <= 31; day++) assert.ok(wb.getWorksheet(String(day)), `day sheet "${day}" exists`);
});

test('the day sheet keeps the original column names and order', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  const ws = wb.getWorksheet('1')!;
  const headers = ['A5', 'B5', 'C5', 'D5', 'E5', 'F5', 'G5', 'H5', 'I5', 'J5', 'K5']
    .map((ref) => String(ws.getCell(ref).value ?? '').trim());
  assert.deepEqual(headers, [
    'Equipments', 'Opening Stock HSD', 'Top-up HSD', 'Total HSD', 'Total Consu. HSD',
    'Total Consu. HRS', 'Opening Running HRS', 'Closing HRS', 'Closing Stock HSD', 'Average', 'Remark If Any',
  ]);
  assert.equal(String(ws.getCell('C3').value).trim(), 'R1');
  assert.equal(String(ws.getCell('F3').value).trim(), 'ILM');
});

test('the template keeps its formulas but carries no leftover data from the source workbook', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  const ws = wb.getWorksheet('1')!;

  assert.equal(ws.getCell('D6').formula, 'B6+C6', 'Total HSD stays a formula');
  assert.equal(ws.getCell('I6').formula, 'D6-E6', 'Closing Stock stays a formula');
  assert.equal(ws.getCell('J6').formula, 'IFERROR(E6/F6,"")', 'Average stays a formula');
  assert.equal(ws.getCell('G4').formula, 'SUM(C4,D4,E4,F4)', 'the hours total stays a formula');

  // Crew-entry cells are empty, and no stale cached result is left behind.
  for (const ref of ['B3', 'C4', 'D4', 'B6', 'C6', 'E6', 'F6', 'G6', 'B30', 'C30', 'E31']) {
    assert.equal(ws.getCell(ref).value, null, `${ref} is blank in a fresh template`);
  }
  assert.equal((ws.getCell('D6').value as { result?: unknown }).result, undefined);

  // The site diesel row's derived cells are formulas, not inputs, so blanking
  // must have left them alone.
  assert.equal(ws.getCell('E30').formula, 'C27');
  assert.equal(ws.getCell('G30').formula, 'D30-E30');
});

test('the rig is stamped on every day sheet and the date only on days the month actually has', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-09' }));
  for (let day = 1; day <= 31; day++) {
    assert.equal(wb.getWorksheet(String(day))!.getCell('B2').value, 'GTC 100-08');
  }
  assert.ok(wb.getWorksheet('30')!.getCell('H2').value instanceof Date, 'September 30 is dated');
  assert.equal(wb.getWorksheet('31')!.getCell('H2').value, null, 'September has no 31st');
});

test('a filled template round-trips through the importer with every derived figure recomputed', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  fillDay(wb, 1);
  const parsed = parseHsdWorkbook(await toBuffer(wb));

  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.logMonth, '2026-08');
  assert.equal(parsed.days.length, 1);

  const day = parsed.days[0];
  assert.equal(day.date, '2026-08-01');
  assert.equal(day.wellName, 'DND#592');
  assert.equal(day.totalHours, 17, 'R1+R2+R3+ILM');

  const line = day.equipment[0];
  assert.equal(line.equipment, 'Rig Carrier CAT (C-15)', 'the pre-printed equipment name is read');
  assert.equal(line.totalHsd, 413, 'opening + top-up');
  assert.equal(line.closingStock, 391, 'total - consumed');
  assert.equal(line.closingHours, 25128.5, 'opening running + consumed hours');
  assert.equal(line.average, 6.29, 'consumed / hours, rounded');

  const site = day.site[0];
  assert.equal(site.label, 'Rig Site Diesel');
  assert.equal(site.totalBalance, 900, 'opening + received');
  assert.equal(site.topUp, 170, 'the equipment table\'s top-up total (E30 = C27)');
  assert.equal(site.totalConsumption, 22, 'the equipment table\'s consumption total (F30 = E27)');
  assert.equal(site.closingBalance, 730, 'total balance - top-up (G30 = D30 - E30)');
});

test('derived figures are recomputed, not read back from the sheet, so a stale formula result never lands', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  fillDay(wb, 1);
  // A viewer that does not evaluate formulas would leave a wrong cached
  // result in the derived columns; the importer must ignore it entirely.
  const ws = wb.getWorksheet('1')!;
  ws.getCell('D6').value = { formula: 'B6+C6', result: 99999 } as ExcelJS.CellFormulaValue;
  ws.getCell('I6').value = { formula: 'D6-E6', result: -1 } as ExcelJS.CellFormulaValue;

  const parsed = parseHsdWorkbook(await toBuffer(wb));
  assert.equal(parsed.days[0].equipment[0].totalHsd, 413);
  assert.equal(parsed.days[0].equipment[0].closingStock, 391);
});

test('unfilled days are skipped rather than reported as errors, so a mid-month upload is valid', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  fillDay(wb, 1);
  fillDay(wb, 2);
  const parsed = parseHsdWorkbook(await toBuffer(wb));
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.days.map((d) => d.date), ['2026-08-01', '2026-08-02']);
});

test('an empty workbook is rejected rather than importing nothing silently', async () => {
  const parsed = parseHsdWorkbook(await toBuffer(
    await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' })),
  ));
  assert.equal(parsed.days.length, 0);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /No HSD data/i.test(i.message)));
});

test('consuming more HSD than the rig has available is a fatal error', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  fillDay(wb, 1);
  wb.getWorksheet('1')!.getCell('E6').value = 5000; // consumed > opening + top-up
  const parsed = parseHsdWorkbook(await toBuffer(wb));
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /more than the total available/i.test(i.message)));
});

test('a non-numeric figure is reported against its own day and row, not swallowed', async () => {
  const wb = await open(await buildHsdTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' }));
  fillDay(wb, 3);
  wb.getWorksheet('3')!.getCell('B6').value = 'plenty';
  const parsed = parseHsdWorkbook(await toBuffer(wb));
  const issue = parsed.issues.find((i) => /Opening Stock HSD/.test(i.message));
  assert.ok(issue, 'the bad cell is reported');
  assert.equal(issue!.day, 3);
  assert.equal(issue!.row, 6);
});

test('a DPR template uploaded to the HSD importer is rejected as the wrong format', async () => {
  const dpr = await buildDprTemplateWorkbook({ rigNumber: 'GTC 100-08', logMonth: '2026-08' });
  const parsed = parseHsdWorkbook(dpr);
  assert.equal(parsed.days.length, 0);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /valid HSD template/i.test(i.message)));
});

/**
 * xlsx does not reject arbitrary bytes — it parses them as a single CSV-ish
 * sheet — so the guard that actually catches a wrong file is the missing
 * day-sheet check, and it must produce a readable message rather than throw.
 */
test('a file that is not a workbook at all fails with a clear message, not a crash', () => {
  const parsed = parseHsdWorkbook(Buffer.from('this is not a spreadsheet'));
  assert.equal(parsed.days.length, 0);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.ok(fatal.length > 0);
  assert.match(fatal[0].message, /Invalid HSD template: day 1 sheet is missing/i);
});

test('uploading one rig\'s HSD file against another rig is refused', () => {
  const issues = withRigMatchCheck(
    { rigKeyInFile: '100-08', rigTextInFile: 'GTC 100-08', issues: [] },
    { rigNumber: 'GTC 200-01', rigKey: '200-01' },
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Incorrect Rig Template/);
});

test('the matching rig passes the rig check untouched', () => {
  const issues = withRigMatchCheck(
    { rigKeyInFile: '100-08', rigTextInFile: 'GTC 100-08', issues: [] },
    { rigNumber: 'GTC 100-08', rigKey: '100-08' },
  );
  assert.deepEqual(issues, []);
});

test('the download is named for the rig and month', () => {
  assert.equal(hsdTemplateFileName('GTC 100-08', '2026-08'), 'Rig_100-08_HSD_August_2026.xlsx');
});
