import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { createDepartment, getActiveDepartment } from '../src/routes/departments.js';

/**
 * Module -> Department -> User -> (future) rig-wise rights. These tests lock
 * in the two properties the request cares about: duplicate departments
 * within the same module are rejected, but the same name is fine across two
 * different modules (they're genuinely different departments); and a
 * department still referenced by a user can't be deleted out from under them.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    db.prepare("DELETE FROM users WHERE username LIKE 'dept_test_%'").run();
    db.prepare("DELETE FROM departments WHERE name LIKE 'Test %'").run();
  });
}

before(reset);
after(reset);

test('a department is created under the module it was given', () => {
  reset();
  const dept = createDepartment({ moduleCode: 'DPR', name: 'Test Rig Ops' }, ctx.user, ctx.ip);
  assert.equal(dept.moduleCode, 'DPR');
  assert.equal(dept.name, 'Test Rig Ops');
  assert.equal(dept.status, 'Active', 'defaults to Active');
});

test('a duplicate department name within the same module is rejected', () => {
  reset();
  createDepartment({ moduleCode: 'DPR', name: 'Test Rig Ops' }, ctx.user, ctx.ip);
  assert.throws(
    () => createDepartment({ moduleCode: 'DPR', name: 'test rig ops' }, ctx.user, ctx.ip), // same name, different case/whitespace
    /already exists under DPR/,
  );
});

test('the same department name is allowed under two different modules', () => {
  reset();
  const dpr = createDepartment({ moduleCode: 'DPR', name: 'Test Rig Ops' }, ctx.user, ctx.ip);
  const ilm = createDepartment({ moduleCode: 'ILM', name: 'Test Rig Ops' }, ctx.user, ctx.ip);
  assert.notEqual(dpr.id, ilm.id, 'these are two genuinely different department records');
  assert.equal(dpr.moduleCode, 'DPR');
  assert.equal(ilm.moduleCode, 'ILM');
});

test('an invalid module code is rejected', () => {
  reset();
  assert.throws(() => createDepartment({ moduleCode: 'XYZ', name: 'Test Bad Module' }, ctx.user, ctx.ip), /Select a module/);
});

test('a blank name is rejected', () => {
  reset();
  assert.throws(() => createDepartment({ moduleCode: 'PMS', name: '  ' }, ctx.user, ctx.ip), /name is required/);
});

test('getActiveDepartment only returns Active departments, never Inactive ones', () => {
  reset();
  const active = createDepartment({ moduleCode: 'PMS', name: 'Test Active Dept' }, ctx.user, ctx.ip);
  const inactive = createDepartment({ moduleCode: 'PMS', name: 'Test Inactive Dept', status: 'Inactive' }, ctx.user, ctx.ip);
  assert.ok(getActiveDepartment(active.id), 'an Active department is found');
  assert.equal(getActiveDepartment(inactive.id), undefined, 'an Inactive department is not returned');
});

test('a database-level constraint blocks deleting a department still referenced by a user', () => {
  reset();
  const dept = createDepartment({ moduleCode: 'PMS', name: 'Test Referenced Dept' }, ctx.user, ctx.ip);
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, name, departmentId, status, rights, createdAt)
    VALUES (?, 'dept_test_user', 'x', 'PMS User', 'Dept Test User', ?, 'Active', '{}', ?)
  `).run(newId('usr'), dept.id, nowIso());

  assert.throws(() => {
    db.prepare('DELETE FROM departments WHERE id = ?').run(dept.id);
  }, /FOREIGN KEY constraint failed/);
});

test('a pre-existing user with no department (departmentId NULL) is unaffected — the column is nullable, not retroactively required', () => {
  reset();
  const id = newId('usr');
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, name, status, rights, createdAt)
    VALUES (?, 'dept_test_legacy', 'x', 'PMS User', 'Legacy User', 'Active', '{}', ?)
  `).run(id, nowIso());
  const row = db.prepare('SELECT departmentId FROM users WHERE id = ?').get(id) as { departmentId: string | null };
  assert.equal(row.departmentId, null);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
});
