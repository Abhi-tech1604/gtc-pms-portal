import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { addDays, nowIso, today } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { logManualCheckup } from '../src/routes/healthNarratives.js';
import { generateEquipmentHealthCheckupPendingNotifications, listForUser } from '../src/services/notifications.js';
import { FLEET } from '../src/db/seed.js';
import bcrypt from 'bcryptjs';
import { serialiseRights } from '../src/services/rights.js';

/**
 * The manual "log a checkup" flow reached from a machine's own record: same
 * fields as the workbook (date, problem, action, remarks), always linked to
 * that one equipmentId, and it must reset the 90-day countdown exactly as the
 * old health_check_records flow did.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of ['health_narratives', 'health_narrative_uploads', 'notifications', 'equipment', 'users', 'rigs']) {
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

function makeEquipment(rigId: string, opts: Partial<{
  name: string; category: string; manufacturer: string; model: string; serialNumber: string;
  lastHealthCheckDate: string | null; healthCheckInterval: number;
}> = {}): string {
  const id = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, manufacturer, model, serialNumber,
      currentRunningHours, lastServiceHours, serviceInterval, lastHealthCheckDate, healthCheckInterval,
      isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 0, 500, ?, ?, 0, 'Normal', 'diesel', ?, ?)
  `).run(
    id, rigId, opts.name ?? 'Rig Engine 1', (opts.name ?? 'rigengine1').toLowerCase().replace(/[^a-z0-9]/g, ''),
    opts.category ?? 'Rig Carrier Engine', opts.manufacturer ?? 'CAT', opts.model ?? 'C-15',
    opts.serialNumber ?? 'JDK00371', opts.lastHealthCheckDate ?? null, opts.healthCheckInterval ?? 90,
    nowIso(), nowIso(),
  );
  return id;
}

function makeUser(rigId: string | null = null): string {
  const id = newId('usr');
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, name, email, rigId, status, rights, createdAt)
    VALUES (?, ?, ?, 'Rig Supervisor', ?, NULL, ?, 'Active', ?, ?)
  `).run(id, `insp_${id}`, bcrypt.hashSync('x', 4), `insp_${id}`, rigId,
    serialiseRights({}, 'Rig Supervisor'), nowIso());
  return id;
}

before(reset);

test('a manual checkup carries the equipmentId, unlike a bulk import', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 50-01').id, { name: 'Rig Engine 1' });
  const narrative = logManualCheckup(
    { equipmentId: eqId, date: today(), problem: 'Oil leak from gasket', action: 'Replaced gasket', remarks: 'Tested OK' },
    ctx,
  ) as { equipmentId: string; problem: string; action: string; outcomeNotes: string; sourceSheet: string };
  assert.equal(narrative.equipmentId, eqId);
  assert.equal(narrative.sourceSheet, 'Manual Entry');
  assert.equal(narrative.problem, 'Oil leak from gasket');
  assert.equal(narrative.action, 'Replaced gasket');
  assert.equal(narrative.outcomeNotes, 'Tested OK', 'remarks are stored in the same column the workbook uses for notes');
});

test('the entry inherits the machine\'s own rig, category, make and serial', () => {
  reset();
  const target = rig('GTC 100-01');
  const eqId = makeEquipment(target.id, {
    name: 'Fire Pump Engine', category: 'Fire Pump', manufacturer: 'Kirloskar', serialNumber: '4H.2280.25',
  });
  const narrative = logManualCheckup({ equipmentId: eqId, problem: 'none' }, ctx) as {
    rigId: string; category: string; make: string; serialNumber: string; application: string;
  };
  assert.equal(narrative.rigId, target.id);
  assert.equal(narrative.category, 'Fire Pump', 'category is not forced into Engine/Transmission for a manual entry');
  assert.equal(narrative.make, 'Kirloskar');
  assert.equal(narrative.serialNumber, '4H.2280.25');
  assert.equal(narrative.application, 'Fire Pump Engine');
});

test('logging a checkup resets the 90-day countdown', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 50-02').id, { lastHealthCheckDate: addDays(today(), -80) });
  logManualCheckup({ equipmentId: eqId, date: today() }, ctx);
  const row = db.prepare<[string], { lastHealthCheckDate: string }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(row.lastHealthCheckDate, today());
});

test('a back-dated entry never undoes a more recent checkup', () => {
  reset();
  const recent = addDays(today(), -5);
  const eqId = makeEquipment(rig('GTC 50-03').id, { lastHealthCheckDate: recent });
  logManualCheckup({ equipmentId: eqId, date: addDays(today(), -40) }, ctx);
  const row = db.prepare<[string], { lastHealthCheckDate: string }>(
    'SELECT lastHealthCheckDate FROM equipment WHERE id = ?',
  ).get(eqId)!;
  assert.equal(row.lastHealthCheckDate, recent, 'the newer date must win');
});

test('logging a checkup resolves a pending EQUIPMENT_HEALTH_CHECKUP_PENDING notification', () => {
  reset();
  const target = rig('GTC 100-02');
  const inspector = makeUser();
  const eqId = makeEquipment(target.id, { lastHealthCheckDate: addDays(today(), -120) });

  generateEquipmentHealthCheckupPendingNotifications();
  const before = listForUser(inspector).find((n) => n.equipmentId === eqId);
  assert.ok(before, 'the overdue machine should have raised a notification');
  assert.equal(before!.resolvedAt, null);

  logManualCheckup({ equipmentId: eqId, date: today() }, ctx);

  const after = listForUser(inspector).find((n) => n.id === before!.id)!;
  assert.notEqual(after.resolvedAt, null);
});

test('the previous checkup date is carried forward into the new entry', () => {
  reset();
  const priorDate = addDays(today(), -95);
  const eqId = makeEquipment(rig('GTC 100-03').id, { lastHealthCheckDate: priorDate });
  const narrative = logManualCheckup({ equipmentId: eqId, date: today() }, ctx) as {
    previousDate: string; lastDate: string;
  };
  assert.equal(narrative.previousDate, priorDate);
  assert.equal(narrative.lastDate, today());
});

test('an empty problem field is stored as no issues found, not an error', () => {
  reset();
  const eqId = makeEquipment(rig('GTC 100-04').id);
  const narrative = logManualCheckup({ equipmentId: eqId }, ctx) as { problem: string | null };
  assert.equal(narrative.problem, null);
  const entry = db.prepare<[string], { detail: string }>(
    "SELECT detail FROM audit_logs WHERE entityId = ? AND action = 'healthnarrative.manual'",
  ).get(eqId)!;
  assert.match(entry.detail, /no issues found/);
});

test('a manual entry does not require choosing a machine that does not exist', () => {
  reset();
  assert.throws(() => logManualCheckup({ equipmentId: 'eq_does_not_exist' }, ctx), /Choose the machine/);
});
