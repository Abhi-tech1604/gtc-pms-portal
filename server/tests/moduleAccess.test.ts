import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULE_ROLE_DEFAULTS, hasModuleAccess, hasModuleAction,
  parseModuleAccess, sanitizeModuleAccessInput, serialiseModuleAccess,
} from '../src/services/moduleAccess.js';
import { db } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import type { Role } from '../src/services/rights.js';

/**
 * The module-access layer sits alongside the existing PMS rights model
 * without replacing it: PMS's own permissions stay in services/rights.ts
 * untouched; this only adds a per-module on/off switch plus, for DPR/ILM
 * (which have no legacy permission model), a view/create/edit/delete shape.
 */

test('a non-Admin role defaults to PMS access only', () => {
  const defaults = MODULE_ROLE_DEFAULTS['PMS User'];
  assert.equal(defaults.PMS.access, true);
  assert.equal(defaults.DPR.access, false);
  assert.equal(defaults.ILM.access, false);
});

test('Admin defaults to full access to every module, including DPR/ILM actions', () => {
  const defaults = MODULE_ROLE_DEFAULTS.Admin;
  for (const code of ['PMS', 'DPR', 'ILM'] as const) {
    assert.equal(defaults[code].access, true, `${code} access`);
  }
  assert.equal(defaults.DPR.view && defaults.DPR.create && defaults.DPR.edit && defaults.DPR.delete, true);
  assert.equal(defaults.ILM.view && defaults.ILM.create && defaults.ILM.edit && defaults.ILM.delete, true);
});

test('parseModuleAccess with no stored value falls back to the role default', () => {
  const parsed = parseModuleAccess(null, 'PMS User');
  assert.deepEqual(parsed, MODULE_ROLE_DEFAULTS['PMS User']);
});

test('parseModuleAccess merges a partial override over the role default', () => {
  const stored = JSON.stringify({ DPR: { access: true, view: true, create: false, edit: false, delete: false } });
  const parsed = parseModuleAccess(stored, 'PMS User');
  assert.equal(parsed.DPR.access, true);
  assert.equal(parsed.DPR.view, true);
  // PMS was never mentioned in the override, so it still comes from the role default.
  assert.equal(parsed.PMS.access, true);
});

test('parseModuleAccess never throws on garbage JSON — falls back to role defaults', () => {
  const parsed = parseModuleAccess('{not json', 'Auditor');
  assert.deepEqual(parsed, MODULE_ROLE_DEFAULTS.Auditor);
});

test('serialiseModuleAccess fills in any module the caller did not specify from the role default', () => {
  const json = serialiseModuleAccess({ DPR: { access: true, view: true, create: true, edit: true, delete: true } }, 'PMS User');
  const parsed = JSON.parse(json);
  assert.equal(parsed.DPR.access, true);
  assert.equal(parsed.PMS.access, true, 'PMS default carried through untouched');
  assert.equal(parsed.ILM.access, false);
});

test('sanitizeModuleAccessInput forces every action off when access itself is off (spec 21)', () => {
  const clean = sanitizeModuleAccessInput({
    DPR: { access: false, view: true, create: true, edit: true, delete: true },
  });
  assert.deepEqual(clean.DPR, { access: false, view: false, create: false, edit: false, delete: false });
});

test('sanitizeModuleAccessInput keeps actions that are legitimately on when access is on', () => {
  const clean = sanitizeModuleAccessInput({
    DPR: { access: true, view: true, create: false, edit: true, delete: false },
  });
  assert.deepEqual(clean.DPR, { access: true, view: true, create: false, edit: true, delete: false });
});

test('hasModuleAccess / hasModuleAction read the parsed matrix correctly', () => {
  const access = parseModuleAccess(
    JSON.stringify({ DPR: { access: true, view: true, create: false, edit: false, delete: false } }),
    'PMS User',
  );
  assert.equal(hasModuleAccess(access, 'DPR'), true);
  assert.equal(hasModuleAccess(access, 'ILM'), false);
  assert.equal(hasModuleAction(access, 'DPR', 'view'), true);
  assert.equal(hasModuleAction(access, 'DPR', 'create'), false);
});

test('a module action never reads true when access is off, even if the action flag itself is true', () => {
  // This can only happen via data that predates sanitizeModuleAccessInput (e.g.
  // a future direct DB edit) — hasModuleAction must still refuse to honour it.
  const access = parseModuleAccess(
    JSON.stringify({ ILM: { access: false, view: true, create: true, edit: true, delete: true } }),
    'PMS User',
  );
  assert.equal(hasModuleAction(access, 'ILM', 'view'), false);
});

test('the modules table is seeded with PMS, DPR, ILM and DRR, all active', () => {
  const rows = db.prepare('SELECT code, isActive FROM modules ORDER BY code').all() as
    { code: string; isActive: number }[];
  assert.deepEqual(rows.map((r) => r.code), ['DPR', 'DRR', 'ILM', 'PMS']);
  assert.ok(rows.every((r) => r.isActive === 1), 'every seeded module starts active');
});

test('a user row created directly against the schema round-trips moduleAccess through the real column', () => {
  const id = newId('usr');
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, name, status, rights, moduleAccess, createdAt)
    VALUES (?, ?, 'x', 'PMS User', 'Test User', 'Active', '{}', ?, ?)
  `).run(id, `moduletest_${id}`, serialiseModuleAccess({ DPR: { access: true, view: true, create: false, edit: false, delete: false } }, 'PMS User'), stamp);

  const row = db.prepare('SELECT moduleAccess, role FROM users WHERE id = ?').get(id) as
    { moduleAccess: string; role: string };
  const access = parseModuleAccess(row.moduleAccess, row.role as Role);
  assert.equal(access.PMS.access, true, 'PMS access carried through from the role default');
  assert.equal(access.DPR.access, true);
  assert.equal(access.DPR.view, true);
  assert.equal(access.ILM.access, false);

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
});
