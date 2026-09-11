import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { addDays, nowIso, today } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import {
  advanceHealthCountdown, deleteNarrativeUpload, logManualCheckup, matchNarrativeEquipment,
} from '../src/routes/healthNarratives.js';
import { FLEET } from '../src/db/seed.js';

/**
 * Two fixes: (1) a bulk-imported workbook row now links to a real tracked
 * machine (serial-then-name, scoped to its rig — the same rule the mechanical
 * log ingestion already trusts) and advances that machine's countdown, where
 * before it was informational text only and never touched equipment.
 * (2) deleting a health log entry walks the countdown it set back, rather
 * than leaving a deleted checkup's effect in place on the machine.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of ['health_narratives', 'health_narrative_uploads', 'equipment', 'rigs']) {
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

function rig(rigNumber: string): { id: string } {
  return db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigNumber = ?').get(rigNumber)!;
}

function makeEquipment(rigId: string, opts: Partial<{
  name: string; serialNumber: string; lastHealthCheckDate: string | null;
}> = {}): string {
  const id = newId('eq');
  const name = opts.name ?? 'Rig Engine 1';
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, serialNumber, serialKey,
      currentRunningHours, lastServiceHours, serviceInterval, lastHealthCheckDate, healthCheckInterval,
      isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'Rig Carrier Engine', ?, ?, 100, 0, 500, ?, 90, 0, 'Normal', 'diesel', ?, ?)
  `).run(
    id, rigId, name, name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    opts.serialNumber ?? null, opts.serialNumber ? opts.serialNumber.toLowerCase() : null,
    opts.lastHealthCheckDate ?? null, nowIso(), nowIso(),
  );
  return id;
}

function insertNarrativeRow(input: {
  uploadId: string; equipmentId: string | null; rigId: string; lastDate: string | null;
}): string {
  const id = newId('hn');
  db.prepare(`
    INSERT INTO health_narratives (id, uploadId, equipmentId, sourceSheet, category, rigId, lastDate, createdAt)
    VALUES (?, ?, ?, 'Engine Health Check up', 'Engine', ?, ?, ?)
  `).run(id, input.uploadId, input.equipmentId, input.rigId, input.lastDate, nowIso());
  return id;
}

function makeUpload(recordsImported = 1): string {
  const id = newId('hnupl');
  db.prepare(`
    INSERT INTO health_narrative_uploads (id, fileName, storedFileName, uploadDate, uploadedBy, recordsImported)
    VALUES (?, 'test.xlsx', NULL, ?, 'tester', ?)
  `).run(id, nowIso(), recordsImported);
  return id;
}

before(reset);

/* ------------------------- matching ------------------------- */

test('a workbook row matches a registered machine by serial, scoped to its rig', () => {
  reset();
  const target = rig('GTC 50-01');
  const other = rig('GTC 50-02');
  makeEquipment(other.id, { name: 'Rig Engine 1', serialNumber: 'JSC08784' });
  const eqId = makeEquipment(target.id, { name: 'Carrier engine (Spare)', serialNumber: 'JSC01354' });

  const match = matchNarrativeEquipment(target.id, 'JSC01354', 'Carrier engine (Spare )');
  assert.ok(match, 'the serial should match despite the punctuation difference in the name');
  assert.equal(match!.id, eqId);
});

test('a serial that matches a machine on a different rig is not matched', () => {
  reset();
  const target = rig('GTC 100-01');
  const other = rig('GTC 100-02');
  makeEquipment(other.id, { name: 'Rig Engine 1', serialNumber: 'JDK00371' });

  const match = matchNarrativeEquipment(target.id, 'JDK00371', 'Rig Engine 1');
  assert.equal(match, null, 'matching must be scoped to the resolved rig, not fleet-wide');
});

test('with no serial on either side, the row falls back to matching by name', () => {
  reset();
  const target = rig('GTC 150-02');
  const eqId = makeEquipment(target.id, { name: 'Mud Pump Engine 1' });
  const match = matchNarrativeEquipment(target.id, null, 'Mud Pump Engine 1');
  assert.equal(match!.id, eqId);
});

test('a row naming no application and no serial matches nothing', () => {
  reset();
  const target = rig('GTC 200-01');
  makeEquipment(target.id, { name: 'Rig Engine 1' });
  assert.equal(matchNarrativeEquipment(target.id, null, null), null);
});

/* ------------------------- advancing (import & manual) ------------------------- */

test('a matched workbook row advances the machine\'s countdown forward', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 250-01').id, { lastHealthCheckDate: addDays(today(), -80) });
  advanceHealthCountdown(eqId, today(), ctx);
  const row = db.prepare<[string], { lastHealthCheckDate: string }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(row.lastHealthCheckDate, today());
});

test('advancing never moves the countdown backward, from any source', () => {
  reset();
  const recent = addDays(today(), -5);
  const eqId = makeEquipment(rig('GTC 1000-01').id, { lastHealthCheckDate: recent });
  advanceHealthCountdown(eqId, addDays(today(), -40), ctx);
  const row = db.prepare<[string], { lastHealthCheckDate: string }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(row.lastHealthCheckDate, recent, 'a hand-set or previously-logged newer date must survive');
});

test('a machine never checked before is set to never-checked no longer once matched', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 1000-02').id, { lastHealthCheckDate: null });
  advanceHealthCountdown(eqId, today(), ctx);
  const row = db.prepare<[string], { lastHealthCheckDate: string; status: string }>(
    'SELECT lastHealthCheckDate, status FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(row.lastHealthCheckDate, today());
});

/* ------------------------- delete walk-back ------------------------- */

test('deleting the upload that set a machine\'s only checkup reverts it to never checked', () => {
  reset();
  const rigId = rig('GTC 50-03').id;
  const eqId = makeEquipment(rigId, { lastHealthCheckDate: null });
  const uploadId = makeUpload();
  insertNarrativeRow({ uploadId, equipmentId: eqId, rigId, lastDate: today() });
  advanceHealthCountdown(eqId, today(), ctx);
  assert.equal(
    db.prepare<[string], { d: string }>('SELECT lastHealthCheckDate AS d FROM equipment WHERE id = ?').get(eqId)!.d,
    today(),
  );

  deleteNarrativeUpload(uploadId, ctx);

  const after = db.prepare<[string], { lastHealthCheckDate: string | null }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(after.lastHealthCheckDate, null, 'no evidence remains, so the machine goes back to never checked');
});

test('deleting a manual entry reverts exactly the machine it was logged against', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 100-03').id, { lastHealthCheckDate: null });
  const narrative = logManualCheckup({ equipmentId: eqId, date: today(), problem: 'test' }, ctx) as { uploadId: string };

  assert.equal(
    db.prepare<[string], { d: string }>('SELECT lastHealthCheckDate AS d FROM equipment WHERE id = ?').get(eqId)!.d,
    today(),
  );

  deleteNarrativeUpload(narrative.uploadId, ctx);

  const after = db.prepare<[string], { lastHealthCheckDate: string | null }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(after.lastHealthCheckDate, null, 'exactly the manual entry\'s effect must be undone');
});

test('deleting one machine\'s checkup falls back to an earlier one still on record, not to null', () => {
  reset();
  const rigId = rig('GTC 100-04').id;
  const eqId = makeEquipment(rigId);
  const earlierUpload = makeUpload();
  insertNarrativeRow({ uploadId: earlierUpload, equipmentId: eqId, rigId, lastDate: addDays(today(), -60) });
  advanceHealthCountdown(eqId, addDays(today(), -60), ctx);

  const laterNarrative = logManualCheckup({ equipmentId: eqId, date: today() }, ctx) as { uploadId: string };
  assert.equal(
    db.prepare<[string], { d: string }>('SELECT lastHealthCheckDate AS d FROM equipment WHERE id = ?').get(eqId)!.d,
    today(),
  );

  deleteNarrativeUpload(laterNarrative.uploadId, ctx);

  const after = db.prepare<[string], { lastHealthCheckDate: string }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(after.lastHealthCheckDate, addDays(today(), -60), 'falls back to the still-recorded earlier checkup');
});

test('deleting old history never disturbs a machine whose current date came from elsewhere', () => {
  reset();
  const rigId = rig('GTC 100-07').id;
  const eqId = makeEquipment(rigId);
  const oldUpload = makeUpload();
  insertNarrativeRow({ uploadId: oldUpload, equipmentId: eqId, rigId, lastDate: addDays(today(), -90) });
  advanceHealthCountdown(eqId, addDays(today(), -90), ctx);

  // A hand-edit (or an unrelated newer entry) sets a more recent date directly,
  // with no narrative row of its own backing it.
  db.prepare('UPDATE equipment SET lastHealthCheckDate = ? WHERE id = ?').run(today(), eqId);

  deleteNarrativeUpload(oldUpload, ctx);

  const after = db.prepare<[string], { lastHealthCheckDate: string }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(after.lastHealthCheckDate, today(), 'the current value was not justified by the deleted rows, so it stands');
});

test('deleting an upload with entries for two machines reverts both independently', () => {
  reset();
  const rigId = rig('GTC 100-08').id;
  const eqA = makeEquipment(rigId, { name: 'Rig Engine 1' });
  const eqB = makeEquipment(rigId, { name: 'Mud Pump Engine 1' });
  const uploadId = makeUpload(2);
  insertNarrativeRow({ uploadId, equipmentId: eqA, rigId, lastDate: today() });
  insertNarrativeRow({ uploadId, equipmentId: eqB, rigId, lastDate: today() });
  advanceHealthCountdown(eqA, today(), ctx);
  advanceHealthCountdown(eqB, today(), ctx);

  deleteNarrativeUpload(uploadId, ctx);

  for (const id of [eqA, eqB]) {
    const row = db.prepare<[string], { d: string | null }>('SELECT lastHealthCheckDate AS d FROM equipment WHERE id = ?').get(id)!;
    assert.equal(row.d, null);
  }
});

test('the countdown change from a delete is written to the audit log', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 2000-01').id);
  const narrative = logManualCheckup({ equipmentId: eqId, date: today() }, ctx) as { uploadId: string };
  deleteNarrativeUpload(narrative.uploadId, ctx);
  const entries = db.prepare<[string], { detail: string }>(
    "SELECT detail FROM audit_logs WHERE entityId = ? AND action = 'healthnarrative.countdown'",
  ).all(eqId);
  assert.ok(entries.some((e) => /cleared/.test(e.detail)), 'the delete-driven revert must be in the audit log');
});
