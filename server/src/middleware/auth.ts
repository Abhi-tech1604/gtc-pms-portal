import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { parseRights, type PermissionFlag, type Rights, type Role } from '../services/rights.js';
import {
  hasModuleAccess, hasModuleAction, parseModuleAccess,
  type ModuleAccess, type ModuleAction, type ModuleCode,
} from '../services/moduleAccess.js';
import {
  hasPagePermission, parsePagePermissions,
  type PageAction, type PagePermissionsByModule,
} from '../services/pagePermissions.js';

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  rigId: string | null;
  status: string;
  rights: Rights;
  moduleAccess: ModuleAccess;
  pagePermissions: PagePermissionsByModule;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      clientIp?: string;
    }
  }
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
}

export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

const selectUser = db.prepare<[string], {
  id: string; username: string; name: string; role: string;
  rigId: string | null; status: string; rights: string; moduleAccess: string | null;
}>('SELECT id, username, name, role, rigId, status, rights, moduleAccess FROM users WHERE id = ?');

const selectModuleActive = db.prepare<[string], { isActive: number }>(
  'SELECT isActive FROM modules WHERE code = ?',
);

/** A module the Admin has switched off in the Modules screen is closed to everyone, Admin included. */
function isModuleActive(code: ModuleCode): boolean {
  const row = selectModuleActive.get(code);
  return !row || !!row.isActive;
}

export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  req.clientIp = clientIp(req);
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string };
    if (!payload.sub) return next();
    const row = selectUser.get(payload.sub);
    if (!row || row.status !== 'Active') return next();
    req.user = {
      id: row.id,
      username: row.username,
      name: row.name,
      role: row.role as Role,
      rigId: row.rigId,
      status: row.status,
      rights: parseRights(row.rights, row.role as Role),
      moduleAccess: parseModuleAccess(row.moduleAccess, row.role as Role),
      pagePermissions: parsePagePermissions(row.moduleAccess),
    };
  } catch {
    // An expired or tampered token simply leaves the request unauthenticated.
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  next();
}

/**
 * Spec 11.4: permission checks are enforced on the server for every endpoint,
 * not merely hidden in the interface.
 */
export function requireRight(flag: PermissionFlag) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    if (!req.user.rights[flag]) {
      res.status(403).json({ error: `Your account does not have the "${flag}" permission.` });
      return;
    }
    next();
  };
}

/**
 * A module's access switch, checked independently of any permission inside
 * it. This is what protects every PMS route today (module 'PMS'), and what
 * will protect DPR/ILM once they grow real endpoints.
 */
export function requireModule(code: ModuleCode) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    if (!isModuleActive(code)) {
      res.status(403).json({ error: `The ${code} module is currently disabled.` });
      return;
    }
    if (!hasModuleAccess(req.user.moduleAccess, code)) {
      res.status(403).json({ error: `Your account does not have access to the ${code} module.` });
      return;
    }
    next();
  };
}

/** Module access AND a specific action within it (view/create/edit/delete). */
export function requireModulePermission(code: ModuleCode, action: ModuleAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    if (!isModuleActive(code)) {
      res.status(403).json({ error: `The ${code} module is currently disabled.` });
      return;
    }
    if (!hasModuleAction(req.user.moduleAccess, code, action)) {
      res.status(403).json({ error: `Your account does not have "${action}" access in the ${code} module.` });
      return;
    }
    next();
  };
}

/**
 * Admin > User Rights' page-level matrix: module Access, THEN this specific
 * page's specific action (view/create/edit/delete) — falling back to that
 * module's existing defaults (its own CRUD grid, or PMS/Admin's legacy
 * per-flag rules) whenever the Admin hasn't set an explicit override for
 * this page. This is the enforcement spec 11.4 asks for: the same check the
 * client's canPage() runs, run again here so hiding a button is never the
 * only thing standing between a user and the action.
 */
export function requirePage(code: ModuleCode, pageKey: string, action: PageAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    if (!isModuleActive(code)) {
      res.status(403).json({ error: `The ${code} module is currently disabled.` });
      return;
    }
    if (!hasPagePermission(req.user, code, pageKey, action)) {
      res.status(403).json({ error: `Your account does not have "${action}" access to this page.` });
      return;
    }
    next();
  };
}

/**
 * Some backend resources (Equipment Master, Rig Master) are reachable from
 * more than one page in the sidebar — e.g. PMS's own Equipment Directory
 * AND Admin > Master > Equipment Master both call the same /api/equipment
 * routes. The request itself doesn't say which page it came from, so this
 * passes if ANY of the given (module, page, action) checks would allow it —
 * matching either page's permission is enough, never both required.
 */
export function requireAnyPage(...checks: [ModuleCode, string, PageAction][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const activeChecks = checks.filter(([code]) => isModuleActive(code));
    if (activeChecks.some(([code, pageKey, action]) => hasPagePermission(req.user!, code, pageKey, action))) {
      next();
      return;
    }
    res.status(403).json({ error: 'Your account does not have access to this action.' });
  };
}

/** The Admin Panel (user/role/module/permission management) is Admin-role-only. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  if (req.user.role !== 'Admin') {
    res.status(403).json({ error: 'This area is restricted to administrators.' });
    return;
  }
  next();
}

const selectUserRigAccess = db.prepare<[string], { rigId: string }>(
  'SELECT rigId FROM user_rig_access WHERE userId = ?',
);

/**
 * Spec 5.3, generalized: which rigs this account is scoped to across PMS/DPR/
 * ILM. Returning `null` means "no restriction" (Admin, or an account with no
 * assignment at all — the same "sees everything" default as before this
 * table existed). Returning an array means every query must filter to it —
 * one entry for the classic single-rig account, several for a Storekeeper or
 * Operational Manager covering multiple rigs. `user_rig_access` (Admin >
 * Users > Add/Edit User's "Assigned Rigs") is authoritative when it has any
 * rows for this user; the legacy single `users.rigId` column is the fallback
 * for an account nothing has migrated onto the new table yet, so no existing
 * account's access silently changes. Admin is always unrestricted, even if
 * rigId/user_rig_access is stray-set on the account — "Admin sees every rig"
 * must never depend on those being left blank.
 */
export function rigScope(req: Request): string[] | null {
  if (req.user?.role === 'Admin') return null;
  if (!req.user) return [];
  const assigned = selectUserRigAccess.all(req.user.id).map((r) => r.rigId);
  if (assigned.length > 0) return assigned;
  return req.user.rigId ? [req.user.rigId] : null;
}

/** Rejects an attempt to reach a rig outside this account's scope by manipulating a request. */
export function assertRigAllowed(req: Request, rigId: string | null | undefined): void {
  const scope = rigScope(req);
  if (scope === null) return;
  if (!rigId || !scope.includes(rigId)) {
    const err = new Error('This account is limited to its assigned rig(s).') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
}
