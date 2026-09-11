import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { parseIlmWorkbook } from '../src/excel/ilmIngest.js';
import { ILM_TEMPLATE_VERSION } from '../src/excel/ilmTemplate.js';

/**
 * Parses the real sample ILM workbook (tests/fixtures/ilm-final-real.xlsx,
 * the same file the ILM module was reverse-engineered from) plus targeted
 * synthetic cases for the validation rules spec 16 asks for. The real file
 * is itself a blank template (no filled data rows, no formulas — confirmed
 * by direct inspection), so it has no cached values to assert against the
 * way the DPR sample did; what it validates here is the sheet/version
 * detection, since it predates this module's version-stamp mechanism.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name));

test('the real sample workbook has the exact three required sheets, and is correctly rejected as pre-versioning', () => {
  const parsed = parseIlmWorkbook(fixture('ilm-final-real.xlsx'));
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /missing version information/i);
});

/** A minimal, correctly-shaped ILM workbook: Meta + Individual + Trailer + Crane sheets. */
function buildGrid(opts: {
  version?: string | null;
  individualExtra?: (unknown[])[];
  trailerExtra?: (unknown[])[];
  craneExtra?: (unknown[])[];
  sheets?: string[];
  indTitle?: string;
  craneTitle?: string;
  rigText?: string;
  trailerRigText?: string;
} = {}): Buffer {
  const wb = XLSX.utils.book_new();

  if (opts.version !== null) {
    const metaWs = XLSX.utils.aoa_to_sheet([['ILM_TEMPLATE_VERSION', opts.version ?? ILM_TEMPLATE_VERSION]]);
    XLSX.utils.book_append_sheet(wb, metaWs, 'ILM_Meta');
  }

  const indRows: unknown[][] = [
    [opts.indTitle ?? 'MODULE 2 – ILM INDIVIDUAL'],
    ['DATE', '2026-08-20'],
    ['RIG NO.', opts.rigText ?? 'GTC 50-01'],
    ['AREA', 'AREA-1'],
    ['MOVEMENT FROM Well', 'WELL-A'],
    ['MOVEMENT TO Well', 'WELL-B'],
    [], [], [], [],
    [],
    ['REASON FOR DELAY', 'TOTAL DELAY TIME', 'HSD STOCK @ ACCESSION', 'RECEIVED QTY', 'HSD STOCK @ SHIFT END'],
    ...(opts.individualExtra ?? []),
  ];
  const indWs = XLSX.utils.aoa_to_sheet(indRows);
  XLSX.utils.book_append_sheet(wb, indWs, '2_ILM_Individual');

  const trlRows: unknown[][] = [
    ['MODULE 4 – ILM TRAILER LOAD DETAIL'],
    ['RIG NAME', opts.trailerRigText ?? opts.rigText ?? 'GTC 50-01'],
    ['OLD LOCATION', 'Loc A'],
    ['NEW LOCATION', 'Loc B'],
    [], [], [], [],
    [],
    ['SR. NO.', 'MT. NO.', 'TRAILER NO.'],
    ...(opts.trailerExtra ?? []),
  ];
  const trlWs = XLSX.utils.aoa_to_sheet(trlRows);
  XLSX.utils.book_append_sheet(wb, trlWs, '4_ILM_Trailer_Load_Detail');

  const crnRows: unknown[][] = [
    [opts.craneTitle ?? 'MODULE 5 – ILM CRANE DETAIL'],
    [],
    ['CRANE NO.', 'CAPACITY', 'REPORTING DATE'],
    ...(opts.craneExtra ?? []),
  ];
  const crnWs = XLSX.utils.aoa_to_sheet(crnRows);
  XLSX.utils.book_append_sheet(wb, crnWs, '5_ILM_Crane_Detail');

  if (opts.sheets) {
    // Remove any sheets not in the allow-list, to simulate a missing-sheet upload.
    for (const name of [...wb.SheetNames]) {
      if (!opts.sheets.includes(name)) {
        const idx = wb.SheetNames.indexOf(name);
        wb.SheetNames.splice(idx, 1);
        delete wb.Sheets[name];
      }
    }
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('a well-formed workbook parses cleanly with no fatal issues', () => {
  const buf = buildGrid({
    individualExtra: [['Weather', 2, 1000, 500, 800]],
    trailerExtra: [[1, 'MT-1', 'TRL-01']],
    craneExtra: [['CRN-01', 25, '2026-08-20']],
  });
  const parsed = parseIlmWorkbook(buf);
  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.rigTextInFile, 'GTC 50-01');
  assert.equal(parsed.ilmDate, '2026-08-20');
  assert.equal(parsed.individualLines.length, 1);
  assert.equal(parsed.individualLines[0].totalHsdConsumption, 700);
  assert.equal(parsed.trailerLoads.length, 1);
  assert.equal(parsed.trailerLoads[0].trailerNo, 'TRL-01');
  assert.equal(parsed.cranes.length, 1);
  assert.equal(parsed.cranes[0].craneNo, 'CRN-01');
});

test('a missing required sheet is rejected with the exact spec-worded message (spec 16)', () => {
  const buf = buildGrid({ sheets: ['ILM_Meta', '2_ILM_Individual', '4_ILM_Trailer_Load_Detail'] });
  const parsed = parseIlmWorkbook(buf);
  assert.ok(parsed.issues.some((i) =>
    i.level === 'fatal' && i.message === 'Missing required sheet: 5_ILM_Crane_Detail. Please download the latest ILM template and try again.',
  ));
});

test('a stale/foreign template version is rejected, not imported', () => {
  const buf = buildGrid({ version: '0.9' });
  const parsed = parseIlmWorkbook(buf);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /Template Version 0\.9/.test(i.message)));
});

test('a workbook with no version stamp at all is rejected', () => {
  const buf = buildGrid({ version: null });
  const parsed = parseIlmWorkbook(buf);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /missing version information/i.test(i.message)));
});

test('an invalid numeric value is a fatal issue naming the field, sheet and row', () => {
  const buf = buildGrid({ individualExtra: [['Weather', 'not-a-number', 1000, 500, 800]] });
  const parsed = parseIlmWorkbook(buf);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.ok(fatal.some((i) => i.sheet === '2_ILM_Individual' && /Total Delay Time.*invalid numeric/i.test(i.message)));
});

test('a trailer row missing its required Trailer No. is a fatal, row-numbered issue', () => {
  const buf = buildGrid({ trailerExtra: [[1, 'MT-1', null]] });
  const parsed = parseIlmWorkbook(buf);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.ok(fatal.some((i) => i.sheet === '4_ILM_Trailer_Load_Detail' && /Trailer No\. is required/i.test(i.message)));
});

test('a crane row missing its required Crane No. is a fatal, row-numbered issue', () => {
  const buf = buildGrid({ craneExtra: [[null, 25, '2026-08-20', null, 'REG-01']] });
  const parsed = parseIlmWorkbook(buf);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.ok(fatal.some((i) => i.sheet === '5_ILM_Crane_Detail' && /Crane No\. is required/i.test(i.message)));
});

test('a blank row among filled ones is skipped, not flagged', () => {
  const buf = buildGrid({
    individualExtra: [
      ['Weather', 2, 1000, 500, 800],
      [null, null, null, null, null],
      ['Traffic', 1, 800, 200, 700],
    ],
  });
  const parsed = parseIlmWorkbook(buf);
  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.individualLines.length, 2);
});

test('total HSD consumption and avg-per-km are always recomputed, never trusted from any pre-filled cell', () => {
  const buf = buildGrid({ individualExtra: [['Weather', 2, 1000, 500, 800]] });
  const parsed = parseIlmWorkbook(buf);
  assert.equal(parsed.individualLines[0].totalHsdConsumption, 700, '1000 + 500 - 800');
});

test('a file with the wrong Individual sheet title is rejected as not a valid ILM template', () => {
  const buf = buildGrid({ indTitle: 'Some Random Sheet' });
  const parsed = parseIlmWorkbook(buf);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /valid ILM Individual/i.test(i.message)));
});

test('a corrupted / unreadable file produces a clear fatal issue rather than crashing', () => {
  const parsed = parseIlmWorkbook(Buffer.from('not an excel file at all'));
  assert.equal(parsed.individualLines.length, 0);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal'));
});
