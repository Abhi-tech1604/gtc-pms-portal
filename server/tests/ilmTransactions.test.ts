import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { withRigMatchCheck } from '../src/routes/ilm.js';
import {
  addCraneRecord, addCraneRound, addTrailerLoad, addTrailerMovement,
  createIlm, endIlm, findActiveIlm, reopenIlm, setDelayLines, updateIlmHeader,
} from '../src/services/ilmLifecycle.js';
import { getIlmTransaction, listIlmTransactions } from '../src/services/ilmView.js';
import { FLEET } from '../src/db/seed.js';

/**
 * An ILM is a long-lived parent record (Active -> Completed) with true
 * one-to-many history underneath it: many Trailer Movement rounds (each
 * with its own Loads), many Crane Rounds (each with its own records), and
 * many Delay/Fuel lines — all appended over however long the ILM runs, never
 * overwritten. Both manual entry and Excel import go through the exact same
 * services/ilmLifecycle.ts functions, so both sources share one data model.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

const emptyIndividual = {
  area: null, operatorName: null, wellNo: null, movementFromWell: null, movementToWell: null,
  releaseDate: null, releaseTime: null, spudDate: null, spudTime: null, ilmRatePerDay: null, ilmExpenses: null,
};

function reset(): void {
  transact(() => {
    for (const table of [
      'ilm_individual_lines', 'ilm_cranes', 'ilm_crane_rounds', 'ilm_trailer_loads', 'ilm_trailer_movements',
      'ilm_individual', 'ilm_trailer_header', 'ilm_transactions', 'ilm_import_batches', 'ilm_rigs',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const rigNumber of FLEET) {
      db.prepare(`
        INSERT INTO ilm_rigs (id, name, rigNumber, rigKey, status, createdAt)
        VALUES (?, ?, ?, ?, 'Active', ?)
      `).run(newId('ilmrig'), rigNumber.replace(/^GTC\s*/i, 'Rig '), rigNumber, rigKey(rigNumber), nowIso());
    }
  });
}

function rig(rigNumber: string): { id: string; rigNumber: string } {
  return db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM ilm_rigs WHERE rigNumber = ?',
  ).get(rigNumber)!;
}

function trailerLoadInput(overrides: Partial<Parameters<typeof addTrailerLoad>[1]> = {}) {
  return {
    mtGatePassNo: 'MT-1', trailerNo: 'TRL-01', equipmentId: null, trailerType: 'HB', capacityTon: null,
    arrivalDate: null, arrivalTime: null,
    loadingDate: '2026-08-20', loadingTime: '08:00', loadDescription: 'Pipes', totalPackages: 10,
    unloadingDate: '2026-08-20', unloadingTime: '14:00', driverName: 'Driver A', driverContact: '9999999999',
    ...overrides,
  };
}
function craneInput(overrides: Partial<Parameters<typeof addCraneRecord>[1]> = {}) {
  return {
    craneNo: 'CRN-01', equipmentId: null, capacityTon: 25, reportingDate: '2026-08-20', rigOrHired: 'Hired',
    registrationNo: 'REG-01', arrivedDate: '2026-08-20', arrivedTime: '07:00', releaseDate: null, releaseTime: null,
    transporterName: 'ACME', dayNo: 1, shiftDate: '2026-08-20', dayShiftHrs: 10, detailsJobDay: 'Rig up', nightShiftHrs: 8,
    detailsJobNight: 'Standby', breakdownHrs: 0, cumulativeHrs: 18, issuedHsdLtrs: 50, totalWorkingHrs: 18,
    ...overrides,
  };
}

before(reset);
// ilm_transactions.rigId is ON DELETE RESTRICT against ilm_rigs (ILM's own
// independent Rig Master, not PMS's) — leave the table empty when done so a
// different test file's own reset() can still delete ilm_rigs.
after(reset);

test('a manual entry and an Excel-sourced ILM for the same rig both land in the one data model', () => {
  reset();
  const target = rig('GTC 50-01');

  const manualId = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementFromWell: 'WELL-MANUAL' }, ctx,
  });
  endIlm(manualId, ctx);
  const excelId = createIlm({
    rigId: target.id, date: '2026-08-21', source: 'excel', importBatchId: null,
    individual: { ...emptyIndividual, movementFromWell: 'WELL-EXCEL' }, ctx,
  });

  const list = listIlmTransactions({ rigId: target.id });
  assert.equal(list.length, 2, 'both sources show up together');
  const sources = list.map((t) => t.source).sort();
  assert.deepEqual(sources, ['excel', 'manual']);

  const manual = getIlmTransaction(manualId)!;
  const excel = getIlmTransaction(excelId)!;
  assert.equal(manual.movementFromWell, 'WELL-MANUAL');
  assert.equal(excel.movementFromWell, 'WELL-EXCEL');
  assert.match(manual.ilmNumber, /^ILM-\d{4}-\d{5}$/, 'a human-readable sequence is generated');
  assert.notEqual(manual.ilmNumber, excel.ilmNumber, 'each ILM gets its own number');
});

test('a rig cannot have two Active ILMs at once — the second create attempt is blocked and points at the existing one', () => {
  reset();
  const target = rig('GTC 50-02');
  const firstId = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  assert.throws(
    () => createIlm({ rigId: target.id, date: '2026-08-21', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx }),
    (err: any) => err.status === 409 && err.details?.activeTransactionId === firstId,
  );

  assert.equal(findActiveIlm(target.id)!.id, firstId);
});

test('the DB-level partial unique index also blocks a second Active row, not only the application check', () => {
  reset();
  const target = rig('GTC 50-03');
  createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  assert.throws(() => {
    db.prepare(`
      INSERT INTO ilm_transactions (id, ilmNumber, rigId, date, source, status, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'manual', 'Active', 'x', ?, ?)
    `).run(newId('ilm'), `ILM-DUP-${Date.now()}`, target.id, '2026-08-21', nowIso(), nowIso());
  }, /UNIQUE constraint/);
});

test('adding a second Trailer Movement never touches the first movement\'s loads (append, not replace)', () => {
  reset();
  const target = rig('GTC 100-01');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const { id: m1 } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: 50, allowedDurationHrs: 24 }, ctx);
  addTrailerLoad(m1, trailerLoadInput({ trailerNo: 'TRL-M1-A' }), ctx);
  addTrailerLoad(m1, trailerLoadInput({ trailerNo: 'TRL-M1-B' }), ctx);

  const { id: m2 } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: 80, allowedDurationHrs: 24 }, ctx);
  addTrailerLoad(m2, trailerLoadInput({ trailerNo: 'TRL-M2-A' }), ctx);

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.trailerMovements.length, 2);
  assert.equal(txn.trailerMovements[0].movementNo, 1);
  assert.equal(txn.trailerMovements[1].movementNo, 2);
  assert.deepEqual(txn.trailerMovements[0].loads.map((l) => l.trailerNo), ['TRL-M1-A', 'TRL-M1-B'], 'movement 1 untouched');
  assert.deepEqual(txn.trailerMovements[1].loads.map((l) => l.trailerNo), ['TRL-M2-A']);
  assert.equal(txn.trailerLoads.length, 3, 'the flat combined array (used by ilmSummaryReport) has all of them');
});

test('Trailer Load Sr. No. is always server-assigned, sequential per movement, and cannot be supplied by the caller', () => {
  reset();
  const target = rig('GTC 100-02');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });
  const { id: movementId } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);

  // addTrailerLoad's input type has no srNo/lineNo field at all — passing one through `as any` proves it's ignored.
  addTrailerLoad(movementId, trailerLoadInput({ trailerNo: 'A', ...({ srNo: '999' } as any) }), ctx);
  addTrailerLoad(movementId, trailerLoadInput({ trailerNo: 'B' }), ctx);
  addTrailerLoad(movementId, trailerLoadInput({ trailerNo: 'C' }), ctx);

  const txn = getIlmTransaction(id)!;
  const loads = txn.trailerMovements[0].loads;
  assert.deepEqual(loads.map((l) => l.srNo), ['1', '2', '3']);
  assert.deepEqual(loads.map((l) => l.lineNo), [1, 2, 3]);
});

test('adding a second Crane Round never touches the first round\'s records', () => {
  reset();
  const target = rig('GTC 100-03');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const r1 = addCraneRound(id, { oldLocation: null, newLocation: null }, ctx);
  addCraneRecord(r1, craneInput({ craneNo: 'CRN-R1' }), ctx);
  const r2 = addCraneRound(id, { oldLocation: null, newLocation: null }, ctx);
  addCraneRecord(r2, craneInput({ craneNo: 'CRN-R2-A' }), ctx);
  addCraneRecord(r2, craneInput({ craneNo: 'CRN-R2-B' }), ctx);

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.craneRounds.length, 2);
  assert.equal(txn.craneRounds[0].roundNo, 1);
  assert.deepEqual(txn.craneRounds[0].records.map((c) => c.craneNo), ['CRN-R1']);
  assert.deepEqual(txn.craneRounds[1].records.map((c) => c.craneNo), ['CRN-R2-A', 'CRN-R2-B']);
  assert.equal(txn.cranes.length, 3, 'the flat combined array (used by ilmCraneSummary/ilmSummaryReport) has all of them');
});

test('a new Trailer Movement snapshots Old/New Location and Rig Release Date&Time from the ILM header, and freezes them', () => {
  reset();
  const target = rig('GTC 100-04');
  const id = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementFromWell: 'WELL-A', movementToWell: 'WELL-B', releaseDate: '2026-08-20', releaseTime: '08:00' },
    ctx,
  });

  const { id: m1 } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);

  // Header changes after the movement was created — must not retroactively change movement 1's snapshot.
  updateIlmHeader(id, { ...emptyIndividual, movementFromWell: 'WELL-X', movementToWell: 'WELL-Y', releaseDate: '2026-09-01', releaseTime: '10:00' }, ctx);
  const { id: m2 } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);

  const txn = getIlmTransaction(id)!;
  const mv1 = txn.trailerMovements.find((m) => m.id === m1)!;
  const mv2 = txn.trailerMovements.find((m) => m.id === m2)!;
  assert.equal(mv1.oldLocation, 'WELL-A');
  assert.equal(mv1.newLocation, 'WELL-B');
  assert.equal(mv1.rigReleaseAt, '2026-08-20 08:00');
  assert.equal(mv2.oldLocation, 'WELL-X', 'the second movement picks up the header as it stood when IT was created');
  assert.equal(mv2.newLocation, 'WELL-Y');
});

test('ending an ILM sets Completed/end date-time/duration, and blocks further additions until reopened', () => {
  reset();
  const target = rig('GTC 100-07');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });
  addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);

  endIlm(id, ctx);

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.status, 'Completed');
  assert.ok(txn.endDate);
  assert.ok(txn.endTime);
  assert.equal(txn.completedBy, ctx.user);
  assert.ok(txn.completedAt);
  assert.ok(txn.durationHours !== null && txn.durationHours >= 0);

  assert.throws(() => addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx), /completed and locked/);
  assert.throws(() => addCraneRound(id, { oldLocation: null, newLocation: null }, ctx), /completed and locked/);
  assert.throws(() => endIlm(id, ctx), /completed and locked/);

  // Reopening restores Active and lifts the lock.
  reopenIlm(id, ctx);
  const reopened = getIlmTransaction(id)!;
  assert.equal(reopened.status, 'Active');
  assert.equal(reopened.endDate, null);
  assert.doesNotThrow(() => addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx));
});

test('deleting an ILM cascades its delay lines, trailer movements/loads and crane rounds/records', () => {
  reset();
  const target = rig('GTC 100-08');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });
  setDelayLines(id, [{
    reasonForDelay: 'Weather Conditions', totalDelayHours: 2, hsdStockAccession: 1000, receivedQtyDuringIlm: 500,
    hsdStockShiftEnd: 800, ilmDistanceKm: 100, totalLoadsMoved: 4, cumulativeTrailerKm: 200,
  }], ctx);
  const { id: movementId } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);
  addTrailerLoad(movementId, trailerLoadInput(), ctx);
  const roundId = addCraneRound(id, { oldLocation: null, newLocation: null }, ctx);
  addCraneRecord(roundId, craneInput(), ctx);

  db.prepare('DELETE FROM ilm_transactions WHERE id = ?').run(id);

  for (const [table, column] of [
    ['ilm_individual_lines', 'transactionId'], ['ilm_trailer_movements', 'transactionId'], ['ilm_trailer_loads', 'transactionId'],
    ['ilm_crane_rounds', 'transactionId'], ['ilm_cranes', 'transactionId'], ['ilm_individual', 'transactionId'],
  ] as const) {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number }).n;
    assert.equal(count, 0, `${table} rows are gone`);
  }
});

test('total HSD consumption / distance / loads-moved on an ILM summary are aggregated from its delay lines, not trusted from any source', () => {
  reset();
  const target = rig('GTC 150-02');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'excel', importBatchId: null, individual: emptyIndividual, ctx });
  setDelayLines(id, [
    { reasonForDelay: null, totalDelayHours: null, hsdStockAccession: 400, receivedQtyDuringIlm: 100, hsdStockShiftEnd: 200, ilmDistanceKm: 50, totalLoadsMoved: 2, cumulativeTrailerKm: 100 },
    { reasonForDelay: null, totalDelayHours: null, hsdStockAccession: 300, receivedQtyDuringIlm: 100, hsdStockShiftEnd: 200, ilmDistanceKm: 30, totalLoadsMoved: 1, cumulativeTrailerKm: 60 },
  ], ctx);
  const { id: movementId } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);
  addTrailerLoad(movementId, trailerLoadInput({ trailerNo: 'TRL-01' }), ctx);
  addTrailerLoad(movementId, trailerLoadInput({ trailerNo: 'TRL-02' }), ctx);

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.totalDistanceKm, 80);
  assert.equal(txn.totalHsdConsumption, 500); // (400+100-200) + (300+100-200)
  assert.equal(txn.totalLoadsMoved, 3);
  assert.equal(txn.trailerCount, 2);
});

test('the movement-from/to filters on listIlmTransactions match by the Individual header', () => {
  reset();
  const target = rig('GTC 160-0');
  const first = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementFromWell: 'ALPHA', movementToWell: 'BETA' }, ctx,
  });
  endIlm(first, ctx);
  createIlm({
    rigId: target.id, date: '2026-08-21', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementFromWell: 'GAMMA', movementToWell: 'DELTA' }, ctx,
  });

  const alphaOnly = listIlmTransactions({ movementFrom: 'ALPHA' });
  assert.equal(alphaOnly.length, 1);
  assert.equal(alphaOnly[0].date, '2026-08-20');
});

/**
 * Regression: the rig-match check must fire on either sheet's rig text (the
 * Individual sheet's RIG NO. or the Trailer sheet's RIG NAME) and must
 * return the exact spec-worded three-line message (spec 17).
 */
test('withRigMatchCheck returns the exact spec-worded message when the Individual sheet names a different rig', () => {
  const issues = withRigMatchCheck(
    { rigKeyInFile: '50-1', rigTextInFile: 'GTC 50-01', trailerRigKeyInFile: '200-1', trailerRigTextInFile: 'GTC 200-01', issues: [] },
    { rigNumber: 'GTC 200-01', rigKey: '200-1' },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'fatal');
  assert.equal(
    issues[0].message,
    'Incorrect Rig Template.\nSelected Rig: GTC 200-01\nUploaded Template Rig: GTC 50-01\nPlease upload the correct Rig template.',
  );
});

test('withRigMatchCheck adds nothing when both sheets\' rig match the one selected', () => {
  const issues = withRigMatchCheck(
    { rigKeyInFile: '200-1', rigTextInFile: 'GTC 200-01', trailerRigKeyInFile: '200-1', trailerRigTextInFile: 'GTC 200-01', issues: [] },
    { rigNumber: 'GTC 200-01', rigKey: '200-1' },
  );
  assert.deepEqual(issues, []);
});

test('withRigMatchCheck does not check the rig when the file already has a fatal issue (avoids a misleading second error)', () => {
  const original = [{ level: 'fatal' as const, message: 'No ILM data rows were found in any sheet.' }];
  const issues = withRigMatchCheck(
    { rigKeyInFile: '50-1', rigTextInFile: 'GTC 50-01', trailerRigKeyInFile: '50-1', trailerRigTextInFile: 'GTC 50-01', issues: original },
    { rigNumber: 'GTC 200-01', rigKey: '200-1' },
  );
  assert.deepEqual(issues, original);
});
