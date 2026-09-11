import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { computeTotalHours, parseDprWorkbook } from '../src/excel/dprIngest.js';

/**
 * Targeted synthetic cases for the 31-sheet-per-month DPR format (spec 8/9):
 * one workbook, one rig, sheets named "1".."31", no List sheet. The old
 * single-sheet fixture this module was originally reverse-engineered from
 * (tests/fixtures/dpr-rig-200-01-real.xlsx) is the format this replaces —
 * it's no longer a valid upload shape, so it's not exercised here.
 */

type DayRow = unknown[];

/** Builds a full 31-sheet workbook. `days` supplies rig/date/rows for whichever day-sheets should carry data; the rest are left blank, matching what the template generator produces for days past a short month or not yet filled in. */
function buildWorkbook(opts: {
  rigText?: string;
  days?: Record<number, { date?: string; rigText?: string; rows?: DayRow[] }>;
  skipDays?: number[]; // simulates a corrupted file missing these sheets entirely
} = {}): Buffer {
  const wb = XLSX.utils.book_new();
  const rigText = opts.rigText ?? 'GTC 50-01';

  for (let day = 1; day <= 31; day++) {
    if (opts.skipDays?.includes(day)) continue;
    const dayOpts = opts.days?.[day];
    const grid: unknown[][] = [
      ['GTC — Daily Progress Report (DPR)'],
      ['RIG NO.', dayOpts?.rigText ?? rigText, null, 'DATE', dayOpts?.date ?? ''],
      ['WELL NAME', 'OPERATION TASK CODE', 'WORK TYPE', 'START TIME', 'END TIME', 'TOTAL TIME'],
      ...(dayOpts?.rows ?? []),
    ];
    const ws = XLSX.utils.aoa_to_sheet(grid);
    XLSX.utils.book_append_sheet(wb, ws, String(day));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('a well-formed monthly workbook with a few filled days parses cleanly', () => {
  const buf = buildWorkbook({
    rigText: 'GTC 50-01',
    days: {
      1: { date: '2026-08-01', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] },
      2: { date: '2026-08-02', rows: [['LNMH', '05 - C&C', 'R1', '12:00', '13:45']] },
    },
  });
  const parsed = parseDprWorkbook(buf);
  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.rigTextInFile, 'GTC 50-01');
  assert.equal(parsed.logMonth, '2026-08');
  assert.equal(parsed.days.length, 2);
  assert.equal(parsed.days[0].lines.length, 1);
  assert.equal(parsed.days[0].lines[0].wellName, 'LNMH');
});

test('a partial month (only the first few days filled) is not an error — the rest are simply not reported yet', () => {
  const buf = buildWorkbook({
    days: { 1: { date: '2026-08-01', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] } },
  });
  const parsed = parseDprWorkbook(buf);
  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.days.length, 1);
});

test('a workbook missing a day-sheet in the middle is rejected with the exact spec-worded message', () => {
  const buf = buildWorkbook({ skipDays: [15] });
  const parsed = parseDprWorkbook(buf);
  assert.ok(parsed.issues.some((i) =>
    i.level === 'fatal' && i.day === 15 && i.message === 'Invalid DPR template: DPR 15 sheet is missing.',
  ));
});

test('a sheet naming a different rig than the rest of the workbook is a fatal, day-numbered issue', () => {
  const buf = buildWorkbook({
    rigText: 'GTC 50-01',
    days: {
      1: { date: '2026-08-01', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] },
      2: { date: '2026-08-02', rigText: 'GTC 200-01', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] },
    },
  });
  const parsed = parseDprWorkbook(buf);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.ok(fatal.some((i) => i.day === 2 && /different rig/i.test(i.message)));
});

test('a date that does not match its sheet\'s day-of-month position is flagged as a date mismatch', () => {
  const buf = buildWorkbook({
    days: { 5: { date: '2026-08-09', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] } },
  });
  const parsed = parseDprWorkbook(buf);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && i.day === 5 && i.message === 'Date mismatch detected.'));
});

test('a date whose month differs from the rest of the workbook is flagged as a date mismatch', () => {
  const buf = buildWorkbook({
    days: {
      1: { date: '2026-08-01', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] },
      2: { date: '2026-09-02', rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00']] },
    },
  });
  const parsed = parseDprWorkbook(buf);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && i.day === 2 && i.message === 'Date mismatch detected.'));
});

test('a row with a missing required field is a fatal, day- and row-numbered issue', () => {
  const buf = buildWorkbook({
    days: {
      3: {
        date: '2026-08-03',
        rows: [
          ['LNMH', '02 - Drilling', 'R1', '06:00', '12:00'], // row 4, valid
          [null, 'P/O', 'R1', '12:00', '13:45'],              // row 5, missing well name
        ],
      },
    },
  });
  const parsed = parseDprWorkbook(buf);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].day, 3);
  assert.equal(fatal[0].row, 5);
  assert.match(fatal[0].message, /well name is required/i);
});

test('an invalid numeric value is a fatal issue naming the field, day and row', () => {
  const buf = buildWorkbook({
    days: {
      3: {
        date: '2026-08-03',
        rows: [['LNMH', '02 - Drilling', 'R1', '06:00', '12:00', null, null, null, '8-1/2"', 'not-a-number', 2001]],
      },
    },
  });
  const parsed = parseDprWorkbook(buf);
  const fatal = parsed.issues.filter((i) => i.level === 'fatal');
  assert.ok(fatal.some((i) => i.day === 3 && i.row === 4 && /Drilling From.*invalid numeric/i.test(i.message)));
});

test('a blank row among filled ones within a day is skipped, not flagged', () => {
  const buf = buildWorkbook({
    days: {
      3: {
        date: '2026-08-03',
        rows: [
          ['LNMH', '02 - Drilling', 'R1', '06:00', '12:00'],
          [null, null, null, null, null], // fully blank — a legitimately unused slot
          ['LNMH', '05 - C&C', 'R1', '12:00', '13:45'],
        ],
      },
    },
  });
  const parsed = parseDprWorkbook(buf);
  assert.equal(parsed.issues.filter((i) => i.level === 'fatal').length, 0);
  assert.equal(parsed.days[0].lines.length, 2);
});

test('a file with no day-sheets at all is rejected as not a valid template', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['hello'], ['world']]);
  XLSX.utils.book_append_sheet(wb, ws, 'Random');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const parsed = parseDprWorkbook(buf);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal' && /DPR \d+ sheet is missing/i.test(i.message)));
  assert.equal(parsed.days.length, 0);
});

test('a corrupted / unreadable file produces a clear fatal issue rather than crashing', () => {
  // SheetJS is lenient about what counts as a workbook, so this either throws
  // (caught by the caller in dpr.ts) or surfaces as a "sheet missing" fatal —
  // either way nothing crashes and no partial data is produced.
  try {
    const parsed = parseDprWorkbook(Buffer.from('not an excel file at all'));
    assert.equal(parsed.days.length, 0);
    assert.ok(parsed.issues.some((i) => i.level === 'fatal'));
  } catch (err) {
    assert.ok((err as Error).message.length > 0);
  }
});

test('computeTotalHours matches the sheet formula, including the overnight wrap', () => {
  assert.equal(computeTotalHours('06:00', '12:00'), 6);
  assert.equal(computeTotalHours('23:30', '01:45'), 2.25); // wraps past midnight
  assert.equal(computeTotalHours(null, '12:00'), null);
  assert.equal(computeTotalHours('06:00', null), null);
});
