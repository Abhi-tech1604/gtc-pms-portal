import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildIlmTemplateWorkbook, ilmTemplateFileName, ILM_TEMPLATE_VERSION } from '../src/excel/ilmTemplate.js';
import { parseIlmWorkbook } from '../src/excel/ilmIngest.js';

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

test('the rig is pre-filled and locked on both the Individual and Trailer sheets; the date is pre-filled and editable', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 200-01', date: '2026-08-24' });
  const wb = await open(buf);
  const ind = wb.getWorksheet('2_ILM_Individual')!;
  const trl = wb.getWorksheet('4_ILM_Trailer_Load_Detail')!;
  assert.equal(ind.getCell('B3').value, 'GTC 200-01', 'the user never has to type the rig');
  assert.notEqual(ind.getCell('B3').protection?.locked, false, 'rig cell stays locked');
  assert.equal(trl.getCell('B2').value, 'GTC 200-01');
  assert.notEqual(trl.getCell('B2').protection?.locked, false, 'trailer rig cell stays locked');
  assert.equal(ind.getCell('B2').value, '24-08-2026');
  assert.equal(ind.getCell('B2').protection?.locked, false, 'the date stays editable');
});

test('all three required sheets exist with the exact names the spec requires', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 200-01', date: '2026-08-24' });
  const wb = await open(buf);
  assert.ok(wb.getWorksheet('2_ILM_Individual'));
  assert.ok(wb.getWorksheet('4_ILM_Trailer_Load_Detail'));
  assert.ok(wb.getWorksheet('5_ILM_Crane_Detail'));
});

test('the HSD consumption and avg-consumption/km columns carry live formulas — a fix over the original, which had none', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 200-01', date: '2026-08-24' });
  const wb = await open(buf);
  const ind = wb.getWorksheet('2_ILM_Individual')!;
  const f = ind.getCell('F13').value as ExcelJS.CellFormulaValue;
  const j = ind.getCell('J13').value as ExcelJS.CellFormulaValue;
  assert.equal(f.formula, 'IF(AND(C13<>"",D13<>"",E13<>""),C13+D13-E13,"")');
  assert.equal(j.formula, 'IF(AND(F13<>"",G13<>"",G13<>0),F13/G13,"")');
  assert.notEqual(ind.getCell('F13').protection?.locked, false, 'formula cells stay locked');
  assert.equal(ind.getCell('A13').protection?.locked, false, 'crew-entry cells stay editable');
});

test('the trailer type and rig/hired dropdowns are wired to the hidden Lists sheet', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 200-01', date: '2026-08-24' });
  const wb = await open(buf);
  const trl = wb.getWorksheet('4_ILM_Trailer_Load_Detail')!;
  const crn = wb.getWorksheet('5_ILM_Crane_Detail')!;
  assert.equal((trl.getCell('D11').dataValidation as { formulae?: string[] })?.formulae?.[0], 'Lists!$B$1:$B$3');
  assert.equal((crn.getCell('D4').dataValidation as { formulae?: string[] })?.formulae?.[0], 'Lists!$C$1:$C$2');
  const lists = wb.getWorksheet('Lists')!;
  assert.equal(lists.getCell('B1').value, 'HB');
  assert.equal(lists.getCell('C1').value, 'Rig');
});

test('the version stamp is embedded for stale-template detection', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 200-01', date: '2026-08-24' });
  const wb = await open(buf);
  const meta = wb.getWorksheet('ILM_Meta')!;
  assert.equal(meta.getCell('B1').value, ILM_TEMPLATE_VERSION);
});

test('all three sheets are protected, matching the fix instructed in spec 13', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 200-01', date: '2026-08-24' });
  const wb = await open(buf);
  for (const name of ['2_ILM_Individual', '4_ILM_Trailer_Load_Detail', '5_ILM_Crane_Detail']) {
    const ws = wb.getWorksheet(name)!;
    assert.ok((ws as unknown as { sheetProtection?: unknown }).sheetProtection, `${name} is protected`);
  }
});

test('a template filled in across all three sheets round-trips through the parser unchanged', async () => {
  const buf = await buildIlmTemplateWorkbook({ rigNumber: 'GTC 50-01', date: '2026-08-24' });
  const wb = await open(buf);

  const ind = wb.getWorksheet('2_ILM_Individual')!;
  ind.getCell('B4').value = 'AREA-X';
  ind.getCell('B5').value = 'WELL-A';
  ind.getCell('B6').value = 'WELL-B';
  ind.getCell('A13').value = 'Weather';
  ind.getCell('C13').value = 1000;
  ind.getCell('D13').value = 500;
  ind.getCell('E13').value = 800;
  ind.getCell('G13').value = 120;

  const trl = wb.getWorksheet('4_ILM_Trailer_Load_Detail')!;
  trl.getCell('B3').value = 'Old Loc';
  trl.getCell('B4').value = 'New Loc';
  trl.getCell('C11').value = 'TRL-01';
  trl.getCell('D11').value = 'HB';

  const crn = wb.getWorksheet('5_ILM_Crane_Detail')!;
  crn.getCell('A4').value = 'CRN-01';
  crn.getCell('E4').value = 'REG-01';

  const refilled = Buffer.from(await wb.xlsx.writeBuffer());
  const parsed = parseIlmWorkbook(refilled);

  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.rigTextInFile, 'GTC 50-01');
  assert.equal(parsed.ilmDate, '2026-08-24');
  assert.equal(parsed.area, 'AREA-X');
  assert.equal(parsed.movementFromWell, 'WELL-A');
  assert.equal(parsed.individualLines.length, 1);
  assert.equal(parsed.individualLines[0].totalHsdConsumption, 700, 'recomputed: 1000 + 500 - 800');
  assert.equal(parsed.individualLines[0].avgConsumptionPerKm, 5.83, 'recomputed: 700 / 120');
  assert.equal(parsed.trailerLoads.length, 1);
  assert.equal(parsed.trailerLoads[0].trailerNo, 'TRL-01');
  assert.equal(parsed.cranes.length, 1);
  assert.equal(parsed.cranes[0].craneNo, 'CRN-01');
});

test('the filename identifies the rig', () => {
  assert.equal(ilmTemplateFileName('GTC 200-01'), 'Rig_200-01_ILM_Template.xlsx');
});
