import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { createModuleRig } from '../src/routes/moduleRigMaster.js';

/**
 * DPR and ILM each own an independent Rig Master (dpr_rigs / ilm_rigs) —
 * structurally separate tables from PMS's `rigs` and from each other, not a
 * shared table filtered by module. These tests lock in the two properties
 * that matter: the shared createModuleRig() factory behaves correctly for
 * either table, and a rig created in one module is genuinely invisible to
 * (and independent of) the others, even with an identical rig number.
 */

const unrestricted = () => ({ restricted: false, rigIds: [] });
const dprOpts = { table: 'dpr_rigs' as const, idPrefix: 'dprrig', auditEntity: 'dpr_rigs', dependents: [], getScope: unrestricted };
const ilmOpts = { table: 'ilm_rigs' as const, idPrefix: 'ilmrig', auditEntity: 'ilm_rigs', dependents: [], getScope: unrestricted };
const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    // Never blanket-delete the shared PMS `rigs` table here — other test
    // files depend on the seeded fleet still being there when they run.
    // This file only ever adds one specific row to it (by a fixed id),
    // which the individual test that adds it also removes.
    for (const table of ['dpr_reports', 'dpr_import_batches', 'dpr_rigs', 'ilm_transactions', 'ilm_import_batches', 'ilm_rigs']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare(`DELETE FROM rigs WHERE id = 'rig_x'`).run();
  });
}

before(reset);
after(reset);

test('creating a DPR rig does not create or touch any PMS or ILM rig', () => {
  reset();
  const pmsCountBefore = (db.prepare('SELECT COUNT(*) AS n FROM rigs').get() as { n: number }).n;

  createModuleRig(dprOpts, { rigNumber: 'GTC 900-01', name: 'Rig 900-01' }, ctx.user, ctx.ip);

  const pmsCountAfter = (db.prepare('SELECT COUNT(*) AS n FROM rigs').get() as { n: number }).n;
  const ilmCount = (db.prepare('SELECT COUNT(*) AS n FROM ilm_rigs').get() as { n: number }).n;
  const dprCount = (db.prepare('SELECT COUNT(*) AS n FROM dpr_rigs').get() as { n: number }).n;
  assert.equal(pmsCountAfter, pmsCountBefore, 'PMS rigs untouched');
  assert.equal(ilmCount, 0, 'ILM rigs untouched');
  assert.equal(dprCount, 1, 'only the DPR rig was created');
});

test('the same rig number can exist independently in PMS, DPR and ILM at once', () => {
  reset();
  db.prepare(`INSERT INTO rigs (id, name, rigNumber, rigKey, status, createdAt) VALUES ('rig_x', 'Rig 900-02', 'GTC 900-02', '900-2', 'Active', datetime('now'))`).run();
  const dprRig = createModuleRig(dprOpts, { rigNumber: 'GTC 900-02', name: 'Rig 900-02' }, ctx.user, ctx.ip);
  const ilmRig = createModuleRig(ilmOpts, { rigNumber: 'GTC 900-02', name: 'Rig 900-02' }, ctx.user, ctx.ip);

  assert.notEqual(dprRig.id, 'rig_x');
  assert.notEqual(ilmRig.id, 'rig_x');
  assert.notEqual(dprRig.id, ilmRig.id, 'DPR and ILM get their own distinct ids for "the same" rig');
});

test('a duplicate rig number (by normalised rigKey) within the same module is rejected', () => {
  reset();
  createModuleRig(dprOpts, { rigNumber: 'GTC 900-03' }, ctx.user, ctx.ip);
  assert.throws(
    () => createModuleRig(dprOpts, { rigNumber: 'Rig 900-03' }, ctx.user, ctx.ip), // same rig, different formatting
    /already registered/,
  );
});

test('editing/deleting rows created for one module never cascades to another module\'s table', () => {
  reset();
  const dprRig = createModuleRig(dprOpts, { rigNumber: 'GTC 900-04' }, ctx.user, ctx.ip);
  const ilmRig = createModuleRig(ilmOpts, { rigNumber: 'GTC 900-05' }, ctx.user, ctx.ip);

  db.prepare('DELETE FROM dpr_rigs WHERE id = ?').run(dprRig.id);

  const ilmStillThere = db.prepare('SELECT id FROM ilm_rigs WHERE id = ?').get(ilmRig.id);
  assert.ok(ilmStillThere, 'deleting a DPR rig leaves ILM rigs untouched');
});

test('a rig record defaults to Active status and normalises its rigKey the same way as PMS rigs', () => {
  reset();
  const rig = createModuleRig(dprOpts, { rigNumber: 'GTC 900-06' }, ctx.user, ctx.ip);
  assert.equal(rig.status, 'Active');
  assert.equal(rig.rigKey, '900-6');
});
