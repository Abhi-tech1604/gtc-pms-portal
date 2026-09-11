import { Router } from 'express';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';

/**
 * Employee Master: a simple global reference list (name, code, default
 * designation) that Manpower Roster and DRR Site Attendance both link to by
 * id — mirrors departments.ts, the closest existing precedent for a simple
 * admin-managed named list other records reference by FK.
 */
export const employeesRouter = Router();

const STATUSES = ['Active', 'Inactive'];

interface EmployeeRow {
  id: string; name: string; employeeCode: string | null; defaultDesignation: string | null;
  status: string; createdBy: string; createdAt: string;
}

/**
 * Active Employee Master rows — DRR's prefill response embeds this directly
 * (mirrors getScheduledEmployees()) so the "+ Add Employee" picker works for
 * any DRR user without a second HTTP round-trip through a PMS-module-gated
 * route: a Rig User can have DRR access without PMS access.
 */
export function listActiveEmployees(): EmployeeRow[] {
  return db.prepare<[], EmployeeRow>("SELECT * FROM employees WHERE status = 'Active' ORDER BY name").all();
}

/**
 * GET is read-only reference data — any authenticated user needs it (DRR's
 * "+ Add Employee" picker reads the same Employee Master, never a separate
 * list). Mutations stay admin-only below.
 */
employeesRouter.get('/', requireAuth, wrap((req, res) => {
  const where = String(req.query.activeOnly ?? '') === 'true' ? "WHERE status = 'Active'" : '';
  const rows = db.prepare<[], EmployeeRow>(`SELECT * FROM employees ${where} ORDER BY name`).all();
  res.json({ employees: rows });
}));

employeesRouter.get('/:id', requireAuth, wrap((req, res) => {
  const row = db.prepare<[string], EmployeeRow>('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('That employee does not exist.');
  res.json({ employee: row });
}));

employeesRouter.post('/', requireAuth, requireAdmin, wrap((req, res) => {
  const record = createEmployee(req.body ?? {}, req.user!.username, req.clientIp ?? null);
  res.status(201).json({ employee: record });
}));

export function createEmployee(body: Record<string, unknown>, user: string, ip: string | null): EmployeeRow {
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('A name is required.');

  const record: EmployeeRow = {
    id: newId('emp'),
    name,
    employeeCode: (body.employeeCode as string)?.trim() || null,
    defaultDesignation: (body.defaultDesignation as string)?.trim() || null,
    status: STATUSES.includes(body.status as string) ? (body.status as string) : 'Active',
    createdBy: user,
    createdAt: nowIso(),
  };
  db.prepare(`
    INSERT INTO employees (id, name, employeeCode, defaultDesignation, status, createdBy, createdAt)
    VALUES (@id, @name, @employeeCode, @defaultDesignation, @status, @createdBy, @createdAt)
  `).run(record);

  audit({ user, ip, action: 'employee.create', entity: 'employees', entityId: record.id, newValue: record });
  return record;
}

employeesRouter.put('/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const existing = db.prepare<[string], EmployeeRow>('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That employee does not exist.');

  const body = req.body ?? {};
  const name = String(body.name ?? existing.name).trim();
  if (!name) throw badRequest('A name is required.');

  const next: EmployeeRow = {
    id: existing.id,
    name,
    employeeCode: 'employeeCode' in body ? ((body.employeeCode as string)?.trim() || null) : existing.employeeCode,
    defaultDesignation: 'defaultDesignation' in body ? ((body.defaultDesignation as string)?.trim() || null) : existing.defaultDesignation,
    status: STATUSES.includes(body.status) ? body.status : existing.status,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
  };
  db.prepare(`
    UPDATE employees SET name=@name, employeeCode=@employeeCode, defaultDesignation=@defaultDesignation, status=@status WHERE id=@id
  `).run(next);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'employee.update', entity: 'employees', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  res.json({ employee: next });
}));
