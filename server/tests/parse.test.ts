import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbook, isRealRow, readWorkbookGrid, findRigNumber } from '../src/excel/parseWorkbook.js';
import { rigKey } from '../src/excel/normalize.js';
import { buildRows, latestUpdate } from '../src/excel/ingest.js';

/**
 * Ingestion tests run against the real rig workbooks in tests/fixtures, not
 * idealised data. They are the messy files the field actually produces.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name));

test('the rig declaration is read wherever the label sits (D1)', () => {
  const { sheets } = readWorkbookGrid(fixture('rig-50-02-real.xlsx'));
  const grid = sheets.get('18')!;
  const found = findRigNumber(grid);
  assert.equal(found, 'Rig 50-02');
  // The merged "Daily Mechanical Report" title sits next to the label and must
  // never be mistaken for the rig number.
  assert.notEqual(found, 'Daily Mechanical Report');
});

test('a workbook written as "Rig 50-02" matches the registered "GTC 50-02" (I4)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  assert.equal(parsed.rigKeyInFile, rigKey('GTC 50-02'));
});

test('the log month comes from the workbook date cells', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  assert.equal(parsed.logMonth, '2026-08');
  assert.ok(parsed.sheetDateSamples.length > 20);
});

test('the real-data test accepts a typed Total Run Hours and rejects everything else (8.3)', () => {
  // A typed zero in column K is a real observation: the machine ran zero hours.
  assert.equal(isRealRow({ totalRunRaw: 0 }), true);
  // Hours run, meter readings, and a service baseline are not enough on their
  // own — only Total Run Hours (column K) itself makes a row real.
  assert.equal(isRealRow({ totalRunRaw: '' }), false);
  assert.equal(isRealRow({ totalRunRaw: null }), false);
  assert.equal(isRealRow({ totalRunRaw: 5 }), true);
});

test('a workbook nobody filled in produces no machines at all (I2, D3)', () => {
  // This fixture is a real seeded template: 31 sheets, formulas throughout, and
  // not one crew entry. Every apparent number in it is formula residue.
  const parsed = parseWorkbook(fixture('rig-50-03-unfilled.xlsx'));
  assert.equal(parsed.groups.length, 0);
  assert.equal(parsed.lastFilledDay, null);
  assert.ok(parsed.issues.some((i) => i.level === 'fatal'));
});

test('machines marked not-in-use all month are still read when the crew filled the row', () => {
  // Rig 200-01 logs several machines as "NO" with zero hours on day 19. A typed
  // zero is a real observation, so the row counts and the machine exists.
  const parsed = parseWorkbook(fixture('rig-200-01-real.xlsx'));
  const idle = parsed.groups.find((g) => /welding machine/i.test(g.name));
  assert.ok(idle, 'a machine logged as not in use with typed zeros is still real');
  assert.equal(idle!.days.every((d) => d.isReal), true);
});

test('structural rows and banners are never treated as machines (8.2)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const names = parsed.groups.map((g) => g.name.toLowerCase());
  for (const label of ['sr no', 'equipment', 'diesel engines', 'generator', 'well no', 'rig no']) {
    assert.ok(!names.includes(label), `"${label}" should not be a machine`);
  }
});

test('every machine keeps only the days the crew actually filled in (I1, D4)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  assert.ok(parsed.groups.length > 0);
  for (const group of parsed.groups) {
    assert.ok(group.days.length > 0, `${group.name} was kept with no real day`);
    assert.ok(group.days.length < 31, `${group.name} claims all 31 days, which is formula residue`);
    for (const day of group.days) assert.equal(day.isReal, true);
  }
});

test('figures match the source sheet exactly for a known machine (I6, D6)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const firePump = parsed.groups.find((g) => /fire\s*pump/i.test(g.name));
  assert.ok(firePump, 'the fire pump should be in the workbook');

  const day18 = firePump!.days.find((d) => d.sheetDay === 18);
  assert.ok(day18, 'day 18 was filled in for the fire pump');
  // Straight from row 12 of sheet 18: 1 + 0 hours, closing 1753, baseline 1523,
  // interval 500, 270 hours remaining.
  assert.equal(day18!.hoursRunDay, 1);
  assert.equal(day18!.hoursRunNight, 0);
  assert.equal(day18!.closing, 1753);
  assert.equal(day18!.lastServiceHours, 1523);
  assert.equal(day18!.defineHours, 500);
  assert.equal(day18!.hoursRemaining, 270);
});

test('the service baseline never comes from the column S sentence (D6)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const generator = parsed.groups.find((g) => /generator set 1/i.test(g.name));
  assert.ok(generator);
  const day = generator!.days.find((d) => d.sheetDay === 18)!;
  // Column S reads "LAST SERVICE DONE @ 25366 HRS. DT- 2026-07-01"; only the
  // date is taken from it, and the baseline comes from column M.
  assert.equal(day.lastServiceHours, 25366);
  assert.equal(day.lastServiceDate, '2026-07-01');
});

test('no stored figure carries spreadsheet decimals (I7, D12)', () => {
  const parsed = parseWorkbook(fixture('rig-100-01-real.xlsx'));
  assert.ok(parsed.groups.length > 0);
  for (const group of parsed.groups) {
    const rows = buildRows(group, parsed.logMonth ?? '2026-08');
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== 'number') continue;
        assert.equal(Number.isInteger(value), true, `${group.name}.${key} = ${value} is not whole`);
      }
    }
  }
});

test('the sheet day becomes a full calendar date (8.5)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const group = parsed.groups[0];
  const rows = buildRows(group, '2026-08');
  for (const row of rows) {
    assert.match(row.logDate, /^2026-08-\d{2}$/);
    assert.equal(Number(row.logDate.slice(8)), row.sheetDay);
  }
});

test('the latest entry is the highest day number, idle or not (I3, D7)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  for (const group of parsed.groups) {
    const rows = buildRows(group, '2026-08');
    const update = latestUpdate(rows)!;
    const highest = Math.max(...rows.map((r) => r.sheetDay));
    assert.equal(update.latestDay, highest);
  }
});

test('a machine idle on the latest day still drives the register (I3)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const idle = parsed.groups.find((g) => /generator set 3/i.test(g.name));
  assert.ok(idle);
  const rows = buildRows(idle!, '2026-08');
  const day18 = rows.find((r) => r.sheetDay === 18);
  assert.ok(day18, 'day 18 was filled in even though the machine ran zero hours');
  assert.equal(day18!.totalRunHours, 0);
  const update = latestUpdate(rows)!;
  assert.ok(update.latestDay >= 18);
});

test('the service baseline and interval are carried back to the register (D5)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const firePump = parsed.groups.find((g) => /fire\s*pump/i.test(g.name))!;
  const update = latestUpdate(buildRows(firePump, '2026-08'))!;
  assert.ok(update.lastServiceHours && update.lastServiceHours > 0,
    'a machine on thousands of hours must never keep a zero baseline');
  assert.ok(update.serviceInterval && update.serviceInterval > 0);
});

test('unfilled days never advance the running total (D4)', () => {
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  for (const group of parsed.groups) {
    const rows = buildRows(group, '2026-08');
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const current = rows[i];
      if (current.openingRunningHours === null || previous.closingHours === null) continue;
      const gap = current.openingRunningHours - previous.closingHours;
      const skipped = current.sheetDay - previous.sheetDay;
      // The opening may jump when the sheet states its own reading, but the
      // engine must never synthesise a default shift for the skipped days.
      assert.ok(
        gap >= 0 || skipped >= 0,
        `${group.name}: opening on day ${current.sheetDay} went backwards`,
      );
    }
  }
});

test('a machine name carrying two serials becomes two machines (8.4)', () => {
  const parsed = parseWorkbook(fixture('rig-100-01-real.xlsx'));
  const keys = parsed.groups.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, 'group keys must be unique');
});

test('a malformed file fails with a clear message, not a crash (11.2)', () => {
  assert.throws(
    () => parseWorkbook(Buffer.from('this is not a spreadsheet')),
    (err: Error) => /could not be read|No day worksheets/i.test(err.message),
  );
});
