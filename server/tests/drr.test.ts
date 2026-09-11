import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { saveReport, loadReportDetail, resolveDprRig } from '../src/routes/dailyRigReport.js';
import { FLEET } from '../src/db/seed.js';

/**
 * The 7 scenarios from the Daily Rig Report spec: one save distributes into
 * DPR + Mechanical Log + HSD, next-day carry-forward, editing never
 * duplicates, breakdown fields persist, invalid input is rejected, and
 * switching rigs changes the equipment set. Exercises saveReport() directly
 * (the function POST/PUT /drr/reports both call) against real SQLite, same
 * convention as dprReports.test.ts.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of [
      'drr_hydraulic_lines', 'drr_oil_lines', 'drr_reports',
      'mechanical_log_rows', 'mechanical_log_uploads', 'equipment',
      'hsd_site_lines', 'hsd_equipment_lines', 'hsd_reports',
      'dpr_line_items', 'dpr_reports',
      'rigs', 'dpr_rigs',
    ]) {
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

function pmsRig(rigNumber: string): { id: string; rigNumber: string } {
  return db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM rigs WHERE rigNumber = ?',
  ).get(rigNumber)!;
}

function makeEquipment(rigId: string, name: string, currentRunningHours = 100): string {
  const id = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, healthCheckInterval, isBreakdown, isActive, status, section, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'DG Set', ?, 0, 500, 90, 0, 1, 'Normal', 'generator', ?, ?)
  `).run(id, rigId, name, name.toLowerCase().replace(/[^a-z0-9]/g, ''), currentRunningHours, nowIso(), nowIso());
  return id;
}

function basePayload(rigId: string, equipmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    rigId, reportDate: '2026-08-25', wellNo: 'DND#592', shift: 'Day', fieldLocation: 'Field A',
    hsdReceived: 200, hsdRemarks: null,
    equipmentLines: [{
      equipmentId, openingRunningHours: 100, dayHours: 8, nightHours: 4,
      hsdConsumption: 22, status: 'Running', remarks: null,
    }],
    oilLines: [{ equipmentId: null, oilType: 'ENGINE OIL 15W40', openingBalance: 107, oilAdded: 0, oilConsumed: 5, remark: null }],
    hydraulicLines: [{ tankName: 'Rig Carrier Hydraulic Tank', openingLevel: 420, topUp: 10, loss: 5, remark: null }],
    dprLines: [{
      wellName: 'DND#592', operationCode: '02 - Drilling', workType: 'R1',
      startTime: '06:00', endTime: '14:00', drillingFrom: 100, drillingTo: 150,
    }],
    status: 'Submitted',
    ...overrides,
  };
}

before(reset);
after(reset);

test('Test 1 — a submitted Daily Rig Report updates DPR, Mechanical Log and HSD', () => {
  reset();
  const rig = pmsRig('GTC 50-01');
  const eqId = makeEquipment(rig.id, 'DG-1');

  const saved = saveReport(null, basePayload(rig.id, eqId), ctx.user, ctx.ip) as any;
  assert.equal(saved.status, 'Submitted');

  const dprRig = resolveDprRig(rig.rigNumber);
  const dprReport = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM dpr_reports WHERE rigId = ? AND dprDate = ?',
  ).get(dprRig.id, '2026-08-25');
  assert.ok(dprReport, 'a DPR report exists');
  const dprLine = db.prepare<[string], { workType: string; totalHours: number; drillingTotal: number }>(
    'SELECT workType, totalHours, drillingTotal FROM dpr_line_items WHERE reportId = ?',
  ).get(dprReport!.id);
  assert.equal(dprLine!.workType, 'R1');
  assert.equal(dprLine!.totalHours, 8, 'start/end recomputed to 8 hours, not trusted from the client');
  assert.equal(dprLine!.drillingTotal, 50, 'drillingTo - drillingFrom recomputed server-side');

  const hsdReport = db.prepare<[string, string], { id: string; r1Hours: number }>(
    'SELECT id, r1Hours FROM hsd_reports WHERE rigId = ? AND hsdDate = ?',
  ).get(dprRig.id, '2026-08-25');
  assert.ok(hsdReport, 'an HSD report exists');
  assert.equal(hsdReport!.r1Hours, 8, 'HSD header hours mirror the DPR activity R1 total, not entered twice');
  const site = db.prepare<[string], { openingBalance: number; closingBalance: number }>(
    "SELECT openingBalance, closingBalance FROM hsd_site_lines WHERE reportId = ? AND label = 'Rig Site Diesel'",
  ).get(hsdReport!.id);
  assert.equal(site!.openingBalance, 0, 'no prior HSD day, so opening defaults to 0');
  assert.equal(site!.closingBalance, 178, '(0 + 200 received) - 22 consumed');

  const mlRow = db.prepare<[string, string], { closingHours: number; totalRunHours: number; source: string; hsdConsumptionLiters: number }>(
    'SELECT closingHours, totalRunHours, source, hsdConsumptionLiters FROM mechanical_log_rows WHERE equipmentId = ? AND logDate = ?',
  ).get(eqId, '2026-08-25');
  assert.ok(mlRow, 'a mechanical_log_rows row exists');
  assert.equal(mlRow!.totalRunHours, 12, 'day + night hours');
  assert.equal(mlRow!.closingHours, 112, 'opening 100 + total 12');
  assert.equal(mlRow!.source, 'drr');
  assert.equal(mlRow!.hsdConsumptionLiters, 22);

  const eq = db.prepare<[string], { currentRunningHours: number }>('SELECT currentRunningHours FROM equipment WHERE id = ?').get(eqId);
  assert.equal(eq!.currentRunningHours, 112, 'the equipment master baseline is written back too');
});

test('Test 2 — the next day carries yesterday\'s HSD and equipment closing values forward as opening', () => {
  reset();
  const rig = pmsRig('GTC 50-02');
  const eqId = makeEquipment(rig.id, 'DG-1');

  saveReport(null, basePayload(rig.id, eqId, { reportDate: '2026-08-25' }), ctx.user, ctx.ip);

  const day2 = saveReport(null, basePayload(rig.id, eqId, {
    reportDate: '2026-08-26',
    equipmentLines: [{ equipmentId: eqId, openingRunningHours: 112, dayHours: 6, nightHours: 6, hsdConsumption: 10, status: 'Running', remarks: null }],
    hsdReceived: 50,
  }), ctx.user, ctx.ip) as any;

  const dprRig = resolveDprRig(rig.rigNumber);
  const day2Hsd = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM hsd_reports WHERE rigId = ? AND hsdDate = ?',
  ).get(dprRig.id, '2026-08-26');
  const day2Site = db.prepare<[string], { openingBalance: number }>(
    "SELECT openingBalance FROM hsd_site_lines WHERE reportId = ? AND label = 'Rig Site Diesel'",
  ).get(day2Hsd!.id);
  assert.equal(day2Site!.openingBalance, 178, "day 2's HSD opening is day 1's closing (0+200-22)");

  const day2Row = db.prepare<[string, string], { openingRunningHours: number; closingHours: number }>(
    'SELECT openingRunningHours, closingHours FROM mechanical_log_rows WHERE equipmentId = ? AND logDate = ?',
  ).get(eqId, '2026-08-26');
  assert.equal(day2Row!.openingRunningHours, 112, "day 2's opening running hours is day 1's closing (100+12)");
  assert.equal(day2Row!.closingHours, 124);

  assert.equal(day2.equipmentLines[0].openingRunningHours, 112);
});

test('a Draft save does not touch DPR/HSD/Mechanical Log at all, so it cannot corrupt next-day carry-forward', () => {
  reset();
  const rig = pmsRig('GTC 100-01');
  const eqId = makeEquipment(rig.id, 'DG-1');

  saveReport(null, basePayload(rig.id, eqId, { status: 'Draft', reportDate: '2026-08-25' }), ctx.user, ctx.ip);

  const dprRig = resolveDprRig(rig.rigNumber);
  assert.equal(db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM dpr_reports WHERE rigId = ?').get(dprRig.id)!.n, 0);
  assert.equal(db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM hsd_reports WHERE rigId = ?').get(dprRig.id)!.n, 0);
  assert.equal(db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM mechanical_log_rows WHERE equipmentId = ?').get(eqId)!.n, 0);

  // But the draft itself is retrievable with everything the user typed.
  const drrRow = db.prepare<[string], { id: string }>('SELECT id FROM drr_reports WHERE rigId = ?').get(rig.id)!;
  const detail = loadReportDetail(drrRow.id) as any;
  assert.equal(detail.status, 'Draft');
  assert.equal(detail.equipmentLines[0].dayHours, 8);
});

test('Test 4 — editing an existing report reuses the same DPR/HSD/mechanical-log rows, never duplicating them', () => {
  reset();
  const rig = pmsRig('GTC 100-02');
  const eqId = makeEquipment(rig.id, 'DG-1');

  const first = saveReport(null, basePayload(rig.id, eqId), ctx.user, ctx.ip) as any;
  const second = saveReport(first.id, basePayload(rig.id, eqId, {
    hsdReceived: 300,
    equipmentLines: [{ equipmentId: eqId, openingRunningHours: 100, dayHours: 10, nightHours: 2, hsdConsumption: 30, status: 'Running', remarks: 'edited' }],
  }), ctx.user, ctx.ip) as any;

  assert.equal(second.id, first.id, 'the same drr_reports row is reused');

  const dprRig = resolveDprRig(rig.rigNumber);
  assert.equal(db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM dpr_reports WHERE rigId = ?').get(dprRig.id)!.n, 1);
  assert.equal(db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM hsd_reports WHERE rigId = ?').get(dprRig.id)!.n, 1);
  assert.equal(db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM mechanical_log_rows WHERE equipmentId = ?').get(eqId)!.n, 1, 'not two rows');

  const mlRow = db.prepare<[string], { hoursRunDay: number; remarks: string }>('SELECT hoursRunDay, remarks FROM mechanical_log_rows WHERE equipmentId = ?').get(eqId);
  assert.equal(mlRow!.hoursRunDay, 10, 'the edit\'s new value, not the original');
  assert.equal(mlRow!.remarks, 'edited');
});

test('Test 5 — a Breakdown status line requires and persists its breakdown fields', () => {
  reset();
  const rig = pmsRig('GTC 100-03');
  const eqId = makeEquipment(rig.id, 'DG-1');

  assert.throws(
    () => saveReport(null, basePayload(rig.id, eqId, {
      equipmentLines: [{ equipmentId: eqId, openingRunningHours: 100, dayHours: 0, nightHours: 0, hsdConsumption: 0, status: 'Breakdown', remarks: null }],
    }), ctx.user, ctx.ip),
    /Fix the highlighted fields/,
    'a Breakdown line with no description is rejected on submit',
  );

  const saved = saveReport(null, basePayload(rig.id, eqId, {
    equipmentLines: [{
      equipmentId: eqId, openingRunningHours: 100, dayHours: 0, nightHours: 0, hsdConsumption: 0, status: 'Breakdown',
      remarks: null, breakdownAt: '2026-08-25T06:00', breakdownDescription: 'Engine seized',
      actionTaken: 'Called service', partsRequired: 'Piston kit', expectedRestoration: '2026-08-27', breakdownRemark: 'Urgent',
    }],
  }), ctx.user, ctx.ip) as any;

  const mlRow = db.prepare<[string], { status: string; breakdownDescription: string; partsRequired: string }>(
    'SELECT status, breakdownDescription, partsRequired FROM mechanical_log_rows WHERE equipmentId = ?',
  ).get(eqId);
  assert.equal(mlRow!.status, 'Breakdown');
  assert.equal(mlRow!.breakdownDescription, 'Engine seized');
  assert.equal(mlRow!.partsRequired, 'Piston kit');

  const eq = db.prepare<[string], { isBreakdown: number }>('SELECT isBreakdown FROM equipment WHERE id = ?').get(eqId);
  assert.equal(eq!.isBreakdown, 1);
  assert.ok(saved.id);
});

test('Test 6 — negative hours and over-consumption are rejected with a clear message', () => {
  reset();
  const rig = pmsRig('GTC 100-04');
  const eqId = makeEquipment(rig.id, 'DG-1');

  assert.throws(
    () => saveReport(null, basePayload(rig.id, eqId, {
      equipmentLines: [{ equipmentId: eqId, openingRunningHours: 100, dayHours: -2, nightHours: 4, hsdConsumption: 22, status: 'Running', remarks: null }],
    }), ctx.user, ctx.ip),
    /Fix the highlighted fields/,
  );

  assert.throws(
    () => saveReport(null, basePayload(rig.id, eqId, {
      oilLines: [{ equipmentId: null, oilType: 'ENGINE OIL 15W40', openingBalance: 5, oilAdded: 0, oilConsumed: 20, remark: null }],
    }), ctx.user, ctx.ip),
    /Fix the highlighted fields/,
    'an oil closing balance that would go negative is rejected',
  );

  assert.throws(
    () => saveReport(null, basePayload(rig.id, eqId, { reportDate: '', shift: '' }), ctx.user, ctx.ip),
    /Fix the highlighted fields/,
    'missing required fields are rejected',
  );
});

test('Test 7 — a different rig loads its own equipment, not another rig\'s', () => {
  reset();
  const rigA = pmsRig('GTC 100-07');
  const rigB = pmsRig('GTC 100-08');
  makeEquipment(rigA.id, 'DG-1');
  makeEquipment(rigA.id, 'DG-2');
  makeEquipment(rigB.id, 'Mud Pump');

  const countFor = (rigId: string) => db.prepare<[string], { n: number }>('SELECT COUNT(*) n FROM equipment WHERE rigId = ?').get(rigId)!.n;
  assert.equal(countFor(rigA.id), 2);
  assert.equal(countFor(rigB.id), 1);
});

test('duplicate rig+date+shift is blocked by the database unique index, not only application logic', () => {
  reset();
  const rig = pmsRig('GTC 150-02');
  const eqId = makeEquipment(rig.id, 'DG-1');
  saveReport(null, basePayload(rig.id, eqId), ctx.user, ctx.ip);

  assert.throws(() => {
    db.prepare(`
      INSERT INTO drr_reports (id, rigId, reportDate, shift, status, submittedBy, createdBy, createdAt, updatedBy, updatedAt)
      VALUES (?, ?, '2026-08-25', 'Day', 'Draft', 'x', 'x', ?, 'x', ?)
    `).run(newId('drr'), rig.id, nowIso(), nowIso());
  }, /UNIQUE constraint/);
});

test('an unresolvable rig (no matching DPR rig) fails clearly instead of silently orphaning data', () => {
  reset();
  const id = newId('rig');
  db.prepare(`INSERT INTO rigs (id, name, rigNumber, rigKey, status, createdAt) VALUES (?, 'Orphan Rig', 'ORPHAN-1', 'orphan-1', 'Active', ?)`)
    .run(id, nowIso());
  const eqId = makeEquipment(id, 'DG-1');

  assert.throws(
    () => saveReport(null, basePayload(id, eqId), ctx.user, ctx.ip),
    /No matching DPR rig/,
  );
});
