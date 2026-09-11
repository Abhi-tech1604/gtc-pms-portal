import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { parseModuleAccess, sanitizeModuleAccessInput, serialiseModuleAccess } from '../services/moduleAccess.js';
import { parsePagePermissions, serialisePagePermissions, type PagePermissionsByModule } from '../services/pagePermissions.js';
import type { Role } from '../services/rights.js';

/**
 * The Admin Panel: module list and per-user module access + page-level
 * permission matrix (Admin > User Rights). Gated via requirePage('ADMIN', ...)
 * rather than a hard role check — Admin always passes that unconditionally,
 * but it also lets an Admin deliberately delegate a specific Admin Panel
 * page to a non-Admin account, per spec ("Admin can assign different
 * permissions to every user individually"). User create/edit/rights
 * themselves are not duplicated here; the Admin Panel's Users tab reuses the
 * existing /api/users endpoints.
 */
export const adminRouter = Router();

interface ModuleRow {
  id: string; code: string; name: string; description: string | null; isActive: number; createdAt: string;
}

interface UserRow {
  id: string; username: string; name: string; role: string; moduleAccess: string | null;
}

adminRouter.get('/modules', requireAuth, requirePage('ADMIN', 'modules', 'view'), wrap((_req, res) => {
  const rows = db.prepare<[], ModuleRow>('SELECT * FROM modules ORDER BY code').all();
  res.json({
    modules: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, description: r.description, isActive: !!r.isActive,
    })),
  });
}));

adminRouter.put('/modules/:code', requireAuth, requirePage('ADMIN', 'modules', 'edit'), wrap((req, res) => {
  const existing = db.prepare<[string], ModuleRow>('SELECT * FROM modules WHERE code = ?').get(req.params.code);
  if (!existing) throw notFound('That module does not exist.');
  const isActive = req.body?.isActive === false ? 0 : 1;
  db.prepare('UPDATE modules SET isActive = ? WHERE code = ?').run(isActive, existing.code);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'module.update',
    entity: 'modules', entityId: existing.code, field: 'isActive',
    oldValue: !!existing.isActive, newValue: !!isActive,
  });
  res.json({ ok: true });
}));

adminRouter.get('/users/:id/module-access', requireAuth, requirePage('ADMIN', 'user_rights', 'view'), wrap((req, res) => {
  const row = db.prepare<[string], UserRow>('SELECT id, username, name, role, moduleAccess FROM users WHERE id = ?')
    .get(req.params.id);
  if (!row) throw notFound('That user does not exist.');
  res.json({
    moduleAccess: parseModuleAccess(row.moduleAccess, row.role as Role),
    pagePermissions: parsePagePermissions(row.moduleAccess),
  });
}));

/**
 * Admin > User Rights' single save action: the module-level Access +
 * view/create/edit/delete grid, AND the page-level matrix underneath it,
 * written together into the same users.moduleAccess JSON column (one User
 * <-> Module relationship, extended — not a second, parallel table).
 */
adminRouter.put('/users/:id/module-access', requireAuth, requirePage('ADMIN', 'user_rights', 'edit'), wrap((req, res) => {
  const existing = db.prepare<[string], UserRow>('SELECT id, username, name, role, moduleAccess FROM users WHERE id = ?')
    .get(req.params.id);
  if (!existing) throw notFound('That user does not exist.');

  const clean = sanitizeModuleAccessInput(req.body?.moduleAccess ?? {});
  const before = parseModuleAccess(existing.moduleAccess, existing.role as Role);
  const beforePages = parsePagePermissions(existing.moduleAccess);
  const serialisedModules = serialiseModuleAccess(clean, existing.role as Role);

  const pagesInput = (req.body?.pagePermissions ?? {}) as PagePermissionsByModule;
  const serialised = serialisePagePermissions(serialisedModules, pagesInput);
  db.prepare('UPDATE users SET moduleAccess = ? WHERE id = ?').run(serialised, existing.id);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'user.module_access', entity: 'users', entityId: existing.id },
    { ...before, pages: beforePages } as unknown as Record<string, unknown>,
    JSON.parse(serialised) as Record<string, unknown>,
  );
  res.json({ moduleAccess: JSON.parse(serialised) });
}));

/** Convenience for the client's module-select page: which modules exist and are active. */
adminRouter.get('/modules/active', requireAuth, wrap((_req, res) => {
  const rows = db.prepare<[], ModuleRow>('SELECT code, name FROM modules WHERE isActive = 1 ORDER BY code').all();
  res.json({ modules: rows });
}));
