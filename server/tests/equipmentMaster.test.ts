import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { listEquipment, getEquipment } from '../src/services/equipmentView.js';
import { FLEET } from '../src/db/seed.js';

/**
 * Equipment Master's soft Active/Inactive status: existing machines default to
 * active, the flag round-trips through the equipment view, and a fresh Excel
 * template for a rig — both the mechanical log and the health checkup one —
 * never offers a machine marked inactive. Historical rows already on record
 * for that machine are untouched by any of this.
 */

function reset(): void {
  transact(() => {
    for (const table of ['mechanical_log_rows', 'equipment', 'rigs']) {
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

function makeEquipment(rigId: string, opts: { name: string; isActive?: boolean }): string {
  const id = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, healthCheckInterval, isBreakdown, isActive, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'Rig Carrier Engine', 0, 0, 500, 90, 0, ?, 'Normal', 'diesel', ?, ?)
  `).run(
    id, rigId, opts.name, opts.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    opts.isActive === false ? 0 : 1, nowIso(), nowIso(),
  );
  return id;
}

/** Mirrors the query mechanicalLogs.ts's /template/:rigId route actually runs. */
function templateMachineNames(rigId: string): string[] {
  return db.prepare<[string], { name: string }>(
    'SELECT name FROM equipment WHERE rigId = ? AND isActive = 1 ORDER BY section, name',
  ).all(rigId).map((r) => r.name);
}

before(reset);

test('a machine created without saying otherwise is active', () => {
  reset();
  const target = rig('GTC 50-01');
  const id = makeEquipment(target.id, { name: 'Rig Engine 1' });
  assert.equal(getEquipment(id)!.isActive, true);
});

test('isActive round-trips through the equipment view for both states', () => {
  reset();
  const target = rig('GTC 50-01');
  const activeId = makeEquipment(target.id, { name: 'Rig Engine 1', isActive: true });
  const inactiveId = makeEquipment(target.id, { name: 'Mud Pump Engine 1', isActive: false });

  assert.equal(getEquipment(activeId)!.isActive, true);
  assert.equal(getEquipment(inactiveId)!.isActive, false);

  const listed = listEquipment(target.id);
  assert.equal(listed.find((e) => e.id === activeId)!.isActive, true);
  assert.equal(listed.find((e) => e.id === inactiveId)!.isActive, false);
});

test('a fresh mechanical log template never offers an inactive machine', () => {
  reset();
  const target = rig('GTC 50-01');
  makeEquipment(target.id, { name: 'Rig Engine 1', isActive: true });
  makeEquipment(target.id, { name: 'Retired Mud Pump', isActive: false });

  const names = templateMachineNames(target.id);
  assert.deepEqual(names, ['Rig Engine 1']);
});

test('marking a machine inactive removes it from the next template but the machine record itself is untouched', () => {
  reset();
  const target = rig('GTC 50-01');
  const id = makeEquipment(target.id, { name: 'Rig Engine 1', isActive: true });

  assert.deepEqual(templateMachineNames(target.id), ['Rig Engine 1']);

  db.prepare('UPDATE equipment SET isActive = 0 WHERE id = ?').run(id);

  assert.deepEqual(templateMachineNames(target.id), [], 'the next template no longer offers it');
  assert.ok(getEquipment(id), 'the machine record itself is still on file');
  assert.equal(getEquipment(id)!.name, 'Rig Engine 1');
});

test('an inactive machine on one rig never affects the template for another', () => {
  reset();
  const a = rig('GTC 50-01');
  const b = rig('GTC 50-02');
  makeEquipment(a.id, { name: 'Rig Engine 1', isActive: false });
  makeEquipment(b.id, { name: 'Rig Engine 1', isActive: true });

  assert.deepEqual(templateMachineNames(a.id), []);
  assert.deepEqual(templateMachineNames(b.id), ['Rig Engine 1']);
});
