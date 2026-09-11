import test from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { addTrailerMovement, createIlm, updateIlmHeader } from '../src/services/ilmLifecycle.js';
import { getIlmTransaction } from '../src/services/ilmView.js';
import { ilmContractDurationRuleModel, resolveContractDuration } from '../src/services/ilmContractDuration.js';
import { FLEET } from '../src/db/seed.js';

/**
 * ILM Contract Duration Rules: per-rig, distance-banded allowed-hours rules
 * that a Trailer Movement resolves against ONCE, at creation, and freezes —
 * never a fleet-wide constant, never recalculated after a rule changes.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };
const emptyIndividual = {
  area: null, operatorName: null, wellNo: null, movementFromWell: null, movementToWell: null,
  releaseDate: null, releaseTime: null, spudDate: null, spudTime: null, ilmRatePerDay: null, ilmExpenses: null,
};

function reset(): void {
  transact(() => {
    for (const table of [
      'ilm_trailer_movements', 'ilm_individual', 'ilm_transactions', 'ilm_import_batches',
      'ilm_contract_duration_rules', 'ilm_rigs',
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

/** The two example rules from the spec: 0-10km flat 36h; above 10km, 36h base + 1.5h per KM or part thereof. */
function seedSpecRules(ilmRigId: string): void {
  ilmContractDurationRuleModel.create({ ilmRigId, fromDistanceKm: 0, toDistanceKm: 10, baseHours: 36, extraHoursPerKm: 0, roundPerKm: true }, 'admin');
  ilmContractDurationRuleModel.create({ ilmRigId, fromDistanceKm: 10, toDistanceKm: null, baseHours: 36, extraHoursPerKm: 1.5, roundPerKm: true }, 'admin');
}

test('the spec examples: 8 KM resolves to 36 hours, 12 KM resolves to 39 hours', () => {
  reset();
  const target = rig('GTC 50-01');
  seedSpecRules(target.id);

  assert.equal(resolveContractDuration(target.id, 8).allowedHours, 36);
  assert.equal(resolveContractDuration(target.id, 12).allowedHours, 39);
});

test('a flat band (extraHoursPerKm = 0) always resolves to exactly baseHours, anywhere in the band', () => {
  reset();
  const target = rig('GTC 50-02');
  seedSpecRules(target.id);

  assert.equal(resolveContractDuration(target.id, 0).allowedHours, 36);
  assert.equal(resolveContractDuration(target.id, 5).allowedHours, 36);
  assert.equal(resolveContractDuration(target.id, 10).allowedHours, 36);
});

test('"per KM or part thereof" rounds a partial extra KM up to a full KM', () => {
  reset();
  const target = rig('GTC 50-03');
  seedSpecRules(target.id);

  // 10.2km into the >10km band: 0.2km extra, rounded up to 1 -> 36 + 1.5 = 37.5
  const r = resolveContractDuration(target.id, 10.2);
  assert.equal(r.allowedHours, 37.5);
});

test('with roundPerKm off, the extra distance is used exactly, not rounded up', () => {
  reset();
  const target = rig('GTC 100-01');
  ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 0, toDistanceKm: null, baseHours: 10, extraHoursPerKm: 2, roundPerKm: false }, 'admin');

  const r = resolveContractDuration(target.id, 3.5);
  assert.equal(r.allowedHours, 17); // 10 + 3.5*2
});

test('no matching rule for the distance -> resolveContractDuration returns no rule, no fabricated hours', () => {
  reset();
  const target = rig('GTC 100-02');
  ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 0, toDistanceKm: 5, baseHours: 12, extraHoursPerKm: 0, roundPerKm: true }, 'admin');

  const r = resolveContractDuration(target.id, 50); // outside every configured band
  assert.equal(r.rule, null);
  assert.equal(r.allowedHours, null);
});

test('an Inactive rule is never matched', () => {
  reset();
  const target = rig('GTC 100-03');
  const rule = ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 0, toDistanceKm: 20, baseHours: 40, extraHoursPerKm: 0, roundPerKm: true }, 'admin');
  ilmContractDurationRuleModel.update(rule.id, { status: 'Inactive' }, 'admin');

  assert.equal(resolveContractDuration(target.id, 5).rule, null);
});

test('rules never cross rigs: Rig A\'s rule is never applied to Rig B\'s movement', () => {
  reset();
  const rigA = rig('GTC 100-04');
  const rigB = rig('GTC 100-07');
  seedSpecRules(rigA.id); // only Rig A gets rules

  assert.equal(resolveContractDuration(rigA.id, 8).allowedHours, 36);
  assert.equal(resolveContractDuration(rigB.id, 8).rule, null, 'Rig B has no rules of its own, and must never inherit Rig A\'s');
});

test('addTrailerMovement freezes the resolved hours/days/rule onto the row, and flags no warning when a rule matched', () => {
  reset();
  const target = rig('GTC 100-08');
  seedSpecRules(target.id);
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const { id: movementId, contractWarning } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: 12, allowedDurationHrs: null }, ctx);
  assert.equal(contractWarning, false);

  const txn = getIlmTransaction(id)!;
  const mv = txn.trailerMovements.find((m) => m.id === movementId)!;
  assert.equal(mv.allowedDurationHrs, 39);
  assert.equal(mv.contractDays, round2(39 / 24));
  assert.ok(mv.contractRuleId);
});

test('addTrailerMovement warns and keeps the caller\'s manual hours when no rule matches this rig/distance', () => {
  reset();
  const target = rig('GTC 1000-01');
  // No rules configured for this rig at all.
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const { id: movementId, contractWarning } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: 15, allowedDurationHrs: 48 }, ctx);
  assert.equal(contractWarning, true);

  const txn = getIlmTransaction(id)!;
  const mv = txn.trailerMovements.find((m) => m.id === movementId)!;
  assert.equal(mv.allowedDurationHrs, 48, 'manual value is kept as-is, never overwritten with a fabricated number');
  assert.equal(mv.contractDays, null);
  assert.equal(mv.contractRuleId, null);
});

test('no distance entered at all -> no warning, no calculation attempted', () => {
  reset();
  const target = rig('GTC 1000-02');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const { contractWarning } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: null, allowedDurationHrs: null }, ctx);
  assert.equal(contractWarning, false);
});

test('changing a rig\'s rule after a movement was created never recalculates that movement (freeze at creation)', () => {
  reset();
  const target = rig('GTC 150-02');
  const rule = ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 0, toDistanceKm: null, baseHours: 36, extraHoursPerKm: 1.5, roundPerKm: true }, 'admin');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const { id: movementId } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: 12, allowedDurationHrs: null }, ctx);
  const before = getIlmTransaction(id)!.trailerMovements.find((m) => m.id === movementId)!;
  assert.equal(before.allowedDurationHrs, round2(36 + 12 * 1.5), 'this rule starts at fromDistanceKm 0, so all 12km count as extra distance');

  // Admin later changes the rule's base hours drastically.
  ilmContractDurationRuleModel.update(rule.id, { baseHours: 100 }, 'admin');

  const after = getIlmTransaction(id)!.trailerMovements.find((m) => m.id === movementId)!;
  assert.equal(after.allowedDurationHrs, before.allowedDurationHrs, 'the already-created movement keeps its original frozen value');
});

test('deactivating a rule after a movement was created never changes that movement\'s frozen value either', () => {
  reset();
  const target = rig('GTC 200-01');
  const rule = ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 0, toDistanceKm: null, baseHours: 20, extraHoursPerKm: 0, roundPerKm: true }, 'admin');
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const { id: movementId } = addTrailerMovement(id, { fleetReportAt: null, leadDistanceKm: 3, allowedDurationHrs: null }, ctx);
  ilmContractDurationRuleModel.update(rule.id, { status: 'Inactive' }, 'admin');

  const after = getIlmTransaction(id)!.trailerMovements.find((m) => m.id === movementId)!;
  assert.equal(after.allowedDurationHrs, 20);
});

test('Excel-imported movements (explicitHeader) are never touched by the auto-calculator', () => {
  reset();
  const target = rig('GTC 250-01');
  seedSpecRules(target.id); // rules exist, but must be ignored for this path
  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'excel', importBatchId: null, individual: emptyIndividual, ctx });

  const { id: movementId, contractWarning } = addTrailerMovement(id, {
    fleetReportAt: null, leadDistanceKm: 12, allowedDurationHrs: 999,
    explicitHeader: { rigName: 'Rig X', oldLocation: 'A', newLocation: 'B', rigReleaseAt: '2026-08-20 06:00' },
  }, ctx);
  assert.equal(contractWarning, false);

  const mv = getIlmTransaction(id)!.trailerMovements.find((m) => m.id === movementId)!;
  assert.equal(mv.allowedDurationHrs, 999, 'the imported value is trusted as-is, never overridden by a rule');
  assert.equal(mv.contractRuleId, null);
});

test('validation: Distance To must be greater than Distance From when given', () => {
  reset();
  const target = rig('GTC 2000-01');
  assert.throws(
    () => ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 10, toDistanceKm: 5, baseHours: 36 }, 'admin'),
    /Distance To/,
  );
});

test('validation: a rule must name a rig that actually exists', () => {
  reset();
  assert.throws(
    () => ilmContractDurationRuleModel.create({ ilmRigId: 'ilmrig_does_not_exist', fromDistanceKm: 0, toDistanceKm: 10, baseHours: 36 }, 'admin'),
    /rig/i,
  );
});

/**
 * ILM Add's header-level preview (below Release Date/Time) — the same
 * resolver as Trailer Movements, but resolved from ilm_individual's own
 * movementDistanceKm and frozen there, independent of any Trailer Movement
 * round's own distance/calculation.
 */
test('createIlm resolves and freezes the header-level contract fields when a distance is given', () => {
  reset();
  const target = rig('GTC 100-02');
  seedSpecRules(target.id);

  const id = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementDistanceKm: 12 }, ctx,
  });

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.individual!.movementDistanceKm, 12);
  assert.equal(txn.individual!.contractAllowedHours, 39);
  assert.equal(txn.individual!.contractAllowedDays, round2(39 / 24));
  assert.ok(txn.individual!.contractRuleId);
});

test('createIlm with no distance leaves the header contract fields null — no calculation attempted', () => {
  reset();
  const target = rig('GTC 100-03');
  seedSpecRules(target.id);

  const id = createIlm({ rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null, individual: emptyIndividual, ctx });

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.individual!.movementDistanceKm, null);
  assert.equal(txn.individual!.contractAllowedHours, null);
  assert.equal(txn.individual!.contractRuleId, null);
});

test('a rig with no active rule leaves the header contract fields null (client shows the warning)', () => {
  reset();
  const target = rig('GTC 100-04');
  // No rules configured for this rig at all.

  const id = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementDistanceKm: 8 }, ctx,
  });

  const txn = getIlmTransaction(id)!;
  assert.equal(txn.individual!.contractAllowedHours, null);
  assert.equal(txn.individual!.contractRuleId, null);
});

test('updateIlmHeader re-resolves on every explicit save, but a later rule change never touches an already-saved header', () => {
  reset();
  const target = rig('GTC 150-02');
  const rule = ilmContractDurationRuleModel.create({ ilmRigId: target.id, fromDistanceKm: 0, toDistanceKm: null, baseHours: 20, extraHoursPerKm: 0, roundPerKm: true }, 'admin');

  const id = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementDistanceKm: 5 }, ctx,
  });
  assert.equal(getIlmTransaction(id)!.individual!.contractAllowedHours, 20);

  // Admin changes the rule after the header was saved — must not retroactively change it.
  ilmContractDurationRuleModel.update(rule.id, { baseHours: 999 }, 'admin');
  assert.equal(getIlmTransaction(id)!.individual!.contractAllowedHours, 20, 'unchanged until the user explicitly re-saves the header');

  // The user now explicitly edits/re-saves the header (distance unchanged) — this SHOULD pick up the new rule.
  const current = getIlmTransaction(id)!.individual!;
  updateIlmHeader(id, { ...current, movementDistanceKm: 5 }, ctx);
  assert.equal(getIlmTransaction(id)!.individual!.contractAllowedHours, 999, 'an explicit re-save resolves against the currently active rule');
});

test('changing the header\'s Movement Distance and re-saving recalculates using the same active rule', () => {
  reset();
  const target = rig('GTC 200-01');
  seedSpecRules(target.id);

  const id = createIlm({
    rigId: target.id, date: '2026-08-20', source: 'manual', importBatchId: null,
    individual: { ...emptyIndividual, movementDistanceKm: 8 }, ctx,
  });
  assert.equal(getIlmTransaction(id)!.individual!.contractAllowedHours, 36);

  const current = getIlmTransaction(id)!.individual!;
  updateIlmHeader(id, { ...current, movementDistanceKm: 12 }, ctx);
  assert.equal(getIlmTransaction(id)!.individual!.contractAllowedHours, 39);
});

function round2(n: number): number { return Math.round(n * 100) / 100; }
