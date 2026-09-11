import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso, today } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { createTransfer } from '../src/routes/equipmentTransfers.js';
import { FLEET } from '../src/db/seed.js';

/**
 * Equipment transfers: moving a machine to another rig updates its owning
 * rigId; moving it to a yard/store location sets currentPlace and leaves
 * rigId as its home rig. Every transfer is kept as history.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of ['equipment_transfers', 'equipment', 'rigs']) {
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

function rig(rigNumber: string): { id: string; rigNumber: string } {
  return db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM rigs WHERE rigNumber = ?',
  ).get(rigNumber)!;
}

function makeEquipment(rigId: string, name = 'Rig Engine 1'): string {
  const id = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, healthCheckInterval, isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'Rig Carrier Engine', 100, 0, 500, 90, 0, 'Normal', 'diesel', ?, ?)
  `).run(id, rigId, name, name.toLowerCase().replace(/[^a-z0-9]/g, ''), nowIso(), nowIso());
  return id;
}

before(reset);

test('transferring to another rig updates rigId and clears any place', () => {
  reset();
  const source = rig('GTC 50-01');
  const dest = rig('GTC 50-02');
  const eqId = makeEquipment(source.id);

  createTransfer(
    { equipmentId: eqId, destinationType: 'rig', toRigId: dest.id, transferType: 'Permanent' },
    ctx,
  );

  const after = db.prepare<[string], { rigId: string; currentPlace: string | null }>(
    'SELECT rigId, currentPlace FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(after.rigId, dest.id);
  assert.equal(after.currentPlace, null);
});

test('transferring to a yard leaves the owning rig unchanged and sets currentPlace', () => {
  reset();
  const source = rig('GTC 100-01');
  const eqId = makeEquipment(source.id);

  createTransfer(
    { equipmentId: eqId, destinationType: 'other', toPlace: 'Bakrol Yard', transferType: 'Temporary', expectedReturnDate: '2026-09-01' },
    ctx,
  );

  const after = db.prepare<[string], { rigId: string; currentPlace: string | null; currentPlaceSince: string | null }>(
    'SELECT rigId, currentPlace, currentPlaceSince FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(after.rigId, source.id, 'the machine keeps its home rig while away at a yard');
  assert.equal(after.currentPlace, 'Bakrol Yard');
  assert.ok(after.currentPlaceSince);
});

test('every transfer is recorded as history, including the from/to values', () => {
  reset();
  const source = rig('GTC 150-02');
  const eqId = makeEquipment(source.id);

  createTransfer({ equipmentId: eqId, destinationType: 'other', toPlace: 'Central Store', transferType: 'Permanent' }, ctx);
  const dest = rig('GTC 200-01');
  createTransfer({ equipmentId: eqId, destinationType: 'rig', toRigId: dest.id, transferType: 'Permanent' }, ctx);

  const history = db.prepare<[string], { fromRigId: string | null; fromPlace: string | null; toRigId: string | null; toPlace: string | null }>(
    'SELECT fromRigId, fromPlace, toRigId, toPlace FROM equipment_transfers WHERE equipmentId = ? ORDER BY createdAt',
  ).all(eqId);
  assert.equal(history.length, 2);
  assert.equal(history[0].fromRigId, source.id);
  assert.equal(history[0].toPlace, 'Central Store');
  assert.equal(history[1].fromPlace, 'Central Store', 'the second transfer records where it was coming from');
  assert.equal(history[1].toRigId, dest.id);
});

test('a temporary transfer keeps its expected return date; a permanent one has none', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 250-01').id);
  const t = createTransfer(
    { equipmentId: eqId, destinationType: 'other', toPlace: 'Akram workshop', transferType: 'Temporary', expectedReturnDate: '2026-10-15' },
    ctx,
  ) as { expectedReturnDate: string | null; transferType: string };
  assert.equal(t.transferType, 'Temporary');
  assert.equal(t.expectedReturnDate, '2026-10-15');

  const eq2 = makeEquipment(rig('GTC 2000-01').id);
  const t2 = createTransfer(
    { equipmentId: eq2, destinationType: 'other', toPlace: 'Central Store', transferType: 'Permanent', expectedReturnDate: '2026-10-15' },
    ctx,
  ) as { expectedReturnDate: string | null };
  assert.equal(t2.expectedReturnDate, null, 'a permanent transfer never carries a return date, even if one was sent');
});

test('transferring a machine to the rig it is already on is rejected', () => {
  reset();
  const source = rig('GTC 1000-01');
  const eqId = makeEquipment(source.id);
  assert.throws(
    () => createTransfer({ equipmentId: eqId, destinationType: 'rig', toRigId: source.id, transferType: 'Permanent' }, ctx),
    /already on this rig/,
  );
});

test('a transfer to an unknown rig or with no place named is rejected', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 1000-02').id);
  assert.throws(
    () => createTransfer({ equipmentId: eqId, destinationType: 'rig', toRigId: 'rig_does_not_exist', transferType: 'Permanent' }, ctx),
    /Choose the rig/,
  );
  assert.throws(
    () => createTransfer({ equipmentId: eqId, destinationType: 'other', toPlace: '', transferType: 'Permanent' }, ctx),
    /Enter the destination/,
  );
});

test('a transfer is written to the audit log', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 100-02').id);
  createTransfer({ equipmentId: eqId, destinationType: 'other', toPlace: 'Central Store', transferType: 'Permanent', date: today() }, ctx);
  const entry = db.prepare<[string], { action: string; detail: string }>(
    "SELECT action, detail FROM audit_logs WHERE entityId = ? AND action = 'equipment.transfer'",
  ).get(eqId);
  assert.ok(entry);
  assert.match(entry!.detail, /Central Store/);
});
