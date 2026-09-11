import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHealthNarrativeWorkbook } from '../src/excel/parseHealthNarrative.js';
import { rigKey } from '../src/excel/normalize.js';

/**
 * Parses the real "Engine Health Check-up" workbook: two sheets sharing one
 * column layout (Engine, Transmission) and a third (Bakrol & Central Store)
 * whose header row is mislabelled by one column relative to its own data —
 * "Problem" holds a date, the real problem text sits in "ACTION". The parser
 * trusts column position, not header text, which is what these tests check.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, 'fixtures', 'health-narrative-real.xlsx'));

test('all three sheets are recognised and every row is accounted for', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  assert.deepEqual(r.sheetsFound, [
    'Engine Health Check up',
    'Transmission Health Check up ',
    'Bakrol & Central Store',
  ]);
  assert.ok(r.rows.length > 100, `expected well over 100 rows, got ${r.rows.length}`);
});

test('the Engine and Transmission sheets carry the rig forward across a merged-cell group', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const engineRows = r.rows.filter((row) => row.sourceSheet === 'Engine Health Check up' && row.rigKey === rigKey('GTC 50-01'));
  // The source sheet states "GTC 50-01" once and leaves four following rows'
  // Rig cell blank; all five must resolve to the same rig, not just the first.
  assert.ok(engineRows.length >= 4, `expected several rows under GTC 50-01, got ${engineRows.length}`);
  assert.ok(engineRows.some((row) => row.application?.includes('Carrier engine')));
  assert.ok(engineRows.some((row) => row.application?.includes('Mud pump engine')));
});

test('the Bakrol & Central Store sheet reads positionally: column 6 is a date despite being headed "Problem"', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const row = r.rows.find(
    (x) => x.sourceSheet === 'Bakrol & Central Store' && x.rigKey === rigKey('1000-1') && x.application === 'Carrier engine -2',
  );
  assert.ok(row, 'the 1000-1 carrier engine row should be present');
  assert.equal(row!.previousDate, '2025-08-12');
  assert.equal(row!.lastDate, '2026-01-09', 'column 6 parses as a date even though its header says "Problem"');
  assert.equal(row!.problem, '1. Water containment in oil');
  assert.match(row!.action ?? '', /Overhauling Completed/);
});

test('column 9 on the yard sheet is a place, not engineering notes', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const row = r.rows.find((x) => x.sourceSheet === 'Bakrol & Central Store' && x.application === 'Carrier engine -2');
  assert.equal(row!.place, 'Central Store');
  assert.equal(row!.outcomeNotes, null, 'the place sheet must never populate outcomeNotes');
});

test('the same column on the Engine/Transmission sheets is engineering notes, not a place', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const row = r.rows.find((x) => x.sourceSheet === 'Engine Health Check up' && x.application?.includes('DG Set - 2'));
  assert.ok(row);
  assert.equal(row!.place, null);
  assert.ok(row!.outcomeNotes, 'the overhauling-details column must be captured as notes');
});

test('yard spares with no Rig cell at all stay unlinked rather than inheriting a neighbouring rig', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const dgSpares = r.rows.filter(
    (x) => x.sourceSheet === 'Bakrol & Central Store' && x.application?.startsWith('DG Set'),
  );
  assert.ok(dgSpares.length >= 4);
  for (const row of dgSpares) {
    assert.equal(row.rigText, null, `${row.application} must not borrow the rig from an earlier row`);
    assert.equal(row.place, 'Bakrol Yard');
  }
});

test('multi-line problem and action text keeps its line breaks', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const row = r.rows.find((x) => x.application?.includes('DG Set - 1 (125 KVA)'));
  assert.ok(row?.problem?.includes('\n'), 'a numbered list of findings must not be collapsed onto one line');
});

test('a serial number is extracted for search without being used to match equipment', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const row = r.rows.find((x) => x.details?.includes('JSC01354'));
  assert.equal(row!.serialNumber, 'JSC01354');
});

test('a rig written without the GTC prefix still matches the registered rig key', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  const row = r.rows.find((x) => x.sourceSheet === 'Bakrol & Central Store' && x.rigText === '100-01');
  assert.ok(row);
  assert.equal(row!.rigKey, rigKey('GTC 100-01'));
});

test('every parsed row keeps which sheet it came from and its category', () => {
  const r = parseHealthNarrativeWorkbook(fixture);
  assert.ok(r.rows.every((row) => row.category === 'Engine' || row.category === 'Transmission'));
  assert.ok(r.rows.some((row) => row.category === 'Transmission'));
  assert.ok(r.rows.filter((row) => row.category === 'Engine').length > 0);
});
