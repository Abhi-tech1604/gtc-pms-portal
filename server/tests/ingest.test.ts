import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso, yesterday } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { parseWorkbook } from '../src/excel/parseWorkbook.js';
import { commitIngestion, planIngestion, matchEquipment, type EquipmentRow } from '../src/excel/ingest.js';
import { complianceFor } from '../src/services/compliance.js';
import { FLEET } from '../src/db/seed.js';

/**
 * End-to-end ingestion against the real workbooks, covering the multi-rig daily
 * operation of section 12.3 and the defects of section 10.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name));
const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of [
      'mechanical_log_rows', 'mechanical_log_uploads', 'equipment_history',
      'health_check_records', 'health_check_uploads', 'equipment',
      'rig_holidays', 'audit_logs', 'notifications', 'rigs',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const rigNumber of FLEET) {
      db.prepare(`
        INSERT INTO rigs (id, name, rigNumber, rigKey, status, createdAt)
        VALUES (?, ?, ?, ?, 'Active', ?)
      `).run(newId('rig'), rigNumber.replace(/^GTC\s*/i, 'Rig '), rigNumber, rigKey(rigNumber), nowIso());
    }
  });
}

function ingest(file: string, options: { fileName?: string; acknowledgeAll?: boolean } = {}) {
  const parsed = parseWorkbook(fixture(file));
  const plan = planIngestion({
    parsed,
    fileName: options.fileName ?? file,
    storedFileName: `stored_${file}`,
  });
  return { plan, parsed };
}

before(reset);

test('a workbook is filed against the rig it declares, not the form (D2, I4)', () => {
  reset();
  const { plan } = ingest('rig-50-02-real.xlsx');
  assert.ok(plan.rig, 'the rig should resolve from the workbook');
  assert.equal(plan.rig!.rigNumber, 'GTC 50-02');
  assert.equal(plan.rigResolvedFrom, 'workbook');
  assert.equal(plan.gates.some((g) => g.kind === 'rigMismatch'), false);
});

test('an unrecognised rig stops and asks instead of guessing (I5, D2)', () => {
  reset();
  const target = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigNumber = ?')
    .get('GTC 50-01')!;
  // Remove the rig the workbook names, so nothing can match it.
  db.prepare('DELETE FROM rigs WHERE rigNumber = ?').run('GTC 50-02');

  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const plan = planIngestion({
    parsed, fileName: 'rig-50-02-real.xlsx', storedFileName: 's',
    selectedRigId: target.id,
  });

  assert.equal(plan.rig, null, 'nothing may be filed until the user chooses');
  const gate = plan.gates.find((g) => g.kind === 'rigMismatch');
  assert.ok(gate, 'the rig mismatch gate must appear');
  assert.match(gate!.message, /Rig 50-02/);
  assert.match(gate!.message, /GTC 50-01/);
});

test('the user can resolve a mismatch by naming the rig explicitly', () => {
  reset();
  const target = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigNumber = ?')
    .get('GTC 50-01')!;
  db.prepare('DELETE FROM rigs WHERE rigNumber = ?').run('GTC 50-02');

  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const plan = planIngestion({
    parsed, fileName: 'f.xlsx', storedFileName: 's', confirmedRigId: target.id,
  });
  assert.equal(plan.rig?.id, target.id);
  assert.equal(plan.rigResolvedFrom, 'user');
});

test('importing writes the register back from the workbook (D5, I6)', () => {
  reset();
  const { plan } = ingest('rig-50-02-real.xlsx');
  const result = commitIngestion(plan, ctx);
  assert.ok(result.recordsImported > 0);

  const firePump = db.prepare<[string], {
    name: string; currentRunningHours: number; lastServiceHours: number; serviceInterval: number; status: string;
  }>(`SELECT name, currentRunningHours, lastServiceHours, serviceInterval, status
      FROM equipment WHERE rigId = ? AND name LIKE 'Fire Pump%'`).get(result.rigId)!;

  assert.ok(firePump.lastServiceHours > 0, 'the baseline must never stay at zero');
  assert.ok(firePump.serviceInterval > 0);
  assert.equal(Number.isInteger(firePump.currentRunningHours), true);
});

test('only the days the crew filled in become log rows (I1, D4)', () => {
  reset();
  const { plan } = ingest('rig-100-01-real.xlsx');
  const result = commitIngestion(plan, ctx);

  const days = db.prepare<[string], { sheetDay: number }>(
    'SELECT DISTINCT sheetDay FROM mechanical_log_rows WHERE rigId = ? ORDER BY sheetDay',
  ).all(result.rigId).map((r) => r.sheetDay);
  assert.deepEqual(days, [1, 18], 'this workbook was filled on days 1 and 18 only');
});

test('nothing stored anywhere carries a decimal (I7, D12)', () => {
  reset();
  const { plan } = ingest('rig-100-01-real.xlsx');
  commitIngestion(plan, ctx);

  const rows = db.prepare('SELECT * FROM mechanical_log_rows').all() as Record<string, unknown>[];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'number') continue;
      assert.equal(Number.isInteger(value), true, `${key} = ${value}`);
    }
  }
  const machines = db.prepare('SELECT currentRunningHours, lastServiceHours, serviceInterval FROM equipment')
    .all() as Record<string, number>[];
  for (const m of machines) {
    for (const [key, value] of Object.entries(m)) {
      assert.equal(Number.isInteger(value), true, `${key} = ${value}`);
    }
  }
});

test('all rigs can upload the same day with no duplicate warnings (M1, M2, D9)', () => {
  reset();
  const files = ['rig-50-02-real.xlsx', 'rig-100-01-real.xlsx', 'rig-200-01-real.xlsx'];
  for (const file of files) {
    const { plan } = ingest(file);
    assert.ok(plan.rig, `${file} should resolve its rig`);
    assert.equal(
      plan.gates.some((g) => g.kind === 'duplicateUpload'), false,
      `${file} must not be flagged as a duplicate of another rig's upload`,
    );
    commitIngestion(plan, ctx);
  }
  const uploads = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM mechanical_log_uploads').get()!.n;
  assert.equal(uploads, files.length, 'every upload stays in the registry');
});

test('re-uploading one rig flags only that rig, and replaces only that upload (M3, M4, D10)', () => {
  reset();
  for (const file of ['rig-50-02-real.xlsx', 'rig-100-01-real.xlsx', 'rig-200-01-real.xlsx']) {
    commitIngestion(ingest(file).plan, ctx);
  }
  const before = db.prepare('SELECT id, rigId FROM mechanical_log_uploads').all() as
    { id: string; rigId: string }[];
  assert.equal(before.length, 3);

  const { plan } = ingest('rig-50-02-real.xlsx', { fileName: 'rig-50-02-reupload.xlsx' });
  const gate = plan.gates.find((g) => g.kind === 'duplicateUpload');
  assert.ok(gate, 'the same rig and same day must raise the duplicate gate');
  assert.match(gate!.message, /GTC 50-02/);
  assert.equal(gate!.details.rigId, plan.rig!.id);

  const superseded = gate!.supersedesUploadId!;
  const result = commitIngestion(plan, ctx);
  assert.equal(result.replacedUploadId, superseded);

  const after = db.prepare('SELECT id, rigId, fileName FROM mechanical_log_uploads').all() as
    { id: string; rigId: string; fileName: string }[];
  assert.equal(after.length, 3, 'one upload replaced, the other two untouched');
  assert.equal(after.some((u) => u.id === superseded), false);
  assert.equal(after.filter((u) => u.rigId === plan.rig!.id).length, 1);
  // The rows of the superseded upload went with it, and no others.
  const orphans = db.prepare<[], { n: number }>(`
    SELECT COUNT(*) AS n FROM mechanical_log_rows WHERE uploadId NOT IN (SELECT id FROM mechanical_log_uploads)
  `).get()!.n;
  assert.equal(orphans, 0);
});

test('uploads on consecutive days coexist in the registry (M5)', () => {
  reset();
  // This fixture has two genuinely crew-filled days (1 and 18); rig-50-02-real
  // has only one, which leaves nothing behind once it is trimmed away.
  const parsed = parseWorkbook(fixture('rig-100-01-real.xlsx'));
  const first = planIngestion({ parsed, fileName: 'day-a.xlsx', storedFileName: 'a' });
  commitIngestion(first, ctx);

  // A second workbook whose latest day is different is not a duplicate.
  const trimmed = {
    ...parsed,
    groups: parsed.groups.map((g) => ({ ...g, days: g.days.filter((d) => d.sheetDay < first.lastFilledDay!) })),
  };
  const second = planIngestion({ parsed: trimmed, fileName: 'day-b.xlsx', storedFileName: 'b' });
  assert.equal(second.gates.some((g) => g.kind === 'duplicateUpload'), false);
  commitIngestion(second, ctx);

  assert.equal(
    db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM mechanical_log_uploads').get()!.n, 2,
  );
});

test('every real day is offered as a candidate, regardless of any override', () => {
  reset();
  const parsed = parseWorkbook(fixture('rig-100-01-real.xlsx'));
  const plan = planIngestion({ parsed, fileName: 'f.xlsx', storedFileName: 's' });
  assert.deepEqual(plan.availableDays, [1, 18]);
});

test('choosing an earlier "data through" day drops everything after it', () => {
  reset();
  const parsed = parseWorkbook(fixture('rig-100-01-real.xlsx'));
  const auto = planIngestion({ parsed, fileName: 'f.xlsx', storedFileName: 's' });
  assert.equal(auto.lastFilledDay, 18, 'day 18 is the latest real day by default');

  const chosen = planIngestion({
    parsed, fileName: 'f.xlsx', storedFileName: 's', lastFilledDayOverride: 1,
  });
  assert.equal(chosen.lastFilledDay, 1);
  assert.equal(chosen.lastFilledDayOverride, 1);
  for (const machine of chosen.machines) {
    assert.ok(machine.rows.every((r) => r.sheetDay <= 1), `${machine.name} kept a row past the chosen day`);
  }
  assert.ok(chosen.totals.rows < auto.totals.rows, 'fewer rows are imported once day 18 is excluded');
});

test('an explicit "data through" choice is itself the confirmation, so the gate stays quiet', () => {
  reset();
  const parsed = parseWorkbook(fixture('rig-100-01-real.xlsx'));
  const auto = planIngestion({ parsed, fileName: 'f.xlsx', storedFileName: 's' });
  assert.ok(
    auto.gates.some((g) => g.kind === 'lastFilledDay'),
    'without an override, an old last-filled day still asks for confirmation',
  );

  const chosen = planIngestion({
    parsed, fileName: 'f.xlsx', storedFileName: 's', lastFilledDayOverride: 1,
  });
  assert.equal(chosen.gates.some((g) => g.kind === 'lastFilledDay'), false);
});

test('identically named machines on two rigs stay separate (M6, D11)', () => {
  reset();
  commitIngestion(ingest('rig-100-01-real.xlsx').plan, ctx);
  commitIngestion(ingest('rig-200-01-real.xlsx').plan, ctx);

  const engines = db.prepare<[], { id: string; rigId: string; currentRunningHours: number }>(
    "SELECT id, rigId, currentRunningHours FROM equipment WHERE name = 'Rig Engine 1'",
  ).all();
  assert.equal(engines.length, 2, 'each rig keeps its own machine');
  assert.notEqual(engines[0].rigId, engines[1].rigId);
  assert.notEqual(engines[0].currentRunningHours, engines[1].currentRunningHours);
});

test('equipment matching is blocked when both serials differ (8.4)', () => {
  const candidate: EquipmentRow = {
    id: 'eq1', rigId: 'r1', name: 'Rig Engine 1', nameKey: 'rigengine1',
    serialNumber: 'AAA111', serialKey: 'aaa111', model: null, manufacturer: null,
    category: 'Others', currentRunningHours: 0, lastServiceHours: 0, serviceInterval: 500,
    isBreakdown: 0, section: 'diesel',
  };
  const sameSerial = matchEquipment(
    { key: 'k', name: 'Rig Engine 1', nameKey: 'rigengine1', serial: 'aaa-111', serialKey: 'aaa111', makeModel: null, section: 'diesel', days: [] },
    [candidate], new Set(),
  );
  assert.equal(sameSerial.equipment?.id, 'eq1');

  const differentSerial = matchEquipment(
    { key: 'k', name: 'Rig Engine 1', nameKey: 'rigengine1', serial: 'BBB222', serialKey: 'bbb222', makeModel: null, section: 'diesel', days: [] },
    [candidate], new Set(),
  );
  assert.equal(differentSerial.equipment, null, 'a differing serial must not fall through to the name');
  assert.equal(differentSerial.matchedBy, 'new');
});

test('compliance is judged on the data date, not the upload timestamp (M7, D8)', () => {
  reset();
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const target = yesterday();
  // Re-date the workbook's latest day onto yesterday, which is what a rig that
  // reported this morning actually looks like.
  const logMonth = target.slice(0, 7);
  const day = Number(target.slice(8));
  const shifted = {
    ...parsed,
    logMonth,
    groups: parsed.groups.map((g) => ({
      ...g,
      days: g.days.slice(-1).map((d) => ({ ...d, sheetDay: day })),
    })),
  };
  const plan = planIngestion({ parsed: shifted, fileName: 'yesterday.xlsx', storedFileName: 'y' });
  commitIngestion(plan, ctx);

  const rows = complianceFor(target);
  const rig = rows.find((r) => r.rigNumber === 'GTC 50-02')!;
  assert.equal(rig.status, 'Uploaded');
  assert.equal(rig.lastDataDate, target);
  assert.ok(rows.filter((r) => r.status === 'Pending').length > 0, 'rigs that did not report stay Pending');
});

test('a rig on a declared holiday shows as exempt rather than pending (M8)', () => {
  reset();
  const target = yesterday();
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigNumber = ?')
    .get('GTC 250-01')!;
  db.prepare('INSERT INTO rig_holidays (id, rigId, date, type, description, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId('hol'), rig.id, target, 'Holiday', 'Rig move', nowIso());

  const rows = complianceFor(target);
  assert.equal(rows.find((r) => r.rigNumber === 'GTC 250-01')!.status, 'Exempt');
  assert.equal(rows.find((r) => r.rigNumber === 'GTC 50-01')!.status, 'Pending');
});

test('ingestion is atomic: a failure leaves the database untouched (11.1)', () => {
  reset();
  const { plan } = ingest('rig-50-02-real.xlsx');
  // Point one machine at an equipment id that does not exist, so the foreign key
  // fails part way through the commit.
  plan.machines[1].equipmentId = 'eq_does_not_exist';
  plan.machines[1].isNew = false;

  assert.throws(() => commitIngestion(plan, ctx));
  assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM mechanical_log_uploads').get()!.n, 0);
  assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM mechanical_log_rows').get()!.n, 0);
  assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM equipment').get()!.n, 0);
});

test('every field the import changes is written to the audit log (6.8)', () => {
  reset();
  const { plan } = ingest('rig-50-02-real.xlsx');
  commitIngestion(plan, ctx);
  const entries = db.prepare<[], { action: string; field: string | null }>(
    'SELECT action, field FROM audit_logs',
  ).all();
  assert.ok(entries.some((e) => e.action === 'equipment.create'));
  assert.ok(entries.some((e) => e.action === 'upload.import'));
  assert.ok(entries.some((e) => e.action === 'equipment.update.import' && e.field !== null));
});
