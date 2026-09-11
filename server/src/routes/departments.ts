import { Router } from 'express';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { MODULE_CODES } from '../services/moduleAccess.js';

/**
 * Module -> Department -> User -> (future) rig-wise rights. A department
 * belongs to exactly one module; the same name may exist under two different
 * modules but not twice within the same one (idx_dept_module_namekey).
 * Mirrors support.ts's companies CRUD — the closest existing precedent for a
 * simple admin-managed named list other records reference by FK.
 */
export const departmentsRouter = Router();

const STATUSES = ['Active', 'Inactive'];

interface DepartmentRow {
  id: string; moduleCode: string; name: string; nameKey: string; status: string; createdAt: string;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

departmentsRouter.get('/', requireAuth, requireAdmin, wrap((req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.module) { where.push('moduleCode = ?'); params.push(req.query.module); }
  if (String(req.query.activeOnly ?? '') === 'true') { where.push("status = 'Active'"); }
  const sql = `SELECT * FROM departments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY moduleCode, name`;
  res.json({ departments: db.prepare(sql).all(...params) });
}));

departmentsRouter.get('/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const dept = db.prepare<[string], DepartmentRow>('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!dept) throw notFound('That department does not exist.');
  res.json({ department: dept });
}));

departmentsRouter.post('/', requireAuth, requireAdmin, wrap((req, res) => {
  const record = createDepartment(req.body ?? {}, req.user!.username, req.clientIp ?? null);
  res.status(201).json({ department: record });
}));

departmentsRouter.put('/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const existing = db.prepare<[string], DepartmentRow>('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That department does not exist.');

  const body = req.body ?? {};
  const moduleCode = String(body.moduleCode ?? existing.moduleCode);
  if (!MODULE_CODES.includes(moduleCode as (typeof MODULE_CODES)[number])) {
    throw badRequest(`Module must be one of: ${MODULE_CODES.join(', ')}.`);
  }
  const name = String(body.name ?? existing.name).trim();
  if (!name) throw badRequest('A department name is required.');
  const key = nameKey(name);

  const clash = db.prepare<[string, string, string], { id: string }>(
    'SELECT id FROM departments WHERE moduleCode = ? AND nameKey = ? AND id != ?',
  ).get(moduleCode, key, existing.id);
  if (clash) throw badRequest(`"${name}" already exists under ${moduleCode}.`);

  const next = {
    id: existing.id, moduleCode, name, nameKey: key,
    status: STATUSES.includes(body.status) ? body.status : existing.status,
  };
  db.prepare('UPDATE departments SET moduleCode=@moduleCode, name=@name, nameKey=@nameKey, status=@status WHERE id=@id').run(next);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'department.update', entity: 'departments', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(existing.id) });
}));

departmentsRouter.delete('/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const existing = db.prepare<[string], DepartmentRow>('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That department does not exist.');

  const usersCount = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM users WHERE departmentId = ?').get(existing.id)!.n;
  if (usersCount > 0) {
    throw new HttpError(409, `${usersCount} user(s) are still assigned to this department. Reassign them first.`, { usersCount });
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(existing.id);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'department.delete', entity: 'departments', entityId: existing.id, oldValue: existing });
  res.json({ ok: true });
}));

/** Exported so users.ts can validate a submitted departmentId without a second query shape. */
export function getActiveDepartment(id: string): DepartmentRow | undefined {
  return db.prepare<[string], DepartmentRow>("SELECT * FROM departments WHERE id = ? AND status = 'Active'").get(id);
}

/** Exported for tests: the create-with-duplicate-check logic the POST route calls. */
export function createDepartment(body: Record<string, unknown>, user: string, ip: string | null): DepartmentRow {
  const moduleCode = String(body.moduleCode ?? '');
  if (!MODULE_CODES.includes(moduleCode as (typeof MODULE_CODES)[number])) {
    throw badRequest(`Select a module: one of ${MODULE_CODES.join(', ')}.`);
  }
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('A department name is required.');
  const key = nameKey(name);

  const clash = db.prepare<[string, string], { name: string }>(
    'SELECT name FROM departments WHERE moduleCode = ? AND nameKey = ?',
  ).get(moduleCode, key);
  if (clash) throw badRequest(`"${clash.name}" already exists under ${moduleCode}.`);

  const record: DepartmentRow = {
    id: newId('dept'), moduleCode, name, nameKey: key,
    status: STATUSES.includes(body.status as string) ? (body.status as string) : 'Active',
    createdAt: nowIso(),
  };
  db.prepare(`
    INSERT INTO departments (id, moduleCode, name, nameKey, status, createdAt)
    VALUES (@id, @moduleCode, @name, @nameKey, @status, @createdAt)
  `).run(record);

  audit({ user, ip, action: 'department.create', entity: 'departments', entityId: record.id, newValue: record });
  return record;
}
