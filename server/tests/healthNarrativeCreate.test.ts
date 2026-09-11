import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso, today } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { planNarrativeRows, commitNarrativeRows } from '../src/routes/healthNarratives.js';
import type { ParsedNarrativeRow } from '../src/excel/parseHealthNarrative.js';
import { FLEET } from '../src/db/seed.js';

/**
 * A health check-up row for a rig that has no matching equipment yet — most
 * often because no mechanical log has been uploaded for that rig — now
 * creates the machine instead of leaving the data stranded, and the preview
 * carries an explicit alert naming the rig and the machines involved. The
 * reverse (equipment the mechanical log knows about that the health check-up
 * never mentions) must never be flagged: that is normal.
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

function rig(rigNumber: string): { id: string; rigNumber: string } {
  return db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM rigs WHERE rigNumber = ?',
  ).get(rigNumber)!;
}

function makeEquipment(rigId: string, opts: Partial<{ name: string; serialNumber: string }> = {}): string {
  const id = newId('eq');
  const name = opts.name ?? 'Rig Engine 1';
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, serialNumber, currentRunningHours,
      lastServiceHours, serviceInterval, healthCheckInterval, isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'Rig Carrier Engine', ?, 100, 0, 500, 90, 0, 'Normal', 'diesel', ?, ?)
  `).run(id, rigId, name, name.toLowerCase().replace(/[^a-z0-9]/g, ''), opts.serialNumber ?? null, nowIso(), nowIso());
  return id;
}

/** A minimal row as parseHealthNarrativeWorkbook would produce it. */
function row(opts: Partial<ParsedNarrativeRow> & { rigText: string | null }): ParsedNarrativeRow {
  return {
    sourceSheet: 'Engine Health Check up',
    category: 'Engine',
    rigText: opts.rigText,
    rigKey: rigKey(opts.rigText),
    place: null,
    application: opts.application ?? 'Carrier engine',
    make: opts.make ?? 'CAT',
    details: opts.details ?? null,
    model: opts.model ?? null,
    serialNumber: opts.serialNumber ?? null,
    previousDate: null,
    previousDateRaw: null,
    lastDate: opts.lastDate ?? today(),
    lastDateRaw: null,
    problem: opts.problem ?? null,
    action: null,
    outcomeNotes: null,
  };
}

before(reset);

test('a row for an unregistered machine on a real rig is marked to create equipment, with an alert', () => {
  reset();
  const target = rig('GTC 50-03'); // no equipment registered on this rig at all
  const plan = planNarrativeRows([row({ rigText: 'GTC 50-03', application: 'Carrier engine', serialNumber: 'RRA17724' })], null);

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].equipmentId, null, 'nothing exists yet to match');
  assert.ok(plan.rows[0].pendingGroupKey, 'it is queued for creation');
  assert.ok(
    plan.issues.some((i) => i.message.includes(target.rigNumber) && /not in its equipment directory/.test(i.message)),
    'the alert must name the rig',
  );
  assert.ok(plan.issues.some((i) => i.message.includes('Carrier engine')), 'the alert names the specific machine');
});

test('committing the plan creates the machine and links the entry to it', () => {
  reset();
  const target = rig('GTC 100-02');
  const plan = planNarrativeRows(
    [row({
      rigText: 'GTC 100-02', application: 'DG Set - 1 (125 KVA)', make: 'Supernova',
      serialNumber: 'E622CDJC204733G', model: 'SVE125', details: 'Model : SVE125\nSR No : E622CDJC204733G',
    })],
    null,
  );
  const result = commitNarrativeRows(plan.rows, 'test.xlsx', null, ctx);
  assert.equal(result.equipmentCreated, 1);
  assert.equal(result.matchedToEquipment, 1);

  const created = db.prepare<[string], {
    id: string; name: string; rigId: string; category: string; manufacturer: string; model: string;
    serialNumber: string; section: string; currentRunningHours: number; serviceInterval: number;
  }>('SELECT * FROM equipment WHERE rigId = ?').get(target.id)!;
  assert.equal(created.name, 'DG Set - 1 (125 KVA)');
  assert.equal(created.category, 'DG Set', 'the same category guess a mechanical log import would use');
  assert.equal(created.section, 'generator');
  assert.equal(created.manufacturer, 'Supernova');
  assert.equal(created.model, 'SVE125');
  assert.equal(created.serialNumber, 'E622CDJC204733G');
  assert.equal(created.currentRunningHours, 0, 'no hours are known yet — that is what the mechanical log will provide');
  assert.equal(created.serviceInterval, 500, 'a sensible default until a mechanical log corrects it');

  const narrative = db.prepare<[], { equipmentId: string }>('SELECT equipmentId FROM health_narratives LIMIT 1').get()!;
  assert.equal(narrative.equipmentId, created.id);
});

test('the new machine\'s health countdown is set from the row that created it', () => {
  reset();
  const plan = planNarrativeRows(
    [row({ rigText: 'GTC 150-02', application: 'Mud Pump engine', lastDate: '2026-06-17' })],
    null,
  );
  commitNarrativeRows(plan.rows, 'test.xlsx', null, ctx);
  const eq = db.prepare<[], { lastHealthCheckDate: string }>(
    "SELECT lastHealthCheckDate FROM equipment WHERE name = 'Mud Pump engine'",
  ).get()!;
  assert.equal(eq.lastHealthCheckDate, '2026-06-17');
});

test('two rows for the same never-seen machine create exactly one equipment record', () => {
  reset();
  const rows = [
    row({ rigText: 'GTC 200-01', application: 'DG Set - 2 (125 KVA)', serialNumber: 'P84089603', lastDate: '2026-01-01' }),
    row({ rigText: 'GTC 200-01', application: 'DG Set - 2 (125 KVA)', serialNumber: 'P84089603', lastDate: '2026-06-01' }),
  ];
  const plan = planNarrativeRows(rows, null);
  assert.equal(
    new Set(plan.rows.map((r) => r.pendingGroupKey)).size, 1,
    'the same serial on the same rig must share one pending group',
  );

  const result = commitNarrativeRows(plan.rows, 'test.xlsx', null, ctx);
  assert.equal(result.equipmentCreated, 1);
  const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM equipment').get()!.n;
  assert.equal(count, 1);

  // Both narrative rows point at the same machine, and its countdown reflects
  // the later of the two dates.
  const narratives = db.prepare('SELECT equipmentId FROM health_narratives').all() as { equipmentId: string }[];
  assert.equal(new Set(narratives.map((n) => n.equipmentId)).size, 1);
  const eq = db.prepare<[], { lastHealthCheckDate: string }>('SELECT lastHealthCheckDate FROM equipment').get()!;
  assert.equal(eq.lastHealthCheckDate, '2026-06-01');
});

test('a row that matches an existing machine is never re-created', () => {
  reset();
  const target = rig('GTC 100-03');
  const eqId = makeEquipment(target.id, { name: 'Rig Engine 1', serialNumber: 'JDY00701' });
  const plan = planNarrativeRows(
    [row({ rigText: 'GTC 100-03', application: 'Rig Engine 1', serialNumber: 'JDY00701' })],
    null,
  );
  assert.equal(plan.rows[0].equipmentId, eqId);
  assert.equal(plan.rows[0].pendingGroupKey, null, 'a matched row is never queued for creation');

  const result = commitNarrativeRows(plan.rows, 'test.xlsx', null, ctx);
  assert.equal(result.equipmentCreated, 0);
  assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM equipment').get()!.n, 1);
});

test('equipment known from a mechanical log but never mentioned in the health check-up raises no alert', () => {
  reset();
  const target = rig('GTC 1000-01');
  makeEquipment(target.id, { name: 'Rig Engine 1' });
  makeEquipment(target.id, { name: 'Mud Pump Engine 1' });

  // The health check-up only mentions one of the two machines on this rig.
  const plan = planNarrativeRows(
    [row({ rigText: 'GTC 1000-01', application: 'Rig Engine 1' })],
    null,
  );
  assert.equal(plan.issues.length, 0, 'a machine the workbook simply does not mention is not a problem');
});

test('a row naming a rig that is not registered at all is not sent through equipment creation', () => {
  reset();
  const plan = planNarrativeRows([row({ rigText: 'GTC 999-99', application: 'Some Engine' })], null);
  assert.equal(plan.rows[0].rigId, null);
  assert.equal(plan.rows[0].pendingGroupKey, null, 'there is no rig to create the machine under');
});

test('a place-only row with no rig at all is never queued for creation', () => {
  reset();
  const plan = planNarrativeRows(
    [row({ rigText: null, place: 'Bakrol Yard', application: 'DG Set - 1' })],
    null,
  );
  assert.equal(plan.rows[0].rigId, null);
  assert.equal(plan.rows[0].pendingGroupKey, null);
});

test('created equipment is written to the audit log with its provenance', () => {
  reset();
  const plan = planNarrativeRows(
    [row({ rigText: 'GTC 2000-01', application: 'Fire Pump Engine', serialNumber: 'ABC123' })],
    null,
  );
  commitNarrativeRows(plan.rows, 'health-check.xlsx', null, ctx);
  const eqId = db.prepare<[], { id: string }>('SELECT id FROM equipment').get()!.id;
  // Two audit rows now exist for this equipment: a generic 'equipment.create'
  // from the one shared createEquipment() every creation path uses, plus this
  // distinct provenance entry recording exactly why/where it came from.
  const entry = db.prepare<[string], { detail: string }>(
    "SELECT detail FROM audit_logs WHERE entityId = ? AND action = 'equipment.createdFromHealthNarrative'",
  ).get(eqId)!;
  assert.match(entry.detail, /health-check\.xlsx/);
  assert.match(entry.detail, /no mechanical log/);
});
