import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { equipmentForDprRig } from '../src/routes/dpr.js';
import { FLEET } from '../src/db/seed.js';

/**
 * The DPR form's "Breakdown Equipment" field used to be a hardcoded static
 * list (client/src/lib/dprLists.ts's old DPR_EQUIPMENT). It is now sourced
 * live from PMS's Equipment Master, bridged to DPR's own independent rig
 * master by rigNumber (equipmentForDprRig(), routes/dpr.ts) — these tests
 * are what prove that bridge actually reflects Equipment Master live,
 * per-rig, and degrades gracefully rather than breaking DPR entry.
 */

function reset(): void {
  transact(() => {
    for (const table of ['equipment', 'rigs', 'dpr_rigs']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const rigNumber of FLEET) {
      const key = rigKey(rigNumber);
      db.prepare(`
        INSERT INTO rigs (id, name, rigNumber, rigKey, status, createdAt) VALUES (?, ?, ?, ?, 'Active', ?)
      `).run(newId('rig'), rigNumber.replace(/^GTC\s*/i, 'Rig '), rigNumber, key, nowIso());
      db.prepare(`
        INSERT INTO dpr_rigs (id, name, rigNumber, rigKey, status, createdAt) VALUES (?, ?, ?, ?, 'Active', ?)
      `).run(newId('dprrig'), rigNumber.replace(/^GTC\s*/i, 'Rig '), rigNumber, key, nowIso());
    }
  });
}

function pmsRigId(rigNumber: string): string {
  return db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigNumber = ?').get(rigNumber)!.id;
}

function addEquipment(rigId: string, name: string, isActive = true): string {
  const id = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, healthCheckInterval, isBreakdown, isActive, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'DG Set', 0, 0, 500, 90, 0, ?, 'Normal', 'generator', ?, ?)
  `).run(id, rigId, name, name.toLowerCase().replace(/[^a-z0-9]/g, ''), isActive ? 1 : 0, nowIso(), nowIso());
  return id;
}

before(reset);
after(reset);

test('Test 1/2 — equipment is scoped to the selected rig, not a shared list', () => {
  reset();
  const rigA = pmsRigId('GTC 50-01');
  const rigB = pmsRigId('GTC 50-02');
  addEquipment(rigA, 'DG-1');
  addEquipment(rigA, 'DG-2');
  addEquipment(rigB, 'Mud Pump');

  const forA = equipmentForDprRig('GTC 50-01');
  const forB = equipmentForDprRig('GTC 50-02');

  assert.equal(forA.linked, true);
  assert.deepEqual(forA.equipment.map((e) => e.name).sort(), ['DG-1', 'DG-2']);
  assert.deepEqual(forB.equipment.map((e) => e.name), ['Mud Pump']);
});

test('Test 3 — adding equipment in Equipment Master appears immediately, no code change needed', () => {
  reset();
  const rigA = pmsRigId('GTC 100-01');
  assert.deepEqual(equipmentForDprRig('GTC 100-01').equipment, []);

  addEquipment(rigA, 'Fresh DG');
  assert.deepEqual(equipmentForDprRig('GTC 100-01').equipment.map((e) => e.name), ['Fresh DG']);
});

test('Test 4 — editing equipment in Equipment Master is reflected on the next read', () => {
  reset();
  const rigA = pmsRigId('GTC 100-02');
  const id = addEquipment(rigA, 'Old Name');
  db.prepare('UPDATE equipment SET name = ? WHERE id = ?').run('New Name', id);

  assert.deepEqual(equipmentForDprRig('GTC 100-02').equipment.map((e) => e.name), ['New Name']);
});

test('Test 5 — deactivated equipment stops appearing for new selection', () => {
  reset();
  const rigA = pmsRigId('GTC 100-03');
  addEquipment(rigA, 'Active Unit', true);
  addEquipment(rigA, 'Retired Unit', false);

  assert.deepEqual(equipmentForDprRig('GTC 100-03').equipment.map((e) => e.name), ['Active Unit']);
});

test('a DPR rig with no matching PMS rig degrades to an empty, non-fatal list', () => {
  reset();
  db.prepare(`DELETE FROM rigs WHERE rigNumber = 'GTC 100-04'`).run();
  const result = equipmentForDprRig('GTC 100-04');
  assert.equal(result.linked, false);
  assert.deepEqual(result.equipment, []);
});
